# Conduit Auto-Updates (macOS OTA) — Design

**Date:** 2026-07-03
**Status:** Approved (user authorized autonomous execution)
**Branch:** `feat/auto-updates`

## Context

Conduit is a Tauri v2 desktop app distributed as a macOS `.app`. There is **no
update mechanism today**: builds are manual (`pnpm tauri build`), unsigned by
default, and users re-download by hand. We want the app to **update itself** —
check for a newer release, download it, verify it, and install on the user's
consent — the desktop equivalent of "OTA."

Three facts about the codebase and distribution shape the design:

- **No update infrastructure exists yet** — no `tauri-plugin-updater` (Rust or
  JS), no `.github/workflows`, no release automation. This is greenfield, so we
  adopt Tauri v2's first-party updater cleanly.
- **Conduit already has an ambient background-polling pattern** — `claude_status.rs`
  / `claude_usage.rs` (Rust) feed a Zustand slice via `useClaudeAmbient.ts`,
  rendered by `Claude{StatusPill,Popover,UsagePanel}.tsx`. An update checker is
  the same shape (poll a remote → store slice → render a notice), so we extend an
  established idiom rather than invent one.
- **Keep-alive terminals are load-bearing** — the `xterm` stack is mounted once
  and never reparented (CSS-positioned) so live `claude` PTYs survive layout
  changes. Any update UI must obey this: it is a normal overlay/sidebar element,
  never something that unmounts the terminal stack.

Tauri's updater is a **pull-a-static-manifest** model, not a push service: the
app fetches a `latest.json` from a URL, compares versions, downloads the platform
bundle, verifies a **minisign** signature (Tauri's own key — separate from Apple
code signing), then self-replaces. Hosting that manifest on GitHub Releases means
the endpoint is a stable URL with no server to run.

## Goals

- The app **checks for updates** in the background (on launch + periodically) and
  via a manual **"Check for updates"** action.
- When a newer version exists, show a **non-blocking notice with the release
  notes**; on consent, **download → verify → install → relaunch**.
- Updates are **signed + notarized** so they install with **zero Gatekeeper
  friction** on modern macOS.
- Every artifact is **minisign-verified** before install — a tampered download
  cannot be installed.
- Releases are **produced by CI on a version tag** (repeatable, laptop-independent).
- Stay within repo conventions: lean deps, pure+tested logic, honest UX copy,
  no secrets on disk or in logs.

## Non-goals (YAGNI for v1)

- **Windows / Linux auto-update.** macOS-only for v1 (matches the current primary
  target). The config is structured so adding platforms later is additive.
- **Silent / forced auto-install.** We always require user consent (chosen UX).
- **Percentage / staged rollout, delta updates, A/B channels.** Achievable later
  behind a custom endpoint; not needed now.
- **Auto-rollback.** Tauri has none; we roll *forward* (see Rollback).
- **In-app changelog rendering beyond release notes** — we surface the release
  `body` and deep-link to the GitHub release.

## Locked decisions

| Decision | Choice |
| --- | --- |
| Target | Conduit **desktop** app (Tauri v2), **macOS-only** for v1 |
| Foundation | **Tauri official updater plugin** (`tauri-plugin-updater`) |
| Signing | **Apple Developer ID** (codesign + notarize) **+ minisign** (updater) |
| Hosting | **GitHub Releases** — stable `releases/latest/download/latest.json` |
| Build shape | **Universal** (`universal-apple-darwin`): one artifact, both arch keys |
| UX | **Prompt with changelog** — background check, consent, install on relaunch |
| Release flow | **GitHub Actions on `v*` tag push** via `tauri-action` |
| First ship | **Seed release `0.5.0`** (manual download); `0.5.1+` auto-updates |

## Approaches considered

- **A — Tauri official updater plugin (chosen).** First-party, minisign-verified,
  minimal new code, matches the existing ambient pattern, and keeps deps lean
  (the plugin does its own fetching — no `reqwest`/`tokio`).
- **B — Custom Rust updater.** Reimplements signature verification and the atomic
  app-swap for marginal control (staged rollout/telemetry). Violates the repo's
  "don't rebuild what exists / lean deps" rule. Rejected.
- **C — Sparkle via a community plugin.** Battle-tested on macOS but a heavier
  native dependency that duplicates what the Tauri updater already gives us once
  Developer ID signing is in place. Overkill. Rejected.

---

## Section 1 — Config, keys & Rust plumbing

**Signing keypair (one-time, local):**

```bash
pnpm tauri signer generate -w ~/.tauri/conduit-updater.key
```

Emits a password-protected **private key** (never committed — password manager +
a GitHub Actions secret) and a **public key** string for `tauri.conf.json`. This
minisign pair is what the updater verifies before installing; it is independent
of Apple's Developer ID.

**`src-tauri/tauri.conf.json`:**

```jsonc
{
  "bundle": {
    "createUpdaterArtifacts": true          // emit Conduit.app.tar.gz + .sig
  },
  "plugins": {
    "updater": {
      "pubkey": "<minisign public key>",
      "endpoints": [
        "https://github.com/uziiuzair/conduit/releases/latest/download/latest.json"
      ]
    }
  }
}
```

`createUpdaterArtifacts` is what makes `tauri build` produce the `.app.tar.gz` +
`.sig` sidecar the updater downloads — without it the updater has nothing to
fetch (classic gotcha). The endpoint is a **stable URL**: `releases/latest/...`
always resolves to the newest *published* (non-draft, non-prerelease) release.

**`src-tauri/Cargo.toml`:** add `tauri-plugin-updater = "2"` and
`tauri-plugin-process = "2"` (the process plugin provides `relaunch()` after
install — the only genuinely new capability beyond the updater).

**`package.json`:** add `@tauri-apps/plugin-updater` and
`@tauri-apps/plugin-process`.

**`src-tauri/src/lib.rs`:** register both plugins in the builder
(`.plugin(tauri_plugin_updater::Builder::new().build())` and
`.plugin(tauri_plugin_process::init())`), and add `updater:default` (plus the
needed `process` permission) to the capabilities file so the JS side can invoke
them.

**Version source of truth:** unchanged — the existing three-file lockstep bump
(`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`) documented
in `CLAUDE.md`. The updater compares the running app's version against the
manifest's `version`, so a version bump + matching `vX.Y.Z` tag is the entire
release trigger.

## Section 2 — Release CI (`.github/workflows/release.yml`)

Triggered on `push` of a `v*` tag. Runs on a macOS runner, adds both Rust targets
(`x86_64-apple-darwin`, `aarch64-apple-darwin`), and uses `tauri-apps/tauri-action`
to build **universal** (`--target universal-apple-darwin`), sign, notarize,
generate `latest.json`, and publish the GitHub Release with all assets attached.

Secrets (GitHub → Settings → Secrets → Actions):

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | minisign private key (updater signature) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |
| `APPLE_CERTIFICATE` | base64 of the Developer ID `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: … (TEAMID)` |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | notarization (app-specific password) |

`tauri-action` config: `includeUpdaterJson: true` (generates & uploads
`latest.json`), `args: --target universal-apple-darwin`, and it **publishes** the
release (not draft) so the stable `latest/download` URL resolves to it. The
generated `latest.json` carries both `darwin-aarch64` and `darwin-x86_64` keys
pointing at the one universal artifact — so Intel and Apple Silicon users both
match (shipping a single-arch artifact would silently strand the other arch).

**Release ritual:** bump the three version files → `cargo build` (refresh
`Cargo.lock`) → update `CHANGELOG.md` → commit → `git tag vX.Y.Z && git push
--tags`. CI does the rest. The release `body` is what surfaces as the in-app
"what changed" notes.

## Section 3 — In-app update experience (frontend)

Extends the ambient pattern; mirrors `useClaudeAmbient.ts` + slice + notice.

- **New files:** `src/hooks/useUpdater.ts`, `src/components/UpdateNotice.tsx`, an
  `updater` slice in `src/store.ts`, and a "Check for updates" row in the Settings
  panel.
- **When it checks:** shortly after launch (delayed so startup isn't blocked),
  then on an interval (~every 6h), plus the manual Settings action. Uses `check()`
  from `@tauri-apps/plugin-updater`.
- **If an update exists:** `check()` returns an `Update` (version, current
  version, `body` = notes, date). Store it in the `updater` slice and render a
  **non-blocking notice** placed like the Claude status pill/banner — **not** a
  modal. Actions: **Install & Relaunch**, **Later**, **View release notes**
  (deep-links to the GitHub release).
- **Install flow:** `update.downloadAndInstall()` streams
  `Started → Progress → Finished` events → progress bar → `relaunch()` from
  `@tauri-apps/plugin-process`. macOS swaps the `.app` and restarts into the new
  version.
- **Don't nag:** "Later" dismisses that version for the session; persist a
  "skipped version" so we don't re-prompt for the same version.
- **Honest copy:** installing restarts Conduit and **ends running agent
  sessions** — the prompt says exactly that.

**Architecture guardrail:** the notice is a normal overlay/sidebar element and
must never reparent or conditionally unmount the `xterm` stack — doing so would
kill live `claude` PTYs merely by showing a banner. The relaunch tears down PTYs,
but that is the explicit, consented action the copy names.

## Section 4 — Security & rollback

- **Verification:** the pinned minisign `pubkey` means the updater refuses any
  artifact whose signature doesn't match — a compromised GitHub asset cannot be
  installed. Private key lives only in a password manager + the GH Actions secret;
  never logged, never on disk in the app.
- **Gatekeeper:** notarization is what lets the freshly-swapped `.app` launch
  without "damaged" errors post-update — the reason Developer ID matters here.
- **No auto-rollback → roll forward.** Because the endpoint tracks "latest,"
  shipping `vX.Y.Z+1` supersedes a bad release for everyone on their next check.
  Runbook (to document in `CONTRIBUTING.md`): (a) stage releases as **draft**,
  sanity-check, then publish; (b) if a bad one escapes, mark it prerelease/delete
  it **and** cut a patch; (c) consent-before-install bounds the blast radius to
  users who actively clicked.
- **Fail safe:** no network / no update / download error → log + optional retry
  toast, **never block startup**. The updater only swaps on a fully verified,
  successful download, so a failed update cannot leave a half-broken app.

## Section 5 — Testing & rollout

- **Rust:** any pure helper we add — interval "should-check-now?" logic,
  skipped-version tracking — gets `#[cfg(test)]` unit tests per `CLAUDE.md`. The
  version comparison itself is the plugin's job.
- **Frontend:** no test runner → verify with `pnpm exec tsc --noEmit`,
  `pnpm build`, and launching the app under
  `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev` so the installed app's state is never
  clobbered.
- **End-to-end updater test:** temporarily point `endpoints` at a scratch
  manifest (raw gist/branch URL) advertising a higher version with a real signed
  artifact, and confirm a lower-version local build detects → downloads →
  verifies → relaunches. Documented as a repeatable procedure.
- **Seed-release nuance (important):** users on today's `0.4.0` have **no
  updater**, so they cannot be auto-updated *to* the first updater build — they
  download `0.5.0` once by hand. Everyone from the seed forward auto-updates. So
  this feature ships as a **minor bump (`0.5.0`)**, announced as a one-time manual
  download; **`0.5.1+` is where auto-update actually kicks in.**
- **Phased rollout:** (1) land config + plugins + CI, cut & manually distribute
  the `0.5.0` seed; (2) verify a `0.5.1` auto-update on a clean test machine;
  (3) turn on periodic background checks.

## Files touched (summary)

| Area | File(s) |
| --- | --- |
| Tauri config | `src-tauri/tauri.conf.json` (bundle + plugins.updater) |
| Capabilities | `src-tauri/capabilities/*.json` (`updater:default`, process perm) |
| Rust deps + registration | `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs` |
| Rust pure logic (tested) | small helper module for check-interval / skipped-version |
| JS deps | `package.json` (`@tauri-apps/plugin-updater`, `-process`) |
| Frontend | `src/hooks/useUpdater.ts`, `src/components/UpdateNotice.tsx`, `src/store.ts` slice, Settings row |
| CI | `.github/workflows/release.yml` |
| Docs | `README.md` (install/update), `CONTRIBUTING.md` (release + rollback runbook), `CHANGELOG.md` |
