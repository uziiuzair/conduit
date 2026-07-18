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

### When to bump (SemVer, pre-1.0)

Conduit is `0.MINOR.PATCH` until its first stable public release. Bump **once per release
that reaches a user** (one bump covers every change in that release), not per commit:

- **MINOR** (`0.X.0`) — a shipped, user-facing **feature or feature set** (e.g. multi-account
  accounts, the usage bar). Reset PATCH to `0`.
- **PATCH** (`0.x.Y`) — bug fixes, polish, perf, refactors, docs: **no** new user-facing
  capability.
- **MAJOR** stays `0` until the first stable public release, which is `1.0.0`; after that,
  breaking changes bump MAJOR.

A `-N` build suffix (e.g. `0.5.0-3`) is only for iterating installers of the *same* target
during testing — a real feature release gets a clean `0.x.0`. Don't bump as a side effect of
an unrelated change; do bump when the release adds or fixes something a user would notice.

### Keeping the changelog (do this every version bump)

`CHANGELOG.md` is the source of truth for what shipped when, and **every version bump must
add a matching entry in the same change** — never bump the three version files without one.
The top entry's version must equal the version in the three files above; a bump that leaves
the changelog behind is incomplete work.

- **One entry per increment, granular.** Each user-facing feature or feature set gets its own
  **MINOR** entry; each fix/polish batch gets its own **PATCH** entry. Do **not** bucket
  several people's unrelated features under one version — split them into separate increments
  so the log reads as a logical timeline.
- **Header format:** `## X.Y.Z — YYYY-MM-DD`, newest first. **No contributor names**, no
  author attribution — describe the change, not who made it.
- **Bullets:** `- **Added|Changed|Fixed — short title.** user-facing description.` Write for
  someone using the app, not reading the diff.
- **Reconstructing history:** when commits landed without changelog updates, derive each
  release's contents from the git range between version-bump commits (`git log
  <prev-bump>..<next-bump>`), **not** from commit dates — feature branches merge after their
  commit dates, so a commit can belong to a later release than its date suggests.

## Conventions

- **Commits:** Conventional Commits (`feat`, `fix`, `docs`, `spike`, `chore`), scoped —
  e.g. `feat(usage): …`. **Never add a `Co-Authored-By: Claude` (or any AI
  attribution) trailer** — it makes GitHub display "claude committed" on every
  commit. The full history was scrubbed of these on 2026-07-10; don't reintroduce
  them.
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
  `reqwest`/`tokio` for a couple of GETs without a real reason. The one exception is the
  official `tauri-plugin-updater`, which brings its own HTTP+TLS stack (streaming download
  + minisign verify + self-replace) — that's not a violation of the curl rule, which
  targets hand-rolling a client for a couple of GETs.
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
  (local consumption + best-effort plan limits via `/api/oauth/usage`; returns usage per
  account -- `Vec<ClaudeAccountUsage>`), `src-tauri/src/agy_usage.rs` (agy quota per account).
- UI: `src/components/Claude{StatusPill,Popover,StatusWarning}.tsx` for service status;
  the usage meter itself is the unified `src/components/UsagePanel.tsx` (all accounts, both
  agents, driven by `usagePrefs`; configured in `UsagePrefsPanel.tsx` under Settings ->
  Usage display). Polled by `src/hooks/useClaudeAmbient.ts`; state in `src/store.ts`
  (`claudeUsage` array + `agyUsageByAccount` map + `usagePrefs`).

## Where the unified session directory lives

Every panel (Files/Changes/Git, tab-strip path, Open in VS Code) and the right-panel
companion shell bind to ONE confirmed per-session directory — the worktree once it
exists on disk, else the project root. **Never wire a new consumer to `workingDirOf`**
(intent only; used solely by the agent-terminal spawn) — use
`effectiveDirOf(project, session, sessionDirs)` from `src/store.ts`. The `sessionDirs`
map is filled by the one resolver `src/hooks/useSessionDirs.ts` (1 s confirm poll via
the Rust `dir_exists` command in `fsops.rs`, ~5 s deletion sweep; a pending worktree
keeps NO entry — that absence holds the shell's `dirReady` gate closed). Shell
kill+respawn on dir change lives in `Terminal.tsx` and is strictly `shellOnly` — agent
terminals are keep-alive and must never be respawned. Design:
`docs/superpowers/specs/2026-07-18-unified-session-directory-design.md`.

## Where multi-account assignment lives

Accounts are per-agent profile pointers (`Account { agents, configDir }`, `store.rs`), assigned
per session (`Session.account_id`) or per project (`Project.default_accounts`), resolved at
spawn by `session_account_config_dir` (session -> project default -> global default -> env).
The account->env redirect is the `ProviderAdapter::account_env` seam (`agent.rs`) -- Claude +
agy override it; a future agent implements only that method. UI: `AccountList.tsx` (registry,
agent tags, per-agent + per-project defaults), the new-session dialog picker, and the
right-click "Account" submenu in `Sidebar.tsx`. Design:
`docs/superpowers/specs/2026-07-12-multi-account-orchestration-design.md`.

## Where session restore + safe shutdown lives

VSCode-style "reopen where I left off" + a running-agent quit guard (Claude + agy; others
deferred). Opening a project eagerly spawns all its sessions (`Terminal.tsx`'s
`spawnPty`/eager effect, gated by `restoreSessionsOnOpen`; Settings -> General). Resume:
Claude via `claude --resume <id>` (already), agy via `agy --conversation=<uuid>` threaded as
`resume_token` through `spawn` -> `build_invocation`. agy won't let us pin our own id, so the
`agyusage` hook captures the id agy chose from `~/.gemini/antigravity-cli/conversations/<uuid>.db`,
disambiguated by a spawn-time baseline (`agy_usage::AgyResumeState`) so two sessions sharing an
agy home don't cross-capture (`Session.agent_conversation_id`). Shutdown: `lib.rs`
`live_running_agent` (fleet `running_sessions` cross-checked against a live PTY) gates
`CloseRequested`/`menu.rs` quit; `App.tsx` shows the confirm. agy activity reaches the guard via
its status-line `agent_state` (`agy_usage::agent_state_is_active` -> `FleetState::set_running`),
since agy fires no Claude-style lifecycle hooks. Design:
`docs/superpowers/specs/2026-07-12-session-restore-and-safe-shutdown-design.md`.

## Where the fleet/Conductor orchestration lives

A per-project **Conductor** (a Claude session flagged `role: Conductor`) observes and
commands the fleet through five MCP tools (`fleet_list`/`fleet_peek`/`fleet_spawn`/
`fleet_send`/`fleet_stop`) served by an in-app HTTP MCP server. As shipped (v0.3.0):

- Rust: `src-tauri/src/fleet.rs` (status mirror, `CONDUCTOR_PERSONA`, worker cap, human
  confirm handshake), `src-tauri/src/fleet_mcp.rs` (the MCP server + tool dispatch),
  `Session.role`/`SessionRole` in `store.rs`.
- The Conductor is currently **Claude-only, spawns only Claude workers**, and hands back
  nothing structured — only a lossy terminal scrape via `fleet_peek`. See
  `docs/superpowers/specs/2026-06-30-conductor-design.md` for how it actually works today.

**A follow-on redesign is planned but NOT implemented** (as of this writing): heterogeneous
(5-adapter, tiered) workers, a project-scoped result/mailbox blackboard, and a per-agent
usage bar. Read `docs/superpowers/specs/2026-07-04-orchestration-v2-design.md` and its
`2026-07-05-orchestration-v2-scope-expansion-design.md` companion (+ matching plan docs)
before touching `fleet.rs`/`fleet_mcp.rs`/`agent.rs`'s adapter dispatch — there's a
confirmed, not-yet-fixed cross-project security leak in `fleet_peek`/`fleet_send`
documented there (SPEC-0), and a caller-role guardrail gap in `dispatch_tool` that any
change granting a worker MCP access must close (design doc §2.0). Short index:
`claude_docs/feature-6-orchestration-v2.md` (gitignored, not committed).
