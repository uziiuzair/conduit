import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The unified-session-directory seam, enforced instead of merely documented.
 *
 * Every panel (Files/Changes/Git, the tab-strip path, Open in VS Code) and the
 * right-panel companion shell must bind to ONE confirmed per-session directory via
 * `effectiveDirOf`. `workingDirOf` is INTENT ONLY — it reports where a session wants
 * to run, including a worktree that does not exist on disk yet — and wiring a
 * consumer to it reintroduces the class of bug the unified-directory design closed:
 * a panel pointed at a path that is not there, and a companion shell whose `dirReady`
 * gate opens too early.
 *
 * CLAUDE.md says this in prose. Prose is not read at the moment someone violates it;
 * a failing test is. This is the Conduit analogue of nodeterm's `no-electron.test.ts`,
 * which is what keeps their core/shell split honest.
 *
 * Design: docs/superpowers/specs/2026-07-18-unified-session-directory-design.md
 */

/** Files allowed to name `workingDirOf`, each with the reason it is allowed. */
const ALLOWED = new Map<string, string>([
  ["src/store.ts", "defines it, and documents the restriction in the comment above it"],
  [
    "src/components/WorkspaceCenter.tsx",
    "the agent-terminal spawn — the one sanctioned consumer, since a spawn must " +
      "create the worktree it is about to run in",
  ],
  ["src/store.seam.test.ts", "this test"],
]);

const SOURCE_EXT = /\.(ts|tsx)$/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, acc);
    else if (SOURCE_EXT.test(entry)) acc.push(path);
  }
  return acc;
}

describe("session-directory seam", () => {
  it("keeps workingDirOf to its sanctioned consumers", () => {
    const offenders = sourceFiles("src")
      .filter((f) => readFileSync(f, "utf8").includes("workingDirOf"))
      .filter((f) => !ALLOWED.has(f));

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These files reference workingDirOf, which is INTENT ONLY:\n` +
            offenders.map((f) => `  - ${f}`).join("\n") +
            `\n\nUse effectiveDirOf(project, session, sessionDirs) instead — it resolves ` +
            `to the worktree once it exists on disk, else the project root. See ` +
            `docs/superpowers/specs/2026-07-18-unified-session-directory-design.md.\n` +
            `If a new consumer genuinely needs intent rather than reality, add it to ` +
            `ALLOWED in this test with the reason.`,
    ).toEqual([]);
  });

  it("has an allowlist that matches reality", () => {
    // A stale allowlist entry is as bad as a missing one: it silently grants
    // permission to a file that no longer uses the symbol, so the next file to take
    // that path inherits the exemption.
    const stale = [...ALLOWED.keys()].filter(
      (f) => !readFileSync(f, "utf8").includes("workingDirOf"),
    );
    expect(stale).toEqual([]);
  });
});
