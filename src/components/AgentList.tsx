import { useState } from "react";
import { useStore } from "../store";
import { AGENTS, type AgentId } from "../agents";
import { AgentGlyph } from "./AgentGlyph";

/** Detection rows: glyph · name · binary/path · status · "default" radio.
 *  A not-found agent with a known installer gets a one-click "Install" button.
 *  `allowNoDefault` adds a "Choose per session" hint (used in onboarding). */
export function AgentList({ allowNoDefault = false }: { allowNoDefault?: boolean }) {
  const detected = useStore((s) => s.agents);
  const loadAgents = useStore((s) => s.loadAgents);
  const installAgent = useStore((s) => s.installAgent);
  const defaultAgent = useStore((s) => s.defaultAgent);
  const setDefaultAgent = useStore((s) => s.setDefaultAgent);
  const agyTracking = useStore((s) => s.agyUsageTracking);
  const setAgyTracking = useStore((s) => s.setAgyUsageTracking);
  const info = (id: AgentId) => detected?.find((d) => d.id === id);
  const ready = (id: AgentId) => !detected || info(id)?.found === true;

  // Per-agent transient install state (not persisted).
  const [installing, setInstalling] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [agyTrackErr, setAgyTrackErr] = useState<string | null>(null);

  const toggleAgyTracking = async (on: boolean) => {
    setAgyTrackErr(null);
    const ok = await setAgyTracking(on);
    if (!ok && on) {
      setAgyTrackErr(
        "agy already has a custom status line — remove it to let Conduit track usage.",
      );
    }
  };

  const doInstall = async (id: AgentId) => {
    setInstalling((m) => ({ ...m, [id]: true }));
    setErrors((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
    const err = await installAgent(id);
    setInstalling((m) => ({ ...m, [id]: false }));
    if (err) setErrors((m) => ({ ...m, [id]: err }));
    else setInstalled((m) => ({ ...m, [id]: true }));
  };

  return (
    <div className="agent-list">
      {AGENTS.map((a) => {
        const d = info(a.id);
        const ok = ready(a.id);
        const busy = !!installing[a.id];
        const err = errors[a.id];
        return (
          <div key={a.id} className={`agent-list-row ${ok ? "" : "off"} ${defaultAgent === a.id ? "def" : ""}`}>
            <button
              className="agent-radio"
              role="radio"
              aria-checked={defaultAgent === a.id}
              aria-label={`Set ${a.label} as default`}
              disabled={!ok}
              onClick={() => ok && setDefaultAgent(a.id)}
            />
            <AgentGlyph id={a.id} size={20} />
            <div className="agent-list-main">
              <div className="agent-list-name">{a.label}</div>
              <div className="agent-list-meta">
                {d?.found
                  ? `${d.binary} · ${d.path ?? "on PATH"}`
                  : `${a.id} · not found on PATH`}
              </div>
              {err && <div className="agent-install-err">Install failed: {err}</div>}
              {installed[a.id] && ok && (
                <div className="agent-install-note">Installed — open a session to sign in.</div>
              )}
              {a.id === "antigravity" && ok && (
                <label className="agy-track-toggle" title="Installs a status-line hook in agy's settings.json so Conduit can show your Antigravity quota. Uses agy's own extension surface — no third-party API access.">
                  <input
                    type="checkbox"
                    checked={agyTracking}
                    onChange={(e) => void toggleAgyTracking(e.target.checked)}
                  />
                  <span>Show usage in Conduit</span>
                </label>
              )}
              {a.id === "antigravity" && agyTrackErr && (
                <div className="agent-install-err">{agyTrackErr}</div>
              )}
            </div>
            {ok ? (
              defaultAgent === a.id ? (
                <span className="agent-tag">default</span>
              ) : (
                <span className="agent-stat ok">ready</span>
              )
            ) : d?.installCommand ? (
              <button
                className="agent-install-btn"
                disabled={busy}
                title={`Runs: ${d.installCommand}`}
                onClick={() => void doInstall(a.id)}
              >
                {busy ? "Installing…" : "Install"}
              </button>
            ) : (
              <span className="agent-stat no">not installed</span>
            )}
          </div>
        );
      })}
      <button className="agent-rescan" onClick={() => void loadAgents()}>
        Re-scan PATH
      </button>
      {allowNoDefault && (
        <div className="agent-list-note">
          You can also pick an agent per session in the New Session dialog.
        </div>
      )}
    </div>
  );
}
