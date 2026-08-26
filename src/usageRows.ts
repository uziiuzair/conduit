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
 * Pure and React-free, so `routing.ts` can stay that way too -- and with NO value import
 * from `store.ts`, which is what lets `usageRows.test.ts` run: importing the store under the
 * node-env vitest touches `localStorage` at module scope and throws. Same reason
 * `startup.ts` exists. Keep the imports from `store` type-only.
 */

/** The map key for an account snapshot (the env default has no id).
 *  Defined here rather than in `store.ts`, which re-exports it, so this module stays
 *  importable without the store -- see the note above. */
export function accountKey(accountId: string | null | undefined): string {
  return accountId ?? "default";
}

/** A window's kind, used both for the prefs filter and for labeling. */
export type WinKind = "fiveHour" | "weekly" | "weeklyOpus" | "context";

/**
 * One meter, normalized across agents.
 *
 * `used` is the ONLY quantity stored, and every agent is converted into it at the row
 * builder. It used to be a `mode` + a `value` that meant remaining for some windows and
 * used for others, and the panel had to branch on the mode in three places to decide what
 * the label said and what the bar drew. It got one of them backwards: the label read
 * "62% left" while the bar filled to 38%. Storing one direction removes the branch, and
 * with it the chance of the two disagreeing again.
 */
export interface UWindow {
  key: string;
  label: string;
  kind: WinKind;
  /** Pool this window belongs to (agy has redundant pools: "Gemini Models", "Claude & GPT
   *  Models"). Used to ignore a whole unavailable pool in the summary metric. */
  group: string;
  /** Fraction of this window CONSUMED, 0..1. */
  used: number;
  /** Does this window gate work? Context does not — it is informational, and letting it
   *  drag an account's health number down would route traffic away from an agent whose
   *  quota is untouched. */
  quota: boolean;
  resetsAt: string | null;
  disabled: boolean;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/**
 * Which direction the user reads a meter.
 *
 * "used" is the default because it is what every agent's own usage view shows — `claude
 * /usage` prints `Current session ████░░░░░░ 18% · resets 3:50pm`, and quota dashboards
 * generally (GitHub Actions minutes, OpenAI usage, cloud budgets) count up toward a cap
 * rather than down from one. "remaining" is offered because a fuel-gauge reading is a real
 * preference, not a wrong one.
 */
export type UsageMetric = "used" | "remaining";

/** Everything the panel needs to draw one meter, derived once. */
export interface MeterView {
  /** The number in the label AND the fraction the bar fills. Returning them as one value
   *  is the point: it is no longer possible for the text and the bar to disagree. */
  fraction: number;
  /** `fraction` as a rounded percent, for the label. */
  pct: number;
  /** The word after the number: "used" or "left". */
  word: string;
  /** Always the CONSUMED fraction, whichever metric is displayed. Danger is a property of
   *  the account, not of how the user likes to read it — so the colour ramp, the low-alert
   *  and the sort all key off this and never off `fraction`. */
  severity: number;
}

export function meterView(w: UWindow, metric: UsageMetric): MeterView {
  const used = clamp01(w.used);
  const fraction = metric === "used" ? used : 1 - used;
  return {
    fraction,
    pct: Math.round(fraction * 100),
    word: metric === "used" ? "used" : "left",
    severity: used,
  };
}

/** The single "how healthy is this account" number for the summary/sort/low-alert. It's the
 *  minimum remaining across windows, BUT a pool whose windows are all disabled or at 0 is
 *  treated as structurally unavailable (e.g. agy's Claude/GPT pool on a Pro tier) and ignored
 *  -- so one unavailable pool can't paint an otherwise-healthy account red. A genuinely low
 *  window in a live pool still drives the number down. */
export function summaryRemaining(windows: UWindow[]): number {
  return healthOf(windows).remaining;
}

/**
 * The window `summaryRemaining` is actually reporting.
 *
 * Returned so the collapsed summary can NAME the meter it agrees with. One bare number
 * that silently meant "the worst of three" is most of why the panel looked like it
 * contradicted itself: the summary said 79% while the meters below it read 18, 3 and 79.
 * `null` when nothing drives it (no quota windows, or every pool unavailable).
 */
export function worstWindow(windows: UWindow[]): UWindow | null {
  return healthOf(windows).worst;
}

interface Health {
  remaining: number;
  worst: UWindow | null;
}

function healthOf(windows: UWindow[]): Health {
  const byGroup = new Map<string, UWindow[]>();
  for (const w of windows) {
    if (!w.quota) continue;
    const arr = byGroup.get(w.group) ?? [];
    arr.push(w);
    byGroup.set(w.group, arr);
  }
  if (byGroup.size === 0) return { remaining: 1, worst: null };
  const remaining = (w: UWindow) => 1 - clamp01(w.used);
  let best: Health | null = null;
  for (const ws of byGroup.values()) {
    const live = ws.filter((w) => !w.disabled);
    if (live.length === 0) continue; // whole pool disabled
    if (Math.max(...live.map(remaining)) <= 0) continue; // whole pool exhausted/unavailable
    let worst = live[0];
    for (const w of live) if (remaining(w) < remaining(worst)) worst = w;
    const r = remaining(worst);
    if (!best || r < best.remaining) best = { remaining: r, worst };
  }
  return best ?? { remaining: 0, worst: null };
}

/** The windows a row actually draws, per the user's window filter. The ONE definition:
 *  the meters, the summary number, the health dot, the sort and the low-alert all read it,
 *  so hiding a window can no longer leave the summary reporting one the user cannot see. */
export function visibleWindows(
  windows: UWindow[],
  show: Record<WinKind, boolean>,
): UWindow[] {
  return windows.filter((w) => show[w.kind]);
}

/**
 * What the PANEL should say about a row, as opposed to what the router should think.
 *
 * `remaining: null` means UNKNOWN -- no readable quota window, usually because the poll was
 * rate-limited. It is deliberately not 1: `summaryRemaining` returns 1 for "nothing known"
 * because a router must not treat an unmeasurable agent as spent, but the panel drawing
 * that as a healthy green dot told the user an account was fine when nothing had been read.
 */
export interface RowHealth {
  remaining: number | null;
  worst: UWindow | null;
}

export function rowHealth(visible: UWindow[]): RowHealth {
  if (!visible.some((w) => w.quota)) return { remaining: null, worst: null };
  const h = healthOf(visible);
  return { remaining: h.remaining, worst: h.worst };
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
  /** Least remaining across non-context, non-disabled windows (1 = healthy / unknown).
   *  This is the ROUTER's number and is deliberately unfiltered by display preferences --
   *  the panel uses `rowHealth` over the windows it actually draws. */
  minRemaining: number;
  /** These numbers are the last good read, not this poll's: the fetch was throttled. */
  stale?: boolean;
}


/**
 * One vocabulary for the same window across every agent.
 *
 * Each CLI names its own windows: Claude says "Current session" / "Current week (all)",
 * Command Code says "5-hour window" / "Weekly", agy says "5-hour" / "Weekly" per pool. In
 * a stacked panel those sat next to each other and read as different KINDS of limit rather
 * than the same limit measured by three vendors. `kind` was already the classification the
 * prefs filter uses, so the label is now derived from it instead of passed through.
 */
const KIND_LABEL: Record<WinKind, string> = {
  fiveHour: "5-hour",
  weekly: "Weekly",
  weeklyOpus: "Weekly · Opus",
  context: "Context",
};

/** `pool` survives only for agy, whose windows genuinely belong to separate quotas and
 *  would otherwise collapse into four rows named "5-hour" and "Weekly". */
export function windowLabel(kind: WinKind, pool?: string): string {
  return pool ? `${pool} · ${KIND_LABEL[kind]}` : KIND_LABEL[kind];
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
    label: windowLabel(claudeKind(w.label)),
    kind: claudeKind(w.label),
    group: "plan", // Claude's windows are distinct limits, treated as one pool.
    used: clamp01(w.pctUsed),
    quota: true,
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
    stale: entry.usage.planSource === "stale",
    localTotal: entry.usage.local.totalTokens,
    minRemaining: summaryRemaining(windows),
  };
}

export function commandCodeRow(entry: CommandCodeAccountUsage): URow {
  const { windows: raw, source, limited } = entry.usage;
  const windows: UWindow[] = (raw ?? []).map((w, i) => ({
    key: `${w.label}-${i}`,
    label: windowLabel(claudeKind(w.label)),
    // Command Code labels its windows "5-hour window" / "Weekly", so the Claude
    // classifier reads them correctly and the prefs filter works without a third variant.
    kind: claudeKind(w.label),
    // One pool: both windows gate the same subscription, so the least-remaining of the
    // two is the honest summary number.
    group: "plan",
    used: clamp01(w.pctUsed),
    quota: true,
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
        label: windowLabel(agyKind(b.label), short),
        kind: agyKind(b.label),
        group: g.displayName,
        // agy reports headroom; every other agent reports consumption. Flipping it here,
        // once, is why nothing downstream has to know which is which.
        used: 1 - clamp01(b.remainingFraction),
        quota: true,
        resetsAt: b.resetsAt,
        disabled: b.disabled,
      });
    }
  }
  if (u.context && u.context.contextWindowSize > 0) {
    windows.push({
      key: "context",
      label: windowLabel("context"),
      kind: "context",
      group: "context",
      used: clamp01(u.context.usedPercentage / 100),
      // Not a quota: a full context window costs nothing and resets on the next turn.
      quota: false,
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
