import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";

/**
 * Settings → Command Code: edit `~/.commandcode/config.json` without opening a session.
 *
 * Command Code's own editing surface is the `/config` slash command, which means you have
 * to already be inside a session to change what the next session starts as. This panel is
 * the way out of that loop.
 *
 * Two deliberate limits:
 *
 * - It edits `config.json` (personal preferences) and never `settings.json`, which is the
 *   project file a team commits and whose `hooks` key Conduit's hook installer owns.
 * - It writes only the keys it shows. The Rust side enforces that with an allowlist rather
 *   than trusting this component, and preserves every key it does not recognize.
 */

/** Command Code's own internal tasks, and what each one is for.
 *
 *  This is `featureModels` — Command Code routing ITS OWN work (naming a session, compacting
 *  a conversation) to cheap models so that spend goes to the work you actually asked for.
 *  It sits one level BELOW Conduit's routing preferences, which choose the agent and the
 *  top-level model for a session. The two must not be confused: nothing here decides which
 *  model answers you. */
const FEATURES: Array<{ key: string; label: string; hint: string }> = [
  {
    key: "titleGeneration",
    label: "Session titles",
    hint: "Names a conversation from its first message.",
  },
  {
    key: "compaction",
    label: "Compaction",
    hint: "Summarizes history when the context window fills.",
  },
  {
    key: "toolDescription",
    label: "Tool descriptions",
    hint: "Writes the one-line summary shown for a tool call.",
  },
  {
    key: "branchSummarization",
    label: "Branch summaries",
    hint: "Summarizes a branch of the session tree.",
  },
  {
    key: "tasteOnboarding",
    label: "Taste onboarding",
    hint: "Learns your code style on first run.",
  },
  { key: "vision", label: "Vision", hint: "Reads images and screenshots." },
];

/** Reasoning effort. Command Code documents the set as model-dependent, so "Default" leaves
 *  the key unset rather than guessing a value the chosen model may not accept. */
const EFFORTS = ["low", "medium", "high"];

interface CcModel {
  id: string;
  description: string;
  category: string;
}
interface CcConfig {
  path: string;
  exists: boolean;
  values: Record<string, unknown>;
}

/** A model `<select>`, grouped by vendor. Shared by the main model and every feature model
 *  so they can never drift apart in what they offer. */
function ModelSelect({
  value,
  groups,
  disabled,
  defaultLabel,
  onPick,
}: {
  value: string;
  groups: Array<[string, CcModel[]]>;
  disabled: boolean;
  defaultLabel: string;
  onPick: (id: string | null) => void;
}) {
  return (
    <select
      className="cc-select"
      disabled={disabled}
      value={value}
      onChange={(e) => onPick(e.target.value || null)}
    >
      {/* Empty = the key is absent, so Command Code picks its own. Conduit deliberately
          does not name that default: it changes with releases, and a stale label here
          would be a confident lie. */}
      <option value="">{defaultLabel}</option>
      {groups.map(([cat, ms]) => (
        <optgroup key={cat} label={cat}>
          {ms.map((m) => (
            <option key={m.id} value={m.id} title={m.description}>
              {m.id}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export function CommandCodePanel() {
  const accounts = useStore((s) => s.accounts);
  // Which account's config to edit. Command Code accounts are `.commandcode` profile roots;
  // with none registered there is just the ambient one.
  const ccAccounts = useMemo(
    () => accounts.filter((a) => a.agents.includes("commandcode")),
    [accounts],
  );
  const [accountDir, setAccountDir] = useState<string | null>(null);
  const [cfg, setCfg] = useState<CcConfig | null>(null);
  const [models, setModels] = useState<CcModel[]>([]);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setErr(null);
    void invoke<CcConfig>("command_code_config", { accountConfigDir: accountDir })
      .then(setCfg)
      .catch((e) => setErr(String(e)));
  }, [accountDir]);

  useEffect(() => {
    // The model list comes from the CLI itself, so it is always the set THIS install can
    // actually run — a hardcoded list would rot the first time the vendor ships a model,
    // and they ship often (58 models at v1.32.1).
    void invoke<CcModel[]>("command_code_models")
      .then((m) => {
        setModels(m);
        setModelsErr(m.length === 0 ? "Command Code returned no models." : null);
      })
      .catch((e) => setModelsErr(String(e)));
  }, []);

  const values = (cfg?.values ?? {}) as Record<string, unknown>;
  const featureModels = (values.featureModels ?? {}) as Record<string, string>;

  const patch = (p: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    void invoke<CcConfig>("set_command_code_config", {
      accountConfigDir: accountDir,
      patch: p,
    })
      .then(setCfg)
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  };

  const groups = useMemo(() => {
    const out = new Map<string, CcModel[]>();
    for (const m of models) {
      const arr = out.get(m.category) ?? [];
      arr.push(m);
      out.set(m.category, arr);
    }
    return [...out.entries()];
  }, [models]);

  return (
    <div className="cc-panel">
      <p className="settings-intro">
        Personal preferences for the Command Code CLI, read from and written to its own{" "}
        <code>config.json</code>. Keys Conduit doesn’t show are left untouched, and the file
        is backed up once before the first change.
      </p>

      {ccAccounts.length > 0 && (
        <label className="cc-field">
          <span>Account</span>
          <select
            className="cc-select"
            value={accountDir ?? ""}
            onChange={(e) => setAccountDir(e.target.value || null)}
          >
            <option value="">Default (~/.commandcode)</option>
            {ccAccounts.map((a) => (
              <option key={a.id} value={a.configDir}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {err && <div className="cc-note cc-warn">{err}</div>}

      {cfg && !cfg.exists && (
        <div className="cc-note">
          No config file yet — Command Code writes one on first run. Changing anything here
          creates it at <code>{cfg.path}</code>.
        </div>
      )}

      <div className="cc-section">
        <span className="section-label">Session defaults</span>

        <label className="cc-field">
          <span>Model</span>
          <ModelSelect
            value={(values.model as string) ?? ""}
            groups={groups}
            disabled={busy}
            defaultLabel="Command Code’s default"
            onPick={(id) => patch({ model: id })}
          />
        </label>

        {modelsErr && (
          <div className="cc-note cc-warn">
            {modelsErr} The model lists are empty, but everything else here still works —
            this usually means Command Code isn’t installed, or isn’t on this app’s PATH.
          </div>
        )}

        <label className="cc-field">
          <span>Reasoning effort</span>
          <select
            className="cc-select"
            disabled={busy}
            value={(values.reasoningEffort as string) ?? ""}
            onChange={(e) => patch({ reasoningEffort: e.target.value || null })}
          >
            <option value="">Default</option>
            {EFFORTS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>

        <label className="cc-toggle">
          <input
            type="checkbox"
            disabled={busy}
            checked={values.tasteLearning === true}
            onChange={(e) => patch({ tasteLearning: e.target.checked ? true : null })}
          />
          <span>
            Taste learning — let Command Code learn this codebase’s conventions from your
            sessions and apply them to later work.
          </span>
        </label>
      </div>

      <div className="cc-section">
        <span className="section-label">Built-in task models</span>
        <p className="cc-note">
          Which model runs Command Code’s <em>own</em> housekeeping. These never answer you —
          they name sessions, compact history, and describe tool calls — so a cheap model
          here keeps your quota for the work you actually asked for. This is Command Code
          routing itself, one level below Conduit’s own agent routing.
        </p>
        {FEATURES.map((f) => (
          <label className="cc-field" key={f.key}>
            <span title={f.hint}>{f.label}</span>
            <ModelSelect
              value={featureModels[f.key] ?? ""}
              groups={groups}
              disabled={busy || models.length === 0}
              defaultLabel="Default"
              onPick={(id) => patch({ featureModels: { [f.key]: id } })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
