# Multi-account orchestration + all-accounts usage — design

**Status:** proposed (2026-07-12)
**Scope:** Let a user run multiple agent accounts (e.g. two $20 Claude accounts + an agy
account) at the same time, assign accounts to sessions and projects, choose how load is
distributed across them (manual / round-robin / auto-failover), and see every active
account's usage at once in the sidebar under a view they configure. Claude + agy only in
v1; the rest is deferred behind clean extension seams.

## Problem

A single account has a 5-hour and a weekly quota window. When it runs out mid-work the user
today must stop, switch accounts, and hope conversation context carried over. Conduit already
lets two sessions in one project run different agents, and the backend can already pin a
session to a registered account, but:

- there is **no human UI** to assign an account to a session or project (only a single global
  default in Settings),
- **usage is a single global blob** for both Claude (reads only the default account) and agy
  (one snapshot; whichever session posts last clobbers the rest), so you cannot see which of
  several accounts is about to run out, and
- there is **no distribution logic** (no round-robin, no failover) and no way to express a
  preference for one.

The goal: distribute token consumption across accounts so the user does more, faster, without
any single window running dry, while keeping intel shared between the accounts that are
working the same project.

## Goals

1. Register and assign accounts **per session** and **per project (default)**, for Claude and
   agy, from Settings, the new-session dialog, and a right-click menu.
2. A user-selectable **distribution policy** per project (with a global default): manual,
   round-robin, or auto-failover.
3. Sibling sessions on different accounts in the same project **share context/intel** through
   the existing fleet MCP + project board (no account moves under a live session).
4. An **all-accounts usage bar** re-keyed per account, driven by a **usage-view preferences**
   layer (layout, scope, which windows, sort, low-threshold).
5. **Off by default.** Single-account users see exactly today's behavior until they opt in.
6. An **agent-agnostic framework** so Codex / Gemini / OpenCode (and credit-based billing)
   slot in later without reworking Claude/agy — and if a later approach is superior, Claude
   and agy migrate to it.

## Non-goals (deferred)

- Multi-account for Codex, Gemini, OpenCode (framework only; no wiring).
- Subscription↔credits handling and mixed billing modes (design must not preclude it; usage
  model already carries a "window" abstraction credits can extend).
- Any change to how a single account authenticates. Accounts stay directory pointers; no
  credentials in `state.json`.

## Current architecture (ground truth)

- **Account** = `{ id, label, configDir }` (`store.rs:256`), a pointer to a `.claude`
  profile. Registry + global default persist in `PersistState` (`store.rs:308`). CRUD +
  `discover_accounts` exist (`store.rs:613-869`).
- **Per-session binding exists**: `Session.account_id` (`store.rs:54`) resolves via
  `session_account_config_dir` = session id → global default → config dir (`store.rs:591`).
  Only caller today is `fleet_spawn(accountId)` (`fleet_mcp.rs:353`); **no frontend binding**.
- **Spawn isolation is already per-process**: `pty.rs:304-329` redirects HOME/USERPROFILE to
  the account's profile root (a `.claude` dir → its parent), so two PTYs on two accounts are
  already isolated. agy reuses the same redirect via `resolve_agy_home` (`agy_usage.rs:297`).
- **Agent is per-session** (`Session.agent`); two agents can coexist in a project today.
- **Usage is global**: Claude reads only `default_account_config_dir()`
  (`claude_usage.rs:202`); agy is one `Mutex<Option<AgyUsage>>` and the hook ignores which
  session posted (`hooks.rs:116`). Codex usage is dead, unwired code (`usage_tally.rs`).
- **Context sharing exists**: the project-scoped **board** (`board.rs`) + fleet MCP
  (`fleet_mcp.rs`). Note the documented, not-yet-fixed cross-project leak SPEC-0 in
  `fleet_peek`/`fleet_send` — multi-account sharing must stay project-scoped and not widen it.

## Design

### A. Agent-agnostic account model

An account today is really a **profile root** that can carry both a `.claude` login and a
`.gemini/antigravity-cli` login. We keep one registry entry per profile root (matches the
two-account-split on disk) but make the model agent-aware:

- Add `agents: Vec<AgentId>` to `Account` (which agents this profile is logged in for),
  auto-detected at add/discover (`.claude` present → `claude`; `.gemini/antigravity-cli`
  present → `antigravity`), user-editable. Back-compat: a legacy account with no `agents`
  is treated as `[claude]`.
- Replace the single global `default_account` with **per-agent defaults**:
  `default_accounts: Map<AgentId, AccountId>` (keep the old field, migrate it to the `claude`
  slot on load).
- Add a per-project default map: `Project.default_accounts: Map<AgentId, AccountId>`
  (`#[serde(default)]`, empty = inherit global).

**Extension seam (the "best practice" for future agents).** The account→env mapping is
currently hardcoded in `pty.rs`. Move it behind a `ProviderAdapter` method:

```rust
/// Env vars that make this agent run under `account`. Empty = agent has no
/// account concept (default). Called once at spawn; never logged.
fn account_env(&self, account: &Account) -> Vec<(String, String)> { vec![] }
```

Claude returns the HOME/USERPROFILE (or `CLAUDE_CONFIG_DIR`) redirect it does today; agy
returns the same profile-root redirect; Codex/Gemini/OpenCode return `vec![]` for now. Adding
a new multi-account agent later is: implement `account_env`, add an `agents` detector, done —
no change to `pty.rs`, the resolver, or the usage plumbing. This is behavior-preserving for
v1 (Claude/agy produce the exact env they do now); it just centralizes the seam.

### B. Assignment & resolution

Resolution order becomes **session → project(agent) → global(agent) → env**:

```
session.account_id
  ?? project.default_accounts[session.agent]
  ?? default_accounts[session.agent]
  ?? (no redirect — inherit Conduit's env)
```

`session_account_config_dir` (`store.rs:591`) extends to walk that chain and to filter by the
session's agent (an account is only eligible if `account.agents` contains it). A frontend
`setSessionAccount` binding (the missing piece) wraps the existing `set_session_account`
command; a new `set_project_default_account(projectId, agent, accountId?)` command + binding
covers project defaults.

### C. Distribution policy + context sharing

A per-project `accountPolicy: "manual" | "roundRobin" | "autoFailover"` (global default,
per-project override). Off by default = `manual`.

- **manual** — resolution exactly as (B). What you assign is what runs.
- **round-robin** — at **new-session** creation with no explicit account, pick the eligible
  account (agent-matched, logged in) with the **most remaining quota** (from the usage data
  in D), tie-broken by least-recently-used. Pure selection at spawn; no mid-session change,
  so no context loss. Falls back to global default if usage is unknown.
- **auto-failover** — each account (or project) names a **designated failover target**
  (another signed-in account/agent). Behavior on crossing a low threshold:
  - **opted in** (policy = autoFailover, target specified, target assumed signed in):
    Conduit **automatically** routes the next work to the target account/agent — no prompt.
  - **not opted in**: Conduit shows a **prompt** when usage hits the escalating thresholds
    **95% / 99% / 100%** — "Usage has hit N%. Fail over to <target account/agent>?" — and only
    switches on confirmation (target assumed signed in).

  In both cases Conduit does **not** move a *running* session's account mid-conversation
  (Claude transcripts are account-scoped and cannot follow). Failover routes **new** work to
  the target; the sibling on the target account picks up project context through the shared
  board. The designated target is a new per-account/per-project field
  (`failover_target: Option<{ accountId, agent }>`).

**Context sharing** is the existing project board — keyed by project, agnostic to account, so
two accounts on one project share freely while cross-project isolation (SPEC-0) is preserved.
Multi-account must not read/write another project's board.

### D. All-accounts usage (re-keying + view preferences)

**Re-key backend + store from one blob to per-account maps:**

- agy: `AgyUsageState(Mutex<Option<AgyUsage>>)` → `Mutex<HashMap<AccountId, AgyUsage>>`. The
  hook resolves the posting session (`CONDUIT_SESSION_ID`) → its `account_id` → key; sessions
  sharing an account dedup naturally. Store: `agyUsage` → `agyUsageByAccount: Record<...>`.
- Claude: poll usage for each **active** account (distinct `account_id` across sessions with a
  live PTY, plus the global default) rather than only the default. `ClaudeAuth.token` single
  mutex → `HashMap<AccountId, token>`; `fetch_claude_usage` iterates active accounts. Store:
  `claudeUsage` → `claudeUsageByAccount`. Bounded to active accounts to avoid request spam.

**Usage-view preferences** (persisted, drive one unified `UsagePanel` that replaces the two
agent-gated panels):

| Pref | Values | Default |
| --- | --- | --- |
| `layout` | `stacked` \| `summary` \| `lowAlertOnly` \| `selectedOnly` | `selectedOnly` |
| `scope` | `allActive` \| `allRegistered` \| `selected` | `selected` |
| `windows` | subset of `{ fiveHour, weekly, weeklyOpus, context }` | all |
| `sort` | `critical` \| `label` | `critical` |
| `lowThresholdPct` | number | 20 |
| `expanded` | bool (remembered) | collapsed |

`selectedOnly` + `scope: selected` reproduces today's single-panel behavior exactly, so the
default install is unchanged. The panel header carries a small gear/menu for fast switching;
the full set lives in a new Settings → **Usage** section. One unified renderer maps each
(account, agent) pair to a compact block filtered by `windows`, sorted by health, showing
only what the layout asks for.

### E. UX surfaces & user journey

- **Off by default.** With zero registered accounts, nothing changes: sessions inherit
  Conduit's env, one usage panel shows for the selected agent.
- **Settings → Accounts** (extend `AccountList`): register/label accounts, per-agent tags,
  per-agent global defaults, per-project defaults table, and the distribution policy control.
- **Settings → Usage** (new): the view-preferences from D.
- **New-session dialog**: an account picker (agent-matched; defaults project → global).
- **Right-click session menu**: "Account ▸" submenu (eligible accounts + "Use project
  default" + "Manage accounts…"). Introduces the first nested-menu pattern; keeps the
  existing flat buttons.
- **Right-click project menu**: "Default accounts…" → Settings (project row focused).
- **Usage panel**: header gear to switch layout/scope quickly; click a row to expand.

## Security / correctness

- Accounts remain directory pointers; **no credentials in `state.json`**; per-account tokens
  stay in memory only (`HashMap<AccountId, token>`), never logged.
- The `agyusage` endpoint stays untrusted localhost display data; keying it by resolved
  session→account changes nothing security-relevant (a spoof still only shows wrong numbers).
- Context sharing is **project-scoped**; this feature must not read/write another project's
  board and must not widen the SPEC-0 `fleet_peek`/`fleet_send` cross-project surface.
- `account_env` output is never logged; the redirect stays per-child-process.

## Phasing

1. **Model + assignment (manual).** `agents` tag, per-agent + per-project defaults, extended
   resolver, `account_env` seam, frontend `setSessionAccount` / project-default bindings,
   right-click + new-session UI. Ships the two-Claude-accounts use case end to end.
2. **All-accounts usage.** Re-key agy + Claude usage to per-account maps; unified `UsagePanel`
   + usage-view preferences + Settings → Usage.
3. **Policies.** `accountPolicy`; round-robin new-session selection (needs phase 2 usage);
   auto-failover detection + surfaced action + board-shared handoff.

Each phase is independently shippable and leaves single-account behavior untouched.

## Open questions

- "Active account" signal for Claude polling: exact source of "session has a live PTY"
  (confirm during phase 2).
- Auto-failover automation depth in v1: detection + manual action only, or wire Conductor
  re-routing now (leaning: detection + action in v1, Conductor routing behind the flag).
