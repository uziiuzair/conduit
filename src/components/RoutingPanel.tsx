import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { AGENTS, agentMeta, type AgentId } from "../agents";
import { AgentGlyph } from "./AgentGlyph";
import type { Chain, RouteTarget, TaskKind } from "../routing";

/**
 * Settings → Routing: which agent and model takes which kind of work.
 *
 * Each task kind owns an ORDERED chain. The order is the fallback: session creation walks
 * it and takes the first target that is installed and not out of quota, so one list answers
 * "what do I prefer", "what if it isn't installed", and "what if I've hit my limit".
 *
 * Two scopes. Global applies everywhere; a project overlays it. Overrides are per task
 * kind and sparse, so pinning `review` for one project leaves the other four inheriting —
 * including later improvements to the built-in defaults. The header for each kind says
 * which of the three it is currently getting, because a settings page that cannot tell you
 * where a value came from cannot offer a meaningful Reset.
 */

interface CcModel {
  id: string;
  description: string;
  category: string;
}

/** Models to offer for an agent: static for Claude, fetched for Command Code, none for the
 *  agents whose CLI takes no `--model` at all. */
function modelsFor(agent: AgentId, ccModels: CcModel[]): string[] {
  if (agent === "commandcode") return ccModels.map((m) => m.id);
  return agentMeta(agent).models ?? [];
}

function TargetRow({
  target,
  index,
  count,
  ccModels,
  onChange,
  onMove,
  onRemove,
}: {
  target: RouteTarget;
  index: number;
  count: number;
  ccModels: CcModel[];
  onChange: (t: RouteTarget) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const meta = agentMeta(target.agent);
  const models = modelsFor(target.agent, ccModels);
  return (
    <div className="route-target">
      <span className="route-rank">{index === 0 ? "1st" : index === 1 ? "2nd" : `${index + 1}th`}</span>
      <AgentGlyph id={target.agent} size={14} />
      <select
        className="route-select"
        value={target.agent}
        onChange={(e) => {
          const agent = e.target.value as AgentId;
          // Drop the model when the agent changes: model ids are per-CLI, and carrying
          // "sonnet" onto Codex would either fail the spawn or mean something else.
          onChange({ agent });
        }}
      >
        {AGENTS.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>

      {meta.supportsModelFlags ? (
        <select
          className="route-select"
          value={target.model ?? ""}
          onChange={(e) => onChange({ agent: target.agent, model: e.target.value || undefined })}
        >
          {/* Absent means "leave the agent's own configured model alone", which is the
              right answer for an agent whose model choice lives in its own settings. */}
          <option value="">Agent’s own model</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      ) : (
        <span className="route-nomodel" title={`${meta.label} has no per-run --model flag`}>
          agent’s own model
        </span>
      )}

      <button
        className="route-btn"
        disabled={index === 0}
        onClick={() => onMove(-1)}
        aria-label="Move up"
        title="Move up"
      >
        ↑
      </button>
      <button
        className="route-btn"
        disabled={index === count - 1}
        onClick={() => onMove(1)}
        aria-label="Move down"
        title="Move down"
      >
        ↓
      </button>
      <button className="route-btn" onClick={onRemove} aria-label="Remove" title="Remove">
        ×
      </button>
    </div>
  );
}

export function RoutingPanel() {
  const routes = useStore((s) => s.routes);
  const taskKinds = useStore((s) => s.taskKinds);
  const loadRouting = useStore((s) => s.loadRouting);
  const setAgentRoute = useStore((s) => s.setAgentRoute);
  const projects = useStore((s) => s.projects);
  const selectedProjectId = useStore((s) => s.selectedProjectId);

  /** null = the global scope. */
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [ccModels, setCcModels] = useState<CcModel[]>([]);

  useEffect(() => {
    void loadRouting(scopeId);
  }, [scopeId, loadRouting]);

  useEffect(() => {
    // Best-effort: with Command Code absent this stays empty and its model box simply
    // offers only "agent's own model".
    void invoke<CcModel[]>("command_code_models")
      .then(setCcModels)
      .catch(() => setCcModels([]));
  }, []);

  const openProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? projects[0],
    [projects, selectedProjectId],
  );

  if (!routes) return <p className="settings-intro">Loading routing…</p>;

  /** Where the chain currently in force came from, for this scope. */
  const originOf = (task: TaskKind): "project" | "global" | "default" => {
    if (scopeId && routes.project[task]) return "project";
    if (routes.global[task]) return "global";
    return "default";
  };

  const chainOf = (task: TaskKind): Chain => routes.effective[task] ?? [];

  const write = (task: TaskKind, chain: Chain | null) =>
    void setAgentRoute(scopeId, task, chain);

  return (
    <div className="routing-panel">
      <p className="settings-intro">
        Which agent takes which kind of work, and what to fall back to. Each list is tried in
        order — session creation takes the first agent that’s installed and isn’t out of
        quota, so the same list covers your preference, a missing CLI, and a spent limit.
      </p>

      <div className="route-scope">
        <button
          className={`route-scope-btn${scopeId === null ? " on" : ""}`}
          onClick={() => setScopeId(null)}
        >
          Global
        </button>
        <button
          className={`route-scope-btn${scopeId !== null ? " on" : ""}`}
          disabled={!openProject}
          onClick={() => openProject && setScopeId(openProject.id)}
          title={openProject ? openProject.name : "Open a project first"}
        >
          {openProject ? openProject.name : "This project"}
        </button>
      </div>

      {taskKinds.map((t) => {
        const chain = chainOf(t.id);
        const origin = originOf(t.id);
        const overridden = (scopeId ? origin === "project" : origin === "global");
        return (
          <div className="route-task" key={t.id}>
            <div className="route-task-head">
              <span className="route-task-name">{t.label}</span>
              <span className="route-origin">
                {origin === "default"
                  ? "built-in default"
                  : origin === "global"
                    ? scopeId
                      ? "inherited from Global"
                      : "set here"
                    : "set here"}
              </span>
              {overridden && (
                <button
                  className="route-btn route-reset"
                  onClick={() => write(t.id, null)}
                  title="Go back to inheriting"
                >
                  Reset
                </button>
              )}
            </div>
            <p className="route-hint">{t.hint}</p>

            {chain.map((target, i) => (
              <TargetRow
                key={`${target.agent}-${i}`}
                target={target}
                index={i}
                count={chain.length}
                ccModels={ccModels}
                onChange={(next) => write(t.id, chain.map((x, j) => (j === i ? next : x)))}
                onMove={(delta) => {
                  const next = [...chain];
                  const [moved] = next.splice(i, 1);
                  next.splice(i + delta, 0, moved);
                  write(t.id, next);
                }}
                onRemove={() => write(t.id, chain.filter((_, j) => j !== i))}
              />
            ))}

            {chain.length === 0 && (
              <p className="route-hint">
                Nothing routed — sessions for this kind fall back to picking an agent by
                hand.
              </p>
            )}

            <button
              className="route-add"
              onClick={() => {
                // Default the new link to an agent not already in the chain, since a
                // fallback onto the same agent shares the same quota and buys nothing.
                const used = new Set(chain.map((x) => x.agent));
                const fresh = AGENTS.find((a) => !used.has(a.id)) ?? AGENTS[0];
                write(t.id, [...chain, { agent: fresh.id }]);
              }}
            >
              + Add fallback
            </button>
          </div>
        );
      })}
    </div>
  );
}
