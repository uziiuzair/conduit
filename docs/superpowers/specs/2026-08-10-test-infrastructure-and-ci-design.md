# Test infrastructure and CI

**Date:** 2026-08-10
**Status:** Design
**Sub-project:** 3 of 6 — see `2026-08-10-nodeterm-lessons-overview.md`

## Problem

The gap here is narrower than it first appeared, and stating it precisely matters because the
wrong version of it leads to the wrong work.

Conduit **already has** a frontend test runner: `vitest` and `happy-dom` are in
`devDependencies`, `vitest.config.ts` exists, `pnpm test` is defined, and nine test files
cover the pure-logic modules (`layout`, `fuzzy`, `markdown`, `trim`, `plugins/*`,
`monaco/registry`, `format/options`). The Rust side has `#[cfg(test)]` modules in 31 files.
CLAUDE.md's claim that "the frontend has no test runner" is stale and should be corrected as
part of this work.

The actual gaps are three:

1. **Nothing runs any of it automatically.** `.github/workflows/` contains only `release.yml`,
   which builds and notarizes on a version tag. No workflow runs on a pull request or a push
   to `main`, so `cargo test`, `pnpm test`, and `tsc --noEmit` are gated by nothing but
   discipline. CONTRIBUTING.md lists the pre-PR checks; nothing enforces them.
2. **Test placement discourages writing tests.** Rust tests live in `#[cfg(test)]` modules at
   the bottom of the file they test, which is idiomatic and fine. Frontend tests live beside
   only the small pure modules. There is no established place for a test of anything in
   `src/components/` or `src/hooks/`, so in practice those never get one.
3. **No seam test.** nodeterm's `no-electron.test.ts` fails the build if anything in
   `src/core` imports `electron`, which is what keeps their three-shell architecture honest.
   Conduit has an analogous invariant that is currently only documented: `effectiveDirOf` is
   the sanctioned session-directory accessor and `workingDirOf` must not gain new consumers.
   CLAUDE.md says so in prose; nothing checks it.

nodeterm's 337 test files against Conduit's 40 is a real difference, but the causal factor is
not a missing runner. It is that they made tests cheap to write (colocated, with a fake
platform to test against) and impossible to skip (CI on every PR).

## Design

### CI workflow

A new `.github/workflows/ci.yml`, modeled on nodeterm's, running on pull requests to `main`
and pushes to `main`:

```yaml
jobs:
  frontend:   # ubuntu — pnpm install, tsc --noEmit, pnpm test, pnpm build
  rust:       # macos  — cargo fmt --check, cargo clippy -D warnings, cargo test
```

Two jobs rather than one, because they fail for unrelated reasons and a developer reading a
red check should not have to open the log to learn which half broke.

The Rust job runs on macOS because Conduit's primary target is macOS and several modules are
`#[cfg(not(windows))]`. It uses the standard GitHub runner rather than a self-hosted one:
unlike `release.yml`, a test job is short, so the 10× macOS billing multiplier is acceptable
for the runtime involved. If it becomes a cost problem, the frontend job alone catches most
regressions and the Rust job can move to a schedule.

`cargo clippy -- -D warnings` is a deliberate choice to start strict. If the existing tree
does not pass cleanly, the correct response is to fix the lints in this sub-project rather
than to weaken the gate — a warning-tolerant lint job stops being read within a month.

### A `platform-fake` equivalent for Rust

The reason nodeterm can test so much of its core is `src/core/platform-fake.ts`: an
in-memory implementation of the platform seam, so a service can be exercised with no Electron,
no IPC, and no real filesystem.

Conduit's closest analogue is the `Store`, which several test modules already construct
directly (`hooks.rs`'s `store_with_one_session` helper does exactly this). The work here is to
promote that pattern from a private test helper in one file to a shared
`#[cfg(test)] pub mod testkit` exposing:

- `fresh_data_dir(tag) -> PathBuf` — an isolated, uniquely named temp data dir, already
  duplicated in at least three test modules today.
- `store_with(project, sessions) -> Store` — the builder from `hooks.rs`, generalized.
- `fake_hook_port() -> u16` — a port that nothing binds, for tests that only inspect
  generated commands.

This is a small, mechanical extraction, and it removes existing duplication rather than
adding a new abstraction.

### The seam test

A Rust test asserting that `workingDirOf` gains no new consumers is not possible — it is a
TypeScript symbol. It belongs in the frontend suite as a source-scanning test, in the spirit
of nodeterm's `no-electron.test.ts`:

`src/store.seam.test.ts` reads the files under `src/` and asserts that `workingDirOf` appears
only in `src/store.ts` (its definition) and in the agent-terminal spawn path that is
sanctioned to use it. Any new import fails the suite with a message pointing at
`effectiveDirOf` and the design doc.

A source-scanning test is a blunt instrument and is worth exactly one use. This is the right
one: the invariant is load-bearing, silently violable, and already documented in prose that
nobody reads at the moment they violate it.

### Test placement convention

Colocation, matching what the pure modules already do: `src/foo.ts` is tested by
`src/foo.test.ts`. This is already the de-facto pattern for the nine existing files, so this
is a codification rather than a change. It gets recorded in CONTRIBUTING.md so it applies to
new work.

Component tests are explicitly **not** part of this sub-project. Testing `Terminal.tsx`
requires a mounted xterm, a PTY, and a Tauri bridge, and a shallow render of it would assert
nothing worth the maintenance. The rule stays as CLAUDE.md has it: verify UI changes by
launching the app. What changes is that the pure logic *behind* components has somewhere
obvious to live and a gate that runs it.

### CLAUDE.md correction

The "Testing reality" section is rewritten to describe what is actually true: a vitest suite
exists and is expected to grow, colocated `*.test.ts` is the convention, CI runs it, and UI
behavior is still verified by launching the app.

## Testing

This sub-project's own verification is that the workflow runs green on a pull request from
this branch, with a deliberate failure injected and reverted to prove the gate is not
vacuous — a test that cannot fail is not a gate.

## Deferred

- **Coverage thresholds.** A number that nobody chose is a number nobody defends. Worth
  revisiting once the suite covers more than pure helpers.
- **An SSH-in-Docker style integration harness.** nodeterm's is excellent and is what makes
  their remote features trustworthy. Conduit has no remote-host feature to exercise, so
  there is nothing for it to test yet.
- **A `pnpm build` gate on the Rust job.** The full Tauri build is slow; the frontend `pnpm
  build` plus `cargo test` catches the overwhelming majority of breakage.
