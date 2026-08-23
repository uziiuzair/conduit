import type { AgentId } from "./agents";

/**
 * Which target in a route's fallback chain is usable right now.
 *
 * The other half of the routing feature lives in `src-tauri/src/routing.rs`, which owns WHAT
 * the preferences are (defaults, overlaid by global, overlaid by project). This file owns
 * WHICH of them can be used at this moment, because that depends on the live usage snapshot
 * — which is already in the frontend store, next to the dialog that has to render
 * synchronously.
 *
 * That is a split, not a fork: neither side re-implements the other's decision, so there is
 * exactly one copy of each rule. (Contrast `statusRules.ts`, which deliberately MIRRORS
 * `status_rules.rs` and carries a warning not to let the two drift.)
 *
 * Design: docs/superpowers/specs/2026-08-23-agent-routing-preferences-design.md
 */

/** Mirrors Rust `TaskKind` (serialized lowercase). */
export type TaskKind = "planning" | "implementation" | "review" | "research" | "bulk";

/** Mirrors Rust `RouteTarget`. `model` absent = leave the agent's own model choice alone. */
export interface RouteTarget {
  agent: AgentId;
  model?: string;
}

/** Mirrors Rust `Chain` / `AgentRoutes` (a sparse map, serialized transparently). */
export type Chain = RouteTarget[];
export type AgentRoutes = Partial<Record<TaskKind, Chain>>;

/** Mirrors Rust `RoutesView`. */
export interface RoutesView {
  effective: AgentRoutes;
  defaults: AgentRoutes;
  global: AgentRoutes;
  project: AgentRoutes;
}

/** Mirrors Rust `TaskKindInfo` — labels come from Rust so the copy lives in one language. */
export interface TaskKindInfo {
  id: TaskKind;
  label: string;
  hint: string;
}

/** What routing needs to know about one agent right now. */
export interface AgentAvailability {
  /** Whether the CLI is on PATH. An agent that isn't installed is skipped silently. */
  installed: boolean;
  /**
   * Fraction of quota LEFT, 0..1 — or `null` when Conduit cannot tell.
   *
   * `null` is load-bearing and is NOT the same as 0. Several agents have no usage API at
   * all, and the ones that do can fail to answer (signed out, offline, endpoint moved).
   * Treating unknown as exhausted would quietly reroute people away from a perfectly good
   * agent because a meter failed to load.
   */
  remaining: number | null;
}

export type AvailabilityMap = Partial<Record<AgentId, AgentAvailability>>;

/** What the picker decided, and why. */
export interface RouteDecision {
  /** The chosen target, or null when the chain had nothing installed. */
  target: RouteTarget | null;
  /** One sentence for the UI. A router that silently picks something other than what the
   *  settings say is indistinguishable from a bug, so every decision explains itself. */
  reason: string;
  /** True when the first preference was passed over. */
  fellBack: boolean;
  /** True when every installed target was at or below the threshold and one was taken
   *  anyway. The session is still created — it just might hit a limit. */
  exhausted: boolean;
}

/** Is this target usable, and if not, why not? `null` means usable. */
function blocker(
  target: RouteTarget,
  avail: AvailabilityMap,
  threshold: number,
): "missing" | "exhausted" | null {
  const a = avail[target.agent];
  // An agent Conduit has never probed is assumed present rather than hidden: the probe is
  // best-effort, and refusing to route to something that is actually installed is the worse
  // error of the two.
  if (a && !a.installed) return "missing";
  if (a && a.remaining !== null && a.remaining <= threshold) return "exhausted";
  return null;
}

function describe(target: RouteTarget): string {
  return target.model ? `${target.agent} (${target.model})` : target.agent;
}

/**
 * Walk a chain and take the first target that is installed and not out of quota.
 *
 * When every installed target is exhausted, the FIRST installed one is taken anyway and
 * `exhausted` is set. Refusing to create a session because a meter is low would be worse
 * than creating one that might hit a limit: extra credits, a reset five minutes away, or a
 * plan change all make the meter wrong in the user's favour, and none of them are visible
 * from here.
 *
 * `threshold` is the same low-water mark the usage bar uses (Settings → Usage display), so
 * one number governs both the warning and the reroute rather than two that can disagree.
 */
export function pickTarget(
  chain: Chain | undefined,
  avail: AvailabilityMap,
  threshold: number,
): RouteDecision {
  if (!chain || chain.length === 0) {
    return {
      target: null,
      reason: "No route configured for this kind of work.",
      fellBack: false,
      exhausted: false,
    };
  }

  const skipped: string[] = [];
  for (const target of chain) {
    const why = blocker(target, avail, threshold);
    if (why === null) {
      const fellBack = skipped.length > 0;
      return {
        target,
        reason: fellBack
          ? `Using ${describe(target)} — ${skipped.join("; ")}.`
          : `Using ${describe(target)}, your first choice for this work.`,
        fellBack,
        exhausted: false,
      };
    }
    skipped.push(
      why === "missing"
        ? `${target.agent} isn't installed`
        : `${target.agent} is low on quota`,
    );
  }

  // Nothing passed. Prefer a real agent over no session at all.
  const firstInstalled = chain.find((t) => blocker(t, avail, threshold) !== "missing");
  if (!firstInstalled) {
    return {
      target: null,
      reason: `None of these agents are installed: ${chain
        .map((t) => t.agent)
        .join(", ")}.`,
      fellBack: false,
      exhausted: false,
    };
  }
  return {
    target: firstInstalled,
    reason: `Every agent for this work is low on quota — using ${describe(
      firstInstalled,
    )} anyway.`,
    fellBack: firstInstalled !== chain[0],
    exhausted: true,
  };
}
