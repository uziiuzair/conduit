# Agent capabilities as data

**Date:** 2026-08-10
**Status:** Design
**Sub-project:** 4 of 6 — see `2026-08-10-nodeterm-lessons-overview.md`

## Problem

Conduit models an agent as a Rust trait, `ProviderAdapter` (`agent.rs:81`), with five
implementations. The trait has twelve methods, of which nine have default implementations
that exist so that most adapters can ignore them: `supports_worktree`, `env_overrides`,
`account_env`, `hooks_profile`, `plugin_profile`, `mcp_add_command`, `mcp_remove_command`,
`install_command`.

That shape has two costs.

**Capabilities are scattered.** To answer "which agents support worktrees?" you read five
impl blocks. There is no single place that states the capability matrix, so the matrix exists
only in the reader's head, and the frontend re-derives its own version of it in TypeScript
with no compile-time link to the Rust one.

**A user-defined agent is not expressible.** `AgentId` is a closed enum. Adding an agent means
a new variant, a new impl block, a new match arm in `adapter_for`, and a matching change on
the TypeScript side. A user who wants to point Conduit at some other CLI cannot, and the
plugin system cannot offer it either.

`AgentId` is also persisted on every `Session` and used as a map key for per-agent default
accounts. A closed enum means an unknown value on load is a deserialization decision, which
today resolves to "unknown or absent → Claude". Once a user-defined agent exists, silently
turning it into Claude would be wrong.

## What nodeterm does

`src/shared/agents/config.ts`, 348 lines, is the whole model:

```ts
export type AgentId = BuiltinAgentId | (string & {})   // open — custom:<uuid>
export const AGENT_CONFIG: Record<BuiltinAgentId, AgentConfig> = { … }
export const SUBAGENT_CAPABLE = ['claude'] as const
export const RESUMABLE_AGENTS = ['claude','codex','gemini','opencode','grok'] as const
export const canSubagent = (id: AgentId) => SUBAGENT_CAPABLE.includes(id)
```

Capabilities are const membership lists, not methods and not a capability struct. An agent
not in a list simply lacks that capability, so a custom agent automatically degrades to spawn
plus terminal title plus process status, with no code path of its own.

Their `AgentConfig` also captures launch grammar that Conduit currently handles ad hoc inside
each `build_invocation`: `promptInjectionMode: 'argv' | 'flag-prompt' | 'stdin-after-start'`
plus an optional `argvPromptSeparator`. The comments record that these were measured against
shipped binaries rather than inferred — opencode's bare positional is a project path, not a
prompt, and grok's positional collides with its subcommand names so a one-word prompt of
`version` silently runs the subcommand instead of reaching the model.

## Design

The goal is not to delete the trait. Behavior that genuinely differs per agent — how to build
an invocation, how to redirect an account — is real code and belongs in code. The goal is to
move *facts* out of the trait and into one declarative table, and to open the id type.

### The capability table

A new `agent_caps.rs` holding one `const` table and typed accessors:

```rust
pub struct AgentCaps {
    pub id: &'static str,
    pub label: &'static str,
    pub binary: &'static str,
    pub color: &'static str,
    pub prompt_injection: PromptInjection,
    pub argv_prompt_separator: Option<&'static str>,
    pub worktree: bool,
    pub resumable: bool,
    pub accounts: bool,
    pub hooks: bool,
    pub mcp: bool,
    pub install: Option<&'static str>,
}

pub const BUILTIN_CAPS: &[AgentCaps] = &[ /* claude, codex, gemini, opencode, antigravity */ ];
```

The trait keeps only the methods that are behavior: `build_invocation`, `account_env`,
`hooks_profile`, `plugin_profile`, `mcp_add_command`, `mcp_remove_command`. Every predicate
method (`supports_worktree`, `install_command`, `binary`) is deleted and its call sites read
the table instead.

`PromptInjection` is adopted from nodeterm because Conduit has the same latent hazard: its
`build_invocation` implementations each decide independently how to pass an initial prompt,
and opencode's positional-is-a-path behavior is the kind of thing that is correct today
because someone got it right once, with nothing recording why.

### Opening `AgentId`

`AgentId` becomes a newtype over a small string rather than a closed enum:

```rust
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AgentId(String);
```

with associated constants `AgentId::CLAUDE`, `AgentId::CODEX`, and so on, so existing match
sites become `if id == AgentId::CLAUDE` or a lookup in the table. Unknown ids deserialize as
themselves rather than collapsing to Claude, and an unknown id with no table entry gets the
empty capability set — which is exactly nodeterm's degradation story.

This is the invasive part of the change. `AgentId` appears in `store.rs` as a session field
and as a map key, in `pty.rs`, in `lib.rs`'s command surface, in `fleet.rs`, and in the
TypeScript store. The serialization format does not change — it is a lowercase string today
and a string after — so persisted state loads unchanged, which is the property that makes the
change safe to make in one commit.

### One table, two languages

The table is the source of truth and lives in Rust. A `agent_caps` Tauri command returns it,
and the TypeScript store consumes it rather than re-declaring the matrix. This removes the
current duplication, in which the frontend decides for itself which agents show a worktree
toggle or an account picker.

Generating TypeScript from Rust at build time would be tighter still, and is rejected: it
adds a codegen step to a build that does not have one, for a table that changes a few times a
year. A runtime command is enough and costs nothing.

## Migration and compatibility

- Persisted `Session.agent` values are unchanged (lowercase strings).
- The per-agent default-account map keys are unchanged (serde emits the newtype as a string).
- An unknown agent id loaded from a state file written by a newer version no longer silently
  becomes Claude. It becomes itself, with no capabilities, and the UI shows it as
  unavailable rather than mislabeling it.

## Testing

- Every builtin id in `BUILTIN_CAPS` has a matching adapter in `adapter_for`, and vice versa.
  This is the test that keeps the two halves from drifting.
- No two entries share an `id` or a `binary`.
- An unknown `AgentId` yields the empty capability set and is not Claude.
- `AgentId` round-trips through serde as the same lowercase string it does today — asserted
  against a literal JSON fixture, so a future refactor cannot change the on-disk format
  without failing.
- Prompt-injection mode is asserted per agent against the documented behavior, with the
  opencode and grok reasoning recorded in the test as comments.

## Deferred

- **User-defined agents in the UI.** This sub-project makes them representable; it does not
  add the settings surface to create one. That is a separate feature, and it should not be
  designed until the representation has shipped and settled.
- **Plugin-provided agents.** The natural follow-on once user-defined agents exist, and a
  Tier-P concern for the plugin system.
