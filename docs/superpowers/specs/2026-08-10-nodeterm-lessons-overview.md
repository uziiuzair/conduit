# nodeterm lessons — overview and decomposition

**Date:** 2026-08-10
**Status:** Design
**Branch:** `feat/nodeterm-lessons`

## Why this exists

`~/ooozzy/experiments/nodeterm` is an Electron app in Conduit's problem space: many real
agent CLI sessions (Claude, Codex, Gemini, opencode, grok) driven from one window. It has
about 158k lines of TypeScript across 799 files and 1711 commits since 2026-06-15, and it
ships on the App Store, a Homebrew tap, and a self-hosted update feed.

A read of that codebase surfaced six things it does better than Conduit does today. This
document decomposes them into independent sub-projects, each with its own design doc, and
records the sequencing.

Two claims from the initial read were wrong and are corrected here, because later documents
build on the corrected version:

- **Conduit is not missing a frontend test runner.** `vitest` and `happy-dom` are already
  wired, `pnpm test` is defined, and nine test files exist. The real gap is that no CI
  workflow runs them — `.github/workflows/` contains only `release.yml`.
- **Conduit's hook command is not fragile in the way nodeterm's used to be.** It is an inline
  `curl … || true` with `${CONDUIT_HOOK_PORT:-<baked>}`, so it can neither block a prompt nor
  break when a script file goes missing. The real gap is narrower: the port is fixed at spawn
  time, so an app restart onto a different port in `8423..=8443` silently dark-ends every
  session that was already running.

## The six sub-projects

| # | Sub-project | Design doc | Value | Risk |
| --- | --- | --- | --- | --- |
| 1 | tmux-backed session persistence | `2026-08-10-tmux-session-persistence-design.md` | Highest | Highest |
| 2 | Hook endpoint indirection | `2026-08-10-hook-endpoint-indirection-design.md` | High | Low |
| 3 | Test infrastructure and CI | `2026-08-10-test-infrastructure-and-ci-design.md` | High | None |
| 4 | Agent capabilities as data | `2026-08-10-agent-capabilities-as-data-design.md` | Medium | Low |
| 5 | Transcript-backed context link | `2026-08-10-transcript-context-link-design.md` | Medium | Medium |
| 6 | Per-project canvas view | `2026-08-10-project-canvas-view-viability.md` | Unproven | Very high |

Each is independently shippable. None depends on another landing first, with one exception:
sub-project 1 changes how a session's environment is established, and sub-project 2 changes
what that environment points at, so 2 should land before or with 1 to avoid writing the
stale-port bug into the new spawn path.

## Sequencing

1. **Test infrastructure and CI** first. It is cheap, it cannot break anything, and every
   later sub-project is verified by it.
2. **Hook endpoint indirection** second. Small, self-contained, and it removes a live bug.
3. **tmux session persistence** third. The largest user-visible win and the largest blast
   radius; it wants the first two in place.
4. **Agent capabilities as data** fourth. A refactor that pays off when the fifth adapter
   arrives, not before.
5. **Transcript-backed context link** fifth. Supersedes the lossy `fleet_peek` scrape.
6. **Per-project canvas** last, and only after its viability question is answered. See its
   doc: the honest cost is dominated by a problem nodeterm needed roughly 11,900 lines to
   solve, and this document recommends a staged version that avoids that cost entirely.

## What Conduit already does better, and should not give up

The comparison is not one-directional, and the following are constraints on every design
here rather than things to reconsider:

- **Tauri over Electron.** Binary size and resident memory are a fraction of nodeterm's.
  No design here may introduce a dependency that pulls in a second runtime.
- **A Rust core.** PTY, git, usage, and hook handling are Rust. Where nodeterm solved a
  problem in TypeScript, the port target is Rust unless the problem is genuinely in the
  renderer.
- **Keep-alive terminals.** `TerminalView` must never be reparented or conditionally
  unmounted; layout is expressed purely through CSS from group weights. This is the single
  hardest constraint in the codebase and it is what sub-project 6 has to survive.
- **The lean-dependency rule.** No `reqwest`/`tokio` for a handful of GETs; shell out to
  `curl`. Every design here holds to it.

## Non-goals

- Adopting nodeterm's canvas as Conduit's primary layout. The pane/group layout is
  load-bearing and better suited to a keyboard-driven workflow.
- Porting nodeterm's Server Edition. Conduit's mobile companion already covers the remote
  case at the level Conduit needs, and a browser shell is a separate product decision.
- Porting the glyph renderer. See sub-project 6 for why this is the decisive cost.
