# Transcript-backed context link

**Date:** 2026-08-10
**Status:** Design
**Sub-project:** 5 of 6 — see `2026-08-10-nodeterm-lessons-overview.md`

## Problem

Conduit's Conductor observes its fleet through `fleet_peek`, which returns a scrape of the
worker's terminal output. CLAUDE.md already records this as a known weakness: it "hands back
nothing structured — only a lossy terminal scrape."

The losses are specific. Terminal output is post-render, so it carries ANSI escapes, redrawn
frames, spinner artifacts, and box-drawing characters, and it has been reflowed to the pane's
current width. A tool call that produced 400 lines is truncated by the ring buffer. Anything
the agent printed before the buffer's window is unrecoverable. The Conductor therefore reasons
about its workers from a degraded, width-dependent, partly-overwritten view.

Meanwhile Conduit already reads structured transcripts elsewhere — `transcript.rs` exists and
the session-restore feature depends on it.

## What nodeterm does

Context Link (`src/core/context-link.ts`) connects two agent nodes and lets each read the
other's context on demand. Three design decisions are worth taking:

1. **Reading and parsing happen in the host process, not in the CLI.** That is what lets a
   remote agent use the feature at all — the transcripts live on the host and the host is
   what can reach them.
2. **The client is a shell shim plus a discovery document,** not an MCP server. A Claude
   skill for agents that have skills, and a marker block merged into `AGENTS.md` /
   `GEMINI.md` for agents that do not. This is why five of their agents can use it while
   Conduit's equivalent is Claude-only.
3. **Linking means "may read", not "sends messages".** No queue, no delivery, no ordering
   problem. A link is a permission, and reads are pull.

## Design

### Scope

Replace `fleet_peek`'s scrape with a structured read, and keep the existing tool name and
call shape so the Conductor persona does not change.

`fleet_peek(session_id, mode)` where `mode` is one of:

- `summary` (default) — the last N turns reduced to role, tool names, and text, with tool
  *inputs and outputs elided to a size cap*. This is what a Conductor actually needs and it
  is dramatically smaller than the scrape it replaces.
- `tail` — the last N structured messages in full.
- `terminal` — today's raw scrape, retained because it is the only thing that shows a live
  TUI's current frame, which is genuinely what you want when an agent is stuck at a prompt.

Defaulting to `summary` rather than `terminal` is the change that matters. `terminal` stays
reachable, so nothing that works today stops working.

### Source of truth per agent

| Agent | Source |
| --- | --- |
| Claude | `<projects>/<slug>/<session-id>.jsonl`, already located by `transcript.rs` |
| Antigravity (agy) | `~/.gemini/antigravity-cli/conversations/<uuid>.db`, already located for resume |
| Codex, Gemini, opencode | No reader yet — fall back to `terminal` |

Falling back rather than erroring is the important property: an agent with no transcript
reader behaves exactly as it does today.

### Security

CLAUDE.md documents a confirmed, unfixed cross-project leak in `fleet_peek`/`fleet_send`
(SPEC-0 in the orchestration-v2 design), and a caller-role guardrail gap in `dispatch_tool`.
This sub-project touches the exact code path both defects live in, so it must close them
rather than port them forward:

- A peek must resolve the target session **within the caller's project** and refuse a session
  id belonging to another project. The current implementation resolves against the global
  fleet.
- `dispatch_tool` must check the caller's role. A worker that reaches the MCP endpoint must
  not be able to call `fleet_peek` at all.

These are not optional extras. Making the peek richer while leaving it cross-project would
turn a leak of rendered terminal output into a leak of full structured transcripts.

### Reading is capped, not streamed

A transcript can be tens of megabytes. The reader takes the tail: seek to the end, read
backwards in bounded chunks until N complete records are recovered or a byte cap is hit.
Never load the whole file. The same discipline `context-tail.ts` uses in nodeterm.

## Testing

- The reducer turns a fixture `.jsonl` into the expected summary shape.
- Tool inputs and outputs over the cap are elided, and the elision is marked rather than
  silent.
- A malformed line is skipped, not fatal — transcripts are appended to by another process and
  a torn final line is normal.
- The tail reader recovers exactly N records from a file whose records straddle chunk
  boundaries.
- A peek for a session in another project is refused, with a test asserting the refusal rather
  than asserting the happy path only.
- A worker-role caller is refused `fleet_peek`.
- An agent with no transcript reader falls back to `terminal` and returns the scrape.

## Deferred

- **Bidirectional context links between arbitrary sessions.** nodeterm's full feature lets any
  two agent nodes read each other. Conduit's need today is Conductor-to-worker, which is a
  strict subset with a clearer authorization story.
- **A shell-shim client for non-Claude agents.** Conduit's fleet access is MCP, which is
  Claude-only. Widening it is the orchestration-v2 redesign's job, and that design should
  decide between MCP and nodeterm's shim-plus-discovery-document approach on its own terms.
