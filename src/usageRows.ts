import { accountKey } from "./store";
import type {
  AgyUsage,
  ClaudeAccountUsage,
  CommandCodeAccountUsage,
} from "./store";
import type { AgentId, AgentInfo } from "./agents";
import type { AgentAvailability, AvailabilityMap } from "./routing";

/**
 * How full is each account, normalized across agents.
 *
 * Extracted from UsagePanel so that the usage bar and the ROUTER agree by construction.
 * They were always going to need the same number -- "how much of this account is left" --
 * and two implementations of it would eventually disagree about whether an agent is too low
 * to route to while its meter still shows green.
 *
 * Pure and React-free, so `routing.ts` can stay that way too.
 */

/** A window's kind, used both for the prefs filter and for labeling. */
export type WinKind = "fiveHour" | "weekly" | "weeklyOpus" | "context";
/** A normalized meter across agents: "remaining" (Claude plan / agy quota) or "used" (context). */
export interface UWindow {
  key: string;
  label: string;
  kind: WinKind;
  /** Pool this window belongs to (agy has redundant pools: "Gemini Models", "Claude & GPT
   *  Models"). Used to ignore a whole unavailable pool in the summary metric. */
  group: string;
  mode: "remaining" | "used";
  value: number; // 0..1 (remaining fraction, or used fraction for context)
  resetsAt: string | null;
  disabled: boolean;
}

/** The single "how healthy is this account" number for the summary/sort/low-alert. It's the
 *  minimum remaining across windows, BUT a pool whose windows are all disabled or at 0 is
 *  treated as structurally unavailable (e.g. agy's Claude/GPT pool on a Pro tier) and ignored
 *  -- so one unavailable pool can't paint an otherwise-healthy account red. A genuinely low
 *  window in a live pool still drives the number down. */
export function summaryRemaining(windows: UWindow[]): number {
  const byGroup = new Map<string, UWindow[]>();
  for (const w of windows) {
    if (w.mode !== "remaining") continue;
    const arr = byGroup.get(w.group) ?? [];
    arr.push(w);
    byGroup.set(w.group, arr);
  }
  if (byGroup.size === 0) return 1;
  const groupMins: number[] = [];
  for (const ws of byGroup.values()) {
    const live = ws.filter((w) => !w.disabled);
    if (live.length === 0) continue; // whole pool disabled
    if (Math.max(...live.map((w) => w.value)) <= 0) continue; // whole pool exhausted/unavailable
    groupMins.push(Math.min(...live.map((w) => w.value)));
  }
  return groupMins.length ? Math.min(...groupMins) : 0;
}
export interface URow {
  agent: AgentId;
  key: string; // account key
  accountId: string | null;
  label: string;
  windows: UWindow[];
  /** Claude only: present when plan limits couldn't be fetched (offer a Connect button). */
  connectable: boolean;
  planSource?: string;
  tier?: string | null;
  /** Claude local token total (from stats-cache.json), shown even before plan-connect. */
  localTotal?: number;
  /** Least remaining across non-context, non-disabled windows (1 = healthy / unknown). */
  minRemaining: number;
}


export function claudeKind(label: string): WinKind {
  if (label.includes("Opus")) return "weeklyOpus";
  if (label.toLowerCase().includes("week")) return "weekly";
  return "fiveHour";
}
export function agyKind(label: string): WinKind {
  return label.toLowerCase().includes("week") ? "weekly" : "fiveHour";
}

export function claudeRow(entry: ClaudeAccountUsage): URow {
  const plan = entry.usage.plan;
  const windows: UWindow[] = (plan ?? []).map((w, i) => ({
    key: `${w.label}-${i}`,
    label: w.label,
    kind: claudeKind(w.label),
    group: "plan", // Claude's windows are distinct limits, treated as one pool.
    mode: "remaining",
    value: Math.max(0, Math.min(1, 1 - w.pctUsed)),
    resetsAt: w.resetsAt,
    disabled: false,
  }));
  return {
    agent: "claude",
    key: accountKey(entry.accountId),
    accountId: entry.accountId,
    label: entry.label,
    windows,
    connectable: plan == null,
    planSource: entry.usage.planSource,
    localTotal: entry.usage.local.totalTokens,
    minRemaining: summaryRemaining(windows),
  };
}

export function commandCodeRow(entry: CommandCodeAccountUsage): URow {
  const { windows: raw, source, limited } = entry.usage;
  const windows: UWindow[] = (raw ?? []).map((w, i) => ({
    key: `${w.label}-${i}`,
    label: w.label,
    // Command Code labels its windows "5-hour window" / "Weekly", so the Claude
    // classifier reads them correctly and the prefs filter works without a third variant.
    kind: claudeKind(w.label),
    // One pool: both windows gate the same subscription, so the least-remaining of the
    // two is the honest summary number.
    group: "plan",
    mode: "remaining",
    value: Math.max(0, Math.min(1, 1 - w.pctUsed)),
    resetsAt: w.resetsAt,
    // `limited` means the account is capped RIGHT NOW. Marking the windows disabled
    // would gray them out and drop them from the summary metric -- the opposite of what
    // being capped should communicate -- so it is deliberately not mapped to `disabled`.
    disabled: false,
  }));
  return {
    agent: "commandcode",
    key: accountKey(entry.accountId),
    accountId: entry.accountId,
    label: entry.label,
    windows,
    // No Connect button: unlike Claude there is no Keychain read to authorize, so a
    // missing key means "not signed in", which a button here could not fix.
    connectable: false,
    planSource: source,
    minRemaining: limited ? 0 : summaryRemaining(windows),
  };
}

export function agyRow(u: AgyUsage): URow {
  const windows: UWindow[] = [];
  for (const g of u.groups) {
    const short = g.displayName.startsWith("Gemini")
      ? "Gemini"
      : g.displayName.startsWith("Claude")
        ? "Claude/GPT"
        : g.displayName;
    for (const b of g.buckets) {
      windows.push({
        key: b.bucketId,
        label: `${short} ${b.label}`,
        kind: agyKind(b.label),
        group: g.displayName,
        mode: "remaining",
        value: Math.max(0, Math.min(1, b.remainingFraction)),
        resetsAt: b.resetsAt,
        disabled: b.disabled,
      });
    }
  }
  if (u.context && u.context.contextWindowSize > 0) {
    windows.push({
      key: "context",
      label: "Context",
      kind: "context",
      group: "context",
      mode: "used",
      value: Math.max(0, Math.min(1, u.context.usedPercentage / 100)),
      resetsAt: null,
      disabled: false,
    });
  }
  return {
    agent: "antigravity",
    key: accountKey(u.accountId),
    accountId: u.accountId,
    label: u.email ? u.email.split("@")[0] : "Antigravity",
    windows,
    connectable: false,
    tier: u.planTier,
    minRemaining: summaryRemaining(windows),
  };
}


/**
 * Collapse per-ACCOUNT usage into per-AGENT availability, which is what routing asks about.
 *
 * An agent is as available as its HEALTHIEST account: with a work and a personal Claude
 * signed in, one being spent does not make Claude unusable, and rerouting away from it
 * would be wrong. The usage bar still shows both rows -- this is only the routing view.
 *
 * `remaining: null` means UNKNOWN, and is deliberately distinct from 0. Codex, Gemini,
 * OpenCode and agy expose no plan meter Conduit can read, so their entries carry null and
 * `pickTarget` treats them as usable. Anything else would make "no usage API" mean "never
 * route here".
 */
export function availabilityFrom(agents: AgentInfo[] | null, rows: URow[]): AvailabilityMap {
  const out: AvailabilityMap = {};
  // `agents === null` = the PATH probe has not answered yet. Leaving the map empty makes
  // every agent read as present, which is the right default: the alternative is a dialog
  // that briefly claims nothing is installed.
  for (const a of agents ?? []) {
    out[a.id] = { installed: a.found, remaining: null };
  }
  const best = new Map<AgentId, number>();
  for (const r of rows) {
    // A row with no windows tells us nothing about quota -- it is a signed-out or
    // unreadable account, not an empty one.
    if (r.windows.length === 0) continue;
    const prev = best.get(r.agent);
    best.set(r.agent, prev === undefined ? r.minRemaining : Math.max(prev, r.minRemaining));
  }
  for (const [agent, remaining] of best) {
    const entry: AgentAvailability = out[agent] ?? { installed: true, remaining: null };
    out[agent] = { ...entry, remaining };
  }
  return out;
}
