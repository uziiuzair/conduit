// Quick Open's fuzzy matcher — a hand-rolled subsequence scorer, deliberately not a
// dependency. The bar is "typing `stots` finds `src/store.ts`", not fzf parity.
// Pure module (no Monaco, no DOM) so vitest exercises it in node.

export interface FuzzyMatch {
  /** The candidate that matched. */
  path: string;
  /** Higher is better; only meaningful relative to other candidates of one query. */
  score: number;
  /** Char indices into `path` that matched, for <mark> highlighting. */
  indices: number[];
}

/** True when `ch` starts a "word" after `prev` — path separators, dot/dash/underscore
 *  boundaries, or a lower→upper camelCase step. */
function isBoundary(prev: string | undefined, ch: string): boolean {
  if (prev === undefined) return true;
  if (prev === "/" || prev === "." || prev === "-" || prev === "_" || prev === " ") return true;
  return prev === prev.toLowerCase() && ch === ch.toUpperCase() && ch !== ch.toLowerCase();
}

/**
 * Case-insensitive subsequence match of `query` against `path`, greedy left-to-right
 * with local backtracking-free scoring: consecutive-run and boundary bonuses reward
 * the alignments humans mean, and a basename bonus makes filename hits beat
 * directory hits. Returns null when `query` is not a subsequence of `path`.
 */
export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  if (query.length === 0) return { path, score: 0, indices: [] };
  if (query.length > path.length) return null;

  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const baseStart = path.lastIndexOf("/") + 1;

  const indices: number[] = [];
  let score = 0;
  let pi = 0;
  let prevMatched = -2;
  for (let qi = 0; qi < q.length; qi++) {
    // Leftmost-greedy: always take the first occurrence. Preferring boundary
    // occurrences reads better on paper but needs backtracking to stay a correct
    // subsequence test (a boundary jump can strand the rest of the query); the
    // bonuses below recover the ranking without risking false negatives.
    const found = p.indexOf(q[qi], pi);
    if (found === -1) return null;

    if (found === prevMatched + 1) score += 8; // consecutive run
    if (isBoundary(path[found - 1], path[found])) score += 6;
    if (found >= baseStart) score += 4; // hit inside the basename
    // Gap penalty, capped — but never for the first char: where in the path the
    // match STARTS says nothing about its quality (deep dirs would lose to
    // shallow near-misses).
    if (qi > 0) score -= Math.min(found - pi, 10);

    indices.push(found);
    prevMatched = found;
    pi = found + 1;
  }
  // Prefer shorter candidates overall (less leftover noise).
  score -= Math.floor(path.length / 16);
  return { path, score, indices };
}

/** Rank `candidates` against `query`; ties break by path length then alphabetically. */
export function fuzzyFilter(query: string, candidates: string[], limit: number): FuzzyMatch[] {
  const out: FuzzyMatch[] = [];
  for (const c of candidates) {
    const m = fuzzyMatch(query, c);
    if (m) out.push(m);
  }
  out.sort(
    (a, b) =>
      b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1),
  );
  return out.slice(0, limit);
}
