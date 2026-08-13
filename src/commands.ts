// The command palette's data model and ranking. Pure — no React, no store, no Tauri — so
// the matching rules are testable and the component stays a list renderer.

import { fuzzyMatch } from "./fuzzy";

export interface Command {
  /** Stable identity, used as the React key and in tests. */
  id: string;
  /** What the user reads and what they type against. */
  label: string;
  /** Group heading, rendered above the first row of each run. */
  section?: string;
  /**
   * Secondary text that IS part of the search corpus — a project name, a branch, a
   * directory. Use this when the extra words are another way someone might find the row.
   */
  hint?: string;
  /**
   * Secondary text that is NOT searchable — a reason, not a key.
   *
   * The distinction is load-bearing. Put "needs a worktree" in `hint` and the row starts
   * answering queries like "worktree", which is precisely backwards: the row is offering
   * to explain why it cannot help, not to be found by the explanation.
   */
  note?: string;
  /** Shown but unrunnable; `note` should say why. */
  disabled?: boolean;
  run: () => void;
}

/** What the matcher sees for a command: its label plus any searchable hint. Never `note`. */
export function corpus(c: Command): string {
  return c.hint ? `${c.label} ${c.hint}` : c.label;
}

/**
 * Rank commands against a query.
 *
 * An empty query returns the list unchanged (and unlimited), because the palette's resting
 * state is a menu: its order is a curated one, and re-sorting it by a score everything ties
 * on would only scramble the sections.
 *
 * A disabled command still matches — it is more useful to see the thing you looked for
 * greyed out with a reason than to be told nothing exists by that name.
 */
export function rankCommands(query: string, commands: Command[], limit: number): Command[] {
  const q = query.trim();
  if (!q) return commands;
  const scored: Array<{ c: Command; score: number; i: number }> = [];
  commands.forEach((c, i) => {
    const m = fuzzyMatch(q, corpus(c));
    if (m) scored.push({ c, score: m.score, i });
  });
  // Ties keep the curated order rather than falling back to alphabetical: two equally good
  // matches should appear in the order the palette would have shown them anyway.
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.c);
}
