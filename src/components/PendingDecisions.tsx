import { useMemo } from "react";
import { useStore } from "../store";
import { summarize } from "../rootProposals";
import { pickTarget, type TaskKind } from "../routing";
import { agyRow, availabilityFrom, claudeRow, commandCodeRow } from "../usageRows";

/** Cards for work root chat wants to start. Rendered at the app root so an approval is
 *  reachable from anywhere, not only from the chat that asked. */
export function PendingDecisions() {
  const decisions = useStore((s) => s.pendingDecisions);
  const approve = useStore((s) => s.approveDecision);
  const deny = useStore((s) => s.denyDecision);
  const routes = useStore((s) => s.routes);
  const detected = useStore((s) => s.agents);
  const claudeUsage = useStore((s) => s.claudeUsage);
  const agyMap = useStore((s) => s.agyUsageByAccount);
  const commandCodeUsage = useStore((s) => s.commandCodeUsage);
  const lowThresholdPct = useStore((s) => s.usagePrefs.lowThresholdPct);

  // The exact account-health collapse NewSessionDialog uses, so a card can never decide
  // an agent is spent while its meter still reads green.
  const availability = useMemo(
    () =>
      availabilityFrom(detected, [
        ...claudeUsage.map(claudeRow),
        ...Object.values(agyMap).map(agyRow),
        ...commandCodeUsage.filter((u) => u.usage.windows?.length).map(commandCodeRow),
      ]),
    [detected, claudeUsage, agyMap, commandCodeUsage],
  );

  if (decisions.length === 0) return null;

  return (
    <div className="decision-stack">
      {decisions.map((d) => {
        // The chat may have named an agent; otherwise routing picks one HERE, because
        // only the frontend knows which accounts still have quota.
        const kind = (d.kind ?? "implementation") as TaskKind;
        const decision = routes
          ? pickTarget(
              routes.effective[kind],
              availability,
              Math.max(0, Math.min(1, lowThresholdPct / 100)),
            )
          : null;
        const routed = d.agent
          ? { agent: d.agent, model: d.model ?? undefined }
          : decision?.target
            ? { agent: decision.target.agent, model: decision.target.model }
            : null;
        const agent = routed?.agent ?? null;
        return (
          <div className="decision-card" key={d.id}>
            <div className="decision-head">
              Start work in <strong>{d.projectName}</strong>
            </div>
            <div className="decision-task">{summarize(d.task, 220)}</div>
            <div className="decision-meta">
              {agent ? (
                <>
                  as <strong>{agent}</strong>
                  {d.agent ? " (chosen by the chat)" : " (by your routing)"}
                </>
              ) : (
                <span className="decision-warn">
                  No agent available for this kind of work — install one or free up quota.
                </span>
              )}
            </div>
            <div className="decision-actions">
              <button onClick={() => void deny(d.id)}>Not now</button>
              <button
                className="primary"
                disabled={!agent}
                onClick={() => void approve(d.id, agent!, routed?.model)}
              >
                Start it
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
