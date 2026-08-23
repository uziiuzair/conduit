import { useEffect, useMemo, useState } from "react";
import { isGitRepo, useStore, type SessionRole } from "../store";
import { AGENTS, agentMeta, type AgentId } from "../agents";
import { AgentGlyph } from "./AgentGlyph";
import { pickTarget, type TaskKind } from "../routing";
import { agyRow, availabilityFrom, claudeRow, commandCodeRow } from "../usageRows";

export function NewSessionDialog({
  projectId,
  projectPath,
  hasConductor,
  onCancel,
  onCreate,
}: {
  projectId: string;
  projectPath: string;
  hasConductor: boolean;
  onCancel: () => void;
  onCreate: (opts: {
    name?: string;
    useWorktree: boolean;
    agent: AgentId;
    role: SessionRole;
    account?: string | null;
    model?: string | null;
  }) => void;
}) {
  const defaultAgent = useStore((s) => s.defaultAgent);
  const accounts = useStore((s) => s.accounts);
  const routes = useStore((s) => s.routes);
  const taskKinds = useStore((s) => s.taskKinds);
  const loadRouting = useStore((s) => s.loadRouting);
  const claudeUsage = useStore((s) => s.claudeUsage);
  const agyMap = useStore((s) => s.agyUsageByAccount);
  const commandCodeUsage = useStore((s) => s.commandCodeUsage);
  const lowThresholdPct = useStore((s) => s.usagePrefs.lowThresholdPct);
  /** "" = pick the agent by hand, which is what this dialog did before routing existed. */
  const [task, setTask] = useState<TaskKind | "">("");
  /** The model a route pinned, carried separately from `agent` so that overriding the
   *  agent by hand drops the model too rather than sending it to a CLI that never
   *  offered it. */
  const [routedModel, setRoutedModel] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  const [gitOk, setGitOk] = useState(false);
  const [agent, setAgent] = useState<AgentId>(defaultAgent);
  const [account, setAccount] = useState<string>("");
  // A Conductor is a Claude session in the project root that orchestrates the fleet.
  const [conductor, setConductor] = useState(false);
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
    if (!ready.has(defaultAgent)) {
      const first = detected.find((a) => a.found);
      if (first) setAgent(first.id);
    }
  }, [detected, defaultAgent]);

  useEffect(() => {
    void loadRouting(projectId);
  }, [projectId, loadRouting]);

  // The same account-health numbers the usage bar draws, collapsed per agent — so a route
  // can never decide an agent is too low while its meter still reads green.
  const availability = useMemo(
    () =>
      availabilityFrom(detected, [
        ...claudeUsage.map(claudeRow),
        ...Object.values(agyMap).map(agyRow),
        ...commandCodeUsage.filter((u) => u.usage.windows?.length).map(commandCodeRow),
      ]),
    [detected, claudeUsage, agyMap, commandCodeUsage],
  );

  const decision = useMemo(
    () =>
      task && routes
        ? pickTarget(routes.effective[task], availability, Math.max(0, Math.min(1, lowThresholdPct / 100)))
        : null,
    [task, routes, availability, lowThresholdPct],
  );

  // Applying the decision is an effect, not render-time state, because the user must stay
  // able to override the agent afterwards — a render-time override would fight them.
  useEffect(() => {
    if (!decision?.target) return;
    setAgent(decision.target.agent);
    setRoutedModel(decision.target.model ?? null);
  }, [decision]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const isReady = (id: AgentId) => !detected || detected.find((a) => a.id === id)?.found === true;
  const anyReady = !detected || detected.some((a) => a.found);
  // The Conductor never isolates in a worktree (it runs in the project root).
  const worktreeAllowed = gitOk && agentMeta(agent).supportsWorktree && !conductor;
  // Account picker: the effective agent is Claude when the Conductor box is ticked. Only
  // accounts tagged for that agent are eligible; blank = inherit the project/global default.
  const effectiveAgent: AgentId = conductor ? "claude" : agent;
  const eligibleAccounts = accounts.filter((a) => a.agents.includes(effectiveAgent));
  // Drop a stale pick when switching to an agent that account isn't tagged for.
  useEffect(() => {
    if (account && !eligibleAccounts.some((a) => a.id === account)) setAccount("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveAgent]);
  const submit = () => {
    const acct = account || null;
    if (conductor) {
      onCreate({ name: name.trim() || undefined, useWorktree: false, agent: "claude", role: "conductor", account: acct });
      return;
    }
    if (!isReady(agent)) return;
    onCreate({
      name: name.trim() || undefined,
      useWorktree: useWorktree && worktreeAllowed,
      agent,
      role: "worker",
      account: acct,
      // Only send a model the route actually picked FOR this agent. Picking a different
      // agent by hand clears it (below), so a Claude model can never reach Codex.
      model: routedModel,
    });
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">New session</div>

        <label
          className={`dialog-toggle ${hasConductor ? "disabled" : ""}`}
          title={
            hasConductor
              ? "This project already has a Conductor"
              : "A Claude session that observes and orchestrates this project's sessions"
          }
        >
          <input
            type="checkbox"
            checked={conductor}
            disabled={hasConductor}
            onChange={(e) => {
              const on = e.target.checked;
              setConductor(on);
              if (on) setAgent("claude");
            }}
          />
          <span>Conductor (orchestrates this project)</span>
        </label>

        {taskKinds.length > 0 && !conductor && (
          <>
            <div className="dialog-label">What is this session for?</div>
            <select
              className="dialog-input"
              value={task}
              onChange={(e) => {
                const next = e.target.value as TaskKind | "";
                setTask(next);
                if (!next) setRoutedModel(null);
              }}
            >
              <option value="">Let me choose the agent</option>
              {taskKinds.map((t) => (
                <option key={t.id} value={t.id} title={t.hint}>
                  {t.label}
                </option>
              ))}
            </select>
            {decision && (
              // Always shown, never only on a fallback: a router that explains itself only
              // when it deviates teaches you to distrust it the rest of the time.
              <div
                className={`route-note${decision.exhausted ? " warn" : ""}`}
                role="status"
              >
                {decision.reason}
              </div>
            )}
          </>
        )}

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
                className={`agent-tile ${agent === a.id ? "sel" : ""} ${ready && !conductor ? "" : "disabled"}`}
                disabled={!ready || conductor}
                onClick={() => {
                  if (!ready || conductor) return;
                  setAgent(a.id);
                  // A hand-picked agent overrides the route. Drop the routed model with
                  // it: it named a model for a DIFFERENT CLI, and passing it on would
                  // either be rejected or, worse, silently mean something else.
                  if (a.id !== decision?.target?.agent) setRoutedModel(null);
                }}
              >
                <AgentGlyph id={a.id} size={20} />
                <span className="nm">{a.label}</span>
                {a.id === defaultAgent && <span className="df">default</span>}
                {!ready && <span className="off">not installed</span>}
              </button>
            );
          })}
        </div>

        {eligibleAccounts.length > 0 && (
          <>
            <div className="dialog-label">Account</div>
            <select
              className="dialog-input"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">Default account for {agentMeta(effectiveAgent).label}</option>
              {eligibleAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </>
        )}

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
          <button
            className="primary"
            onClick={submit}
            disabled={conductor ? !isReady("claude") : !isReady(agent)}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
