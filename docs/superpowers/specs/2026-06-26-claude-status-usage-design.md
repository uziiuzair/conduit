# Claude status + usage in Conduit — design

- **Date:** 2026-06-26
- **Status:** Approved (design); pending implementation plan
- **Topic:** Surface Anthropic service status (status.claude.com) and the user's Claude subscription usage inside Conduit as a passive ambient indicator — a sidebar-footer pill with a click-to-open detail popover.

## Context

Conduit is a Tauri desktop app (React 19 frontend + Rust backend) for running multiple real `claude` CLI terminals in one window. Relevant existing structure:

- **Shell layout** (`src/App.tsx`): `Sidebar │ WorkspaceCenter │ RightColumn`. The sidebar footer hosts `ThemeSwitcher.tsx` — the natural home for a new ambient pill.
- **State** (`src/store.ts`, Zustand): data reaches the frontend two ways — `invoke()` **pull** (git, files, projects) and Tauri **events** push (hooks → status/todos). There is **no polling of external services** today.
- **Rust backend** (`src-tauri/src/lib.rs`): commands registered in one `invoke_handler!`. Modules: `pty.rs`, `hooks.rs` (inbound `tiny_http` listener), `git.rs`, `fsops.rs`, `store.rs` (persists `~/Library/Application Support/ConduitTauri/state.json`), `notify.rs`, `bridge.rs`.
- **Dependencies are deliberately lean.** `Cargo.toml` has **no outbound HTTP client** (no `reqwest`). It already shells out to subprocesses: `claude -p` for naming, and hooks fire via `curl`. `serde_json` is present.
- **No settings panel exists** (only `ThemeSwitcher`). No global status bar.
- **Conduit does not handle Claude credentials** — it relies entirely on the `claude` CLI's own auth (OAuth token in the macOS Keychain on this platform; there is no `~/.claude/.credentials.json` on macOS).

Two relevant local data sources were verified during brainstorm:

- `status.claude.com/api/v2/summary.json` — a standard Atlassian Statuspage JSON API. Public, no auth. Returns overall `status.indicator`, `components[]` (claude.ai, Claude Console, **Claude API**, **Claude Code**, Claude Cowork, Claude for Government), and `incidents[]`.
- `~/.claude/stats-cache.json` — a local aggregation Claude Code maintains: `dailyModelTokens[]` (tokens by model per day), `dailyActivity[]` (sessions/messages/toolCalls per day), totals. This is **local consumption**, not subscription plan limits.

## Decisions (from brainstorm)

1. **Two features, one surface.** Status and usage share a single **sidebar-footer pill + click popover** (chosen over a RightColumn tab or a new top status bar). Lowest chrome; reuses the existing footer pattern and theme status-color tokens.
2. **Usage = "Both, resilient."** Show best-effort **subscription plan limits** (5-hour / weekly %) layered over always-available **local consumption** from `stats-cache.json`, with automatic fallback to local-only if the plan path is unavailable. The fragile dependency becomes a *progressive enhancement*, not a single point of failure.
3. **No OS notifications — passive only.** Everything lives in the pill/popover; nothing interrupts the user. This removes the need for state-change/notification machinery.
4. **Zero new `Cargo.toml` dependencies.** Make the two outbound HTTPS calls with `curl` (subprocess), parse with the existing `serde_json`, and read the Keychain token with the macOS `security` CLI. Matches Conduit's established subprocess patterns.
5. **Pull model, poll only while visible.** A frontend `setInterval` (~60s) calls the two `invoke` commands; polling pauses on `visibilitychange` and refreshes on resume. Justified by decision 3 — with nothing to push, a background Rust poller is unnecessary.

## Scope

**v1 core:**
- Status pill dot (operational / minor / major / critical / unknown) from `summary.json`.
- Popover: service components (dev-relevant first), active incidents (title · status · link).
- Local usage (always): today's tokens-by-model + session/message counts from `stats-cache.json`. **No dollar cost** (subscription users don't pay per token; `$` would mislead).
- Plan limits (best-effort, opt-in): "Connect plan usage" button → Keychain token → usage endpoint → 5-hour / weekly / weekly-Opus meters with reset times. Token held **in memory only, never persisted**.
- Graceful fallback and error isolation throughout.

**Out of scope (v1, YAGNI):** historical charts / sparklines · per-session usage attribution · cost estimation · scheduled-maintenance display · Windows/Linux Keychain equivalents (macOS-first) · configurable poll interval · OS notifications.

**Constraints accepted (documented, not solved):** the plan-limit endpoint is **undocumented** (see Key risk); macOS-only for the plan path (Keychain); reading the OAuth token triggers macOS's own Keychain allow prompt.

## Architecture

```
frontend  useClaudeAmbient (setInterval 60s, while visible)
   ├─ invoke("fetch_claude_status") ─► claude_status.rs ─► curl summary.json ─────► typed JSON
   └─ invoke("fetch_claude_usage")  ─► claude_usage.rs  ─► serde_json stats-cache.json (always)
                                                          └─ + curl usage endpoint (if connected)
        ▼
   Zustand slice { claudeStatus, claudeUsage, planConnected }
        ▼
   ClaudeStatusPill (sidebar footer, beside ThemeSwitcher)  ──click──►  ClaudePopover
```

Green-field vs reuse: **no change to existing behavior.** Everything is new Rust modules, a new Zustand slice, and new components mounted in the existing footer.

### Rust — components (new)

- **`claude_status.rs`** → command `fetch_claude_status() -> ClaudeStatus`. Runs `curl -s --max-time 8 https://status.claude.com/api/v2/summary.json`; parses into:
  - `ClaudeStatus { indicator: String /* none|minor|major|critical */, description: String, components: Vec<Component{name, status}>, incidents: Vec<Incident{name, status, impact, shortlink}>, fetchedAt }`.
  - On timeout / non-zero exit / bad JSON → `ClaudeStatus` with `indicator: "unknown"` (never errors to the frontend).
- **`claude_usage.rs`** → command `fetch_claude_usage() -> ClaudeUsage`.
  - Always: parse `~/.claude/stats-cache.json` → today's `tokensByModel` + `dailyActivity` (sessions/messages).
  - If `planConnected`: read the OAuth token from Keychain (in-memory cache), `curl -s --max-time 8 -H "Authorization: Bearer <token>" <usage-endpoint>`, parse windows.
  - Returns `ClaudeUsage { local: { tokensByModel, sessions, messages }, plan: Option<{ windows: Vec<Window{label, pctUsed, resetsAt}> }>, planSource: "live" | "unavailable" }`.
- **`connect_claude_plan_usage() -> bool`** — one-time consent action: read token from Keychain via `security find-generic-password` (triggers the macOS allow prompt), validate with a single usage call, on success persist a `planConnected: true` flag in `state.json`. **Never persists the token itself.**
- Register `mod claude_status; mod claude_usage;` and the three commands in `lib.rs`'s `invoke_handler!`. Persist `planConnected` via `store.rs`.

### Frontend — components (new)

- **Zustand slice** (`store.ts`): `claudeStatus`, `claudeUsage`, `planConnected`, plus `refreshClaudeStatus()`, `refreshClaudeUsage()`, `connectPlanUsage()` actions and their TS types.
- **`useClaudeAmbient.ts`** — immediate fetch on mount + `setInterval(60_000)`; pause on `document.hidden`, refresh on resume; isolate the two fetches (one failing never blocks the other).
- **`ClaudeStatusPill.tsx`** — footer pill: a status dot (color from `indicator`) + a compact usage figure (plan % if connected, else today's token total). Mounted beside `ThemeSwitcher` in the sidebar footer.
- **`ClaudePopover.tsx`** — on click: components list (Claude Code / Claude API / claude.ai first) with per-component dots; active incidents with latest update + link to `status.claude.com`; usage section — plan meters if connected, else local consumption plus the "Connect plan usage" button; a last-updated timestamp.

## Status half

- One `summary.json` call yields indicator + components + unresolved incidents.
- Dot color: `none`→green · `minor`→yellow · `major`→orange · `critical`→red · fetch-fail→gray "unknown". Reuses existing theme status tokens.
- Popover sorts dev-relevant components first; renders any active incident with its name, status, and a link out.

## Usage half ("Both, resilient")

- **Local (always):** today's tokens-by-model + session/message counts from `stats-cache.json`. Tokens and counts only — no `$`.
- **Plan limits (best-effort, opt-in):** default state is *not connected* — pill/popover show local usage and a "Connect plan usage" button explaining it reads Claude Code's login to show 5-hour / weekly limits. On connect → token from Keychain → usage endpoint → meters with reset times. Token read fresh per session, **in memory only, never written to disk**; if a read fails, fall back to local-only and flip `planConnected` off.
- **Fallback:** any plan-path failure → silently show local only, with a quiet "Plan limits unavailable" note.

## Error handling & resilience

- `curl` timeout / non-zero exit / unparseable JSON → typed "unavailable" result; pill shows last-known value + a subtle stale indicator; **never crashes**.
- Status and usage are isolated — a failure in one never affects the other.
- Offline → "status unknown" + last-known usage, no error spew. Polling pauses when the window is hidden and refreshes on resume.

## Security & privacy

The only sensitive operation is reading the Claude Code OAuth token. It is: (a) **opt-in** behind an explicit button; (b) gated by **macOS's own Keychain allow prompt**; (c) used **only** to call Anthropic's own usage endpoint; (d) **never persisted** by Conduit; (e) fully degradable. All network traffic goes only to Anthropic-owned hosts (`status.claude.com`, `api.anthropic.com`). No telemetry.

## Testing (TDD)

- **Rust unit tests first**, against captured fixtures (no network):
  - `summary.json` parser → `ClaudeStatus`.
  - `stats-cache.json` parser → local usage.
  - usage-endpoint payload parser → plan windows.
  - indicator→color mapping; the local+plan merge and fallback logic.
- **Frontend:** a mock `invoke` layer feeding fixtures to the Zustand slice; render the pill across all states (ok / minor / major / critical / unknown) and the popover (connected vs not, incident present vs not).
- **Manual:** cross-check against the live status API; verify local usage against `claude`'s own stats; the spike (below) validates the plan endpoint.

## Key risk → first task is a spike

The **plan-limit usage endpoint is undocumented**, and reading the OAuth token from the Keychain is platform-sensitive. Implementation **task #1 is a spike** to confirm:

1. the Keychain service/account name Claude Code stores its OAuth token under, and that `security find-generic-password` can read it (with the expected allow prompt), and
2. the exact usage endpoint + JSON payload shape that Claude Code's interactive `/usage` command calls.

Because the design is **resilient** (decision 2), **if the spike fails the feature still ships** — status + local usage are fully functional, and only the "% of limit / reset countdown" line is dropped. The spike's outcome is therefore a *go/no-go for the plan half only*, not for the feature.

## File-level change summary

**New**
- `src-tauri/src/claude_status.rs`
- `src-tauri/src/claude_usage.rs`
- `src/components/ClaudeStatusPill.tsx`
- `src/components/ClaudePopover.tsx`
- `src/hooks/useClaudeAmbient.ts`

**Edited**
- `src-tauri/src/lib.rs` — `mod` declarations + register the three commands.
- `src-tauri/src/store.rs` — persist the `planConnected` flag.
- `src/store.ts` — Zustand slice, actions, and types.
- `src/App.tsx` (or `Sidebar.tsx`) — mount the pill in the footer; start the poller.
- `src/theme.css` — only if a new token is needed (likely reuses existing status colors).
