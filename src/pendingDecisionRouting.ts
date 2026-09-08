// What a pending-decision card should show and whether "Start it" is enabled. Kept pure
// and separate from PendingDecisions.tsx so the disabled-button rule -- the one place a
// bug here silently creates a session that can't spawn -- is unit-tested without a DOM or
// the Zustand store, which touches localStorage at import time and can't load under the
// node-env vitest (same reason `usageRows.ts` and `startup.ts` stay store-free).

import type { AgentId } from "./agents";
import type { PendingDecision } from "./rootProposals";
import { pickTarget, type AvailabilityMap, type RoutesView, type TaskKind } from "./routing";

export interface DecisionRoute {
  /** Resolved target, or null when nothing usable exists -- disabled means disabled,
   *  there is no partial credit for a named agent that is merely close to usable. */
  agent: AgentId | null;
  model?: string;
  /** Why `agent` is what it is, for the "as X (...)" line. Absent when `agent` is null. */
  source?: "chat" | "routing";
  /** The chat named an agent that isn't installed or is out of quota. Kept distinct from
   *  "routing found nothing" because it names the PROPOSAL's own bad choice -- the user
   *  needs to know the ask itself named something unavailable, not that nothing at all
   *  is configured for this kind of work. */
  unusableNamed?: { agent: string; why: string };
  /** Routing fell back past a preference, or took an exhausted target anyway. Surfaced as
   *  a warning, not a disable: `pickTarget` already decided a lesser choice beats no
   *  session at all for a fallback CHAIN. A chat-named agent gets no such benefit of the
   *  doubt above, because it named exactly one choice with nothing to fall back to. */
  warning?: string;
}

/**
 * Decide what a pending-decision card offers: the agent (if any) "Start it" would use,
 * and why. A chat-named agent is run through the same installed/quota test a routed
 * target gets (`pickTarget` on a chain of one) -- but unlike a real fallback chain there
 * is no alternative behind it, so "usable" means clean: not installed, or at/below the
 * low-quota threshold, must not produce an enabled button.
 */
export function decisionRoute(
  d: Pick<PendingDecision, "agent" | "model" | "kind">,
  routes: RoutesView | null,
  availability: AvailabilityMap,
  threshold: number,
): DecisionRoute {
  if (d.agent) {
    const named = pickTarget(
      [{ agent: d.agent as AgentId, model: d.model ?? undefined }],
      availability,
      threshold,
    );
    if (named.target && !named.exhausted) {
      return { agent: named.target.agent, model: named.target.model, source: "chat" };
    }
    return {
      agent: null,
      unusableNamed: {
        agent: d.agent,
        why: named.target ? "its quota is too low right now" : "it isn't installed",
      },
    };
  }

  const kind = (d.kind ?? "implementation") as TaskKind;
  const decision = routes ? pickTarget(routes.effective[kind], availability, threshold) : null;
  if (!decision?.target) return { agent: null };
  return {
    agent: decision.target.agent,
    model: decision.target.model,
    source: "routing",
    warning: decision.fellBack || decision.exhausted ? decision.reason : undefined,
  };
}
