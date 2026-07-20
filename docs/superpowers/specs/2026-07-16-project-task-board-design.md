# Project task board (Kanban) for the live fleet — design

**Status:** proposed (2026-07-16)
**Scope:** Give every Conduit project a **task board** — a Kanban of work stored as
git-shared files in the project's own repo — that the live fleet of real CLI sessions
(Claude + agy today) reads and drives through MCP: sessions **claim**, **move**,
**comment on**, and **advance** cards; humans drag, add, and edit them in a full-screen
board view. Each card can *optionally* carry a stage-gate **workflow** (discovery →
requirements → UX → architecture → plan → build → verify) with role-specific briefings
and a project **knowledge** bundle, ported from the reference project this design grew
out of. Increment 1 ships the flexible board **and** the stage-gate overlay; a
per-project Conductor and the orchestration-v2 fold-in are deferred behind clean seams.

## Origin

This grew from a friend's experiment (`~/ooozzy/Experiments/agent-development`, author
Saad): a filesystem-native, single-session multi-agent **delivery workflow**. Work items
are folders (`work-items/<id>/item.yaml`) whose `status` field drives a stage-gate state
machine (ISO/IEC/IEEE 12207 + BABOK + Double Diamond as reference standards); five role
agents (orchestrator, delivery-planner, ux-designer, solution-architect, implementer) own
distinct states; a project **knowledge** bundle in **OKF** (Open Knowledge Format — markdown +
YAML frontmatter, git-diffable) holds decisions/patterns/anti-patterns/domain/components
that agents read before proposing and promote to after. Human checkpoints gate
requirements sign-off, blocks, and final verification.

That design is elegant but **single-lane**: one orchestrator session, one item advancing
at a time, humans editing YAML by hand. Conduit's whole premise is the opposite — **many
real CLI sessions running in parallel**. This spec lifts the friend's stage-gate + OKF
knowledge into Conduit, but reframes the driver as a **shared, live, human-visible board**
that a parallel fleet coordinates through, instead of a solo state machine.

## Problem

Conduit runs multiple `claude`/`agy` sessions side by side, but they have **no shared,
durable, human-visible model of the work**. Today:

- Coordination is either a lossy `fleet_peek` terminal scrape or the transient in-memory
  blackboard (`board.rs`: Mission/Result/Note records, a 500-entry ring that is
  deliberately **not** persisted). Neither is a task list a human can see or steer.
- There is **no way for an idle session to discover "what should I work on next"** and
  claim it without colliding with a sibling session doing the same.
- There is **no durable record of work** that travels with the repo, so a teammate (or a
  plain `claude` CLI outside Conduit) can't see the board.
- The friend's stage-gate rigor (structured requirements, architecture-before-code,
  verification hygiene, promoted knowledge) exists nowhere in Conduit.

The goal: a **project task board** that is (1) a shared blackboard the parallel fleet
claims work from and reports progress to, (2) durable and git-shared so it travels with
the repo and the team, (3) human-first — drag, add, edit, watch AI claims land live, and
(4) capable of the friend's full stage-gate depth **per card, on demand**, without forcing
that process on every task.

## Goals

1. **Flexible Kanban** per project: human-defined columns; cards = units of work; any
   session claims/moves/comments via MCP; humans drag/add/edit in the UI.
2. **Git-shared source of truth**: board lives in `<repo>/.conduit/` as one file per card,
   so it diffs cleanly, merges cleanly, travels with the repo, and is visible to any agent
   in that repo — even outside Conduit.
3. **Hybrid stage-gate overlay**: a card can opt into the friend's workflow; the claiming
   session is handed that stage's role briefing inline and advances the card through an
   authoritative, Rust-side state machine, stopping at human gates.
4. **Flat self-claim coordination** with a **claim-lease** so parallel sessions never
   double-work a card, with a **Conductor-per-project** mode left as a clean seam.
5. **Project knowledge (OKF)**: the friend's decisions/patterns/anti-patterns/domain/
   components bundle, read before proposing and promoted to after, scoped per project.
6. **Live, two-channel refresh**: in-app mutations reflect instantly; teammate/git edits
   reflect by polling — matching how Conduit already handles both.
7. **Off by default, lean**: no board files until a project opts in; no new frontend
   dependency (reuse native HTML5 drag-and-drop); no new Rust HTTP/watcher crate.

## Non-goals (Increment 1)

- **No full Conductor-per-project orchestration.** The board leaves the seam (roles,
  assignment, `task_advance` driver) but the flat self-claim path is what ships. Conductor
  drive = Inc 2.
- **No orchestration-v2 blackboard rewrite.** `board.rs` (Mission/Result/Note) is left
  exactly as is; the board complements it, doesn't replace it. Folding the two is Inc 2+.
- **No tiered/heterogeneous worker economics, no per-agent usage bar on cards.**
- **No cross-project or mobile board view.**
- **No new agent adapters.** Claude + agy only, via the existing MCP + persona seams.

## Key decisions (locked in brainstorming)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Hybrid board**: flexible status columns + *optional* per-card stage-gate | Conduit's edge is parallel live sessions → coordination-first; the friend's stage-gate is too valuable to discard → keep as opt-in depth. |
| D2 | **Source of truth = `<repo>/.conduit/` files, git-shared** | Board travels with the repo and the team; any CLI agent reads it via the filesystem; friend's file-native model preserved. |
| D3 | **Coordination = flat self-claim (default) + optional Conductor per project** | Matches the vision ("AIs take on tasks, claim, move"); Conductor is an opt-in overlay, not a requirement. |
| D4 | **UI = full board view**, main-area toggle, terminals CSS-hidden | Respects Conduit's load-bearing keep-alive terminals (never unmount); gives the board full width. |
| D5 | **Inc 1 = substrate + stage-gate** (board + 5 role briefings + human gates + OKF knowledge); Conductor mode deferred | User chose the richer first slice; one design doc, one focused-but-complete first plan. |

## Architecture

### Two coordination layers, one project

| Layer | Module | Storage | Lifetime | Purpose |
|---|---|---|---|---|
| **Task board** (new) | `tasks.rs` → `TaskBoard` | `<repo>/.conduit/` files | durable, git-shared | "what work exists + who owns it" — the Kanban |
| **Blackboard** (exists) | `board.rs` → `BoardState` | in-memory ring (500) | transient | "what's happening now" — Mission/Result/Note bus |

They **compose**: a `task_claim` may drop a `fleet_note` ("s2 took the auth card"); a
worker's Mission can cite a card id; a card can link to the `fleet_result` a session
handed back. Neither owns the other.

### Naming (avoid the `board.rs` collision)

- Product / UI noun: **Board** (it is a Kanban board).
- Rust type: **`TaskBoard`** in a new **`tasks.rs`** module — never `BoardState`.
- MCP verbs: **`task_*`**.
- Files: `<repo>/.conduit/board/`.

### Data model — `<repo>/.conduit/`

```
.conduit/                         # git-shared with the team; already git-trackable today
  board/
    columns.yaml                  # ordered [{id, name}] — human-editable column defs
    cards/<card-id>.yaml          # ONE file per card (merge-friendly; friend's per-item model)
  work-items/<card-id>/           # stage-gate artifacts, ONLY for cards that opted into a workflow
    discovery.md requirements.md clarifications.md ux-spec.md
    architecture.md implementation-plan.md implementation-log.md verification-report.md
  knowledge/                      # OKF bundle, ported verbatim in structure
    index.md log.md
    decisions/ patterns/ anti-patterns/ domain/ components/
  agents/                         # the 5 role personas, shipped by Conduit on board init
    orchestrator.md delivery-planner.md ux-designer.md solution-architect.md implementer.md
```

`.conduit/` is **not** gitignored today (Conduit already writes `.conduit/result.schema.json`
there — `hooks.rs:496`), so board files are shareable without any gitignore change. Conduit
should add a `.conduit/.gitignore` for genuinely local scratch (e.g. claim leases if we
decide leases shouldn't be committed — see Concurrency).

**Card schema** (`board/cards/<id>.yaml`, camelCase to match Conduit's serde convention):

```yaml
id: "a1b2c3"                 # uuid
title: "Rename dispo → loan across web"
body: |                       # markdown; the human/agent-readable description
  ...
column: "in_progress"         # references a columns.yaml id
order: "0|hzzzzz:"            # fractional index (LexoRank-style) — see Concurrency
labels: ["web", "naming"]
createdBy: "human"            # "human" or a session id
createdAt: 1784200000000
updatedAt: 1784203000000
claim:                        # null when unclaimed
  by: "s2"                    # session id (or "human")
  at: 1784202000000
  leaseUntil: 1784202600000   # heartbeat-extended TTL
workflow: null                # null, OR the stage-gate overlay (below)
links: { workItem: null, pr: "", branch: "" }
comments:
  - { by: "s2", at: 1784202100000, text: "claimed; starting discovery" }
```

**Stage-gate overlay** (`workflow`, present only on opt-in cards):

```yaml
workflow:
  kind: "stage-gate"
  stage: "architecture_input"     # one of the WORKFLOW states below
  resumeState: null               # set only when stage == "blocked"
  blockedQuestion: null
  history:                        # append-only, mirrors friend's item.yaml history
    - { at, agent: "solution-architect", from: "ux_input", to: "architecture_input", note: "..." }
```

**Columns** (`board/columns.yaml`): ordered `[{id, name}]`. Default set: `Backlog`, `Todo`,
`In Progress`, `Review`, `Done` — human-editable. Columns are **coordination status only**;
the stage-gate `workflow.stage` is orthogonal (a workflow card sits in whatever column and
shows a stage sub-badge — exactly the hybrid the user picked).

### Stage-gate: the friend's model as an opt-in per-card overlay

Ported states (from the reference `WORKFLOW.md`), encoded as an **authoritative pure
function** `stage_machine::next(stage, outcome) -> Transition`:

```
requested → discovery → requirement_draft → business_clarification(HUMAN)
  → ux_input → architecture_input → implementation_plan → implementation
  → verification(HUMAN accept) → done
blocked(HUMAN) is a pause from any state with a resume_state.
Rework edges: verification → implementation | architecture_input | ux_input;
              business_clarification → requirement_draft.
```

**The board briefing IS the persona.** When a session calls `task_claim` on a stage-gate
card, the MCP reply hands back, inline: (a) the current stage, (b) that stage's role-agent
instructions (from `.conduit/agents/<role>.md`), (c) the "reads" list for that stage, and
(d) the artifact paths under `work-items/<card-id>/`. The claiming session *becomes* that
role for that card — **no subagent spawn, no mid-session persona re-injection** (which
Conduit can't do to a live PTY anyway). It produces the stage artifact, then calls
`task_advance(card, outcome)`.

`task_advance` validates the transition in Rust (the state machine is the source of truth,
not the model's judgment), appends a `history` entry, and **stops at human gates**
(`business_clarification`, `blocked`, `verification` acceptance) — the board shows a "needs
you" badge and refuses to advance until the human acts (a UI action, or editing
`clarifications.md`). This is the friend's orchestrator routing, enforced by the backend
instead of a session.

### Coordination — flat self-claim + lease + liveness

- **Flat (default):** every session in a board-enabled project gets `task_*`. An idle
  session lists its lane and claims the top unclaimed card.
- **`TaskBoard` is the single arbiter.** Every `task_claim` is a compare-and-set under
  `TaskBoard`'s Mutex: it succeeds only if the card is unclaimed **or** its lease has
  expired. Two sessions racing for the same card → exactly one wins.
- **Lease + liveness.** A claim carries a TTL, extended by a heartbeat while the session
  works. A card auto-releases if (a) the lease expires, or (b) the claiming session's PTY
  is dead — reusing `FleetState.running_sessions` (the live-PTY cross-check that already
  backs the safe-shutdown guard, `fleet.rs:370-389`).
- **Conductor seam (Inc 2):** a project may promote one session to Conductor
  (`SessionRole::Conductor` already exists, `store.rs:18-24`); it plans/assigns and drives
  `task_advance`. Inc 1 leaves the role check and assignment field in place but ships only
  the flat path.

### MCP surface (`task_*`, added to `fleet_mcp.rs`)

Copy the existing tool pattern exactly: a `json!` spec appended to `tool_specs()`
(`fleet_mcp.rs:50`), a match arm added to `dispatch_tool` (`fleet_mcp.rs:231`), args pulled
via `args.get("k")…`. `Ctx` (`fleet_mcp.rs:32`) gains **`tasks: Arc<TaskBoard>`** (wired in
`fleet_mcp::start` / `lib.rs:1278` alongside the existing `board`).

| Verb | Args | Effect | Worker-callable |
|---|---|---|---|
| `task_list` | `column?`, `mine?`, `unclaimed?` | List cards in the caller's project (scoped) | yes |
| `task_get` | `id` | Full card incl. stage briefing if a workflow card | yes |
| `task_claim` | `id` | CAS claim + start lease; returns role briefing for workflow cards | yes |
| `task_release` | `id` | Drop own claim | yes |
| `task_move` | `id`, `column`, `before?/after?` | Move column + reorder (fractional) | yes |
| `task_comment` | `id`, `text` | Append a comment (capped like `NOTE_MAX_BYTES`) | yes |
| `task_add` | `title`, `body?`, `column?` | Create a card | yes (policy-gated) |
| `task_advance` | `id`, `outcome` | Advance stage-gate; stops at human gates | yes (own claim only) |

Human UI actions (add/edit/move/delete card, edit columns) go through **Tauri commands**,
not MCP. Both entry points land in the **same `TaskBoard` methods** — one source of truth,
two adapters.

### Security (must-close — see CLAUDE.md SPEC-0 and design-doc §2.0)

1. **Structural project scope.** Every `task_*` handler resolves the caller's project from
   `store.fleet_snapshot(&ctx.conductor_id)` — where `conductor_id` is the caller's own
   session id, baked into the MCP URL query (`?conductor=<sid>`, `fleet.rs:205-215`). A
   handler **never** trusts a project id passed in args. This is the same structural
   isolation `board.rs` already relies on and directly closes the cross-project
   `fleet_peek`/`fleet_send` leak class for the new surface.
2. **`WORKER_ALLOWED` widening.** Flat self-claim requires workers to call the `task_*`
   verbs above. Add them to `WORKER_ALLOWED` (`fleet_mcp.rs:182`) — they are safe because
   each is project-scoped and (for `task_advance`/`task_release`) restricted to the
   caller's **own** claim. Structural ops that affect others (delete a column, delete
   another session's card) stay Conductor/human-only.
3. **MCP-config widening.** Today only a Conductor or a fleet-spawned/mailbox-opted worker
   gets the MCP config file written (`gets_fleet_mcp`, `lib.rs:181`). For every manual
   session to self-claim, a **board-enabled** project must write the MCP config for all its
   sessions at spawn. Gate this on a per-project "board enabled" flag so single-terminal
   users are unaffected.
4. **Write-path caps.** `task_comment`/`task_add` text is length-capped and UTF-8-truncated
   with the existing `truncate_utf8` helper (`board.rs:63`); a per-session rate cap mirrors
   `MAX_NOTES_PER_MINUTE_PER_SESSION` (`fleet.rs:297`).

### Live refresh (no `notify` crate)

Conduit has **no OS file-watcher** (confirmed: no `notify`/`walkdir` in `Cargo.toml`); its
only "watch" is 1500ms frontend polling via `stat_file` (`useFileWatch.ts`). Match that
with two channels:

- **In-app mutations** (any `task_*` or Tauri command write): backend emits a
  `board-changed { projectId }` Tauri event — the same push pattern as `fleet-spawn`
  (`fleet_mcp.rs:374`, consumed at `App.tsx:368`). Frontend reloads that project's board
  via a `list_board` command.
- **Teammate / git-external edits** (a `git pull` rewrites `.conduit/board/`): poll the
  `.conduit/board/` directory mtime ~1.5s while the board view is open, reusing the
  `useFileWatch` approach. Cheap; only runs when the board is visible.

### UI — full board view

- **State:** per-project `centerMode: 'terminals' | 'board'`, persisted (follow the
  `sidebarCollapsed`/`toggleSidebar` localStorage pattern, `store.ts:1984`). Toggle via a
  header button and ⇧⌘B (menu wiring like `toggle-maximize`, `App.tsx:257`).
- **Keep-alive:** the board renders as an overlay `position:absolute; inset:0; z-index` over
  `.center` (the `EmptyState` overlay model, `WorkspaceCenter.tsx:333`) — or a maximize-style
  gate. **Terminals stay mounted** in `.term-stack`, hidden by `visibility:hidden` exactly
  as the maximize feature already does. Never unmount a `TerminalView`.
- **Board:** columns + cards; **native HTML5 drag-and-drop** (Sidebar and tab-split already
  use it — `Sidebar.tsx:216-232` — so **no new dependency**). Card shows title, labels,
  **claim badge** (which session / human), **stage sub-badge** (`arch 4/8`) on workflow
  cards, and a **"needs you"** badge at human gates.
- **Add/edit:** inline input (reuse the `RenameInput` autofocus pattern, `Sidebar.tsx:428`);
  card/column actions via a context menu (reuse `openMenu`/`SessionContextMenu` or the
  viewport-aware `TabContextMenu`).
- **New components:** `BoardView.tsx`, `BoardColumn.tsx`, `BoardCard.tsx`, `useBoard.ts`
  (load + poll), and a store slice.

### Component boundaries (isolation)

| Unit | Responsibility | Depends on | Tested by |
|---|---|---|---|
| `tasks.rs::TaskBoard` | card/column model, atomic file IO (tmp+rename), claim CAS, fractional order | filesystem, `Project.path` | Rust unit tests against a temp dir |
| `stage_machine` (submodule) | pure `next(stage, outcome)` transition table | nothing | Rust unit tests (port friend's table) |
| `task_*` MCP arms | MCP → `TaskBoard` adapter + authorize/scope | `Ctx`, `TaskBoard`, `Store` | Rust tests (like the fleet guardrail tests) |
| Tauri commands | UI → `TaskBoard` adapter | `TaskBoard` | Rust tests |
| `BoardView`/`useBoard`/slice | render + DnD + refresh | Tauri commands, events | manual (no FE test runner) |

Each unit answers cleanly: what it does, how to use it, what it depends on. `TaskBoard`'s
internals (file layout) can change without touching the MCP or UI adapters.

## Concurrency & git-sharing model

Two kinds of concurrency, two mechanisms:

1. **Same-machine, live sessions (real-time).** All writes funnel through the one MCP
   server process and one `TaskBoard` Mutex → serialized. Claims are CAS. File writes are
   atomic (tmp + `fs::rename`, like `store.rs:502-537`). No lost updates.
2. **Cross-machine, teammates (async via git).** The **one-file-per-card** layout localizes
   conflicts: two people editing different cards never conflict. The historically painful
   spot — **column ordering** — is solved by storing a **fractional `order` key per card**
   (LexoRank/Figma-style): moving a card sets its `order` to the midpoint between its new
   neighbors, so a reorder rewrites **only the moved card's file**, never a shared array.
   Two teammates reordering different cards merge cleanly; the rare same-card conflict is a
   normal one-file git conflict.

**Leases and git.** A live `claim.leaseUntil` is machine-local, high-churn state that
should probably **not** be committed (it would thrash the repo and be meaningless on
another machine). Options: (a) keep `claim` in the committed card file but treat a claim by
a session id unknown to *this* machine's fleet as advisory/expired; or (b) split live claim
state into a gitignored `.conduit/board/.claims/` sidecar. **Default: (b)** — commit the
durable card, keep the volatile lease local — resolved during P1. Either way, `TaskBoard`
is the arbiter for the machine that owns the session.

## Role personas + OKF knowledge

- **Personas:** the five `.md` role definitions are shipped by Conduit (bundled assets) and
  written into `.conduit/agents/` on board init (like `install_profile` writes project
  config, `hooks.rs:642`). They are the briefings `task_claim` returns for workflow cards.
  Ported nearly verbatim from the reference project, with permissions reframed for Conduit
  (e.g. "Never change `item.yaml.status`" → "Never call `task_advance` past a human gate").
- **Knowledge (OKF):** the `knowledge/` bundle structure is ported verbatim
  (`decisions/patterns/anti-patterns/domain/components` + `index.md` + `log.md`). Role
  briefings instruct the read-before-propose / promote-after duties. In Inc 1 the bundle is
  **scaffolded and honored by stage-gate cards**; making non-workflow cards consult it is
  optional and light.

## Conduit integration points (grounded in code)

| Concern | Hook | File:line |
|---|---|---|
| Project repo root (anchor for `.conduit/`) | `Project.path: String` | `store.rs:259` |
| `.conduit/` already written, not gitignored | `write_codex_result_schema` | `hooks.rs:496`; `.gitignore` |
| MCP server start + wiring | `fleet_mcp::start(app, store, pty, fleet, board)` | `lib.rs:1278` |
| Tool registry / dispatch pattern to copy | `tool_specs()` / `dispatch_tool` | `fleet_mcp.rs:50` / `:231` |
| Handler context to extend with `tasks` | `struct Ctx` | `fleet_mcp.rs:32-39` |
| Caller identity + project scope | `?conductor=<sid>` → `store.fleet_snapshot` | `fleet.rs:205-215` |
| Worker authorization guardrail | `authorize` + `WORKER_ALLOWED` | `fleet_mcp.rs:182-201` |
| Who gets MCP config written (widen) | `gets_fleet_mcp` | `lib.rs:181` |
| Session liveness for lease auto-release | `FleetState.running_sessions` | `fleet.rs:370-389` |
| Backend→frontend push pattern | `emit("fleet-spawn", …)` / `App.tsx` listener | `fleet_mcp.rs:374` / `App.tsx:368` |
| One-shot state hydration | `load_projects` command | `lib.rs:410` |
| External-file polling model to mirror | `useFileWatch.ts` (`stat_file`, 1500ms) | `useFileWatch.ts:8` |
| Keep-alive hide mechanism (never unmount) | `.term-host.hidden{visibility:hidden}` | `theme.css:620-636` |
| Full-area overlay model | `EmptyState` (`position:absolute;inset:0`) | `WorkspaceCenter.tsx:333` |
| Maximize gate (hide siblings, stay mounted) | `toggleMaximizeGroup` | `store.ts:1760` |
| Native DnD convention (no new dep) | Sidebar drag payload | `Sidebar.tsx:57-75,216-232` |
| Persisted UI-flag pattern | `sidebarCollapsed`/`toggleSidebar` | `store.ts:664,1984` |
| Context-menu patterns to reuse | `openMenu`/`SessionContextMenu`; `TabContextMenu` | `Sidebar.tsx:563` / `WorkspaceCenter.tsx:503` |
| Text cap / rate-cap helpers to reuse | `truncate_utf8`; `MAX_NOTES_PER_MINUTE…` | `board.rs:63` / `fleet.rs:297` |

## Increment 1 plan (phases; the plan doc will detail tasks)

- **P1 — `TaskBoard` core.** `tasks.rs`: card/column schema, `.conduit/board/` read/write,
  atomic writes, fractional `order`, claim CAS + lease, lease/liveness auto-release. Rust
  unit tests against a temp dir. No UI/MCP yet.
- **P2 — Human command surface.** Tauri commands (`list_board`, add/edit/move/delete card,
  edit columns, claim/release for humans) + the `board-changed` emit.
- **P3 — Board UI.** `BoardView`/`BoardColumn`/`BoardCard` + `useBoard` (event + poll
  refresh) + `centerMode` toggle (⇧⌘B, header button) + native DnD + badges. Verify by
  launching the app (no FE test runner).
- **P4 — MCP `task_*`.** Add verbs to `tool_specs()`/`dispatch_tool`; extend `Ctx` with
  `tasks`; widen `WORKER_ALLOWED`; widen `gets_fleet_mcp` behind the board-enabled flag;
  enforce structural project scope; Rust tests mirroring the fleet guardrail tests.
- **P5 — Stage-gate overlay.** `stage_machine` transition table (port `WORKFLOW.md`) with
  unit tests; `task_claim` returns the role briefing + reads for workflow cards;
  `work-items/<id>/` artifact plumbing; `task_advance` with human-gate stops; "needs you"
  UI.
- **P6 — Knowledge + personas + flat orchestration.** Ship the 5 personas into
  `.conduit/agents/`; scaffold the OKF `knowledge/` bundle; wire the flat auto-claim loop
  (idle session picks the top unclaimed card in its lane). Bump version + CHANGELOG.

## Testing strategy

- **Rust unit tests** (this repo's real test surface) for the pure/logic pieces: fractional
  order, claim CAS + lease expiry, `stage_machine::next` over the full transition + rework +
  gate table, project-scope enforcement in the `task_*` arms, and text/rate caps — mirroring
  the existing `tools_list_includes_all_eleven` and worker-guardrail tests.
- **Frontend has no runner** → verify UI by `pnpm exec tsc --noEmit` **and launching the
  app** (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`): create a board, drag a
  card, watch a second session self-claim it, drive one card through the full stage-gate to
  a human gate.

## Open questions (minor; sane defaults chosen)

- **Card metadata format** — YAML (matches friend's `item.yaml`) vs Markdown+frontmatter
  (matches OKF). **Default: YAML for the card, `.md` for stage-gate artifacts.**
- **Lease persistence** — committed vs gitignored sidecar. **Default: gitignored
  `.conduit/board/.claims/` sidecar** (durable card committed, volatile lease local).
- **Default columns** — **Backlog / Todo / In Progress / Review / Done.**
- **`task_add` by workers** — allowed (subtask decomposition) but rate-capped; revisit if
  abused.

## References

- Reference project: `~/ooozzy/Experiments/agent-development` (`WORKFLOW.md`, `.claude/agents/*`, `knowledge/`, `templates/`).
- Conduit blackboard: `src-tauri/src/board.rs`; MCP server: `src-tauri/src/fleet_mcp.rs`; fleet: `src-tauri/src/fleet.rs`.
- Related Conduit designs: `docs/superpowers/specs/2026-06-30-conductor-design.md`,
  `2026-07-04-orchestration-v2-design.md` (+ scope-expansion companion) — the deferred
  Conductor/blackboard fold-in this board should eventually meet.
