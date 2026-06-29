import { useEffect, useState } from "react";
import { isGitRepo, useStore } from "../store";
import { AGENTS, DEFAULT_AGENT, agentMeta, type AgentId } from "../agents";
import { AgentGlyph } from "./AgentGlyph";

export function NewSessionDialog({
  projectPath,
  onCancel,
  onCreate,
}: {
  projectPath: string;
  onCancel: () => void;
  onCreate: (opts: { name?: string; useWorktree: boolean; agent: AgentId }) => void;
}) {
  const [name, setName] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  const [gitOk, setGitOk] = useState(false);
  const [agent, setAgent] = useState<AgentId>(DEFAULT_AGENT);
  // Detection is loaded once at startup (store.loadAgents) and cached, so opening
  // this dialog is instant — no per-open login-shell PATH scan.
  const detected = useStore((s) => s.agents);

  useEffect(() => {
    let alive = true;
    void isGitRepo(projectPath).then((ok) => alive && setGitOk(ok));
    return () => {
      alive = false;
    };
  }, [projectPath]);

  // Pre-select the default if it's installed, else the first installed agent.
  useEffect(() => {
    if (!detected) return;
    const ready = new Set(detected.filter((a) => a.found).map((a) => a.id));
    if (!ready.has(DEFAULT_AGENT)) {
      const first = detected.find((a) => a.found);
      if (first) setAgent(first.id);
    }
  }, [detected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const isReady = (id: AgentId) => !detected || detected.find((a) => a.id === id)?.found === true;
  const anyReady = !detected || detected.some((a) => a.found);
  const worktreeAllowed = gitOk && agentMeta(agent).supportsWorktree;
  const submit = () => {
    if (!isReady(agent)) return;
    onCreate({ name: name.trim() || undefined, useWorktree: useWorktree && worktreeAllowed, agent });
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">New session</div>

        <div className="dialog-label">Agent</div>
        <div className="agent-tiles" role="radiogroup" aria-label="Agent">
          {AGENTS.map((a) => {
            const ready = isReady(a.id);
            return (
              <button
                key={a.id}
                role="radio"
                aria-checked={agent === a.id}
                aria-label={`${a.label}${ready ? "" : " (not installed)"}`}
                className={`agent-tile ${agent === a.id ? "sel" : ""} ${ready ? "" : "disabled"}`}
                disabled={!ready}
                onClick={() => ready && setAgent(a.id)}
              >
                <AgentGlyph id={a.id} size={20} />
                <span className="nm">{a.label}</span>
                {a.id === DEFAULT_AGENT && <span className="df">default</span>}
                {!ready && <span className="off">not installed</span>}
              </button>
            );
          })}
        </div>

        <input
          className="dialog-input"
          placeholder="Name (optional)"
          autoFocus
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        <label
          className={`dialog-toggle ${worktreeAllowed ? "" : "disabled"}`}
          title={
            !gitOk
              ? "Not a git repository"
              : agentMeta(agent).supportsWorktree
                ? ""
                : `Worktrees aren't supported for ${agentMeta(agent).label} yet`
          }
        >
          <input
            type="checkbox"
            checked={useWorktree && worktreeAllowed}
            disabled={!worktreeAllowed}
            onChange={(e) => setUseWorktree(e.target.checked)}
          />
          <span>Isolate in a git worktree</span>
        </label>

        {!anyReady && (
          <div className="dialog-note">No agents installed — install one to start.</div>
        )}

        <div className="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!isReady(agent)}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
