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
pnpm test                       # vitest suite
cargo fmt --manifest-path src-tauri/Cargo.toml      # format Rust
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings   # lint Rust
cargo test --manifest-path src-tauri/Cargo.toml     # Rust unit tests
pnpm tauri build --bundles app  # ensure it builds end to end
```

Everything above except the final bundle is also enforced by
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) on every pull request, so a red
check tells you which half broke without opening the log.

**Where tests go.** Frontend tests are colocated — `src/foo.ts` is tested by
`src/foo.test.ts`. Rust tests live in a `#[cfg(test)]` module at the bottom of the file
they cover. Prefer testing pure functions over wiring in both languages; there are no
component tests on purpose (see CLAUDE.md's "Testing reality").

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

## Cutting a release (maintainers)

Releases are built + signed + notarized by CI on a version tag.

1. Bump the version in all three files (see the table in `CLAUDE.md`):
   `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
2. `cargo build --manifest-path src-tauri/Cargo.toml` (refreshes `Cargo.lock`).
3. Update `CHANGELOG.md`.
4. Commit, then tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
5. The **Release** workflow builds a universal macOS app, signs + notarizes it,
   generates `latest.json`, and publishes the GitHub Release. Confirm the release
   is **published** (not draft/prerelease) — the app's updater endpoint,
   `releases/latest/download/latest.json`, only resolves to a published release.

### If a bad release ships (rollback = roll forward)

Tauri has no auto-rollback. To pull a bad version:

1. On GitHub, mark the bad release **prerelease** or delete it, so it stops being
   "latest".
2. Fix the issue and cut a higher patch (`vX.Y.Z+1`). Because the endpoint tracks
   "latest," every user moves forward on their next check.
3. Consent-before-install already limits the blast radius to users who clicked
   Install before you rolled forward.
