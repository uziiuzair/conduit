# Orchestration v2 — Design

> Status: **proposal / under review**. Date: 2026-07-04.
> Supersedes nothing; extends the Conductor (`2026-06-30-conductor-design.md`).
> This is the *why* and the *shape*. The phased task breakdown lives in
> `docs/superpowers/plans/2026-07-04-orchestration-v2-plan.md`.
>
> **2026-07-05 update:** the product owner locked in three decisions that
> change §8 and §9 below (all five adapters spawnable, not just
> Claude+OpenCode/local; the horizontal mailbox SPEC-F built in v1, not
> deferred; usage meter = shared-pool % + per-session tokens, now a decision
> not just a recommendation). §1–§7 and §10 here are **still in force
> unchanged**. See
> `docs/superpowers/specs/2026-07-05-orchestration-v2-scope-expansion-design.md`
> for the rewritten §8/§9 and full per-adapter detail, and
> `docs/superpowers/plans/2026-07-05-orchestration-v2-scope-expansion.md` for
> the phase breakdown from (what was) Phase 2 onward.

## 1. Problem

Conduit today has exactly one orchestration primitive: a per-project **Conductor**
(a privileged Claude session) with five MCP tools. It works, but it is a
*homogeneous, poll-driven, lossy* orchestrator:

- `fleet_spawn` hard-codes `AgentId::Claude` and worktree-`true`
  (`fleet_mcp.rs:171`) — it can only make Claude workers.
- Workers hand nothing back. The Conductor learns "done" from a status flag and
  must reconstruct *what happened* from `fleet_peek` — the last **8 KiB of
  ANSI-stripped terminal output** (`fleet_mcp.rs:28`). No status/confidence/cost,
  no structure.
- Coordination is **poll-only**: the MCP server answers server→client push with
  405 (`fleet_mcp.rs:315`), so the Conductor re-calls `fleet_list` on a timer,
  burning tokens while workers idle.
- The reserved Session fields `model_tier`, `channels`, `seed_memory`
  (`store.rs:73–79`) are persisted but read by **zero** runtime code.
- There is **no per-agent or per-session cost signal**; the only usage surface is
  an app-global, Claude-only, macOS-only panel.
- **Confirmed security bug:** `fleet_peek`/`fleet_send` resolve the target id
  against the *global* PTY map with no project membership check, so a Conductor in
  project A can read or inject into any running session in project B
  (see §4).

## 2. Goals & hard constraints

From the product owner (verbatim intent, condensed):

1. An orchestrated session decides **autonomously** whether to spawn, **which
   agent/model** per task, and how to exploit each agent's nature.
2. **Some** cross-agent sharing — **vertical** (orchestrator↔worker) and
   **horizontal** (worker↔worker). Minimal, not all-encompassing.
3. Reduce token usage **and** maximize performance (route cheap/bulk work to
   cheaper/local models; don't over-spawn).
4. A bottom progress bar: subscription-allowance / API-key usage, **per-agent and
   cumulative**.
5. **Cross-project sharing must be forbidden and impossible** (hard invariant).
6. Agents are **aware** of what other agents in the project exist and what each
   was *set out to do* (mission, not necessarily live activity).
7. A **small horizontal channel** for bare-minimum peer info.
8. **Custom/manual sessions don't share by default** — opt-in only, still within
   the one project.

## 3. The load-bearing decision: fleet vs native subagents

**This governs everything.** A Claude Conductor already has in-process **Task
subagents**: shared prompt cache, no ~6 s PTY startup, no MCP round-trip, no
worktree setup, and a built-in parent-summarizes-child contract. Spawning a PTY
worker for a *homogeneous Claude subtask* is pure overhead and re-incurs the
~15× multi-agent token multiplier Anthropic documents — for work native
subagents already do more cheaply. (Anthropic, *How we built our multi-agent
research system*; LangChain, *How and when to build multi-agent systems*;
Cognition, *Don't Build Multi-Agents*.)

Therefore Conduit's heavyweight PTY fleet is reserved for the three things native
subagents **structurally cannot** do. `fleet_spawn` is *only* justified for:

- **(a) A different agent or model** than the orchestrator — above all routing
  bulk/mechanical work to a **local model via OpenCode** for near-$0 cost.
- **(b) A durable, human-visible session** the user can jump into and steer.
- **(c) Long-lived parallel work over a large repo** where physical worktree
  isolation and independent restart matter.

For parallel *Claude* subtasks (fan out reads/exploration, gather summaries), the
orchestrator uses its **native Task subagents**, not `fleet_spawn`. This is a
**hard rule in `CONDUCTOR_PERSONA`** and in the capability cards, not a soft
preference. It is the difference between Conduit paying 15× to reimplement a
free mechanism and Conduit earning its multiplier.

> Design consequence: the primary token-savings lever is not "more workers" — it
> is **routing the right work to a $0 local model** and **not spawning when a
> native subagent (or doing-it-yourself) is cheaper**.

## 4. Security first — close the cross-project leak (SPEC-0)

`fleet_peek` (`fleet_mcp.rs:124`) and `fleet_send` (`fleet_mcp.rs:195`) take a
caller-supplied `id` and call `ctx.pty.recent_output` / `ctx.pty.write` against
the **global** `PtyManager` DashMap keyed by bare session id. The private-mode
`can_read`/`can_inject` gate is an `if let (Some, Some)` that **fails open when
the target id is absent from the caller's project snapshot** — so a foreign
id skips the gate in *every* mode, including private-mode-on. `fleet_stop`
already does it correctly (`fleet_mcp.rs:241`).

**Fix:** in both tools, resolve the target against
`fleet_snapshot(conductor_id).sessions` **unconditionally** and return
`session-not-found` (deny-by-default) *before* any `ctx.pty` call; keep
`can_read`/`can_inject` on top. Ship alone, first, with a per-tool unit test
proving a foreign-project id is rejected. **Every other spec is gated behind
this.**

### Honest threat model

Do not call the result "structurally impossible" — that overstates it. The
loopback MCP server (127.0.0.1:8475–8495) has **no auth**; scoping keys off a
`?conductor=<id>` query param, and that id is written to a predictable,
world-readable `conductor-mcp-<id>.json`. Any local process or sibling session
that reads that id can impersonate the Conductor. So the honest claim is a
**single enforcement point, bearer-secret scoped, single-user threat model**.
Hardening (deferred, tracked): add a per-conductor random nonce to the URL that
is not world-readable, tighten the config-file perms, and verify loopback
`Origin`.

## 5. The sharing model — a project-scoped blackboard

One new substrate, borrowed from LangGraph's checkpointer-vs-store split and the
classic blackboard pattern:

- **Private (default):** each session's PTY context is its own isolated memory.
  This is the default for *all* sessions and the hard default for custom/manual
  sessions. A custom session joins the shared board **only** on explicit opt-in
  (`shareInProject: bool`, default false, in the Sidebar trust menu).
- **Shared (the project blackboard):** an append-only, per-agent-namespaced,
  provenance-tagged log **keyed by `project_id`**, holding three tiny **structured**
  record kinds — never raw transcripts:
  - `Mission` — `{agent, model_tier, objective, output_shape, boundaries, status}`.
    The mandate; powers awareness (#6). Reuses `seed_memory` as the brief.
  - `Result` — `{session_id, status, summary, artifact_paths[], tokens?}`.
    The structured hand-back that replaces the 8 KiB scrape.
  - `Note` — `{from_session, channel, text ≤ ~512 B}`. The bare-minimum peer note
    (#7), on a named channel that revives `channels`.

**Vertical** = narrow brief in, summarized `Result` out (the Claude-subagent
contract). **Horizontal** = data-only: read peers' `Mission` roster + post/read
short `Note`s on a channel you belong to; **never** peer transcripts, **never**
control transfer.

Every read is filtered by `can_read` (`store.rs:86`) + silo/clearance/local_only,
so a siloed sensitive worker's records are never surfaced to a cloud
orchestrator — the board can never become a new leak path. Cross-project is
enforced in exactly one place: the board has **no global accessor**; every access
goes `conductor_id → fleet_snapshot → one project_id → that project's board`.

**Storage:** the board is high-churn (missions/results/notes). It must **not**
live in `state.json` (the durable config file) — put it in a **separate
per-project file or in-memory with periodic flush**, with a bounded per-project
ring to cap growth.

## 6. Orchestrator intelligence

> **2026-07-05 research integration:** the concrete routing levers that make this
> section pay off — **effort tuning as the primary token lever**, routing native
> subagents to Haiku via `CLAUDE_CODE_SUBAGENT_MODEL`, the filled-in
> `model_tier`→model table, and the task-type→agent heuristics (Codex for
> terminal, Opus for SWE-bench-shaped fixes, Gemini **Flash** over Pro) — are
> specified in the scope-expansion design's **§7** (§7.2, §7.3, §7.5) and wired
> into the plan's Phase 6/10. Read those alongside this section.

Three layers on the existing manager/agents-as-tools pattern:

1. **Capability cards** — a static JSON card per `AgentId`, exposed via a new
   `fleet_capabilities` MCP tool, written as an LLM-facing routing trigger
   (`when_to_use` / `when_NOT_to_use`, strengths, cost tier, `supports_worktree`,
   `supports_local`). Seeded from empirical strengths: Claude = complex multi-file
   reasoning + orchestration; OpenCode+local = bulk/mechanical/$0; (Gemini/Codex
   deferred, see §8). **Each card names the native-subagent boundary from §3.**
2. **Effort ladder** — encoded in `CONDUCTOR_PERSONA`, coding-calibrated:
   0 workers for serial single-file work; 1 for a scoped independent exploration;
   2–4 only for genuinely parallel independent subtasks; more only with explicit
   justification. This is Anthropic's anti-over-spawn recipe adapted to the fact
   that **coding parallelizes less than research**.
3. **Cost-aware cascade** — route by task *type* (not a global smart/dumb knob):
   cheapest-capable/local first; escalate to a stronger agent on **objective**
   signals — tests failing, nonzero exit, or no `Result` produced — **not** the
   worker's self-rated confidence (unreliable; MAST echo-chamber finding).

### Guardrails (deterministic, not persona-only)

- `MAX_WORKERS = 8` (exists, `fleet.rs:131`).
- **Spawn-depth cap = 1**, enforced in code: a test asserts a Worker-role session
  gets **no** fleet MCP config, and `fleet_spawn` refuses a caller whose
  `conductor_id` resolves to a Worker. (Do not rely on config plumbing alone.)
- **Spawns-per-time-window** limiter + optional per-session transcript-token
  ceiling.
- Human-confirm handshake (exists, `fleet.rs:175`) extended to gate spawns that
  cross a cost threshold. Default-deny everywhere.

## 7. Usage meter — honest by construction

> **2026-07-05 research integration:** the meter should additionally break out
> **cache-read vs fresh** input tokens (the `message.usage.cache_*` fields are
> already in the transcript) so the human can see prompt caching (90% off cache
> reads) actually working — see the scope-expansion design §7.6 and plan Phase 8.

The meter mixes **three different units** and must label them; it never invents a
single dollar/token figure (client-side token estimation is off 2–3× on
tool-heavy coding workloads).

| Source | What it is | Scope | Cross-platform? |
|---|---|---|---|
| `/api/oauth/usage` window % + `resets_at` | % of a subscription window (5h / 7d / 7d-opus) | **account-global** | needs OAuth token — **macOS-only today** |
| `message.usage` in `<id>.jsonl` | real input/output/cache **token counts** | **per session** (roll up per agent/project) | **yes** (plain file) |
| Local model (OpenCode/Ollama/vLLM) | no cost | per session | yes → render **"$0"** |
| Codex / Gemini / Antigravity | no usage source exists | — | render **"unmetered"** |

**Decisions forced by this reality:**

- The subscription bar is **advisory soft-warn only**, never a hard gate — it is
  account-global, shared with the user's Claude usage *outside* Conduit and across
  all projects, best-effort, and lags. Hard limits use the **deterministic local
  counters** in §6. When the endpoint is unavailable, **never hard-halt on a
  signal you can't attribute** (fail-open with a visible "unavailable" label).
- **Per-agent subscription %** is only real if each agent maps to a **distinct
  Claude account**. Otherwise show Claude as one shared pool with per-session
  **token counts** broken out underneath. Do not fabricate a per-agent %.
- **Windows blocker (owner's platform):** `read_keychain_token`
  (`claude_usage.rs:221`) is macOS `security`-only, so the subscription meter
  **cannot connect on Windows today**. The token-tally half (transcript parsing)
  is a plain file and works cross-platform. A Windows credential path
  (`~/.claude/.credentials.json` / Credential Manager) is **prioritized early**,
  not buried in the last phase — otherwise the subscription bar is dead on the
  owner's own machine.

## 8. Scope decisions for review

Three calls materially change the roadmap. Recommended positions, with the
owner's original ask noted:

- **Non-Claude workers (owner asked: multi-vendor routing).**
  *Recommendation: v1 = Claude + OpenCode/local only.* Codex/Gemini/Antigravity
  `build_invocation` drop task+session-id+prompt (e.g. `gemini || gemini`), have
  no worktree flag, and can't receive fleet tools (Claude-only flags). Making them
  full participants is L-effort greenfield for little marginal value; **OpenCode's
  per-session model injection (`build_opencode_config`, `agent.rs:465`) is the
  real token lever** (route bulk to a $0 local model). Add the others when a
  concrete need appears.
- **Horizontal mailbox / SPEC-F (owner asked: a small peer channel, #7).**
  *Recommendation: defer; ship awareness (SPEC-E) first.* Roster awareness alone
  satisfies "agents know who exists and their mandate" (#6). The mailbox is the
  footgun the owner themselves worried about — context poisoning, spam, feedback
  loops, conflicting concurrent actions — with no validated use case yet (writes
  are worktree-isolated and single-threaded; control stays with the orchestrator).
  Route real collaboration through the orchestrator until a concrete need appears.
- **Per-agent subscription bar (owner asked: per-agent + cumulative, #4).**
  *Recommendation: ship one account-global window % + per-session token counts +
  explicit $0/unmetered rows.* A true per-agent % requires distinct accounts per
  agent role; offer it as an opt-in for users who run that way, not the default.

These are the product owner's to decide; the plan sequences so that choosing
"keep" for any of them adds a phase rather than reworking earlier ones.

## 9. Spec index

| Spec | Title | Effort | Depends on |
|---|---|---|---|
| SPEC-0 | Close the cross-project peek/send leak | S | — |
| SPEC-1 | Project-scoped blackboard store | M | SPEC-0 |
| SPEC-C | Structured result hand-back | M | SPEC-1 |
| SPEC-D | Reactive fleet — wake on worker stop/needsInput | M | SPEC-C |
| SPEC-A | Heterogeneous spawn (Claude + OpenCode/local) | M* | SPEC-0, SPEC-C |
| SPEC-B | Account/model routing (revive `model_tier`) | M* | SPEC-A |
| SPEC-E | Awareness / mission board + capability cards | M | SPEC-1, SPEC-A |
| SPEC-F | Horizontal mailbox (**deferred** — see §8) | M | SPEC-E |
| SPEC-G | Per-agent + cumulative usage meter | L | SPEC-A, SPEC-B |
| SPEC-H | Orchestrator routing intelligence + guardrails | M | SPEC-E, SPEC-G, SPEC-B, SPEC-D |

\* SPEC-A/B drop from L to M once scope is Claude + OpenCode/local (not four
adapters).

Per-spec problem/approach/files/tests are in the plan doc.

## 10. Invariants any implementation must hold

1. No tool addresses a session outside the caller's project — deny-by-default,
   membership resolved before any PTY or board touch.
2. Sharing is minimal by default: narrow brief in, summarized result out;
   horizontal is data-only mission/notes — never transcripts, never control.
3. Custom/manual sessions are isolated by default; join the board only on explicit
   opt-in, still within one project.
4. Silo/clearance/local_only compose with every new sharing path.
5. Stay one level deep; a worker cannot spawn workers (enforced in code + tests).
6. `fleet_spawn` is for a *different* agent/model, a *durable visible* session, or
   *long-lived worktree* work — never for homogeneous Claude parallelism (use
   native subagents).
7. Lean deps: `curl` shell-out, no `reqwest`/`tokio` for a few GETs.
8. The usage meter never conflates window-% with tokens with dollars, and never
   hard-gates on an unattributable signal.
9. A Tier-2/3 adapter's absence of a structured result/mailbox channel must be
   stated to the orchestrator (persona + capability card), never silently
   implied to work the same as Tier 1 — added by the scope-expansion design's
   §5; see `2026-07-05-orchestration-v2-scope-expansion-design.md`.
