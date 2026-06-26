# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repo. For human-facing
setup and architecture, see [README.md](./README.md) and
[CONTRIBUTING.md](./CONTRIBUTING.md) — this file captures the agent-specific workflow
and the gotchas that bite.

## What this is

Conduit — a Tauri v2 desktop app that runs multiple real `claude` CLI sessions side by
side. **Frontend:** React 19 + TypeScript in `src/` (state in `src/store.ts`, Zustand,
no Redux). **Backend:** Rust in `src-tauri/src/` (Tauri commands registered in
`lib.rs`). The README's "How it works" table is the file map — read it first.

## Commands

```bash
pnpm install
pnpm tauri dev                                       # run the app (dev)
pnpm exec tsc --noEmit                               # typecheck the frontend
pnpm build                                           # tsc + vite production build
cargo test   --manifest-path src-tauri/Cargo.toml    # Rust unit tests
cargo fmt    --manifest-path src-tauri/Cargo.toml    # format Rust
cargo clippy --manifest-path src-tauri/Cargo.toml    # lint Rust
```

Run the same pre-PR checks listed in CONTRIBUTING.md before claiming work is done.

### Running the dev app SAFELY (important)

A Conduit build reads/writes `~/Library/Application Support/ConduitTauri/state.json`. If
the **installed** Conduit.app is also running, a plain `pnpm tauri dev` shares that file
and **clobbers its project/session state**. Always isolate the dev build with the data-dir
override (read in `src-tauri/src/store.rs`):

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

This writes to `…/ConduitTauri-dev/state.json`, so dev and the installed app coexist.

## Testing reality

- **Rust** has `#[cfg(test)]` unit tests. Add tests for any new pure logic (parsers,
  helpers) and run `cargo test`. Prefer testing pure functions over wiring.
- **The frontend has no test runner.** Verify UI changes with `pnpm exec tsc --noEmit` /
  `pnpm build` **and by launching the app** — never claim a UI change "works" from a
  typecheck alone.

## Bumping the version

The version lives in **three** files and they must stay in lockstep:

| File | Field |
| --- | --- |
| `package.json` | `"version"` |
| `src-tauri/Cargo.toml` | `version` (the `[package]` one on line 3 — not a dependency) |
| `src-tauri/tauri.conf.json` | `"version"` |

After editing `Cargo.toml`, run `cargo build --manifest-path src-tauri/Cargo.toml` once so
`Cargo.lock` updates too. Quick sanity check that all three agree:

```bash
grep -E '"?version"?\s*[:=]\s*"[0-9]' package.json src-tauri/tauri.conf.json; sed -n '3p' src-tauri/Cargo.toml
```

Use semantic versioning. Don't bump the version as a side effect of an unrelated change.

## Conventions

- **Commits:** Conventional Commits (`feat`, `fix`, `docs`, `spike`, `chore`), scoped —
  e.g. `feat(usage): …`. End every commit message with the
  `Co-Authored-By: Claude …` trailer.
- **Branches:** one `feat/<topic>` branch per change; integrate to `main` with a merge
  commit: `git merge --no-ff feat/<topic> -m "Merge feat/<topic> into main"`.
- **Never push or merge to `main` without explicit human approval.**
- **Design workflow:** non-trivial features get a spec then a plan under
  `docs/superpowers/specs/` and `docs/superpowers/plans/` before implementation. Keep
  those docs as the record of *why*.

## Architecture gotchas (don't reintroduce)

- **Keep-alive terminals are load-bearing.** Never reparent or conditionally unmount an
  `xterm` / `TerminalView` — it kills the underlying `claude` PTY. Layout is expressed
  purely through CSS from group weights (see CONTRIBUTING.md).
- **Lean dependencies.** The Rust side intentionally has no outbound HTTP client; network
  calls shell out to `curl` (see `claude_status.rs` / `claude_usage.rs`). Don't pull in
  `reqwest`/`tokio` for a couple of GETs without a real reason.
- **`claude` spawns must scrub `npm_config_prefix`.** Launching Conduit via a package
  manager leaks `npm_config_prefix` into the env; nvm then refuses to initialize in the
  login shell and `claude` falls off `PATH`. Both spawn sites — `pty.rs` and the
  `claude -p` titler in `lib.rs` — call `env_remove("npm_config_prefix")`. Keep that when
  editing spawn code.
- **Secrets.** The plan-usage path reads Claude Code's OAuth token from the macOS Keychain
  (`security find-generic-password`) only on explicit user action, holds it in memory, and
  never writes it to disk. Don't log the token or persist it.

## Where the Claude status/usage feature lives

Service status + subscription/local usage (distinct from per-session hook status):

- Rust: `src-tauri/src/claude_status.rs` (status.claude.com), `src-tauri/src/claude_usage.rs`
  (local consumption + best-effort plan limits via `/api/oauth/usage`).
- UI: `src/components/Claude{StatusPill,Popover,UsagePanel,StatusWarning}.tsx`, polled by
  `src/hooks/useClaudeAmbient.ts`, state in the Claude slice of `src/store.ts`.
