import { describe, expect, it } from "vitest";
// @ts-expect-error node builtins are deliberately untyped here — this project has no
// @types/node on purpose (see vite.config.ts), because it would make `process`, `Buffer`
// and friends visible to frontend code that has no Node runtime under it.
import { readdirSync, readFileSync, statSync } from "node:fs";
// @ts-expect-error same reason as above
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

/**
 * Repo-relative path with forward slashes, on every platform.
 *
 * `join` uses the host separator, so on Windows this walk yields `src\store.ts` while
 * ALLOWED is keyed on `src/store.ts` — every allowlisted file would read as an offender
 * and the suite would fail for no reason but the OS. The allowlist is written the way the
 * repo writes paths, so normalize toward that rather than the other way around.
 */
function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, acc);
    else if (SOURCE_EXT.test(entry)) acc.push(normalize(path));
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

/**
 * The root-chat approval seam.
 *
 * `store.ts` cannot be imported here — it touches `localStorage` and the Tauri bridge at
 * module scope, which is why `startup.ts`, `usageRows.ts` and `pendingDecisionRouting.ts`
 * exist as store-free modules at all. So the RULES live in pure modules with their own
 * unit tests, and this asserts the store actually applies them. Both of these were live
 * bugs, and both are invisible to a typecheck: the code compiles perfectly while doing
 * the wrong thing.
 */
describe("root-chat approval seam", () => {
  const storeSrc = () => readFileSync("src/store.ts", "utf8");

  it("navigates to the approved card's project", () => {
    // Without this, approving in a project that is not the selected one starts NOTHING —
    // `Terminal.tsx`'s eager spawn is gated on `projectId === selectedProjectId` — and
    // because `pendingPrompts` is runtime-only, quitting first loses the brief entirely.
    const body = storeSrc().split("approveDecision: async")[1]?.split("denyDecision:")[0] ?? "";
    expect(
      body.includes("approvalFocus("),
      "approveDecision must apply `approvalFocus` (rootProposals.ts) so the work it just " +
        "created actually starts — see the root-chat orchestration section of CLAUDE.md.",
    ).toBe(true);
    expect(body).toContain("selectedProjectId");
  });

  it("routes decision cards per project, not off the shared `routes` slot", () => {
    // `routes` is one slot, also written by NewSessionDialog and RoutingPanel. A card read
    // from it is routed by whichever project was loaded last, and by globals only when the
    // app-level load passed `null` — so a project-level override never applied to a card.
    const card = readFileSync("src/components/PendingDecisions.tsx", "utf8");
    expect(
      /useStore\(\(s\) => s\.routes\)/.test(card),
      "PendingDecisions must read `decisionRoutes` (keyed by project id), not `routes`.",
    ).toBe(false);
    expect(card).toContain("decisionRoutes");
  });
});
