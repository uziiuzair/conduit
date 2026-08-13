// Pure presentation rules for the per-session context-window meter.
//
// Separated from the component so the thresholds and the wording are testable — the meter
// itself is four divs and a title attribute.

import type { ContextUsage } from "./store";

/** Where the meter changes its mind about how worried to look. */
export const WARN_AT = 0.7;
export const DANGER_AT = 0.9;

export type MeterLevel = "ok" | "warn" | "danger";

/**
 * How full is too full.
 *
 * The bands are about what the user can still do, not about arithmetic: below 70% a session
 * has room for a normal exchange, past 90% the next big file read is what triggers a
 * compaction. The bar is deliberately quiet in the `ok` band — a meter that shouts at 20%
 * teaches people to ignore it by the time it matters.
 */
export function meterLevel(fraction: number): MeterLevel {
  if (fraction >= DANGER_AT) return "danger";
  if (fraction >= WARN_AT) return "warn";
  return "ok";
}

/** Compact token count: `847`, `46.0k`, `1.2M`. */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1_000;
    // Two significant-ish digits up to 100k, then drop the decimal — "999.9k" is noise.
    return k < 100 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** The meter's tooltip: the percentage, the raw numbers, and the model behind them. */
export function meterTitle(u: ContextUsage): string {
  const pct = Math.round(u.fraction * 100);
  const head = `Context ${pct}% — ${formatTokens(u.used)} / ${formatTokens(u.window)}`;
  return u.model ? `${head} (${u.model})` : head;
}
