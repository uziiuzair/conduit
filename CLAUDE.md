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
- **The frontend has a vitest suite** (`pnpm test`, `vitest.config.ts`, node env).
  Convention is **colocated**: `src/foo.ts` is tested by `src/foo.test.ts`. Add tests for
  new pure logic here the same way you would in Rust.
- **`.github/workflows/ci.yml` runs all of it** on every PR and push to `main` —
  typecheck + `pnpm test` + `pnpm build` on one job, `cargo fmt --check` + `cargo clippy
  -D warnings` + `cargo test` on another. Clippy is strict; fix the lint rather than
  weakening the gate.
- **The Rust job is a matrix: macOS AND Windows.** The two compile different programs
  (`tmux`/`session_budget` are cfg-gated; spawn, PTY, path and process-kill each have a
  Windows arm), so a green macOS leg proves nothing about Windows. It was macOS-only for
  76 commits and the Windows build was broken that whole time. If you add a
  `#[cfg(windows)]` block, the Windows leg is the only thing that will ever compile or
  lint it.
- **Component tests are deliberately absent.** Testing `Terminal.tsx` needs a mounted
  xterm, a PTY, and the Tauri bridge, and a shallow render would assert nothing worth
  maintaining. Verify UI changes with `pnpm exec tsc --noEmit` / `pnpm build` **and by
  launching the app** — never claim a UI change "works" from a typecheck alone.
- **`src/store.seam.test.ts` guards the session-directory seam** — it fails if anything
  outside the sanctioned consumers references `workingDirOf`. If you add a consumer that
  genuinely needs intent rather than reality, add it to that test's allowlist with a
  reason.

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

## Where the terminal renderer choice lives

Panes draw through WebGL by default, canvas on request (Settings → Terminal). The tier ladder
is `src/terminalRenderer.ts` (`attachRenderer`: WebGL → canvas → xterm's DOM renderer), with
the concrete addons injected from `src/terminalRendererAddons.ts` — they are UMD bundles that
touch `self` on import, so a static import would break the Node-env vitest. Two rules:

- **The preference is intent; `handle.active` is reality.** WebGL costs one GPU context per
  pane and WebKit caps how many are live; a pane that loses its context drops to canvas *in
  place* and the stored preference is NOT rewritten. Same split as `workingDirOf` vs
  `effectiveDirOf`.
- **Switching must never recreate the xterm** — that would kill the PTY (keep-alive rule
  above). `Terminal.tsx` keeps the renderer in its own effect keyed on the pref, so a change
  disposes one addon and loads another on the live instance; the create effect stays `[]`.

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

## Where the continuity panels live

Two READ-ONLY right-column tabs (Decisions, Messages) mirror continuity's running memory
for the active project. Conduit never writes that database — continuity owns every write.

- Rust: `continuity_read.rs` owns the path + read-only open (board presence/handoffs);
  `continuity_feed.rs` reuses both for the panels (decisions + messages).
  `feed_for_project` degrades to `available: false` on a missing DB, a drifted schema, or a
  continuity install that has never run — the tabs then do not render at all.
- Scoping is two allowlist arms, never a prefix or wildcard: `agent_label IN (this
  project's Conduit session ids)` — exact, because `pty.rs` sets `CONTINUITY_AGENT_ID` to
  the session id — plus `cwd_hash IN (sha256(git toplevel)[..16])` for sessions started
  outside Conduit in the same checkout. Do NOT canonicalize the toplevel: continuity hashes
  git's raw output, and `/tmp` vs `/private/tmp` would break the match.
- **Continuity's coordination surface is global; only authorship is project-bound.**
  `message_send` fans out to EVERY live session and `decision_write` fans out as a message,
  so another repo's traffic legitimately lands in this project's inbox (scoped by recipient)
  while its decisions do not (scoped by author). That asymmetry is intended: `FeedMessage.foreign`
  is set in `read_messages` when the SENDER is outside the scope set, and the panel dims and
  badges those rows. The projection decides it — the UI never re-derives scope.
- UI: `ContinuityPanels.tsx` (rows + detail modal), tabs in `RightColumn.tsx`, state in
  `store.ts` (`continuityFeed`), polled at 4 s by `hooks/useContinuityFeed.ts` —
  deliberately separate from `useBoard`'s 1.5 s poll and its `board_enabled` gate.
- Design: `docs/superpowers/specs/2026-08-14-continuity-panels-design.md`.

## Where Command Code lives

A sixth agent (`npm i -g command-code`), fronting ~58 models from one subscription.

- **The binary is `cmd`, which is unusable on Windows.** Use `agent::COMMAND_CODE_BIN`,
  never a literal: it is `cmdc` on Windows and `cmd` elsewhere, matching Command Code's own
  `getBinaryCommand()`. A bare `cmd` on Windows resolves to System32's shell, and Conduit
  spawns sessions as `cmd.exe /K "cd /d <dir> && <agent>"` -- so it would open a nested
  command interpreter instead of the agent.
- **Hooks:** `hooks::command_code_profile()` -> `.commandcode/settings.local.json`. Command
  Code implements Claude's hook SCHEMA, so the generic installer carries over, but it fires
  only FOUR events (`PreToolUse`/`PostToolUse`/`Stop`/`SessionStart`). Do not add Claude's
  others -- they would be dead keys in a file Conduit does not own. Consequence: no `prompt`
  verb, so a session reads `running` from its first tool call, not the keystroke.
- **Resume:** there is no `--session-id` to pin Conduit's id, so Command Code's own
  `session_id` is captured from the `SessionStart` hook body into
  `Session.agent_conversation_id` and replayed as `--session <id>`. This looks like agy's
  problem and is NOT: the payload and the hook URL carry both halves of the mapping in one
  request, so no baseline or filesystem scan is involved. `source != "resume"` is what lets a
  stale id be replaced instead of pinned forever.
- **Usage:** `commandcode_usage.rs` reads `api.commandcode.ai/alpha/usage/summary` with the
  key from `~/.commandcode/auth.json`. `/alpha/` is an internal surface and WILL move, so
  every field is optional and an unknown shape degrades to `source: "unavailable"`.
- **Config GUI:** `commandcode_config.rs` + `CommandCodePanel.tsx` patch
  `~/.commandcode/config.json` behind a Rust-side allowlist, preserving unknown keys, backing
  up once, merging `featureModels` key-by-key, and refusing a file that does not parse.
  It never writes `settings.json` (team-committed, and its `hooks` key belongs to the hook
  installer).
- Design: `docs/superpowers/specs/2026-08-23-command-code-agent-design.md`.

## Where agent routing lives

Task-shaped preferences: a task kind (planning / implementation / review / research /
bulk) maps to an ORDERED chain of targets (agent + optional model). The order IS the
fallback, so one list covers preference, a missing CLI, and a spent quota.

**The work is split across two languages and must not become a fork.** Rust
(`routing.rs`) owns WHAT the preferences are -- built-in defaults, overlaid by global,
overlaid by project, all sparse so an override of one kind keeps inheriting the rest.
TypeScript (`src/routing.ts`, `pickTarget`) owns WHICH target is usable right now, because
that needs the live usage snapshot already in the store. Neither re-implements the other.

- **Defaults derive from `agent::capability_card`**, so an opinion about an agent lives in
  one place. A default chain must reach a SECOND AGENT, not just a second model -- one
  agent's windows all close together, so a Claude-only chain is not a fallback. A test
  enforces it.
- **Unknown quota is not exhausted quota.** Agents with no usage API carry
  `remaining: null` and stay routable; treating null as 0 would silently make "no meter"
  mean "never route here".
- `usageRows.ts` holds the shared "how full is this account" arithmetic so the usage bar
  and the router cannot disagree. `--model`/`--effort` are gated by
  `ProviderAdapter::supports_model_flags`, not by naming Claude.
- Design: `docs/superpowers/specs/2026-08-23-agent-routing-preferences-design.md`.

## Where the rich session view lives

An opt-in pane (`SessionChat.tsx`, Settings -> General) that renders a session's
conversation instead of its terminal output, fed by `transcript::session_transcript` over
the JSONL Claude already writes. No model generates it and none summarizes it -- it is a
renderer over a file, and costs nothing.

**It covers the terminal; it never replaces it.** The pane is an absolutely positioned
sibling inside `.term-host`, so the xterm stays mounted and attached (the keep-alive rule
above). Two consequences worth keeping: a session revealed with the pane open must not pull
terminal focus, or the caret lands behind the pane -- and that check reads a REF, since
adding it to the reveal effect's deps would re-run a fit and its spawn branch on every
toggle. Claude-only, enforced in `session_transcript` rather than assumed in the view.

## Where multi-account assignment lives

Accounts are per-agent profile pointers (`Account { agents, configDir }`, `store.rs`), assigned
per session (`Session.account_id`) or per project (`Project.default_accounts`), resolved at
spawn by `session_account_config_dir` (session -> project default -> global default -> env).
The account->env redirect is the `ProviderAdapter::account_env` seam (`agent.rs`) -- Claude +
agy override it; a future agent implements only that method. UI: `AccountList.tsx` (registry,
agent tags, per-agent + per-project defaults), the new-session dialog picker, and the
right-click "Account" submenu in `Sidebar.tsx`. Design:
`docs/superpowers/specs/2026-07-12-multi-account-orchestration-design.md`.

## Where the launch selection lives

Which project a cold start lands on. `store.load()` used to take `projects[0]`, so the
TOPMOST project opened (and, under `restoreSessionsOnOpen`, every one of its sessions
spawned) no matter what the user was last in — and a sidebar drag-reorder silently changed
which project launched.

- The decision is `initialProjectSelection` in `src/startup.ts`, kept pure because
  `store.ts` cannot be imported under the node-env vitest (it touches `localStorage` and
  the Tauri bridge at module scope). `src/startup.test.ts` covers it.
- **A stale or absent memory resolves to `null`, never to `projects[0]`.** Falling back to
  the first project is the exact bug; a fallback would reproduce it once on every machine's
  first launch after the change and then hide it. `null` is also free — no selected project
  means `Terminal.tsx`'s eager-spawn effect (`projectId !== selectedProjectId`) starts
  nothing, and `WorkspaceCenter` already renders an empty state for it.
- **The memory is written by a `useStore.subscribe` at the bottom of `store.ts`, not by
  each action.** Seven code paths move `selectedProjectId` (select project/session, open to
  side, add project, add session, reopen closed tab, remove project); a memory six of them
  forget to update is worse than none.
- User-facing switch: `openBehavior` (`"last"` default | `"none"`), Settings → General.

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

## Where the session status rules live

The per-session status (`idle`/`running`/`needsInput`/`done`) is derived TWICE from the same
hook stream — `fleet.rs`'s `apply_event` (what `fleet_list` and the Conductor read) and the
`switch` in `App.tsx` (what the sidebar dot renders). The time-aware rules that govern both
live in **one module per side and must not fork**: `src-tauri/src/status_rules.rs` and
`src/statusRules.ts`. They own three things — the 20-minute stale-`running` watchdog (swept by
`FleetState::sweep_stale_working`, broadcast as the `session-stale` event so the frontend map
agrees), the 3-second done-holdoff against out-of-order tool hooks, and the classification of
`notification` by `notification_type` (`idle_prompt` only ever retires a stuck turn; unknown
types are a no-op). Design:
`docs/superpowers/specs/2026-08-10-nodeterm-lessons-round-2-design.md`.

## Where the transcript readers live

Four separate consumers read Claude's transcript store, and all of them resolve it per
session (`store.session_account_config_dir` → `<cfg>/projects`, else `pty::claude_projects_dir`)
because a session on a non-default account writes elsewhere: `transcript.rs` (mobile chat
items), `context_window.rs` (the per-tab context meter — scans BACKWARDS with a substring
pre-filter and reads only the trailing 1 MB; the window is resolved by model FAMILY because
Claude Code runs opus/sonnet at 1M while the id stays bare), `subagents.rs` (the right panel's
Agents tab), and `transcript_index.rs` (palette search over past conversations). All are
read-only and degrade to "show less" rather than erroring.

## Where session persistence's safety net lives

`tmux.rs` wraps spawns; two modules keep that honest. `scrollback.rs` persists 256 KB of each
terminal's recent output (cut on a UTF-8 boundary) and replays it into the FIRST frame of a
COLD spawn only — warmth is decided by `tmux::has_session` BEFORE the wrap, since
`new-session -A` erases the difference afterwards. `session_budget.rs` retires abandoned
sessions under memory pressure. Its safety contract is load-bearing: a reap kills the tmux
session and **nothing else** — never the snapshot, never the session record — so a reaped
session is indistinguishable from one that lost its tmux server to a reboot. `pty::kill` (a
destroy) is the only place a snapshot is deleted.

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
