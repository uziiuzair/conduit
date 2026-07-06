# Orchestration v2 — Implementation Plan

> Companion to `docs/superpowers/specs/2026-07-04-orchestration-v2-design.md`.
> Status: **proposal**. Date: 2026-07-04.
> Each phase ships standalone value; the security fix lands first. Line numbers
> are anchors as of this date — verify against the tree before editing.
>
> **2026-07-05 update:** Phase 0 and Phase 1 below (SPEC-0, SPEC-1/C/D) are
> **unchanged — execute them exactly as written here**, with **one addition**:
> SPEC-C now carries a mandatory amendment (see the callout inside that
> section) closing a caller-role/depth-cap gap a second audit pass found —
> read it before implementing SPEC-C. Phase 2 onward is
> **superseded** by
> `docs/superpowers/plans/2026-07-05-orchestration-v2-scope-expansion.md`,
> which covers all five adapters (tiered), the mailbox built in v1, and the
> per-adapter usage meter, per the owner's three locked-in decisions in
> `docs/superpowers/specs/2026-07-05-orchestration-v2-scope-expansion-design.md`.
> Do not implement this doc's Phase 2/3/4 sections (Codex/Gemini/Antigravity
> deferred, mailbox deferred) — they reflect the superseded recommendation.
>
> **2026-07-05 implementation update (later same day):** Phase 0 and Phase 1
> below both shipped — ✅ DONE, see their section headers for the as-built
> detail — on `feat/orchestration-v2` (off `build/f2-antigravity`). Everything
> from Phase 2 onward in *this* doc was correctly never implemented as written
> here; the companion scope-expansion plan's own per-phase headers are the
> as-built record for that work (0-8, X, 10 done/partial, Phase 4G blocked on
> a missing `gemini` binary, Phase 9 correctly not started — gated on
> real-world usage). The "Open decisions (owner)" section at the bottom of
> this file is stale as of this same date — see the note added there.

## Phasing at a glance

| Phase | Specs | Ships | Effort |
|---|---|---|---|
| 0 — Seal the perimeter | SPEC-0 | leak closed; safe to add sharing | S |
| 1 — Real results, not scrapes | SPEC-1, SPEC-C, SPEC-D | typed hand-back + event-driven fleet | M+M+M |
| 2 — Heterogeneous, cost-aware | SPEC-A, SPEC-B | route bulk to $0 local models | M+M |
| 3 — Awareness (+ opt-in) | SPEC-E (SPEC-F deferred) | mission board + capability cards | M |
| 4 — Cost governor + routing | SPEC-G, SPEC-H | honest usage bar + guardrailed routing | L+M |
| X — Windows meter | (part of SPEC-G) | subscription bar works on Windows | S–M |

Windows credential work is pulled forward out of Phase 4 (owner is on Windows;
the subscription meter cannot connect there today).

---

## Phase 0 — SPEC-0: close the cross-project leak — ✅ DONE (2026-07-05)

**Change.** In `fleet_mcp.rs`, both `fleet_peek` (124–150) and `fleet_send`
(195–228): resolve the target id against
`ctx.store.fleet_snapshot(conductor_id).sessions` **unconditionally**; return
`session-not-found` before any `ctx.pty.*` call. Keep `can_read`/`can_inject`
(under `private_mode`) layered on top. Mirror the pattern `fleet_stop` already
uses at 241–245.

**Implemented as:** a new `resolve_pair(store, conductor_id, target_id)` helper
in `fleet_mcp.rs` that resolves both caller and target against the caller's own
`fleet_snapshot`, deny-by-default (`session-not-found` on any foreign/unknown
id). Both `fleet_peek` and `fleet_send` call it before touching `ctx.pty`, with
`can_read`/`can_inject` layered on top exactly as before. Extracted as a pure
function (no `Ctx`/`AppHandle` needed) so it's directly unit-testable —
`Store::for_test` was widened to `pub(crate)` for this.

**Tests (Rust, `#[cfg(test)]`).** — all passing:
- [x] `resolve_pair_rejects_id_from_a_foreign_project` — `fleet_peek`/`fleet_send`'s shared gate on an id not in the conductor's project snapshot → `session-not-found`.
- [x] `resolve_pair_rejects_a_completely_unknown_id`.
- [x] `private_mode_still_denies_a_siloed_in_project_target_via_can_read` — membership resolves (same project) but the `can_read` overlay still denies.
- [x] `resolve_pair_allows_a_legitimate_in_project_worker` — regression guard.

**Verify manually.** Two projects, a running session in each; Conductor in A can
no longer peek/send B's session id. Ship as a security fix, no other coupling.
**Not yet done by the implementing agent** — requires a live two-project desktop
session; flagged for the human to confirm before merge (see CLAUDE.md: don't
PR/push until personally tested).

---

## Phase 1 — typed results over a project-scoped store — ✅ DONE (2026-07-05)

### SPEC-1: blackboard store — ✅ DONE
- **New module `board.rs`** (not `store.rs` — kept separate since the board must
  NOT live in `state.json`; see the design's own storage note): `BoardKind`
  (Mission|Result|Note), `BoardRecord { id, projectId, authorSession, kind,
  payload, createdAt }`, `BoardState { append(record), query(project_id, kind?) }`
  with a bounded (500-record) per-project ring, oldest evicted first.
- `query` deliberately does NOT apply `can_read` itself (would need a `Store`
  dependency for no benefit) — callers (`fleet_mcp.rs`) apply it against the
  `FleetSnapshot` they already hold, via a new shared `readable_by()` helper.
- serde camelCase, `#[serde(default)]` on `payload` for back-compat.
- **Tests (all passing):** `append_and_query_round_trip`,
  `query_never_crosses_projects` (no global accessor exists — every method
  requires a `project_id`), `ring_evicts_oldest_once_over_capacity`,
  `note_payload_shape`, `record_serializes_camel_case`.

### SPEC-C: structured result hand-back — ✅ DONE
- **`fleet_mcp.rs`:** `fleet_spawn`'s input schema gained optional `objective` /
  `outputShape` / `boundaries` (falls back to `task` when omitted, so an older
  plain call still yields a Mission). New `fleet_result(status, summary,
  artifactPaths?, tokens?)` and `fleet_results()` (Conductor-only reader,
  `can_read`-filtered) arms in `dispatch_tool`.
- On spawn, a `Mission` record is written to the board (author = the new
  worker's session id). Rather than folding objective/boundaries into the
  worker's initial prompt (design's original suggestion), the Mission record is
  the source of truth for awareness (`fleet_roster`, Phase 7); the worker still
  receives `task` as its prompt, unchanged — simpler and fully back-compatible.
- **Closed a real reachability gap:** `pty_spawn` only ever attached the fleet
  MCP server to `role == "conductor"` — a fleet-spawned Claude WORKER had no MCP
  connection at all, so `fleet_result` would have been unreachable. `pty_spawn`
  now also attaches the fleet MCP server (scoped to the worker's own id) when a
  worker has a Mission record on the board, with a small `WORKER_BRIEF_SUFFIX`
  system-prompt addition (not the full `CONDUCTOR_PERSONA`) telling it about the
  one tool it may call. A manual/custom worker (no Mission) is unaffected.
- **`fleet.rs`:** `CONDUCTOR_PERSONA` rewritten to teach the brief+result
  contract, `fleet_results()`, and "you'll be nudged, no need to poll."
- Kept `fleet_peek` as a rare, membership-gated (per SPEC-0) debug fallback.
- **Schema honesty:** `tokens` documented as self-reported/best-effort in the
  code comment; `fleet_results`'s doc string says a missing result means "not
  reported yet", not "failed".
- **Tests (all passing):** `authorize_allows_fleet_result_from_worker_role`,
  `readable_by_hides_a_siloed_authors_records_from_an_over_clearance_reader`,
  `persona_teaches_the_brief_and_result_contract`, `tools_list_includes_all_seven`.

> **2026-07-05 amendment — implemented, not skipped.** `authorize(store,
> conductor_id, tool)` is called as the first line of `dispatch_tool`, with
> `WORKER_ALLOWED = ["fleet_result"]` (only). Implemented as a function taking
> `&Store` rather than `&Ctx` (per the design's illustrative signature) so it's
> unit-testable without a Tauri `AppHandle` — same rationale as SPEC-0's
> `resolve_pair` extraction. **Tests (all passing):**
> `authorize_rejects_orchestration_tools_from_worker_role` (parameterized over
> fleet_spawn/fleet_send/fleet_stop/fleet_peek/fleet_list),
> `authorize_allows_fleet_result_from_worker_role`,
> `authorize_allows_all_tools_from_conductor_role`.

### SPEC-D: reactive fleet — ✅ DONE
- **`hooks.rs`:** `start` now also takes `Arc<Store>` + `Arc<PtyManager>` (pulled
  forward from where the scope-expansion plan assigned this to Phase 3 — SPEC-D
  needs it immediately, so Phase 3's equivalent task is already satisfied).
  After `fleet.record(...)`, a wake-eligible event (`stop`/`notification`)
  resolves the same-project Conductor via `Store::fleet_snapshot` + a new pure
  `fleet::resolve_wake_target`, and — only when `fleet::conductor_wakeable`
  (not mid-turn) and `FleetState::should_wake_now` (debounced) both agree —
  injects a short `[Conduit] worker <id> reported "<event>"...` nudge via
  `pty.write`, the same primitive `fleet_send` already uses.
- **Scope note (honest, not silently narrowed):** "no human input pending" is
  approximated as "Conductor status != running" — the one deterministic signal
  observable from the Rust backend today. Actual desktop focus/keystroke state
  isn't tracked anywhere in this codebase; a truer signal would need frontend
  cooperation and is out of scope for this pass.
- Left `fleet_list`'s shape unchanged (no `{worker, mission, last_result}`
  ledger yet) — that enrichment belongs to `fleet_roster` (Phase 7, SPEC-E),
  not SPEC-D; keeps this phase's diff scoped to the reactive-wake mechanism only.
- **Tests (all passing):** `is_wake_event_matches_stop_and_notification_only`,
  `conductor_wakeable_suppressed_only_while_running` (the guard-predicate test
  the plan calls for), `resolve_wake_target_finds_the_same_project_conductor`,
  `resolve_wake_target_never_self_wakes_the_conductor`,
  `resolve_wake_target_a_foreign_project_worker_never_surfaces`,
  `debounce_collapses_a_rapid_stop_start_storm`,
  `debounce_is_independent_per_conductor`.

---

## Phase 2 — heterogeneous, cost-aware fleet (Claude + OpenCode/local)

> Scope decision (design §8): **Claude + OpenCode/local only** for v1.
> Gemini/Codex/Antigravity workers deferred.

### SPEC-A: heterogeneous spawn
- **`fleet_mcp.rs`:** `fleet_spawn` gains `agent`; drop the `AgentId::Claude`
  literal (171–180). Gate worktree on `adapter.supports_worktree()`
  (`agent.rs:52`) — Claude keeps `--worktree`; OpenCode/local workers run in
  project root (read-only/specialist roles first — low-risk).
- **`agent.rs`:** add trait capability methods (`supports_initial_prompt`,
  `cost_tier`, `supports_local`). OpenCode already carries a task via config; no
  `build_invocation` rewrite needed for the deferred adapters.
- **`store.rs`:** `add_session` already takes `agent`; thread it from the tool.
- **Frontend:** `App.tsx` / `store.ts` fleet-spawn round-trip (113–120 / 798–822)
  already merges a backend-created session — verify it renders a non-Claude glyph.
- **Depth guard (critique):** test that a **Worker-role** spawn attaches **no**
  fleet MCP config, and `fleet_spawn` refuses a caller resolving to a Worker.
- **Tests:** spawn an OpenCode worker end-to-end (config injected, runs local
  model); Claude worker unchanged; worker gets no fleet config.

### SPEC-B: account/model routing
> **2026-07-05 research integration (execute with this section, at scope-expansion
> Phase 6):** add an `effort` spawn field (`low|medium|high|xhigh|max`, `xhigh`
> Opus-only) and fill the `model_tier`→model table with pinned IDs — see
> scope-expansion design §7.2/§7.5 and plan Phase 6. Encode **Gemini 3 Flash >
> Pro** for coding.
- Activate the dead fields: `fleet_spawn` gains `model_tier` + `account_id`,
  written onto the Session at creation.
- **`agent.rs`:** map `model_tier` → concrete model per adapter — for OpenCode,
  derive a **per-session** config from `build_opencode_config` (465–521) instead
  of the single global `OpenCodeSettings`; for Claude, `model_tier` picks
  opus/sonnet/haiku. Routing is a heuristic `task_type → tier` table first (no
  trained router).
- User-facing **cost mode** threshold biases bulk work toward local.
- **Tests:** `model_tier` selects the right model per adapter; per-session
  OpenCode config overrides the global one; account_id pins the right config dir
  (Claude).

---

## Phase 3 — collective awareness

### SPEC-E: mission board + capability cards
- **`fleet_mcp.rs`:** `fleet_roster()` (peers' `Mission` mandates — identity +
  objective + status, **not** transcripts) and `fleet_capabilities()` (static
  per-`AgentId` cards). Both project-scoped.
- **`agent.rs`:** capability-card JSON per agent (net-new; each names the
  native-subagent boundary from design §3).
- **`fleet.rs`:** persona teaches "consult roster + capabilities before spawning."
- **Tests:** roster returns only same-project missions; a non-opted-in custom
  session does **not** appear; capabilities are static and complete.

### SPEC-F: horizontal mailbox — **DEFERRED** (design §8)
Held pending a concrete use case. If picked up: `fleet_note(channel, text≤512B)` /
`fleet_inbox(channel)` over `Note` records + `channels`; `shareInProject` opt-in
on custom sessions; every read gated by `can_read`/silo; append-only, data-only,
no control transfer. This phase is where the "keep the mailbox" decision (design
§8) slots in without reworking earlier phases.

---

## Phase 4 — cost governor + autonomous routing

### SPEC-G: usage meter (honest, cross-platform token half first)
- **`transcript.rs`:** extend `parse_line` (35–77) to capture
  `message.usage {input, output, cache_*}` from each `<id>.jsonl` (already tailed
  by the bridge) → real per-session Claude **token tally** keyed by `Session.id`,
  rolled up per agent/account and project-cumulative. **Cross-platform.**
- **`claude_usage.rs`:** keep `/api/oauth/usage` window % + `resets_at` (curl
  only). **Windows credential path** (`~/.claude/.credentials.json` / Credential
  Manager) so the subscription bar connects on Windows — **do this early**.
- **`store.ts`:** reshape the single global `claudeUsage` (363) into a map keyed
  by `(project_id, agent, account_id, session_id)` + cumulative summary.
- **UI:** bottom bar, one segment per active agent/account. Subscription-backed
  Claude → window-% + reset countdown; token-metered → cumulative count; local →
  "$0"; others → "unmetered". Cumulative roll-up **never aggregates across
  projects**. Reuse the `Meter` component (`ClaudeUsagePanel.tsx:23`).
- **Do not** build a per-agent subscription % by default (design §8) — offer as
  opt-in for distinct-account-per-agent setups.
- **Tests:** token tally matches a known transcript; roll-ups are project-scoped;
  unmetered/`$0` rows render without fabricated numbers; Windows token path works.

### SPEC-H: routing intelligence + guardrails — ✅ DONE (2026-07-05; see the scope-expansion plan's Phase 10 section for the full accounting, incl. the one deliberately-deferred item: extending human-confirm to cost-threshold spawns, which needs new frontend UI this pass didn't build)
> **2026-07-05 research integration (execute with this section, at scope-expansion
> Phase 10):** the `CONDUCTOR_PERSONA` rewrite must add the native-subagent-first
> rule (Haiku via `CLAUDE_CODE_SUBAGENT_MODEL`), the effort-first cascade
> (effort before model; `xhigh` Opus-only), the task-type→agent heuristics, and
> the prompt-cache/Batch hints — see scope-expansion design §7.2/§7.3/§7.5/§7.6
> and plan Phase 10.
- **`fleet.rs`:** rewrite `CONDUCTOR_PERSONA` — heterogeneous roster framing;
  **the native-subagent hard rule (design §3)**; coding-calibrated effort ladder
  (0–2 workers default); mission-brief requirement; capability + roster
  consultation before spawn; cheap-first cascade escalating on **objective**
  signals (tests/exit/no-result), not self-confidence; remaining budget as a
  **soft** spawn input.
- **`fleet_mcp.rs`:** hard guardrails in `fleet_spawn` — keep `MAX_WORKERS=8`;
  enforce **spawn-depth cap = 1** in code; **spawns-per-window** limiter;
  extend the human-confirm handshake to gate threshold-crossing spawns.
  Budget signal is advisory; hard limits are the deterministic local counters.
- **Tests:** over-cap spawn refused; a worker-role caller refused; spawn-rate
  limiter trips; persona rules paired with a hard check where cost/safety matters.

---

## Cross-cutting test & safety notes

- **Recursion:** the depth cap must be a code-enforced test, not an assumption
  about config plumbing (critique).
- **Fail-open policy:** when `/api/oauth/usage` is unavailable, show "unavailable"
  and **do not** hard-halt spawns.
- **No new deps:** all HTTP via `curl` subprocess (arch gotcha); no
  `reqwest`/`tokio`.
- **`cargo fmt` drift:** main is not whole-crate rustfmt-clean; format only
  touched files.
- **Frontend has no test runner:** verify UI by `tsc --noEmit` + `pnpm build` +
  launching the dev app with `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev`.

## Open decisions (owner)

> **Resolved 2026-07-05 — stale below, kept for the historical record of what
> was actually asked.** The owner's three locked-in decisions (all five
> adapters, mailbox built in v1, shared-pool + per-session usage) are recorded
> in `docs/superpowers/specs/2026-07-05-orchestration-v2-scope-expansion-design.md`
> and implemented per the scope-expansion plan. Quick resolutions against the
> original questions below: (1) mailbox — **kept, built in Phase 5**, not
> deferred (owner overrode this doc's own "Rec: defer"); (2) heterogeneity —
> **all five adapters**, tiered, not just Claude + OpenCode; (3) usage —
> **shared pool + per-session token counts**, as recommended; (4) wake-on-stop
> — implemented as a **visible injected line** in the Conductor's own PTY
> (`[Conduit] worker <id> reported "<event>"...`), idle-gated and debounced,
> not a silent queue — the opposite of this doc's own "Rec: queue + idle-gated
> inject," though it kept the idle-gating half of that recommendation; (5) cost-mode
> / budget units — **still genuinely open**: Phase 10 shipped the persona
> treating remaining budget as an advisory signal without picking a concrete
> unit, and explicitly deferred the human-confirm spawn threshold that would
> have forced this decision (see the scope-expansion plan's Phase 10 section).

1. Keep or defer the horizontal **mailbox** (SPEC-F)? *Rec: defer.*
2. v1 heterogeneity = **Claude + OpenCode/local**, or all five adapters?
   *Rec: Claude + OpenCode/local.*
3. **Per-agent subscription %** (needs distinct Claude accounts) or one shared
   pool + per-session token counts? *Rec: shared pool + token counts; per-agent
   as opt-in.*
4. Wake-on-stop: visible line in the Conductor PTY (human sees it) or a quieter
   queue the Conductor drains? *Rec: queue + idle-gated inject.*
5. Cost-mode / budget units — window % or token counts (no $ obtainable for
   subscription agents)?
