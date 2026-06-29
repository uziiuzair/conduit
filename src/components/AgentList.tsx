import { useStore } from "../store";
import { AGENTS, type AgentId } from "../agents";
import { AgentGlyph } from "./AgentGlyph";

/** Detection rows: glyph · name · binary/path · status · "default" radio.
 *  `allowNoDefault` adds a "Choose per session" option (used in onboarding). */
export function AgentList({ allowNoDefault = false }: { allowNoDefault?: boolean }) {
  const detected = useStore((s) => s.agents);
  const loadAgents = useStore((s) => s.loadAgents);
  const defaultAgent = useStore((s) => s.defaultAgent);
  const setDefaultAgent = useStore((s) => s.setDefaultAgent);
  const info = (id: AgentId) => detected?.find((d) => d.id === id);
  const ready = (id: AgentId) => !detected || info(id)?.found === true;

  return (
    <div className="agent-list">
      {AGENTS.map((a) => {
        const d = info(a.id);
        const ok = ready(a.id);
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
                {d?.found ? `${d.binary} · ${d.path ?? "on PATH"}` : `${a.id} · not found on PATH`}
              </div>
            </div>
            {ok ? (
              defaultAgent === a.id ? <span className="agent-tag">default</span> : <span className="agent-stat ok">ready</span>
            ) : (
              <span className="agent-stat no">not installed</span>
            )}
          </div>
        );
      })}
      <button className="agent-rescan" onClick={() => void loadAgents()}>Re-scan PATH</button>
      {allowNoDefault && <div className="agent-list-note">You can also pick an agent per session in the New Session dialog.</div>}
    </div>
  );
}
