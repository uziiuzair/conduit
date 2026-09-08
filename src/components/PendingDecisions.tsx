import { useMemo } from "react";
import { useStore } from "../store";
import { summarize } from "../rootProposals";
import { decisionRoute } from "../pendingDecisionRouting";
import { agyRow, availabilityFrom, claudeRow, commandCodeRow } from "../usageRows";

/** Cards for work root chat wants to start. Rendered at the app root so an approval is
 *  reachable from anywhere, not only from the chat that asked. */
export function PendingDecisions() {
  const decisions = useStore((s) => s.pendingDecisions);
  const approve = useStore((s) => s.approveDecision);
  const deny = useStore((s) => s.denyDecision);
  const decisionRoutes = useStore((s) => s.decisionRoutes);
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
  const threshold = useMemo(
    () => Math.max(0, Math.min(1, lowThresholdPct / 100)),
    [lowThresholdPct],
  );

  if (decisions.length === 0) return null;

  return (
    <div className="decision-stack">
      {decisions.map((d) => {
        // `decisionRoute` is the one place that decides whether "Start it" is enabled —
        // a chat-named agent gets the same installed/quota test a routed one does, it
        // just has no fallback behind it, so unusable there means disabled, not warned.
        // It is handed the whole by-project map, not one table: picking the card's own
        // project is part of the rule, and part of what the test pins.
        const route = decisionRoute(d, decisionRoutes, availability, threshold);
        return (
          <div className="decision-card" key={d.id}>
            <div className="decision-head">
              Start work in <strong>{d.projectName}</strong>
            </div>
            <div className="decision-task">{summarize(d.task, 220)}</div>
            <div className="decision-meta">
              {route.agent ? (
                <>
                  as <strong>{route.agent}</strong>
                  {route.source === "chat" ? " (chosen by the chat)" : " (by your routing)"}
                </>
              ) : route.unusableNamed ? (
                <span className="decision-warn">
                  The chat asked for <strong>{route.unusableNamed.agent}</strong>, but{" "}
                  {route.unusableNamed.why}.
                </span>
              ) : route.routesPending ? (
                // Not a verdict yet: this project's routing table is still in flight.
                <span>Resolving your routing preferences…</span>
              ) : (
                <span className="decision-warn">
                  No agent available for this kind of work — install one or free up quota.
                </span>
              )}
              {route.warning && (
                <div className="decision-warn decision-route-note">{route.warning}</div>
              )}
            </div>
            <div className="decision-actions">
              <button onClick={() => void deny(d.id)}>Not now</button>
              <button
                className="primary"
                disabled={!route.agent}
                onClick={() => void approve(d.id, route.agent!, route.model)}
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
