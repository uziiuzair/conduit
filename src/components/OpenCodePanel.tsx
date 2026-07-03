import { useEffect, useRef, useState } from "react";
import {
  useStore,
  type LocalModel,
  type LocalProviderStatus,
  type OpenCodeSettings,
} from "../store";

/**
 * Local models — route OpenCode sessions to a local GPU / self-hosted endpoint. Zero-config
 * by design: opening the panel (or flipping the switch) scans the well-known local
 * servers, picks the best one, fetches its models, and selects the strongest coding
 * model (tool-calling first, then context size) — the user only confirms. Conduit
 * injects the result into each OpenCode session at spawn (env-only inline config); the
 * API key never leaves backend memory and nothing is written to disk.
 */

// 127.0.0.1 (not localhost): OpenCode's runtime may resolve localhost IPv6-first and
// get refused by servers that bind IPv4 loopback only (Ollama does).
const PRESET_FALLBACK: Array<Pick<LocalProviderStatus, "preset" | "label" | "baseUrl">> = [
  { preset: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { preset: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  { preset: "vllm", label: "vLLM", baseUrl: "http://127.0.0.1:8000/v1" },
  { preset: "llamacpp", label: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1" },
  { preset: "openwebui", label: "OpenWebUI", baseUrl: "http://127.0.0.1:3000/api" },
];
const CUSTOM = { preset: "custom", label: "Custom", baseUrl: "http://127.0.0.1:8000/v1" };

/** Rank for auto-pick: tool-calling first (an agent is crippled without it), then the
 * biggest context window. */
const rankModels = (ms: LocalModel[]): LocalModel[] =>
  [...ms].sort((a, b) => {
    const at = a.tools === true ? 1 : 0;
    const bt = b.tools === true ? 1 : 0;
    if (at !== bt) return bt - at;
    return (b.context ?? 0) - (a.context ?? 0);
  });

/** Auto-pick candidate list: models that declare tools=false can never drive an agent,
 * so they're only eligible when nothing else is served. */
const pickable = (ms: LocalModel[]): LocalModel[] => {
  const ranked = rankModels(ms);
  const usable = ranked.filter((m) => m.tools !== false);
  return usable.length > 0 ? usable : ranked;
};

const fmtCtx = (n?: number | null) => (n ? `${Math.round(n / 1024)}k ctx` : "");

export function OpenCodePanel() {
  const oc = useStore((s) => s.opencode);
  const keySet = useStore((s) => s.opencodeKeySet);
  const privateMode = useStore((s) => s.privateMode);
  const loadSettings = useStore((s) => s.loadOpenCodeSettings);
  const setSettings = useStore((s) => s.setOpenCodeSettings);
  const setOpenCodeKey = useStore((s) => s.setOpenCodeKey);
  const detectLocalProviders = useStore((s) => s.detectLocalProviders);
  const listLocalModels = useStore((s) => s.listLocalModels);
  const probeToolCall = useStore((s) => s.probeToolCall);

  const [statuses, setStatuses] = useState<LocalProviderStatus[] | null>(null);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [probe, setProbe] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [probing, setProbing] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const mounted = useRef(false);

  const save = (patch: Partial<OpenCodeSettings>) => {
    const cur = useStore.getState().opencode;
    // A tool-calling verdict is only valid for the (endpoint, model) it tested.
    if (
      (patch.model !== undefined && patch.model !== cur.model) ||
      (patch.baseUrl !== undefined && patch.baseUrl !== cur.baseUrl)
    ) {
      setProbe(null);
    }
    const next = { ...cur, ...patch };
    void setSettings(next);
    return next;
  };

  /** The whole "it just works" chain: scan servers → pick one → fetch models → pick the
   * best → save. `presetHint` pins the server (a chip click); otherwise priority order.
   * Keeps a model the user already chose when the server still offers it. Never touches
   * `enabled` — the master toggle owns that (so an in-flight scan can't revert it) — and
   * re-reads store state after each await so edits made mid-scan aren't stomped. */
  const scanning = useRef(false);
  const autoConfigure = async (opts?: { presetHint?: string }) => {
    if (scanning.current) return; // one scan at a time; re-clicks are no-ops
    scanning.current = true;
    try {
      setBusy("Scanning for local servers…");
      setNote(null);
      const found = await detectLocalProviders();
      setStatuses(found);
      const candidates = opts?.presetHint
        ? found.filter((s) => s.preset === opts.presetHint)
        : found.filter((s) => s.running && (!s.needsKey || keySet));
      const target = candidates.find((s) => s.running) ?? candidates[0];
      if (!target) {
        setNote({
          kind: "warn",
          text: "No local server found. Start Ollama (or LM Studio / vLLM / …) and re-scan — or enter a URL under Advanced.",
        });
        return;
      }
      if (!target.running) {
        // Explicitly chosen but not up: still prefill its URL so the user can fix/start it.
        save({ preset: target.preset, baseUrl: target.baseUrl });
        setNote({
          kind: "warn",
          text: `${target.label} isn't answering at ${target.baseUrl}${target.needsKey && !keySet ? " (it also needs an API key — set one under Advanced)" : ""}. Start it and re-scan.`,
        });
        return;
      }
      setBusy(`Found ${target.label} ${target.detail} — fetching models…`);
      const listed = await listLocalModels(target.baseUrl, target.preset);
      if (typeof listed === "string") {
        save({ preset: target.preset, baseUrl: target.baseUrl });
        setNote({ kind: "warn", text: `${target.label} found, but listing models failed: ${listed}` });
        return;
      }
      setModels(listed);
      const fresh = useStore.getState().opencode;
      const keep = listed.find((m) => m.id === fresh.model);
      const best = keep ?? pickable(listed)[0];
      const next = save({
        preset: target.preset,
        baseUrl: target.baseUrl,
        model: best.id,
        contextLimit: best.context ?? fresh.contextLimit ?? null,
      });
      setNote({
        kind: "ok",
        text: `${target.label} ${target.detail} — ${keep ? "kept" : "picked"} ${best.id}${
          best.context ? ` (${fmtCtx(best.context)})` : ""
        }${best.tools ? ", tool-calling ✓" : ""}. ${
          next.enabled ? "Active for new OpenCode sessions." : "Turn the switch on to use it."
        }`,
      });
    } finally {
      scanning.current = false;
      setBusy(null);
    }
  };

  // On open: refresh persisted state, then configure automatically. An already-configured
  // setup gets a passive re-scan plus a model-list refresh (so the picker is always a
  // populated dropdown), but its saved choice is never stomped.
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    void (async () => {
      await loadSettings();
      const cur = useStore.getState().opencode;
      if (cur.model) {
        const [found, listed] = await Promise.all([
          detectLocalProviders(),
          cur.baseUrl.trim()
            ? listLocalModels(cur.baseUrl, cur.preset || "custom")
            : Promise.resolve<LocalModel[] | string>([]),
        ]);
        setStatuses(found);
        if (typeof listed !== "string") setModels(listed);
      } else {
        await autoConfigure();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMasterToggle = (on: boolean) => {
    // Optimistic: the switch responds instantly and a running scan can never revert it.
    const next = save({ enabled: on });
    if (on && !next.model) void autoConfigure(); // first enable = full auto-setup
  };

  const fetchModels = async () => {
    setBusy("Fetching models…");
    setNote(null);
    const r = await listLocalModels(oc.baseUrl, oc.preset || "custom");
    if (typeof r === "string") {
      setModels([]);
      setNote({ kind: "warn", text: r });
    } else {
      setModels(r);
    }
    setBusy(null);
  };

  const pickModel = (id: string) => {
    const m = models.find((x) => x.id === id);
    setProbe(null); // verdict belongs to the previously tested model
    save({ model: id, ...(m?.context ? { contextLimit: m.context } : {}) });
  };

  /** Live-test that the served model does NATIVE tool calls. Advertised capabilities
   * lie (qwen2.5-coder claims tools but prints the call as text); this catches it
   * before the user wonders why a session "does nothing". */
  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    const r = await probeToolCall(oc.baseUrl, oc.model);
    setProbe(
      typeof r === "string"
        ? { kind: "warn", text: r }
        : { kind: r.native ? "ok" : "warn", text: `${oc.model}: ${r.detail}` },
    );
    setProbing(false);
  };

  const parseLimit = (v: string): number | null => {
    const n = parseInt(v.replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const presetRows = (statuses ?? PRESET_FALLBACK).concat([CUSTOM]);
  const statusOf = (preset: string) => statuses?.find((s) => s.preset === preset);
  const needsKey = statusOf(oc.preset)?.needsKey ?? oc.preset === "openwebui";
  const showKeyRow = needsKey || keySet || oc.preset === "custom" || oc.preset === "vllm";
  const insecureRemote =
    keySet &&
    oc.baseUrl.startsWith("http://") &&
    !/\/\/(localhost|127\.0\.0\.1)[:/]/.test(oc.baseUrl);
  const lowContext = oc.enabled && oc.contextLimit != null && oc.contextLimit < 32768;

  return (
    <div className="trust-panel">
      <label className="telemetry-toggle">
        <input
          type="checkbox"
          checked={oc.enabled}
          onChange={(e) => onMasterToggle(e.target.checked)}
        />
        <span>Use a local model for OpenCode sessions</span>
      </label>

      {(busy || note) && (
        <p className={`trust-note${note?.kind === "warn" ? " trust-warn" : ""}`}>
          {busy ?? note?.text}
        </p>
      )}

      <div className="oc-section">
        <div className="section-label">
          Server
          <button className="oc-detect" onClick={() => void autoConfigure()} disabled={!!busy}>
            {busy ? "Working…" : "Re-scan & auto-set"}
          </button>
        </div>
        <div className="oc-presets">
          {presetRows.map((p) => {
            const st = statusOf(p.preset);
            return (
              <button
                key={p.preset}
                className={`oc-preset${(oc.preset || "") === p.preset ? " on" : ""}`}
                onClick={() =>
                  p.preset === "custom"
                    ? save({ preset: "custom", baseUrl: oc.baseUrl || CUSTOM.baseUrl })
                    : void autoConfigure({ presetHint: p.preset })
                }
                title={`${p.baseUrl}${st?.running ? " — running" : ""}`}
                disabled={!!busy}
              >
                <span className={`oc-dot${st?.running ? " up" : ""}`} />
                {p.label}
                {st?.running && <span className="oc-preset-detail">{st.detail}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="oc-section">
        <div className="section-label">
          Model
          <span className="oc-actions">
            <button
              className="oc-detect"
              onClick={() => void runProbe()}
              disabled={!!busy || probing || !oc.model.trim() || !oc.baseUrl.trim()}
              title="Sends one real request to check the model makes NATIVE tool calls — the thing agents live on. May take a minute if the model has to load."
            >
              {probing ? "Testing…" : "Test tool-calling"}
            </button>
            <button
              className="oc-detect"
              onClick={() => void fetchModels()}
              disabled={!!busy || !oc.baseUrl.trim()}
            >
              Refresh list
            </button>
          </span>
        </div>
        {models.length > 0 ? (
          <select
            className="oc-model-select"
            value={models.some((m) => m.id === oc.model) ? oc.model : ""}
            onChange={(e) => e.target.value && pickModel(e.target.value)}
          >
            {!models.some((m) => m.id === oc.model) && (
              <option value="">{oc.model ? `${oc.model} (not on server)` : "Pick a model…"}</option>
            )}
            {rankModels(models).map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.context ? ` — ${fmtCtx(m.context)}` : ""}
                {m.tools ? " — tools ✓" : ""}
                {m.tools === false ? " — no tools ✗" : ""}
                {m.detail ? ` — ${m.detail}` : ""}
              </option>
            ))}
          </select>
        ) : (
          <p className="trust-note">
            {busy
              ? "Loading model list…"
              : oc.model
                ? `Using ${oc.model}. No list from the server — re-scan, or type an id under Advanced.`
                : "No models yet — re-scan, or type an id under Advanced."}
          </p>
        )}
        {probing && (
          <p className="trust-note">
            Testing {oc.model} with a real tool call — a cold model may need a minute to load…
          </p>
        )}
        {probe && (
          <p className={`trust-note${probe.kind === "warn" ? " trust-warn" : ""}`}>{probe.text}</p>
        )}
        {models.find((m) => m.id === oc.model)?.tools === false && (
          <p className="trust-note trust-warn">
            {oc.model} reports no tool-calling support — an agent can’t work with it. Pick a
            model marked “tools ✓”.
          </p>
        )}
        {lowContext && (
          <p className="trust-note trust-warn">
            {oc.contextLimit} tokens of context is tight for agentic coding — 64k+ recommended.
            Small models also fail at tool calling far more often; “Test tool-calling” checks
            before you burn a session.
          </p>
        )}
      </div>

      <div className="oc-section">
        <button className="oc-advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
          {showAdvanced ? "▾" : "▸"} Advanced
        </button>
        {showAdvanced && (
          <>
            <div className="oc-row">
              <label className="oc-field">
                <span>Base URL</span>
                <input
                  type="text"
                  value={oc.baseUrl}
                  placeholder="http://127.0.0.1:11434/v1"
                  onChange={(e) => save({ baseUrl: e.target.value })}
                  spellCheck={false}
                />
              </label>
              <label className="oc-field">
                <span>Model id</span>
                <input
                  type="text"
                  value={oc.model}
                  placeholder="auto-set by scan"
                  onChange={(e) => save({ model: e.target.value })}
                  spellCheck={false}
                />
              </label>
            </div>
            <div className="oc-row">
              <label className="oc-field oc-num">
                <span>Context tokens</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={oc.contextLimit ?? ""}
                  placeholder="auto"
                  onChange={(e) => save({ contextLimit: parseLimit(e.target.value) })}
                />
              </label>
              <label
                className="oc-field oc-num"
                title="OpenCode requires context and output limits together, so this only applies when Context tokens is set (defaults to 8192 then)."
              >
                <span>Max output{oc.contextLimit == null ? " (needs context)" : ""}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={oc.outputLimit ?? ""}
                  placeholder="8192"
                  onChange={(e) => save({ outputLimit: parseLimit(e.target.value) })}
                />
              </label>
            </div>
            {showKeyRow && (
              <div className="oc-row">
                <label className="oc-field">
                  <span>API key {needsKey ? "(required by this server)" : "(optional)"}</span>
                  <input
                    type="password"
                    value={keyInput}
                    placeholder={keySet ? "•••••• held for this run" : "none"}
                    onChange={(e) => setKeyInput(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <button
                  disabled={!keyInput.trim()}
                  onClick={() => {
                    void setOpenCodeKey(keyInput);
                    setKeyInput("");
                  }}
                >
                  Set
                </button>
                {keySet && <button onClick={() => void setOpenCodeKey("")}>Clear</button>}
              </div>
            )}
            <label className="telemetry-toggle">
              <input
                type="checkbox"
                checked={oc.pinLocal}
                onChange={(e) => save({ pinLocal: e.target.checked })}
              />
              <span>Local only — block every other provider</span>
            </label>
            <p className="trust-note">
              Applied to new OpenCode sessions via an env-only config that outranks (but never
              edits) your <code>opencode.json</code>; the key lives in memory until Conduit
              quits. “Local only” allowlists this endpoint so OpenCode can’t fall back to a
              cloud provider{privateMode ? " (sensitive sessions are pinned automatically)" : ""}.
            </p>
            {insecureRemote && (
              <p className="trust-note trust-warn">
                Plain <code>http://</code> to a non-local host — the API key would travel
                unencrypted. Prefer <code>https://</code> for remote GPUs.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
