# Multi-account orchestration — implementation plan

Companion to `docs/superpowers/specs/2026-07-12-multi-account-orchestration-design.md`.
Three independently-shippable phases; each keeps single-account behavior unchanged and is
verified with `cargo test`, `cargo clippy`, `cargo fmt --check`, `pnpm exec tsc --noEmit`,
and a live app launch (frontend has no test runner).

Legend: **R** = Rust (`src-tauri/src`), **T** = TypeScript (`src`).

---

## Phase 1 — Account model + manual assignment

Goal: register agent-tagged accounts, assign them per session and per project, from Settings,
new-session dialog, and right-click. No usage/policy changes yet.

### 1.1 Model (R)
- `store.rs` `Account` (`:256`): add `#[serde(default)] pub agents: Vec<AgentId>`. Empty
  vec on load → treat as `[Claude]` (migration helper `account_agents(&Account)`).
- `discover_accounts`/`push_candidate` (`:832`,`:359`): detect `agents` by probing
  `<root>/.claude` and `<root>/.gemini/antigravity-cli`.
- `PersistState` (`:308`): add `#[serde(default)] pub default_accounts: HashMap<AgentId,String>`;
  keep `default_account` and migrate it into `default_accounts[Claude]` on load. `Store`
  gains `default_accounts: Mutex<HashMap<..>>`.
- `Project` (add field): `#[serde(default)] pub default_accounts: HashMap<AgentId,String>`.
- `AgentId` (`agent.rs:7`): derive `Hash, Eq, Serialize` map-key-usable (add `Deserialize` key
  support — serialize as its lowercase string).

### 1.2 Resolver (R)
- Extend `session_account_config_dir` (`:591`) to the chain
  session → `project.default_accounts[agent]` → `default_accounts[agent]`, filtering
  candidates by `account.agents.contains(agent)`. Needs the session's project + agent in
  scope (walk projects once, capture both).
- Unit tests: each rung of the chain; agent-mismatch skip; legacy `default_account` migration;
  empty maps = env inheritance (today's behavior).

### 1.3 `account_env` seam (R, behavior-preserving)
- Add `fn account_env(&self, account:&Account)->Vec<(String,String)>` to `ProviderAdapter`
  (`agent.rs`), default `vec![]`.
- Claude impl: the `.claude`→parent HOME/USERPROFILE-or-`CLAUDE_CONFIG_DIR` logic currently in
  `pty.rs:304-329`. agy impl: same profile-root redirect (`resolve_agy_home` logic).
- `pty.rs`: replace the inline block with `for (k,v) in adapter.account_env(&account) { cmd.env(k,v) }`.
  Assert byte-identical env for the existing single-account path (snapshot test on the vec).

### 1.4 Commands + bindings (R + T)
- R: `set_default_account` → generalize to `set_default_account(agent, account_id?)`; add
  `set_project_default_account(project_id, agent, account_id?)`. Register in `lib.rs`.
- T `store.ts`: add `accounts` agent field to `Account` (`:52`); add `setSessionAccount`
  (wraps existing `set_session_account`), `setDefaultAccount(agent,id)`,
  `setProjectDefaultAccount(projectId,agent,id)`; mirror `Project.defaultAccounts`.

### 1.5 UI (T)
- `AccountList.tsx`: per-account agent tags (checkboxes), per-agent default pickers, a
  per-project defaults table, and a placeholder for the policy control (wired in phase 3).
- `NewSessionDialog.tsx`: account `<select>` (agent-matched via `account.agents`, default
  project→global), passed through `opts.account` → `addSession` → `add_session` (thread a new
  optional `account_id` param, else keep `None`).
- `Sidebar.tsx` `SessionContextMenu` (`:492`): add an "Account ▸" nested list (eligible
  accounts + "Use project default" + "Manage accounts…"); first submenu pattern — a small
  absolutely-positioned sub-panel, dismiss rules shared with the parent. Project menu (`:406`)
  gets "Default accounts…" → open Settings on Accounts.

### 1.6 Verify
- `cargo test` (new resolver + `account_env` snapshot tests), clippy, fmt, tsc.
- Live: register two accounts, assign different accounts to two sessions in one project,
  confirm each `claude`/`agy` spawns under the right profile (check `whoami`/account in each).

---

## Phase 2 — All-accounts usage bar

Goal: usage keyed per account; one unified panel driven by view preferences.

### 2.1 Re-key agy usage (R + T)
- `agy_usage.rs`: `AgyUsageState(Mutex<Option<AgyUsage>>)` → `Mutex<HashMap<String,AgyUsage>>`
  keyed by account id; `set(account_id,u)`, `get_all()`, `has_data` gate unchanged.
- `hooks.rs` (`:116`): resolve posting `session` → `store` → `account_id` (fallback: a
  home-path key) before `set`. Emit `agyusage` with `{ accountId, usage }`.
- T `store.ts`: `agyUsage` → `agyUsageByAccount: Record<string,AgyUsage>`; `App.tsx:180`
  listener merges by `accountId`.

### 2.2 Re-key Claude usage (R + T)
- `claude_usage.rs`: `fetch_claude_usage` takes/derives a list of **active** account ids
  (distinct `account_id` over sessions with a live PTY, plus default) and returns
  `Vec<(accountId, ClaudeUsage)>`. `ClaudeAuth.token` → `Mutex<HashMap<String,String>>`
  (per-account token cache); `connect_claude_plan_usage(account_id)`.
- T: `claudeUsage` → `claudeUsageByAccount`; `useClaudeAmbient.ts` polls the active set.
- "Active session" signal: confirm the PTY-alive source (resolve the spec open question here).

### 2.3 Usage-view preferences (R persist + T)
- Persist `UsagePrefs { layout, scope, windows, sort, lowThresholdPct, expanded }` (localStorage
  is fine, like `defaultAgent`; no Rust needed unless we want cross-device).
- T `store.ts`: `usagePrefs` + setters.

### 2.4 Unified panel (T)
- New `UsagePanel.tsx` replacing the mount of `ClaudeUsagePanel`/`AgyUsagePanel` in
  `Sidebar.tsx` (`:117-131`). Given the two per-account maps + prefs, build a flat list of
  `(account, agent, windows[])`, filter by `scope`/`windows`, sort by `sort`, render per
  `layout` (stacked rows / summary+expand / low-alert-only / selected-only). Keep the existing
  `Meter`/violet-vs-Claude coloring; reuse `AgyUsagePanel`/`ClaudeUsagePanel` innards as row
  renderers. Header gear opens the quick prefs menu.
- `Settings.tsx`: add a `usage` tab + `UsagePrefsPanel`.
- Keep `ClaudeStatusPill` polling mount intact.

### 2.5 Verify
- `cargo test` (agy map keying, Claude multi-account fetch shaping), tsc, clippy, fmt.
- Live: two accounts active → both meters show; switch each layout/scope/window pref and
  confirm; low-alert threshold highlights the right account; single-account default install
  looks identical to today.

---

## Phase 3 — Distribution policy

Goal: manual/round-robin/auto-failover as a user preference; failover leans on the board.

### 3.1 Policy state (R + T)
- `PersistState` + `Project`: `#[serde(default)] account_policy: Option<AccountPolicy>`
  (`Manual|RoundRobin|AutoFailover`), global default `Manual`. Command
  `set_account_policy(scope, policy)`; T bindings + the AccountList control from 1.5.

### 3.2 Round-robin (R)
- At `add_session` when no explicit account and policy=RoundRobin: pick the eligible
  (agent-matched, logged-in) account with the most remaining quota from phase-2 usage,
  tie-broken LRU; fall back to global default if usage unknown. Pure selection; unit-tested
  with a stubbed usage snapshot.

### 3.3 Auto-failover (R + T)
- Detection: on each usage refresh, mark an account "exhausted" when a window is disabled or
  remaining < `lowThresholdPct`. Emit an event; T surfaces a banner/action on affected
  sessions ("Account low — start next task on <healthy account>").
- Handoff: for fleet/Conductor work, route the **next** spawn to a healthy account via 3.2;
  the sibling reads the project board for context. Fully-automatic Conductor re-routing stays
  behind the policy flag and respects project-scoped board isolation (do not widen SPEC-0).
- v1 depth: detection + surfaced action + round-robin next-spawn. Document Conductor
  auto-routing as the follow-up.

### 3.4 Verify
- `cargo test` (round-robin selection, exhaustion detection), tsc, clippy, fmt.
- Live: force one account low (or stub), confirm round-robin picks the healthy one for a new
  session and the failover banner appears; manual policy = unchanged behavior.

---

## Cross-cutting

- **Version bump** on the release (three files in lockstep per CLAUDE.md).
- **Docs:** update this repo's CLAUDE.md "accounts" note once phase 1 lands; keep the spec as
  the record of *why*.
- **No AI-attribution commit trailer.** One `feat/<topic>` branch per phase, merge with
  `--no-ff`; never push/merge `main` without explicit approval.
- **Back-compat:** every new persisted field is `#[serde(default)]`; legacy `state.json`
  (bare array or object with `default_account`) migrates on load with a round-trip test.
