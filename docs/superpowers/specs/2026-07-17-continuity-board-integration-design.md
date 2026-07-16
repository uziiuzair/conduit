# Continuity-backed handoffs & awareness on the task board — design

**Status:** proposed (2026-07-17)
**Scope:** Ship `continuity-mcp` with Conduit and use it as the **handoff + awareness layer**
for the project task board. Continuity gives every session a distinct identity and the board
gains: **session→session handoffs carrying AI context** (the thing the board has no equivalent
for today), **live presence** (who is actually working a card right now), and a path to shared
**decisions**. The board keeps its own durable, git-shared file claims as the source of truth
for ownership; continuity is the live/transient coordination layer on top. Spans two repos:
Conduit (host) and `~/ooozzy/continuity-mcp` (one small change).

## Origin

The task board (v0.14.0 substrate + v0.15.0 stage-gate) can show *who claimed* a card, but it
has no way to answer "is that agent still alive on it?" and, more importantly, no way for one
agent to **hand a card to another with the context it built up** — what it did, which files it
touched, what to do next. `continuity-mcp` (the user's own project) already solves exactly this
for parallel Claude Code sessions: **presence**, **file-activity awareness**, typed **decisions**,
atomic **task-claims**, structured **handoffs**, and an audit log — Local (SQLite, zero-config)
or Team (Neon + Cloudflare Worker) flavors behind a `ContinuityBackend` seam. This design wires
that in as the board's coordination backbone without disturbing the durable board files.

## Problem

- **No handoffs.** When a session stops mid-card (context window full, human ends it, or it wants
  a fresh agent to continue), everything it learned is lost. The next agent starts cold.
- **No live presence.** The board's claim badge says `s2` holds a card, but not whether `s2` is
  still alive and working, idle, or gone — so a stale claim looks identical to an active one.
- **Continuity doesn't fit Conduit out of the box.** Continuity identifies a session by its git
  checkout (`cwd_hash`) and enforces **one live session per checkout**
  (`agent_sessions_cwd_live_uq`, `schema.sqlite.ts:203`). Conduit runs *many* sessions in one
  project folder, so they collapse into a single continuity identity — handoffs between two
  same-folder sessions become impossible.

## Goals

1. **Bundle continuity with Conduit** (Local/SQLite flavor, zero-config) and enable it per project
   alongside the board.
2. **Give every Conduit session a distinct continuity identity** via a session-id override.
3. **Card-scoped handoffs**: an agent hands off a card with a context blob + suggested next actions;
   the next agent sees it, reads it, accepts it, and continues.
4. **Live presence on cards**: show whether a card's claimant is live / idle / gone right now.
5. **Keep the board's file claim authoritative** for ownership; continuity never owns the durable claim.
6. **Isolate the alpha coupling.** Continuity is `0.1.0-alpha` ("may break without notice"). Conduit
   touches it through exactly two seams: the plugin's MCP tools (agents write) and one read-only
   adapter (board reads). Everything degrades gracefully if continuity is absent.

## Non-goals

- **No full coordination-backbone rewrite.** The board's claim stays file-based; continuity does
  NOT become the claim of record (avoids the `(repo, issue_number)` vs card-UUID mismatch).
- **No Team flavor** in v1 (no Neon/Worker/API-key). Local SQLite only.
- **No decisions↔OKF wiring yet.** Continuity `decision_*` tools are available to agents, but the
  board doesn't yet surface/sync them into the `knowledge/` bundle. Later increment.
- **No GitHub-Projects / plan-check / escalate** (those are continuity's team-only tools).
- **No rich rendered-artifact drawer** (the Agent Dev Tracker style). The card detail panel here is
  intentionally light — enough to show handoff context, not a markdown-artifact renderer.

## Key decisions (locked in brainstorming)

| # | Decision | Rationale |
|---|---|---|
| D1 | Continuity = **handoff + awareness layer**, not the claim of record | Board's durable file-claim already works; continuity fills the *missing* pieces (handoffs, presence) without the issue-number claim mismatch. |
| D2 | **Extend continuity** with a `CONTINUITY_SESSION_ID` identity override | Conduit's many-sessions-per-folder model needs per-session identity; a small change to the user's own tool, works whether sessions share a cwd or use worktrees. |
| D3 | Board **reads continuity's SQLite directly** (one read-only Rust adapter) | Live presence/handoff badges need a fast local read; isolating it in one file contains the alpha-schema coupling. |
| D4 | **Local flavor only**, zero-config, per-project (reuse `board_enabled`) | "Shipped with Conduit" ⇒ no deploy step; matches the board's opt-in gate. |
| D5 | **Light card-detail panel** (not click-less) | Handoff context needs a place to render; a basic panel is the minimum. |

## Architecture

### The two coordination layers (now three, cleanly split)

| Layer | Owner | Storage | Lifetime | Owns |
|---|---|---|---|---|
| Task board | `tasks.rs` | `<repo>/.conduit/` files | durable, git-shared | *what work exists* + authoritative claim |
| Continuity | `continuity-mcp` | `~/.continuity/continuity.db` (SQLite) | live, machine-local | *who's live, handoffs, decisions* |
| Blackboard | `board.rs` | in-memory ring | transient | Mission/Result/Note bus (unchanged) |

Continuity is the durable-across-restart-but-machine-local **live coordination** layer. It sits
between the ephemeral in-memory blackboard and the git-shared board files.

### Continuity surface used (grounded in the research)

Agents call these via the bundled plugin (namespaced `mcp__plugin_continuity_continuity__<tool>`):
- **Handoffs** — `handoff_create {to_session_id?, project_scope, context, state, suggested_next_actions}`,
  `handoff_pending`, `handoff_accept`, `handoff_complete` (`handoffs.ts:7-73`).
- **Presence** — `agent_report_focus {current_focus}` (heartbeat), `agent_list_active` (`agent.ts`).
- **Decisions** — `decision_write` / `decision_recent` / `decision_get_by_key` / `decision_supersede`
  (available to agents; board sync deferred).

Data model (SQLite, `schema.sqlite.ts`): `handoffs` (`:279-294`) — `{id, from_agent_session_id,
to_agent_session_id, project_scope, context, state, suggested_next_actions, status(pending|
accepted|completed|expired), created_at, accepted_at, completed_at}`; `agent_sessions` (`:187-204`)
— `{session_id, agent_label, current_focus, status(active|idle|gone), last_seen_at, cwd_hash}`.
DB at `~/.continuity/continuity.db`, WAL mode (`db.ts:26-39`).

### Card-scoping convention (the key glue)

Continuity has no "card" concept; its handoffs carry a free-text `project_scope`. We define a
stable convention:

```
project_scope = "conduit:<projectId>:card:<cardId>"
```

A card handoff sets this scope; the board finds a card's handoffs by querying continuity for that
exact scope string. Presence is matched to a card via its **claimant session id** (the board's
`.claims/<cardId>.json.by` == a continuity `agent_sessions.session_id`).

### Session identity (the one continuity change)

`~/ooozzy/continuity-mcp`, `gate.ts` / `checkin`: honor an explicit **`CONTINUITY_SESSION_ID`**
(and/or the existing `CONTINUITY_AGENT_ID`) env — when set, it becomes the session identity
instead of the `cwd_hash`-derived one, and the one-live-session-per-cwd unique index is scoped
to that id. Conduit sets `CONTINUITY_SESSION_ID = <conduit session id>` at spawn, so every
Conduit session is a distinct continuity identity even in a shared project folder. Small,
localized change in the continuity repo; ship a matching continuity release Conduit bundles.

### Data flow

```
agent (claude/agy session)
  │  writes: handoff_create / agent_report_focus / decision_write
  ▼
continuity plugin MCP (stdio, bundled) ── writes ──▶  ~/.continuity/continuity.db  (SQLite)
                                                             │
Conduit Rust ── continuity_read.rs (rusqlite, READ-ONLY) ───┘
  │  queries: presence for claimant sessions + handoffs scoped to conduit:<proj>:card:*
  ▼  emits board-changed
Board UI ── presence dot · ↪ handoff badge · handoff context in card detail
```

- **Agents write** through the plugin's MCP tools only. Conduit never writes continuity.
- **Board reads** through `continuity_read.rs` — a single read-only module using `rusqlite`
  (bundled SQLite). It opens `~/.continuity/continuity.db` read-only, runs a small fixed set of
  `SELECT`s (presence by session id; handoffs by `project_scope` prefix), maps rows to a
  `ContinuityView` DTO. **This is the only place Conduit knows continuity's schema** — if continuity
  changes its schema, only this file breaks, and the board degrades to "no presence/handoffs."
- **Refresh:** on any board mutation we already emit `board-changed`; additionally poll the
  continuity DB `mtime` ~1.5s while the board view is open (same pattern as `useFileWatch`), and
  re-query on the poll. A handoff/presence change by an agent shows within ~1.5s.

> **Dependency note (lean-deps rule).** CLAUDE.md keeps the Rust side free of heavy clients (curl
> instead of reqwest). Reading a SQLite file genuinely needs an SQLite library — there is no
> curl-equivalent — so `rusqlite` (with the `bundled` feature, no system SQLite required) is a
> **deliberate, justified new dependency**, confined to `continuity_read.rs`. Alternative
> considered + rejected: agents mirroring handoff state into card files (no dep, but loses live
> presence, which is a stated goal). Flagged for veto before implementation.

### Shipping continuity

- Bundle the continuity **plugin** payload (`plugin/` — `.claude-plugin/plugin.json`, `.mcp.json`,
  `hooks/hooks.json`, `scripts/*.mjs`, `mcp/{launch.mjs,index.mjs}` — pure JS, ~428KB, MIT) as a
  Conduit asset (like the role personas). On spawn of a session in a **board-enabled** project,
  Conduit writes the continuity MCP-server config into the session (alongside the existing
  fleet-MCP config in `pty.rs` / `write_mcp_config`), sets `CONTINUITY_SESSION_ID`, and (Local
  flavor) leaves `CONTINUITY_API_URL/KEY` unset so it runs against `~/.continuity/continuity.db`.
- **Node ≥ 22.5 required** (continuity's `node:sqlite`). Conduit detects Node + version at first
  use; if missing/old, it **skips** wiring continuity and shows a one-line notice — the board and
  all existing features work unchanged (graceful degrade). Never a hard failure.
- Enablement reuses the per-project `board_enabled` flag (§Plan A). No continuity for
  non-board projects.

### Card anatomy

**In-column card** (extends today's `BoardCard`): title · labels · **claim badge** (who) ·
**presence dot** (green live / amber idle / gray gone, from continuity) · stage badge ·
**↪ handoff** badge (a pending continuity handoff is scoped to this card) · "needs you" gate badge.

**Card detail panel** (click a card → right-side panel; light): body · claim + live presence ·
**incoming handoff** (context blob + `state` + suggested next actions, with Accept) · comments ·
links · workflow/history. Rendered from the board card + the `ContinuityView`. Markdown is shown
as plain text in v1 (no artifact renderer).

### Claim ↔ presence reconciliation

The board file-claim stays authoritative. `continuity_read.rs` maps each card's `claim.by` to a
continuity `agent_sessions.status`. UI rules: `active` → green dot; `idle` → amber; `gone`/unknown
→ gray + the card renders **stale** (already auto-releasable by our lease/liveness path). No change
to `claim_card`'s CAS — presence is display + a hint for the existing liveness closure.

## Component boundaries (isolation)

| Unit | Responsibility | Depends on | Tested by |
|---|---|---|---|
| continuity `gate.ts`/`checkin` change | honor `CONTINUITY_SESSION_ID` | env | continuity's vitest (separate repo) |
| Conduit spawn wiring (`pty.rs`/`lib.rs`) | write continuity MCP config + identity env when board-enabled + Node OK | Node detection | Rust tests for the gate + env assembly |
| `continuity_read.rs` | read-only SQLite → `ContinuityView` DTO | `rusqlite`, DB path | Rust tests against a fixture DB |
| `ContinuityView` DTO + Tauri command | presence + card handoffs for a project | `continuity_read` | Rust tests |
| `BoardCard`/detail panel + `useBoard` | render presence dot, handoff badge, detail | Tauri commands, events | manual launch (no FE runner) |

## Increments

- **Inc 0 (prereq, continuity repo):** add `CONTINUITY_SESSION_ID` override + a release. Small.
- **Inc 1 (Conduit — plumbing):** bundle the plugin asset; Node ≥22.5 detection + graceful skip;
  write continuity MCP config + identity env at spawn for board-enabled sessions. Result: agents
  can `handoff_create`/`accept` and heartbeat presence — no board UI yet. Verify two sessions
  hand off a card end-to-end via the tools.
- **Inc 2 (Conduit — surface it):** `rusqlite` dep + `continuity_read.rs` + `ContinuityView`
  command + `board-changed`/poll wiring; presence dot + ↪ handoff badge on `BoardCard`; the light
  card-detail panel with the incoming-handoff context + Accept. The card-scope convention
  (`conduit:<proj>:card:<id>`) is documented for agents (persona/brief note).
- **Later:** decisions ↔ OKF `knowledge/` sync; Team flavor; richer artifact rendering in the panel.

## Testing

- **continuity (separate repo):** its vitest covers the identity override (distinct sessions for
  distinct `CONTINUITY_SESSION_ID`, same cwd).
- **Rust:** `continuity_read.rs` against a fixture `continuity.db` (create tables per the documented
  DDL, insert a handoff + presence rows, assert the `ContinuityView` mapping + scope filtering);
  spawn-wiring gate tests (board-enabled + Node-present ⇒ config written; Node-absent ⇒ skipped).
- **Frontend:** `pnpm exec tsc --noEmit` + launch (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm
  tauri dev`): two sessions, one hands off a card, confirm the ↪ badge + presence dot + context in
  the detail panel; kill a session, confirm its presence goes gray + claim renders stale.

## Conduit integration points

| Concern | Hook | Where |
|---|---|---|
| Per-session MCP-config write + env | `write_mcp_config` / spawn env | `fleet.rs` / `pty.rs` |
| Who gets fleet/continuity MCP | `gets_fleet_mcp` / `board_enabled` | `lib.rs:181` / `store.rs` |
| Board refresh event | `emit("board-changed", …)` | `fleet_mcp.rs` / `lib.rs` |
| External-file polling model | `useFileWatch.ts` (1500ms) | `src/hooks/` |
| Card render | `BoardCard.tsx`, `useBoard.ts` | `src/components/` |
| Claim liveness (reuse presence as a hint) | `claim_card(..., live)` | `tasks/mod.rs` |

## Continuity integration points (research-grounded)

| Concern | Fact | continuity file |
|---|---|---|
| Handoff tools | create/pending/accept/complete | `packages/mcp/src/tools/handoffs.ts:7-73` |
| Handoff row | `{from/to_session, project_scope, context, state, suggested_next_actions, status}` | `packages/shared/src/types.ts:120-133`; `schema.sqlite.ts:279-294` |
| Presence | `agent_report_focus`, `agent_list_active`; `agent_sessions.status/last_seen_at` | `tools/agent.ts`; `schema.sqlite.ts:187-204` |
| Identity keyed by cwd (to override) | `cwd_hash`, `agent_sessions_cwd_live_uq` | `gate.ts:86`; `schema.sqlite.ts:203` |
| DB path + WAL | `~/.continuity/continuity.db`, `CONTINUITY_DB_PATH` | `index.ts:43-45`; `db.ts:26-39` |
| Launch (stdio, Node ≥22.5, flavor via API env) | `plugin/mcp/{launch.mjs,index.mjs}`; `resolveRuntime` | `index.ts:49-63` |
| Shippable bundle | `plugin/` (pure JS, MIT, alpha 0.1.0-alpha.2) | `plugin/**` |

## Open questions (defaults chosen)

- **`rusqlite` dep** — accepted as a justified exception to lean-deps (see note). Veto ⇒ fall back
  to agents mirroring handoff state into card files, dropping live presence.
- **Node absent** — graceful skip (board unaffected). Default; not a hard requirement.
- **Card-detail panel** — included (light). Could go inline-only if preferred.
- **Presence dot colors** — green/amber/gray for active/idle/gone.

## References

- Research: continuity tool surface + data model + `ContinuityBackend` seam + embedding options
  (this session).
- continuity repo: `~/ooozzy/continuity-mcp` (`README.md`, `docs/architecture.md`,
  `packages/{shared,mcp}`, `plugin/`).
- Board: `docs/superpowers/specs/2026-07-16-project-task-board-design.md` (+ Plan A/B).
