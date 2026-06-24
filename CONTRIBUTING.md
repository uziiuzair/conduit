# Contributing to Conduit

Thanks for your interest in improving Conduit! This is a small, focused app — issues
and pull requests are very welcome.

## Getting set up

```bash
pnpm install
pnpm tauri dev
```

You'll need Rust (`rustup`), Node + pnpm, the `claude` CLI on your `PATH`, plus `git`
and `curl`. On macOS, also the Xcode Command Line Tools.

## Before opening a PR

Run the same checks CI/build would:

```bash
pnpm exec tsc --noEmit          # type-check the frontend
cargo fmt --manifest-path src-tauri/Cargo.toml      # format Rust
cargo clippy --manifest-path src-tauri/Cargo.toml   # lint Rust
pnpm tauri build --bundles app  # ensure it builds end to end
```

Please keep changes scoped and match the surrounding style.

## Project layout

- `src/` — React + TypeScript frontend (workspace UI, state in `src/store.ts`).
- `src-tauri/src/` — Rust backend (PTY manager, store/persistence, hook server, git,
  filesystem, notifications). See the architecture table in the
  [README](./README.md#how-it-works).

## A note on the architecture

The keep-alive design (all terminals mounted once, positioned by CSS) is load-bearing:
**never** move a `TerminalView` between DOM parents or conditionally unmount one — that
kills the underlying PTY (`claude`) process. Layout is expressed purely through state +
CSS positioning. Keep that invariant when touching the workspace.

## Reporting bugs

Open an issue with your OS, how you launched the app (`pnpm tauri dev` vs a built
`.app`), steps to reproduce, and any output from the terminal where you ran it.

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE).
