// Pure helpers for the continuity panels. No store, no Tauri, no DOM — so the formatting
// rules that decide what a row looks like are testable on their own.

/** Mirrors Rust `continuity_feed::FeedDecision` (serde camelCase). */
export interface FeedDecision {
  id: string;
  decisionKey: string;
  content: string;
  decisionType: string;
  status: string;
  supersedes: string | null;
  createdAt: string;
  authorLabel: string | null;
}

/** Mirrors Rust `continuity_feed::FeedMessage` (serde camelCase). */
export interface FeedMessage {
  id: string;
  kind: string;
  body: string;
  requiresResponse: boolean;
  relatedKey: string | null;
  status: string;
  response: string | null;
  createdAt: string;
  expiresAt: string;
  fromLabel: string | null;
  toLabel: string | null;
  /** Sent by a session outside this project — continuity broadcasts reach every live
   *  session, so another repo's traffic lands in this project's inbox. In scope, but not
   *  ours; the row is dimmed and badged so it doesn't read as local conversation. */
  foreign: boolean;
}

/** Mirrors Rust `continuity_feed::ContinuityFeed`. */
export interface ContinuityFeed {
  available: boolean;
  decisions: FeedDecision[];
  messages: FeedMessage[];
}

/** A decision's prose is paragraphs; a row is one line. Collapse, then ellipsize. */
export function truncateLine(text: string, max = 96): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/** Compact relative time. `nowMs` is injected rather than read from the clock so the
 *  formatting rules are testable without freezing time. */
export function timeAgo(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  // Clamped at zero: continuity's timestamps come from whatever machine wrote the row, so
  // a little clock skew must read as "now", not as a negative age.
  const secs = Math.max(0, Math.round((nowMs - then) / 1000));
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** id of a replaced decision -> the decision that replaced it, for the detail modal.
 *  Only resolves within the loaded page; a pointer past the row cap is simply dropped. */
export function supersededMap(decisions: FeedDecision[]): Record<string, FeedDecision> {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const out: Record<string, FeedDecision> = {};
  for (const d of decisions) {
    if (d.supersedes && byId.has(d.supersedes)) out[d.supersedes] = d;
  }
  return out;
}
