# Agent routing preferences

Date: 2026-08-23
Status: design, being implemented on `feat/agent-routing`

## The problem

Conduit can run six agents and, between them, the better part of a hundred models. A
session picks ONE agent at creation and then runs everything on it. So in practice one
subscription absorbs planning, implementation, review and mechanical edits alike --
which is both the most expensive way to buy those tokens and the fastest way to hit a
five-hour window in the middle of the afternoon.

What people actually want is closer to: *plan on the strongest model, implement on the
fast one, run checks on the cheap one, do research somewhere that isn't my coding
quota, and when something runs out, keep going.*

## Shape

A **route** maps a task kind to an ORDERED list of targets. A target is an agent plus,
optionally, a model.

```
review:  [ claude/haiku, commandcode/claude-haiku-4-5, opencode ]
           ^ preferred     ^ same work, different quota   ^ $0 local
```

The order is the fallback chain. Resolution walks it and takes the first target that is
both installed and not out of quota. That single mechanism covers three things people
otherwise ask for separately: preference, "what if that agent isn't installed", and
"what if I've hit my limit".

### Task kinds

Five, deliberately. They are the distinctions people already make out loud when they
say what they want, and each one has a different right answer:

| Kind | What it is |
| --- | --- |
| `planning` | Decide before writing. Strongest reasoning earns its cost here. |
| `implementation` | Write the code. Wants speed and volume more than peak reasoning. |
| `review` | Check the work. Short, frequent, cheap. |
| `research` | Find things out. Large context, low stakes, no reason to spend a coding quota. |
| `bulk` | Mechanical, repetitive, high-volume. The obvious place for a $0 local model. |

More kinds would be easy to add and hard to choose between. "Debugging" was cut because
in practice it routes exactly like implementation, and a distinction nobody can apply
consistently is a setting nobody sets correctly.

### Defaults come from the strengths already written down

The user-facing requirement is "by default, set to the strength of each agent" -- and
Conduit already records those strengths, in `agent::capability_card`'s `whenToUse` /
`whenNotToUse`. The default table is derived from those cards rather than invented
alongside them, so there is one place where an opinion about an agent lives.

The defaults also deliberately put a DIFFERENT agent second wherever one exists. A
fallback chain of three Claude models is not a fallback chain: when Claude's five-hour
window closes, it closes on all three at once.

## Where the split is

Two decisions look like one and are not:

1. **What are this project's preferences?** Defaults, overlaid by global settings,
   overlaid by per-project settings. Pure data, needs persistence, changes rarely.
2. **Which target is usable right now?** Depends on what is installed and how much
   quota is left, which changes minute to minute.

(1) lives in Rust (`routing.rs`), because that is where `state.json` and the capability
cards already are. It answers with a FULLY RESOLVED table -- defaults filled in,
project merged over global -- so no consumer has to re-implement the precedence.

(2) lives in TypeScript (`src/routing.ts`), because the live usage snapshot is already
in the frontend store and the consumer is a dialog that has to render synchronously.

This is a split, not a fork: neither side re-implements the other's decision. The
failure mode to avoid is the one `status_rules.rs` / `statusRules.ts` warns about, where
two copies of the same rule drift. Here there is exactly one copy of each rule.

## Resolution rules

Given an ordered target list and an availability map:

- **Unknown quota is not exhausted quota.** An agent whose usage Conduit cannot read
  (not signed in, endpoint down, no usage API at all) is treated as available. The
  alternative silently reroutes people away from a perfectly good agent because a meter
  failed to load.
- **Not installed is skipped**, always, and never reported as a quota problem.
- **Exhausted means at or below the same low-water threshold the usage bar already
  uses** (Settings -> Usage display), so one number governs both the warning and the
  reroute rather than two that can disagree.
- **If everything is exhausted, pick the first INSTALLED target anyway** and say so.
  Refusing to create a session because a meter is low is worse than creating one that
  might hit a limit -- extra credits, a reset five minutes away, or a plan change all
  make the meter wrong in the user's favour.
- **Every decision carries a reason string.** A router that silently picks something
  other than what the settings say is indistinguishable from a bug.

## Scope

Session creation is the consumer. The new-session dialog gains a task picker; choosing
one preselects the agent and model, showing which route produced it and why.

**Not doing yet:** routing the Conductor's `fleet_spawn` workers. It is the obvious next
consumer and the resolver is deliberately shaped to serve it, but the Conductor picks
agents through `fleet.rs` with its own capability-card prompt, and reconciling those two
mechanisms is a design question rather than a wiring exercise.

**Not doing:** switching models mid-session. Every agent here pins its model at spawn.
