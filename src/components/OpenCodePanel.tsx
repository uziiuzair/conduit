import { useEffect, useState } from "react";
import {
  useStore,
  type LocalModel,
  type LocalProviderStatus,
  type OpenCodeSettings,
} from "../store";

/**
 * Feature 3 — route OpenCode sessions to a local GPU / self-hosted endpoint (Ollama,
 * LM Studio, vLLM, llama.cpp, OpenWebUI, or a custom OpenAI-compatible URL). Conduit
 * injects the provider + model into each OpenCode session at spawn (env-only inline
 * config that outranks the user's opencode.json files); nothing is written to disk and
 * the API key never leaves backend memory.
 */
export function OpenCodePanel() {
  const oc = useStore((s) => s.opencode);
  const keySet = useStore((s) => s.opencodeKeySet);
  const privateMode = useStore((s) => s.privateMode);
  const loadSettings = useStore((s) => s.loadOpenCodeSettings);
  const setSettings = useStore((s) => s.setOpenCodeSettings);
  const setOpenCodeKey = useStore((s) => s.setOpenCodeKey);
  const detectLocalProviders = useStore((s) => s.detectLocalProviders);
  const listLocalModels = useStore((s) => s.listLocalModels);

  const [statuses, setStatuses] = useState<LocalProviderStatus[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [keyInput, setKeyInput] = useState("");

  const save = (patch: Partial<OpenCodeSettings>) => void setSettings({ ...oc, ...patch });

  const runDetect = async () => {
    setDetecting(true);
    setStatuses(await detectLocalProviders());
    setDetecting(false);
  };

  // Refresh persisted settings + key state, and probe for running servers, on open.
  useEffect(() => {
    void loadSettings();
    void runDetect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickPreset = (preset: string, baseUrl: string) => {
    // Re-prefill the URL when switching preset; keep a hand-edited URL for the same one.
    save({ preset, baseUrl: oc.preset === preset && oc.baseUrl ? oc.baseUrl : baseUrl });
    setModels([]);
    setModelsError(null);
  };

  const fetchModels = async () => {
    setFetchingModels(true);
    setModelsError(null);
    const r = await listLocalModels(oc.baseUrl, oc.preset || "custom");
    if (typeof r === "string") {
      setModels([]);
      setModelsError(r);
    } else {
      setModels(r);
    }
    setFetchingModels(false);
  };

  const pickModel = (id: string) => {
    const m = models.find((x) => x.id === id);
    // Autofill the context limit from what the server reports (editable afterwards).
    save({ model: id, ...(m?.context ? { contextLimit: m.context } : {}) });
  };

  const parseLimit = (v: string): number | null => {
    const n = parseInt(v.replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const custom = { preset: "custom", label: "Custom", baseUrl: "http://localhost:8000/v1" };
  const presetRows: Array<Pick<LocalProviderStatus, "preset" | "label" | "baseUrl">> =
    statuses ?? [
      { preset: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1" },
      { preset: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1" },
      { preset: "vllm", label: "vLLM", baseUrl: "http://localhost:8000/v1" },
      { preset: "llamacpp", label: "llama.cpp", baseUrl: "http://localhost:8080/v1" },
      { preset: "openwebui", label: "OpenWebUI", baseUrl: "http://localhost:3000/api" },
    ];
  const statusOf = (preset: string) => statuses?.find((s) => s.preset === preset);
  const needsKey = statusOf(oc.preset)?.needsKey ?? oc.preset === "openwebui";
  const insecureRemote =
    keySet && oc.baseUrl.startsWith("http://") && !/\/\/(localhost|127\.0\.0\.1)[:/]/.test(oc.baseUrl);

  return (
    <div className="trust-panel">
      <label className="telemetry-toggle">
        <input
          type="checkbox"
          checked={oc.enabled}
          onChange={(e) => save({ enabled: e.target.checked, preset: oc.preset || "ollama" })}
        />
        <span>Run OpenCode sessions on a local / self-hosted model</span>
      </label>
      <p className="trust-note">
        Point OpenCode at your own GPU — Ollama, LM Studio, vLLM, llama.cpp, OpenWebUI, or any
        OpenAI-compatible endpoint. Applied to <strong>new</strong> OpenCode sessions at launch;
        your <code>opencode.json</code> files are never modified. Off = OpenCode runs untouched.
      </p>

      <div className="oc-section">
        <div className="section-label">
          Server
          <button className="oc-detect" onClick={() => void runDetect()} disabled={detecting}>
            {detecting ? "Scanning…" : "Re-scan"}
          </button>
        </div>
        <div className="oc-presets">
          {presetRows.concat([custom]).map((p) => {
            const st = statusOf(p.preset);
            return (
              <button
                key={p.preset}
                className={`oc-preset${(oc.preset || "") === p.preset ? " on" : ""}`}
                onClick={() => pickPreset(p.preset, p.baseUrl)}
                title={p.baseUrl}
              >
                <span className={`oc-dot${st?.running ? " up" : ""}`} />
                {p.label}
                {st?.running && <span className="oc-preset-detail">{st.detail}</span>}
              </button>
            );
          })}
        </div>
        <div className="oc-row">
          <label className="oc-field">
            <span>Base URL</span>
            <input
              type="text"
              value={oc.baseUrl}
              placeholder="http://localhost:11434/v1"
              onChange={(e) => save({ baseUrl: e.target.value })}
              spellCheck={false}
            />
          </label>
        </div>
        <div className="oc-row">
          <label className="oc-field">
            <span>API key {needsKey ? "(required by this server)" : "(optional)"}</span>
            <input
              type="password"
              value={keyInput}
              placeholder={keySet ? "•••••• key held for this run" : "none"}
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
            Set key
          </button>
          {keySet && (
            <button onClick={() => void setOpenCodeKey("")}>Clear</button>
          )}
        </div>
        <p className="trust-note">
          The key is held in memory until Conduit quits and is passed to OpenCode only through
          its process environment — never written to disk, settings, or logs.
        </p>
        {insecureRemote && (
          <p className="trust-note trust-warn">
            This endpoint is plain <code>http://</code> on a non-local host — the API key would
            travel unencrypted. Prefer <code>https://</code> for remote GPUs.
          </p>
        )}
      </div>

      <div className="oc-section">
        <div className="section-label">
          Model
          <button
            className="oc-detect"
            onClick={() => void fetchModels()}
            disabled={fetchingModels || !oc.baseUrl.trim()}
          >
            {fetchingModels ? "Fetching…" : "Fetch models"}
          </button>
        </div>
        {models.length > 0 && (
          <div className="oc-row">
            <select
              className="oc-model-select"
              value={models.some((m) => m.id === oc.model) ? oc.model : ""}
              onChange={(e) => e.target.value && pickModel(e.target.value)}
            >
              <option value="">Pick a model…</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.context ? ` — ${Math.round(m.context / 1024)}k ctx` : ""}
                  {m.detail ? ` — ${m.detail}` : ""}
                </option>
              ))}
            </select>
          </div>
        )}
        {modelsError && <p className="trust-note trust-warn">{modelsError}</p>}
        <div className="oc-row">
          <label className="oc-field">
            <span>Model id</span>
            <input
              type="text"
              value={oc.model}
              placeholder="qwen3:30b-a3b"
              onChange={(e) => save({ model: e.target.value })}
              spellCheck={false}
            />
          </label>
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
          <label className="oc-field oc-num">
            <span>Max output</span>
            <input
              type="text"
              inputMode="numeric"
              value={oc.outputLimit ?? ""}
              placeholder="auto"
              onChange={(e) => save({ outputLimit: parseLimit(e.target.value) })}
            />
          </label>
        </div>
        <p className="trust-note">
          Agentic coding wants a large context window — 64k+ is recommended; small contexts make
          OpenCode forget its task. Context autofills when the server reports it (Ollama does).
        </p>
      </div>

      <div className="oc-section">
        <label className="telemetry-toggle">
          <input
            type="checkbox"
            checked={oc.pinLocal}
            onChange={(e) => save({ pinLocal: e.target.checked })}
          />
          <span>Local only — block every other provider</span>
        </label>
        <p className="trust-note">
          Pins OpenCode to this endpoint (<code>enabled_providers</code> allowlist), so it cannot
          fall back to a cloud provider even if cloud credentials exist on this machine.
          {privateMode && (
            <>
              {" "}Sessions marked <strong>sensitive</strong> under private mode are pinned
              automatically, regardless of this switch.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
