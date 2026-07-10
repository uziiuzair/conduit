# Orchestration v2 — Scope Expansion (Tiered 5-Adapter Fleet + Mailbox)

> Status: **accepted, supersedes §8/§9 of the baseline**. Date: 2026-07-05.
> Baseline: `docs/superpowers/specs/2026-07-04-orchestration-v2-design.md` (read it
> first — §1–§7 and §10 are **unchanged and still in force**: SPEC-0 security fix,
> the blackboard shape, the native-subagent boundary, the guardrails, the usage
> honesty rules, the invariants). This document rewrites only what the product
> owner's three decisions below change: §8 (scope decisions), §9 (spec index),
> and the per-adapter detail inside SPEC-A/F/G. Companion plan:
> `docs/superpowers/plans/2026-07-05-orchestration-v2-scope-expansion.md` (the
> literal, ordered task breakdown a fresh agent executes).
>
> **2026-07-05 research integration:** a new **§7** appends seven cost/quality
> optimization levers grounded in `claude_docs/conduit-ai-agent-cli-research.md`
> (multi-vendor CLI reference). They are additive to SPEC-A/B/G/H — read §7 and
> its §7.8 index before executing Phases 2, 6, 7, 8, 10. Owner decision folded
> in there: **build the Antigravity (`agy`) adapter before Gemini** (Gemini CLI
> is EOL; `agy` is its successor) — see §7.0/§7.1 and the plan's phasing table.
>
> **Post-write audit (2026-07-05, same day):** a second adversarial pass caught
> four concrete defects in the first draft of this document, all fixed inline
> and marked with a `2026-07-05 audit fix` callout at the exact location: (1)
> a dropped depth-cap/caller-role guardrail — §2.0, new; (2) a Codex Windows
> invocation that would not run (`cmd.exe` has no `;` separator) — §2.5,
> rewritten; (3) Gemini's flag surface asserted without the same verification
> spike Codex got — §1.2/§2.6, spike now mandatory; (4) OpenCode's Tier-1 MCP
> claim not reconciled with a prior accepted spec — §1.1, reconciling note
> added. Two non-blocking findings were also folded in: the mailbox rate limit
> was pulled forward from Phase 10 to Phase 5 (see the plan doc), and a
> `hookbus.rs` semantics description was corrected (drop-newest, not
> drop-oldest). Nothing below reflects the un-audited first draft.

## 0. The three decisions that force this rewrite

1. **Build the horizontal worker↔worker mailbox in v1** (SPEC-F). Not deferred.
2. **All five adapters** (Claude, Codex, Gemini, OpenCode, Antigravity) must be
   spawnable by the orchestrator in v1 — not just Claude + OpenCode/local.
3. **Usage meter ships as:** one shared-pool Claude subscription-window % +
   per-session token counts broken out underneath. **Not** a true per-agent %
   by default (unchanged from the baseline's recommendation — now locked in as
   the decision, not just a recommendation).

Everything below exists to make decisions 1 and 2 concrete without lying about
what a `codex`/`gemini`/`agy` process can actually do today.

---

## 1. Tiered participation model — the honest finding

**Plainly: "all five adapters spawnable" cannot mean "all five adapters get
equal capability."** Only Claude has a documented, per-invocation, zero-setup
mechanism for MCP injection + prompt delivery + a structured result channel.
The other four require Conduit to *engineer* isolation and/or fall back to a
different transport, and for one of them (Antigravity) no working transport
could be verified against an authoritative source at all. Shipping v1 as if
all five were symmetric would either (a) quietly ship four broken/no-op
integrations, or (b) burn the whole phase on unverified, high-risk plumbing
(Codex `CODEX_HOME` cloning, Gemini per-worktree trust bypass) before the
mailbox — which the owner explicitly wants in v1 — ever lands. So v1 draws a
line and documents it; upgrading a Tier-2 adapter to Tier-1 MCP is scoped as an
explicit fast-follow, not a silent gap.

| Tier | Adapters | Gets fleet MCP tools (`fleet_result`, `fleet_note`, `fleet_inbox`, …)? | Prompt/mission delivery | Isolation | Result/mailbox transport |
|---|---|---|---|---|---|
| **1 — Full MCP participant** | Claude, OpenCode | Yes, native | `--append-system-prompt` + positional (Claude); `--prompt` flag (OpenCode) | Claude: self (`--worktree`). OpenCode: Conduit-driven `git worktree add` | MCP tool calls |
| **2 — Structured participant, no MCP (v1)** | Codex, Gemini | No (v1); MCP is an **opt-in fast-follow**, see §1.3 | Codex: `codex exec` headless run, then drop into interactive `codex`. Gemini: `--prompt-interactive` (seeds then stays interactive) | Conduit-driven `git worktree add` | Extended hook channel: new `result`/`note` verbs over the *existing* HooksProfile curl mechanism |
| **3 — Leaf / unmonitored** | Antigravity | No | None (build_invocation stays the constant `"agy \|\| agy"`) | Conduit-driven `git worktree add` (isolation is orthogonal to monitoring — still worth doing) | None. Orchestrator relies on `fleet_peek`'s raw 8 KiB scrape or asks the human. `CONDUCTOR_PERSONA` must say this outright. |

### 1.1 Why Claude and OpenCode are Tier 1 today, unmodified

- **Claude:** already wired (`ClaudeAdapter::build_invocation`, `agent.rs:119-139`);
  no change needed beyond what SPEC-A/SPEC-1/SPEC-C already do.
- **OpenCode:** `opencode.json`'s top-level `"mcp"` key merges through the exact
  same `OPENCODE_CONFIG_CONTENT` env-var channel Conduit already uses for local-model
  routing (`build_opencode_config`, `agent.rs:465-521`). No new CLI flag, no new
  env var, no worktree-scoped trust dance. This is the cheapest possible Tier-1 win
  and should ship first within this phase.

  **Reconciliation with the existing accepted OpenCode spec (do not treat as a
  conflict):** `docs/superpowers/specs/2026-06-30-opencode-integration-tier-2-design.md`
  defines `supportsMcp: false` for OpenCode and lists "OpenCode in the MCP
  matrix" as an out-of-scope Tier-3/future item, with the UI footnote "OpenCode
  MCP support is coming soon." **These are two different mechanisms and do not
  contradict each other:** the MCP-matrix feature is a *user-editable, persistent*
  list of MCP servers a human configures per agent (`mcp_apply`, `fleet_mcp`'s
  sibling in `lib.rs:578-624`) — that remains unsupported for OpenCode, unchanged.
  What this phase adds is a *single, ephemeral, Conduit-injected* MCP server
  (`fleet`) that exists only for the lifetime of one fleet-worker spawn, wired
  through the same env-var channel already used for local-model routing, never
  surfaced in or managed by the MCP matrix UI. **Verification spike required
  before wiring `inject_fleet_mcp` into the real spawn path (Phase 2 task list):**
  confirm against a live installed `opencode` version that an `OPENCODE_CONFIG_CONTENT`
  payload containing a top-level `"mcp"` key is actually recognized and the
  declared server appears as a callable tool inside the running session — do
  not ship on the assumption that the JSON shape "looks plausible."

### 1.2 Why Codex and Gemini are Tier 2 in v1, not Tier 1

Both *could* reach Tier-1 MCP participation, but only via a mechanism Conduit
would have to build and that the research flags as unverified/fragile:

- **Codex:** no ephemeral `--mcp-config` flag. The only per-invocation route is
  `CODEX_HOME` redirection to a Conduit-managed directory containing a throwaway
  `config.toml` with `[mcp_servers.fleet]` pointing at Conduit's HTTP MCP endpoint
  (Codex's streamable-HTTP server fields — `url`, `http_headers`,
  `bearer_token_env_var` — support this shape). **The catch:** redirecting
  `CODEX_HOME` also redirects away from `~/.codex/auth.json`, so Codex would have
  no credentials unless Conduit *copies* the user's real `auth.json` into every
  per-session `CODEX_HOME` directory — a real increase in secret-copy blast radius
  (see Audit Finding 4). Additionally, whether Codex's native hook runner supports
  multiple hook entries per event the way Claude's does is **unverified** in this
  codebase (no test, no comment — flagged by the grounding pass).
- **Gemini:** no ephemeral MCP flag either; MCP servers only come from
  `.gemini/settings.json` read relative to CWD. Because Conduit already gives
  Gemini fleet workers their own worktree directory (§2), writing a
  `.gemini/settings.json` *inside that worktree* would be a legitimate
  per-session-scoped config — **but** first use of hooks/MCP config in a fresh
  directory hits Gemini's workspace-trust gate and throws
  `FatalUntrustedWorkspaceError` in headless mode unless Conduit also passes
  `--skip-trust` / sets `GEMINI_CLI_TRUST_WORKSPACE=true` on every such spawn.

Neither is *impossible* — both are a plausible fast-follow — but both add new
failure modes (a credential-copy hygiene problem for Codex; a trust-bypass flag
that must never leak to a session Conduit *didn't* provision, for Gemini) on top
of unverified assumptions about hook multiplicity and headless approval modes.
v1 ships the **hook-channel path** for both (§3), which reuses machinery already
proven in this codebase (`HooksProfile`, `entries_for`, `install_profile`) and
carries none of those risks. The MCP upgrade is Phase 6 (fast-follow, gated on a
manual verification spike — see the plan doc, Phase 6).

> **2026-07-05 audit fix:** the Codex spike (Phase 3, task 1 in the plan) was
> the only mandatory pre-implementation verification in the first draft of
> this document. Gemini's flag surface (`--skip-trust`, `--prompt-interactive`,
> and `AfterAgent`'s `prompt_response` payload field) was asserted with the
> same confidence but **no equivalent spike** — and a live web search during
> the audit surfaced a real, version-specific regression report for
> `--skip-trust` against gemini-cli. **This is now a mandatory spike, not an
> optional nice-to-have** — see the plan doc's Phase 3, task "3a" (Gemini
> spike, inserted before the Gemini `build_invocation` rewrite task). Do not
> implement §2.6 below against an uninstalled/unverified `gemini` version.

### 1.3 Why Antigravity is Tier 3

`agent.rs:415-419`'s existing comment is honest: hooks/MCP are left `None`
"until `agy`'s integration surface is verified." The research surfaced a
third-party (non-Google, unverified) claim that Antigravity plugins live at
`~/.gemini/antigravity-cli/plugins/<name>/` with an optional `hooks.json` — but
this could not be corroborated against `antigravity.google`'s own docs (the
official CLI-features page returned no extractable body content), and several
supporting sources are low-quality SEO content. **Do not build against an
unverified third-party claim.** Antigravity v1 = spawnable, worktree-isolated,
structurally silent. `CONDUCTOR_PERSONA` must say so explicitly (§5 of the plan,
Phase 2 task list) so the orchestrator doesn't assume a `fleet_result` is coming.
A follow-up research spike (installing `agy` and inspecting
`~/.gemini/antigravity-cli/` directly) is a tracked, explicitly non-blocking task.

---

## 2. Rewritten SPEC-A — heterogeneous spawn, all five adapters

### 2.0 Guardrail patch (do this FIRST — closes a dropped invariant)

**Finding from a second audit pass, verified against the live tree:**
`fleet_mcp.rs`'s `dispatch_tool` has **zero caller-role check today**. Any
session holding an MCP connection to `conduit-fleet` can call all 7 tools
(5 existing + the 2 this document adds), regardless of whether that session
is the project's Conductor or a worker. This was already latent as of the
baseline's Phase 1/SPEC-C (`docs/superpowers/plans/2026-07-04-orchestration-v2-plan.md`)
the moment a worker needed to call `fleet_result` — but §2.3 below makes it
acute, because it is the first place a **Worker-role** session (an OpenCode
fleet worker) is deliberately wired an MCP connection. Left unfixed, that
worker could also call `fleet_spawn`/`fleet_send`/`fleet_stop`/`fleet_peek`/
`fleet_list` — breaking the baseline's invariant 5 ("a worker cannot spawn
workers, enforced in code + tests", §10 of the base design) the moment this
phase ships. `MAX_WORKERS=8` would be the *only* remaining backstop, and it
caps count, not capability.

**Fix — a role allowlist checked before every dispatch arm runs:**

```rust
/// Every tool call MUST pass through this before touching Store/Pty/Board.
/// Conductor: all tools. Worker: only the vertical/horizontal DATA tools —
/// never anything that spawns, commands, or observes a sibling session.
fn authorize(ctx: &Ctx, tool: &str) -> Result<(), String> {
    let snap = ctx.store.fleet_snapshot(&ctx.conductor_id).ok_or("caller-not-found")?;
    let caller = snap.sessions.iter().find(|s| s.id == ctx.conductor_id).ok_or("caller-not-found")?;
    const WORKER_ALLOWED: &[&str] = &["fleet_result", "fleet_note", "fleet_inbox"];
    match caller.role {
        SessionRole::Conductor => Ok(()),
        SessionRole::Worker if WORKER_ALLOWED.contains(&tool) => Ok(()),
        SessionRole::Worker => Err("worker-role-cannot-orchestrate".into()),
    }
}
```

Call `authorize(&ctx, tool_name)?` as the **first line** inside `dispatch_tool`
(`fleet_mcp.rs:90`, before the existing `match name { ... }`), using the
already-parsed tool name. `fleet_result` is added in Phase 1/SPEC-C and must
be in `WORKER_ALLOWED` from the moment it exists — do not wait for Phase 5's
`fleet_note`/`fleet_inbox` to add this gate; add it now, with only
`"fleet_result"` in the allowlist, then extend the `const` array in Phase 5
when the other two tools land (a one-line diff, not a redesign).

**Tests (add in whichever phase first grants a Worker an MCP connection —
Phase 2, since OpenCode Tier-1 is where that first happens):**
- `dispatch_tool_rejects_fleet_spawn_from_worker_role` — a `Worker`-role
  caller's `fleet_spawn` call → `Err` containing `"worker-role-cannot-orchestrate"`.
- Parallel tests (or one parameterized test) for `fleet_send`, `fleet_stop`,
  `fleet_peek`, `fleet_list` — same assertion.
- `dispatch_tool_allows_fleet_result_from_worker_role` — positive case,
  regression guard so the gate doesn't over-block the one thing Tier-1 workers
  exist to do.
- `dispatch_tool_allows_all_tools_from_conductor_role` — regression guard on
  the existing Conductor flows (all 5 original tools still work post-patch).

### 2.1 Per-adapter table (mission delivery / isolation / result mechanism)

| Adapter | Mission/prompt delivery | Isolation mechanism | Exact isolation commands | Result/mailbox mechanism |
|---|---|---|---|---|
| **Claude** | Unchanged: `ClaudeAdapter::build_invocation` (`agent.rs:119-139`), positional prompt + `--append-system-prompt` via `flags` | Self-managed: `claude --worktree <slug>` (existing) | n/a (Claude's own CLI creates it) | `fleet_result`/`fleet_note` MCP tools (Tier 1) |
| **OpenCode** | **Rewritten** `build_invocation` — see §2.2 | Conduit-driven `git worktree add` (new — OpenCode never had one) | `git worktree add -b worktree-<slug> <wt_path> <base_ref>` (via new `worktree::add`, §2.4) | `fleet_result`/`fleet_note` MCP tools (Tier 1), wired via `inject_fleet_mcp` (§2.3) |
| **Codex** | **Rewritten** `build_invocation` — headless `codex exec` run, then always drop into interactive `codex` — see §2.5 | Conduit-driven `git worktree add` | same as above | Extended hook channel: new `result` HookRow on `Stop`, fed by `--output-last-message`/`--output-schema` files curl'd from the invocation string itself (§3.2) |
| **Gemini** | **Rewritten** `build_invocation` — `gemini --prompt-interactive <mission>` — see §2.6 | Conduit-driven `git worktree add` | same as above | Extended hook channel: new `result` HookRow on `AfterAgent` (alongside the existing `stop`-mapped row), reading `prompt_response` from the hook payload (§3.2) |
| **Antigravity** | **Unchanged**: constant `"agy \|\| agy"` (`agent.rs:420-428`) | Conduit-driven `git worktree add` (isolation still applies even though monitoring doesn't) | same as above | None. `fleet_peek` only. |

### 2.2 OpenCode `build_invocation` — exact rewrite

Current (`agent.rs:377-385`) drops `initial_prompt` entirely. Rewrite:

```rust
fn build_invocation(
    &self,
    _session_id: &str,
    _projects_dir: Option<&Path>,
    flags: &str,
    initial_prompt: Option<&str>,
) -> String {
    // `--prompt` seeds the message into the TUI session and then STAYS interactive
    // (unlike `opencode run "<msg>"`, which is a one-shot that exits) — this keeps
    // fleet workers durable/human-visible per design §3(b).
    let prompt = initial_prompt
        .map(|p| format!(" --prompt {}", crate::pty::quote_arg(p)))
        .unwrap_or_default();
    format!("opencode{flags}{prompt} || opencode{flags}{prompt}")
}
```

`flags` for OpenCode carries no new CLI text (OpenCode's MCP wiring is 100%
env-var-based, never a flag) — it stays available for future use (e.g. a
`--worktree`-equivalent marker) but is not consumed by MCP injection.

**Test to add** (`agent.rs` `mod tests`): `opencode_appends_initial_prompt_via_prompt_flag`
— asserts `OpenCodeAdapter.build_invocation("sid", None, "", Some("do X"))` equals
`"opencode --prompt 'do X' || opencode --prompt 'do X'"` (POSIX) /
`"opencode --prompt \"do X\" || opencode --prompt \"do X\""` (Windows), mirroring
the existing `claude_appends_initial_prompt_as_quoted_positional` test shape
(`agent.rs:727-736`).

### 2.3 OpenCode Tier-1 MCP injection — exact new function

`build_opencode_config` (`agent.rs:465-521`) is the **local-model** feature and
must stay independent — Tier-1 fleet participation must work even when local
models are off. Add a sibling function in `agent.rs`:

```rust
/// Merge the fleet MCP server into an OpenCode spawn config (or start a fresh one).
/// Independent of `build_opencode_config`/local-model routing — callable whenever
/// this OpenCode session is a fleet worker, regardless of `OpenCodeSettings.enabled`.
/// Wired as a "remote" (streamable-HTTP) server, matching Conduit's fleet MCP
/// server's own transport (`fleet_mcp.rs`, `"type": "http"` on the Claude side).
pub fn inject_fleet_mcp(
    base: Option<OpenCodeSpawnConfig>,
    mcp_port: u16,
    conductor_id: &str,
) -> OpenCodeSpawnConfig {
    let mut root: Value = base
        .as_ref()
        .and_then(|c| serde_json::from_str(&c.config_json).ok())
        .unwrap_or_else(|| json!({ "$schema": "https://opencode.ai/config.json" }));
    root["mcp"] = json!({
        "fleet": {
            "type": "remote",
            "url": format!("http://127.0.0.1:{mcp_port}/mcp?conductor={conductor_id}"),
            "enabled": true,
        }
    });
    OpenCodeSpawnConfig {
        config_json: root.to_string(),
        api_key: base.and_then(|c| c.api_key),
    }
}
```

Call site: `lib.rs:119-126` (the existing `opencode` local-config block inside
`pty_spawn`) gains a fleet-aware branch — when `role == Some("worker")` **and**
`agent == AgentId::OpenCode` **and** the worker was created via `fleet_spawn`
(i.e. it has a `Mission` record — see SPEC-C), call `inject_fleet_mcp` on top of
whatever `build_opencode_config` already returned (or `None`), then set
`OPENCODE_CONFIG_CONTENT` from the merged result. **Test:**
`inject_fleet_mcp_adds_mcp_key_without_disturbing_provider_config` — build a
config via `build_opencode_config`, pipe it through `inject_fleet_mcp`, assert
both `v["provider"]["conduit"]` (untouched) and `v["mcp"]["fleet"]["url"]`
(new) are present; and a second test asserting `inject_fleet_mcp(None, ...)`
produces a valid minimal config with only the `mcp` key when local-model
routing is off.

### 2.4 Conduit-driven worktree — the new `worktree::add`

**Pre-existing gap this surfaces (see Audit Finding 1):** `Store::add_session`
(`store.rs:508-553`) already computes `worktree_path`/`branch` for **any**
agent when `use_worktree=true` (lines 530-538 are agent-agnostic), but
`pty_spawn` (`lib.rs:130`) only ever *realizes* that path when
`adapter.supports_worktree()` is true (Claude only) — for the other four
adapters the field is silently inert today. This phase finally makes it real
for Codex/Gemini/OpenCode/Antigravity.

New function in `worktree.rs` (alongside `remove`, mirroring its error-handling
shape):

```rust
/// Create a NEW worktree Conduit itself manages, for adapters with no built-in
/// `--worktree` flag. Runs `git worktree add -b <branch> <worktree_path> <base_ref>`
/// from `repo_path`. Fails closed on any ambiguity rather than guessing — mirrors
/// `is_dirty`'s "assume the conservative outcome" philosophy, adapted to creation:
///   - target path already exists (any kind, even non-git-worktree junk) -> Err
///     WITHOUT touching it (never silently reuse/overwrite an existing directory).
///   - `git worktree add` itself fails (branch collision, `base_ref` doesn't resolve
///     — e.g. a brand-new repo with zero commits — or `repo_path` isn't a repo at
///     all) -> Err(stderr), propagated verbatim so the caller can surface it.
pub fn add(repo_path: &str, worktree_path: &str, branch: &str, base_ref: &str) -> Result<(), String> {
    if Path::new(worktree_path).exists() {
        return Err("worktree-path-exists".into());
    }
    let out = Command::new("git")
        .args(["worktree", "add", "-b", branch, worktree_path, base_ref])
        .current_dir(repo_path)
        .no_window()
        .output()
        .map_err(|e| format!("git worktree add: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
```

**Tests** (mirror the existing `fresh_repo`/`git` test helpers at
`worktree.rs:136-164`):
- `add_creates_worktree_on_fresh_branch` — happy path, dir + branch exist after.
- `add_fails_closed_when_path_already_exists` — pre-create the target dir, assert
  `Err("worktree-path-exists")` and that git was never invoked (dir untouched).
- `add_fails_when_base_ref_does_not_resolve` — pass a bogus `base_ref` (e.g.
  `"nonexistent-branch-xyz"`), assert `Err(_)` with git's own stderr text present.
- `add_fails_when_repo_path_is_not_a_git_repo` — a plain empty temp dir, assert
  `Err(_)`.

**Call site** in `pty_spawn` (`lib.rs:60-169`), new branch inserted between the
existing Claude branch (line 130) and the plain-session `else` (line 138):

```rust
} else if worktree_name.is_some() && !adapter.supports_worktree() && !shell_only {
    let slug = worktree_name.as_deref().unwrap();
    let wt_path = worktree::worktree_path(&working_directory, slug);
    let branch = worktree::branch_name(slug);
    if !Path::new(&wt_path).exists() {
        let base_ref = crate::git::current_branch(&working_directory)
            .unwrap_or_else(|| "HEAD".to_string());
        if let Err(e) = worktree::add(&working_directory, &wt_path, &branch, &base_ref) {
            eprintln!("conduit: git worktree add failed for {slug}: {e}");
            // Fail-safe: surface the error rather than silently spawning unisolated
            // in the shared project root — an isolation failure must be visible, not
            // quietly downgraded to "no isolation". Return Err from pty_spawn here
            // (existing signature is already Result<(), String>) rather than falling
            // through.
            return Err(format!("worktree setup failed: {e}"));
        }
    }
    // Install this adapter's status/result/note channel INTO the worktree, not the
    // repo root — result/note routing must be scoped to the worker's own tree.
    if let Some(profile) = adapter.hooks_profile() {
        hooks::install_profile(&wt_path, port, &profile);
    }
    if let Some(plugin) = adapter.plugin_profile() {
        hooks::install_plugin(&wt_path, port, &plugin);
    }
    (wt_path, None, None)
}
```

`Path` is already imported in `lib.rs` (used at line 134). No new import needed.

### 2.5 Codex `build_invocation` — exact rewrite

Current (`agent.rs:286-294`) is the constant `"codex || codex"`. Rewrite drops
the mission into a headless `codex exec` pass (capturing a schema-constrained
structured result to a file), then reports that file to Conduit's own hook
endpoint, then always continues into an interactive `codex` so the worker
stays a durable, human-visible terminal.

> **2026-07-05 audit fix — do not ship the naive `;`-joined version.** An
> earlier draft of this rewrite joined three commands with `;` unconditionally
> and hand-embedded escaped double quotes in the curl call, cfg-gating only the
> URL syntax. On Windows, `cmd.exe /K` (`pty.rs:230`) has **no `;` separator**
> — only `&`/`&&`/`||` chain commands on one line — and `pty.rs`'s own doc
> comment (`pty.rs:618-620`) already warns that a compound command containing
> embedded double quotes inside a single `cmd /K` argument "is not fully
> robust under cmd's re-parse." That draft would have silently failed to spawn
> a working Codex worker on Windows — the owner's own platform. The fix below
> (a) cfg-gates the **entire** join, not just the curl syntax, using `&` on
> Windows, and (b) sidesteps the embedded-quote fragility altogether by
> writing the curl call into a small **helper script file** on Windows,
> instead of inlining a quote-heavy compound command as a single `cmd /K`
> argument. POSIX `sh` has no equivalent fragility, so it stays inlined.

```rust
fn build_invocation(
    &self,
    session_id: &str,
    _projects_dir: Option<&Path>,
    flags: &str,
    initial_prompt: Option<&str>,
) -> String {
    let Some(prompt) = initial_prompt else {
        // No mission (e.g. a manual/non-fleet Codex session) — unchanged behavior.
        return "codex || codex".to_string();
    };
    let quoted = crate::pty::quote_arg(prompt);
    // `.conduit/` is provisioned by the same step that installs this adapter's
    // HooksProfile (see §3.2) — it writes result.schema.json there before spawn.
    #[cfg(windows)]
    {
        // The curl call itself lives in `.conduit\result.cmd`, a real file
        // Conduit writes at provisioning time (see below) — no shell-escaping
        // needed there since Rust writes the file's bytes directly, not
        // through a shell. The outer invocation only ever chains three SIMPLE
        // tokens with '&' (cmd.exe's actual separator), never an embedded
        // quote-heavy command.
        format!(
            "codex{flags} exec --json --output-last-message .conduit\\result.json --output-schema .conduit\\result.schema.json {quoted} & call .conduit\\result.cmd & codex{flags}"
        )
    }
    #[cfg(not(windows))]
    {
        let tail = format!(
            "curl -s -m 5 -X POST -H \"Content-Type: application/json\" --data-binary @.conduit/result.json \"http://127.0.0.1:${{CONDUIT_HOOK_PORT:-0}}/hook?session=${{CONDUIT_SESSION_ID:-{session_id}}}&event=result\" >/dev/null 2>&1 || true"
        );
        format!(
            "codex{flags} exec --json --output-last-message .conduit/result.json --output-schema .conduit/result.schema.json {quoted}; {tail}; codex{flags}"
        )
    }
}
```

**New Windows-only provisioning step** (write this alongside
`.conduit/result.schema.json`, at the same point in the Phase 2 worktree
branch that calls `hooks::install_profile`/`hooks::install_plugin` — see
§2.4's call site): a new function, e.g. `hooks::write_codex_result_script
(worktree_path: &str, port: u16) -> std::io::Result<()>` (Windows-only,
`#[cfg(windows)]`), writes `.conduit\result.cmd` containing:

```bat
@echo off
curl -s -m 5 -X POST -H "Content-Type: application/json" --data-binary @.conduit\result.json "http://127.0.0.1:%CONDUIT_HOOK_PORT%/hook?session=%CONDUIT_SESSION_ID%&event=result" >NUL 2>&1
```

This file is written once, per worktree, using `std::fs::write` with the
content above as a plain string — there is no shell re-parsing at write time,
only at the single `call .conduit\result.cmd` invocation inside the already-
simple `&`-joined outer command.

**Unverified assumptions flagged for a pre-implementation spike** (Phase 3,
task 1 in the plan — see also the new Gemini-equivalent spike, task "3a"):
(a) that `--output-last-message` + `--output-schema` together produce a file
whose content is valid JSON matching the schema (rather than plain text) on a
current `codex` build; (b) that `codex exec` respects a non-interactive
approval mode without hanging on a permission prompt (may need `-a never`/
`--full-auto` or equivalent — verify against a live install, do not guess the
flag name); (c) — new — that the Windows `& call .conduit\result.cmd &`
chain actually runs all three legs in order inside `cmd /K` without one
leg's exit code short-circuiting the next (unlike `||`, plain `&` runs the
next command regardless of the previous one's exit code — verify this is
the desired semantic: a failed `codex exec` should still be followed by the
interactive `codex` fallback, which `&` gives you; a failed curl should not
abort the sequence either, which `&` also gives you — confirm empirically,
this is why `&` and not `&&` was chosen). All three are exact, falsifiable
checks to run against a real `codex` binary and a real Windows `cmd.exe`
before wiring this into the shipped build; if (a)/(b) fail, the fallback is:
drop `--output-schema`, curl whatever plain-text `--output-last-message`
produced as `{"status":"unknown","summary":"<raw text>","artifact_paths":[],
"tokens":null}` (a client-side wrap), and note the degraded structuring in the
result envelope.

**Tests to add:**
- `codex_with_prompt_chains_exec_then_interactive` (POSIX target) — asserts
  the built string contains `"exec --json"`,
  `"--output-schema .conduit/result.schema.json"`, `"event=result"`, and ends
  with `"; codex"` (or `"; codex --worktree ..."` when `flags` is non-empty).
- `codex_with_prompt_uses_ampersand_chain_on_windows` (Windows target,
  `#[cfg(windows)]` or built with a Windows-target test config) — asserts the
  built string uses `'&'` as every separator, contains **no** un-doubled
  embedded double-quote inside the single `cmd /K` argument (i.e. no raw
  `curl ... -H \"Content-Type...` inlined), and contains
  `"call .conduit\\result.cmd"` — mirroring the shape of the existing
  `build_script_win_quotes_spaced_flags` test in `pty.rs`.
- `codex_without_prompt_is_unchanged` — asserts the no-`initial_prompt` branch
  still returns exactly `"codex || codex"` (regression guard on the existing
  `codex_spawns_fresh_with_fallback` test, `agent.rs:693-701`).

### 2.6 Gemini `build_invocation` — exact rewrite

Current (`agent.rs:184-192`) is the constant `"gemini || gemini"`. Rewrite:

```rust
fn build_invocation(
    &self,
    _session_id: &str,
    _projects_dir: Option<&Path>,
    flags: &str,
    initial_prompt: Option<&str>,
) -> String {
    match initial_prompt {
        // `--prompt-interactive` runs the mission once, then STAYS in the TUI —
        // the durable/human-visible worker shape, no headless/exit step needed
        // (unlike Codex). `--skip-trust` is required because Conduit just wrote a
        // brand-new `.gemini/settings.json` into this worktree (see §1.2) and a
        // fresh directory otherwise throws FatalUntrustedWorkspaceError headless.
        Some(p) => format!(
            "gemini{flags} --skip-trust --prompt-interactive {} || gemini{flags} --skip-trust",
            crate::pty::quote_arg(p)
        ),
        None => "gemini || gemini".to_string(),
    }
}
```

**Test to add:** `gemini_with_prompt_uses_prompt_interactive_and_skip_trust` —
asserts the string contains `"--prompt-interactive"` and `"--skip-trust"` when
`initial_prompt` is `Some`; `gemini_without_prompt_is_unchanged` — regression
guard on `gemini_spawns_fresh_and_has_no_worktree` (`agent.rs:769-779`), which
must keep passing unmodified (no-prompt path untouched).

**Risk called out explicitly:** `--skip-trust` must **never** apply to a
directory Conduit didn't just provision — always pair it with the
Conduit-driven worktree add in §2.4 (which only fires for a `worktree_name`
Conduit computed itself), never with a plain/manual Gemini session running in
an arbitrary user directory. This is a one-line but security-relevant
constraint the plan's Phase 2 acceptance criteria must test for directly (a
manual, non-worktree Gemini session's invocation must **not** contain
`--skip-trust`).

**Fallback if the Phase 3 spike (task "3a") fails:** if `--skip-trust` is
rejected or renamed on the installed `gemini` version, try
`GEMINI_CLI_TRUST_WORKSPACE=true` as an env var instead (set alongside the
worktree's other spawn env, not as a CLI flag) — record whichever mechanism
actually worked in a code comment above this function, with the verified
`gemini` version. If `--prompt-interactive` doesn't exist either, degrade to a
plain positional prompt in non-interactive/one-shot mode; note in the same
comment that this Gemini worker loses the "durable, human-visible session"
property (§3(b) of the baseline design) until a working interactive-seed flag
is confirmed — do not silently ship a worker that exits immediately without
flagging that its isolation/visibility contract is weaker than intended.

---

## 3. Rewritten SPEC-F — horizontal mailbox, built in v1 (not deferred)

### 3.1 Tier-1 path: new MCP tools

Add to `fleet_mcp.rs::tool_specs()` (`agent.rs` line ~48-80 today has 5 tools;
this becomes 7):

```json
{
  "name": "fleet_note",
  "description": "Post a short note to peers on a named channel you belong to. Data-only — never control, never a full transcript.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "channel": { "type": "string", "description": "A channel name from this session's `channels` list." },
      "text": { "type": "string", "maxLength": 512, "description": "Note body, max 512 bytes." }
    },
    "required": ["channel", "text"]
  }
}
```

```json
{
  "name": "fleet_inbox",
  "description": "Read notes on a channel you belong to, newest last.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "channel": { "type": "string" },
      "since": { "type": "string", "description": "Optional record id; only notes after this id are returned." }
    },
    "required": ["channel"]
  }
}
```

`dispatch_tool` (`fleet_mcp.rs:90-264`) gains two arms:

```rust
"fleet_note" => {
    let channel = args.get("channel").and_then(|v| v.as_str()).ok_or("missing channel")?;
    let text = args.get("text").and_then(|v| v.as_str()).ok_or("missing text")?;
    if text.len() > 512 { return Err("note-too-long".into()); }
    let snap = ctx.store.fleet_snapshot(&ctx.conductor_id).ok_or("conductor-not-found")?;
    let caller = snap.sessions.iter().find(|s| s.id == ctx.conductor_id).ok_or("caller-not-found")?;
    if !caller.channels.iter().any(|c| c == channel) {
        return Err("not-a-member-of-this-channel".into());
    }
    ctx.board.append(&snap.project_id, BoardRecord::note(&ctx.conductor_id, channel, text));
    Ok("posted".into())
}
"fleet_inbox" => {
    let channel = args.get("channel").and_then(|v| v.as_str()).ok_or("missing channel")?;
    let since = args.get("since").and_then(|v| v.as_str());
    let snap = ctx.store.fleet_snapshot(&ctx.conductor_id).ok_or("conductor-not-found")?;
    let caller = snap.sessions.iter().find(|s| s.id == ctx.conductor_id).ok_or("caller-not-found")?;
    if !caller.channels.iter().any(|c| c == channel) {
        return Err("not-a-member-of-this-channel".into());
    }
    let notes = ctx.board.query_notes(&snap.project_id, channel, since)
        .into_iter()
        .filter(|r| {
            let author = snap.sessions.iter().find(|s| s.id == r.author_session);
            author.is_some_and(|a| crate::store::can_read(caller, a))
        })
        .collect::<Vec<_>>();
    Ok(json!(notes).to_string())
}
```

`Ctx` (`fleet_mcp.rs:31-37`) gains a `board: Arc<BoardState>` field, threaded
through `start`/`handle_request` the same way `fleet`/`pty` already are.

### 3.2 Tier-2 path: extended hook channel, for Codex and Gemini

**New Note record shape** (shared with Tier 1 — one board, two write paths):

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardRecord {
    pub id: String,               // uuid v4, assigned on append
    pub project_id: String,
    pub author_session: String,
    pub kind: BoardKind,           // Mission | Result | Note
    pub payload: Value,            // shape depends on `kind` (see below)
    pub created_at: u64,           // unix millis
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BoardKind { Mission, Result, Note }
```

- `Mission` payload: `{ agent, model_tier, objective, output_shape, boundaries, status }`.
- `Result` payload: `{ status: "success"|"failure"|"partial", summary, artifact_paths: [String], tokens: Option<{input,output}> }`.
- `Note` payload: `{ channel: String, text: String }` (≤512 bytes on `text`,
  enforced at every write path, not just the MCP one — see below).

**New hook verbs** (extend `fleet::apply_event`'s match, `fleet.rs:45-85`,
today's silent catch-all at line 82 becomes two real arms):

```rust
"result" => {
    s.status = "done".into();
    // Also forwarded to the board (see below) — this arm only updates the
    // lightweight FleetStatus mirror fleet_list reads; the board is the
    // source of truth for `fleet_results`/`fleet_inbox`.
}
"note" => { /* status mirror untouched; board append happens in hooks.rs, not here */ }
```

**Where the board append actually happens:** `hooks.rs`'s listener
(`hooks.rs:75-128`) is the single point every Tier-2 event arrives at
(Codex/Gemini's curl POSTs), so board writes for `result`/`note` happen there,
immediately after `fleet.record(&session, &event, &parsed)` (line 109) — see
the exact ownership-gated insertion in §3.3.

**Per-adapter native-event mapping (new `HookRow`s):**

- **Codex** (`CodexAdapter::hooks_profile`, `agent.rs:295-333`): add a second
  row on the existing `Stop` event: `HookRow { event: "Stop", matcher: None,
  verb: "result" }`, alongside the existing `Stop`→`"stop"` row (line 316-320).
  `entries_for` (`hooks.rs:292-306`) already groups multiple rows under one
  native event into an array (proven today by Claude's `PostToolUse` having
  both a `TodoWrite`-matched and a catch-all entry) — **no plumbing change
  needed**, but Codex's actual support for >1 hook firing per event is
  **unverified** (flag from the grounding pass) — verify empirically in Phase
  5's spike task before relying on it; if Codex only fires the first
  registered hook per event, the fallback is to fold `result`-posting into the
  *same* command string as the `stop` row (one `curl` call posting a combined
  body) rather than two separate `HookRow`s.
- **Gemini** (`GeminiAdapter::hooks_profile`, `agent.rs:193-241`): add a second
  row on the existing `AfterAgent` event: `HookRow { event: "AfterAgent",
  matcher: None, verb: "result" }`, alongside the existing `AfterAgent`→`"stop"`
  row (line 219-223). `AfterAgent`'s hook payload includes `prompt_response`
  (the model's full final-turn text) — the mission prompt instructs the
  worker to end its final turn with a JSON blob matching the `Result` payload
  shape, and the `result`-verb command posts that same stdin body (Conduit
  parses `body.prompt_response` as the Result JSON on the receiving end, in
  `hooks.rs`'s new result-handling branch — see §3.3).
- **Note** (`fleet_note`-equivalent for Tier-2 workers): **not** delivered via
  a native hook event (neither Codex's nor Gemini's hook payloads carry an
  agent-authored "send a note" action distinct from a tool call). Ship it as a
  **second export in the OpenCode-style pattern is not applicable here** — for
  Codex/Gemini specifically, a Tier-2 worker cannot *originate* a note through
  the hook channel at all in v1 (hooks only fire on the CLI's own lifecycle
  events, not on arbitrary agent-invoked "post a note" actions). **This is an
  honest capability gap, not an oversight:** Tier-2 workers can produce a
  `Result` (their one structured hand-back) but cannot participate in
  free-form horizontal `Note` exchange the way a Tier-1 MCP worker can. State
  this plainly in `CONDUCTOR_PERSONA` and the capability cards (SPEC-E):
  horizontal mailbox chat is a Tier-1-only capability in v1; Tier-2 workers are
  vertical-only (mission in, one result out).

### 3.3 The real gap: the hook write path is unauthenticated — the fix

**Confirmed from the grounding pass:** `parse_query` (`hooks.rs:203-217`)
accepts any POST whose query string contains `session=`/`event=` keys — it
doesn't even require the path to be `/hook`. `fleet.record()`
(`fleet.rs:157-161`) creates a brand-new status entry for **any** claimed
session id via `entry().or_default()`, no existence check. Today this is a
"forge a status ping" risk (annoying, low blast radius). Once `result`/`note`
verbs feed the mailbox — data another session or the Conductor may act on —
this becomes a real integrity problem: any local process on the same machine
that can guess or read a session id can inject a fabricated `Result` or `Note`
into a project's board.

**Fix — validate session ownership before any board write**, reusing the
*existing* project-lookup primitive rather than inventing a new one:
`Store::fleet_snapshot(id)` (`store.rs:865-876`) already resolves "which
project owns this session id" for **any** session id, not just a Conductor's —
its doc comment undersells this; it works for any session because it just
searches `project.sessions` for a matching id. Thread `Arc<Store>` into
`hooks::start` (currently `hooks.rs:53-59` takes `app, state, bus, broker,
presence, fleet` — no store) and gate the two new verbs:

```rust
// hooks.rs, inside the main loop, after `fleet.record(&session, &event, &parsed)`
// (line 109) and before the bus/webview forwarding:
if event == "result" || event == "note" {
    match store.fleet_snapshot(&session) {
        Some(snap) => {
            board.append(&snap.project_id, BoardRecord::from_hook(&session, &event, &parsed));
        }
        None => {
            // Unknown session id posting a high-stakes verb — drop it, don't mirror,
            // don't forward. Optionally log under CONDUIT_HOOK_LOG=1 for diagnosis.
            if std::env::var("CONDUIT_HOOK_LOG").as_deref() == Ok("1") {
                eprintln!("[hook] rejected {event} from unknown session={session}");
            }
            continue;
        }
    }
}
```

This closes the gap for `result`/`note` specifically (the two verbs that now
feed a cross-session-visible store) without touching the existing low-stakes
verbs (`prompt`/`pretool`/`todos`/`stop`/`notification`/`sessionstart`/
`sessionend`), which stay exactly as forgeable as they are today — an
explicit, documented scope decision (see Audit Finding 2 on why even this
fix is a session-*existence* check, not a session-*secrecy* check, and remains
part of the single-user/loopback threat model SPEC-0 already accepted).

`Note.text` truncation to ≤512 bytes must be enforced **at this same insertion
point** for the hook-channel path (not only in `fleet_note`'s MCP arm, §3.1) —
a Tier-2 worker's `result`-verb body is attacker-shaped-if-forged, so cap it
the same way regardless of write path.

### 3.4 `channels` — how `can_read`/silo gates apply

`channels: Vec<String>` on `Session`/`SessionTrust` (`store.rs:69-72, 118`) is
"reserved, unconsumed" today. This phase activates it:
- A session is a member of a channel iff `channel` appears in its
  `Session.channels`. Membership is set via `set_session_trust` (`store.rs:722-736`,
  full-overwrite semantics — remember to resend the whole trust bundle) or, for
  custom/manual sessions, via the opt-in `shareInProject: bool` UI toggle from
  the baseline (§5 of the base design) which, when turned on, adds that
  session to the project's single implicit default channel (e.g. `"project"`).
- `fleet_note`/`fleet_inbox` (§3.1) both gate on `caller.channels.contains(channel)`
  **before** touching the board — a caller not on the channel can't even query
  it, independent of `can_read`.
- **On top of** the channel-membership gate, every note surfaced by
  `fleet_inbox` is *also* filtered by `can_read(caller, author)` (§3.1's
  `.filter(...)`) — so a siloed author's notes never leak to an over-clearance
  reader even if both happen to nominally share a channel name. This composes
  the two existing trust primitives (`channels`, previously inert; `can_read`,
  already enforced elsewhere) rather than inventing a third.
- Custom/manual sessions default to **no channels** (`Session::default()`
  already yields `channels: vec![]`) — consistent with "custom/manual sessions
  don't share by default" (baseline §2, goal 8).

---

## 4. Rewritten SPEC-G — usage meter, per adapter

Decision 3 (shared-pool % + per-session tokens) was already the baseline's
*recommendation* (§7/§8 of the base design) — it's now locked as the decision.
What's new here is the **per-adapter honesty table**, incorporating what the
research found about local usage logs for the other four CLIs.

| Adapter | Local per-session token source | Parse it? | Row shown |
|---|---|---|---|
| **Claude** | `message.usage` in `<id>.jsonl` (transcript) — real input/output/cache counts, per session | Yes — extend `transcript::parse_line` (§4.1) | Token count (cumulative, rolled up per project) + the one shared subscription-window % (`claude_usage.rs`, unchanged) |
| **Codex** | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, `event_msg.payload.type == "token_count"` entries carrying **cumulative** `input_tokens`/`cached_input_tokens`/`output_tokens`/`reasoning_output_tokens`/`total_tokens`. Only present in rollouts from Codex builds ≥ commit `0269096` (2025-09-06) — older rollouts have no usage data. | Yes — new parser (§4.2), fail-open to "unmetered" on parse failure or missing field | Token count (cumulative, per session) when parseable; **"unmetered"** on an old Codex build or unparseable rollout |
| **Gemini** | `--session-summary <path.json>` (per-invocation flag!) writing `models.<model>.tokens.{prompt,candidates,total,cached,thoughts,tool}` at process exit. Better than Claude's global file — Conduit controls the path per spawn. | Yes — pass a per-session path, new parser (§4.3) | Token count (cumulative, per session) |
| **OpenCode** | `storage/message/{sessionID}/msg_*.json` under `OPENCODE_DATA_DIR` (default `~/.local/share/opencode`), per-message token fields; dollar cost is NOT stored (computed post-hoc elsewhere) — irrelevant, Conduit only wants raw counts | Yes — new parser (§4.4), OR **"$0" row** if the session is routed to a local model (existing `pin_local`/`build_opencode_config` path) — local-model sessions skip token parsing entirely and just render "$0" | Token count (cumulative) for cloud-routed OpenCode sessions; **"$0"** for local-model-routed sessions (unchanged from baseline) |
| **Antigravity** | No local usage/cost log path found in any source, official or third-party. | No. | **"unmetered"** (unchanged from baseline — now with adapter-level confirmation, not just an assumption) |

### 4.1 `TokenTally` — the new data model

```rust
// claude_usage.rs or a new usage_tally.rs (implementer's call — keep it near
// claude_usage.rs since it shares the "fail-open, never fabricate" philosophy)
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenTally {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_input_tokens: i64,
    pub total_tokens: i64,
    /// None when this adapter has no local usage source at all (Antigravity) —
    /// distinct from Some(0), which means "parsed successfully, zero so far".
    pub source: TallySource,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TallySource { Parsed, LocalModelFree, Unmetered }
```

**Keyed map shape** (rolled up in `store.ts`/a new Rust-side aggregator,
`(project_id, agent, account_id, session_id) -> TokenTally`), matching the
baseline's SPEC-G call for a map keyed exactly this way — no change to that
shape, just a concrete `TokenTally` value type per adapter instead of an
implicit "Claude-only" assumption.

### 4.2 Codex parser — exact shape

```rust
/// Sum `token_count` events across a Codex rollout JSONL, returning the LAST
/// (most recent) cumulative snapshot — these are cumulative-to-date per the
/// research, NOT per-turn deltas, so summing them would double count; take
/// the last one, mirroring how `parse_stats_cache` takes `.last()` of Claude's
/// daily arrays (`claude_usage.rs:77-78`).
pub fn parse_codex_rollout(body: &str) -> Option<TokenTally> {
    let mut last: Option<TokenTally> = None;
    for line in body.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.pointer("/payload/type").and_then(|t| t.as_str()) != Some("token_count") {
            continue;
        }
        let p = v.get("payload")?;
        last = Some(TokenTally {
            input_tokens: p.get("input_tokens")?.as_i64().unwrap_or(0),
            output_tokens: p.get("output_tokens")?.as_i64().unwrap_or(0),
            cached_input_tokens: p.get("cached_input_tokens").and_then(|x| x.as_i64()).unwrap_or(0),
            total_tokens: p.get("total_tokens")?.as_i64().unwrap_or(0),
            source: TallySource::Parsed,
        });
    }
    last
}
```

Fail-open: a rollout with zero `token_count` events (old Codex build) returns
`None` → caller renders "unmetered" for that session, never a fabricated zero.

**Test:** `parse_codex_rollout_takes_last_cumulative_snapshot` (a JSONL fixture
with 3 `token_count` lines, assert the LAST values win, not a sum);
`parse_codex_rollout_returns_none_when_no_token_count_events` (old-format
fixture with none).

### 4.3 Gemini parser — exact shape

Spawn each Gemini fleet worker with `--session-summary <data_dir>/gemini-usage-<session_id>.json`
appended to `flags` (analogous to how Claude's `flags` already carries
`--mcp-config`/`--append-system-prompt`). Parser:

```rust
pub fn parse_gemini_session_summary(body: &str) -> Option<TokenTally> {
    let v: Value = serde_json::from_str(body).ok()?;
    let models = v.get("models")?.as_object()?;
    let mut tally = TokenTally { source: TallySource::Parsed, ..Default::default() };
    for (_model, m) in models {
        let t = m.get("tokens")?;
        tally.input_tokens += t.get("prompt").and_then(|x| x.as_i64()).unwrap_or(0);
        tally.output_tokens += t.get("candidates").and_then(|x| x.as_i64()).unwrap_or(0);
        tally.cached_input_tokens += t.get("cached").and_then(|x| x.as_i64()).unwrap_or(0);
        tally.total_tokens += t.get("total").and_then(|x| x.as_i64()).unwrap_or(0);
    }
    Some(tally)
}
```

Read at session-end (`sessionend` hook fires, or the file's mtime changes) —
file is written **at process exit**, so live mid-session tallying isn't
available for Gemini the way Claude's live transcript tailing is; label this
row "as of last completed turn" in the UI, not live.

### 4.4 OpenCode parser — exact shape

```rust
/// Sum per-message token fields across storage/message/{sessionID}/msg_*.json.
/// `OPENCODE_DATA_DIR` may be a comma-separated list (per `opencode debug paths`);
/// try each until one has a matching session dir.
pub fn parse_opencode_session_messages(msg_dir: &Path) -> Option<TokenTally> {
    let mut tally = TokenTally { source: TallySource::Parsed, ..Default::default() };
    let mut found_any = false;
    for entry in std::fs::read_dir(msg_dir).ok()? {
        let Ok(entry) = entry else { continue };
        let Ok(body) = std::fs::read_to_string(entry.path()) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&body) else { continue };
        found_any = true;
        tally.input_tokens += v.pointer("/tokens/input").and_then(|x| x.as_i64()).unwrap_or(0);
        tally.output_tokens += v.pointer("/tokens/output").and_then(|x| x.as_i64()).unwrap_or(0);
        tally.total_tokens += v.pointer("/tokens/total").and_then(|x| x.as_i64()).unwrap_or(0);
    }
    found_any.then_some(tally)
}
```

Skip entirely (render `TallySource::LocalModelFree`, i.e. "$0") when the
session was spawned via `build_opencode_config`/`pin_local` — no need to parse
tokens for a session Conduit already knows costs nothing.

---

## 5. Updated invariant

Add one invariant to the baseline's §10 list (invariant 9):

> 9. A Tier-2 or Tier-3 adapter's absence of a structured result/mailbox
>    channel must be stated to the orchestrator (persona + capability card),
>    never silently implied to work the same as Tier 1. Capability asymmetry
>    is a fact to surface, not a gap to paper over.

---

## 6. Updated spec index (supersedes baseline §9)

| Spec | Title | Effort | Depends on | Status vs. baseline |
|---|---|---|---|---|
| SPEC-0 | Close the cross-project peek/send leak | S | — | Unchanged |
| SPEC-1 | Project-scoped blackboard store | M | SPEC-0 | Unchanged shape; now also backs SPEC-F (was previously only Mission/Result) |
| SPEC-C | Structured result hand-back | M | SPEC-1 | Unchanged for Claude; extended with the hook-channel `result` verb for Tier 2 (§3.2) |
| SPEC-D | Reactive fleet — wake on worker stop/needsInput | M | SPEC-C | Unchanged |
| SPEC-A | Heterogeneous spawn, **all five adapters, tiered** | **L** (was M*) | SPEC-0, SPEC-C | **Rewritten** — see §2 |
| SPEC-B | Account/model routing (revive `model_tier`) | M | SPEC-A | Unchanged |
| SPEC-E | Awareness / mission board + capability cards | M | SPEC-1, SPEC-A | Capability cards must now state each adapter's **tier** explicitly |
| SPEC-F | Horizontal mailbox — **built in v1, not deferred** | **M** | SPEC-E | **Un-deferred, rewritten** — see §3 |
| SPEC-G | Per-agent + cumulative usage meter, **per-adapter honesty** | **L** | SPEC-A, SPEC-B | **Rewritten** — see §4 |
| SPEC-H | Orchestrator routing intelligence + guardrails | M | SPEC-E, SPEC-G, SPEC-B, SPEC-D | Persona must teach the tier asymmetry (invariant 9) and the mailbox's channel model |

SPEC-A moves back to **L** effort now that it covers all five adapters and two
new isolation mechanisms (Conduit-driven worktrees, `CODEX_HOME`-class
plumbing deferred to Phase 6) — the baseline's "M* … drops from L to M" framing
no longer applies once scope is all five.

---

## 7. Research-driven optimization levers (2026-07-05)

> Grounded in `claude_docs/conduit-ai-agent-cli-research.md` (multi-vendor AI
> agent CLI reference, July 2026 — official docs + benchmarks + community
> findings). These levers are **additive** to SPEC-A/B/G/H: they change *how the
> orchestrator routes work and spends tokens*, not the tiered spawn mechanics of
> §1–§4. Each lever names the file it touches and the SPEC it amends, so a fresh
> implementer can slot it into the existing phase without reworking §1–§6. The
> single biggest finding: **the primary token lever is not "which model" — it is
> effort tuning (§7.2) + routing bulk work to a $0 local model (already SPEC-B) +
> not spawning when a native Haiku subagent is cheaper (§7.3).**

### 7.0 Sequencing decision (owner, 2026-07-05)

The research found that Google's standalone **Gemini CLI was retired June 18,
2026**, and **`agy` (Antigravity CLI) is its successor**, a Go rebuild that
`agy plugin import gemini` migrates existing Gemini CLI configs, extensions, and
**hooks (pre/post-tool)** and **MCP connections** into. Two consequences:

1. The `gemini` binary the plan's Gemini adapter targets may be **EOL on the
   dev machine**; and
2. `agy` may not actually be a structurally-silent Tier-3 leaf — if it inherited
   Gemini CLI's hook + MCP surface, it could reach Tier 2 or even Tier 1.

**Owner decision:** keep the **full tiered spec for both** Gemini and Antigravity
(no re-tiering on paper), but **build the Antigravity (`agy`) adapter before the
Gemini adapter** — Gemini moves to the *last* adapter phase. This front-loads the
live Google tool and defers the possibly-dead binary until a live-binary spike
(§7.1) confirms it still runs. The plan doc's phasing table is updated to this
order; §1.3 (Antigravity = Tier 3) still stands as the *shipped default* pending
the spike below.

### 7.1 Antigravity/Gemini reconciliation spike (amends §1.3, §2.6 / SPEC-A)

Because §1.3 could **not** corroborate `agy`'s hook/MCP surface against official
docs, do not flip tiers on the research's word alone. Instead, **when the
Antigravity adapter is built (now sequenced before Gemini), run a mandatory
spike:**

- Install `agy`; run `agy plugin import gemini`; inspect
  `~/.gemini/antigravity-cli/` (and `agy`'s own config dir) for a real
  `hooks.json` / MCP config surface — the exact artifact the third-party claim
  in §1.3 names.
- Confirm whether standalone **`gemini` still launches at all** on the dev box
  (owner's Windows machine) — this gates the Gemini phase.
- Record `agy` version + outcome in a code comment above
  `AntigravityAdapter::build_invocation` (`agent.rs:420-428`).

**Branch on the outcome:**
- **Hooks confirmed** → promote `agy` to **Tier 2** *in the same phase*: reuse the
  Codex `result`-verb `HookRow` pattern (§3.2) verbatim; Antigravity stops being
  "unmonitored." Update its capability card (SPEC-E) `tier` to 2.
- **MCP confirmed** → file a **Tier-1 fast-follow** (join it to Phase 9's
  Codex/Gemini MCP-upgrade spike).
- **Neither confirmed** → ship Antigravity exactly as §1.3 specifies (Tier 3,
  silent) — no wasted work; the persona already tells the Conductor not to
  expect a result.

**Gemini stays in the plan, built last, full spec** — but its `--skip-trust` /
`--prompt-interactive` work (§2.6, plan Phase 3 tasks 3a/4/5/9/10) is **gated on
the live-binary check above**. If `gemini` is EOL on the dev machine, that
adapter's spike **fails closed** and the phase is documented as *blocked* (not
shipped broken), with `agy` already covering the Google-model slot.

### 7.2 Effort as the primary token lever (amends SPEC-B, SPEC-H)

Anthropic's own guidance (research §2.4): *"Tuning effort is often a better lever
than switching models."* Effort multiplies thinking tokens roughly **1.5× (low) →
5–8× (max)**, so escalating effort on a *cheaper* model often beats jumping to a
pricier one.

- **SPEC-B change:** `fleet_spawn` gains `effort: Option<String>`
  (`low|medium|high|xhigh|max`) alongside `model_tier`, written onto the Session
  at creation and mapped per adapter in `agent.rs`:
  - **Claude:** map to the CLI effort control. **`xhigh` is Opus-4.8-only** — on
    any non-Opus tier the persona must **not** request `xhigh` (the model
    silently falls back to `high`, wasting the intent). `max` for the hardest
    algorithmic work only.
  - **Codex/Gemini/OpenCode/Antigravity:** no equivalent per-invocation effort
    knob today → the field is accepted but ignored, documented in the mapping
    function so it isn't mistaken for a bug.
- **SPEC-H change (persona effort ladder, coding-calibrated):**
  classification/boilerplate/extraction → `low`; standard feature or bug fix →
  `medium`; multi-file refactor or deep debug → `high` (default); codebase-wide
  audit / migration / security review → `xhigh` (Opus). The cheap-first cascade
  (baseline §6.3) escalates **effort first, then model** — it is the cheaper of
  the two moves.

### 7.3 Native-subagent cost routing (amends baseline §3, SPEC-H)

The load-bearing §3 rule ("prefer native Task subagents over `fleet_spawn` for
homogeneous Claude parallelism") only pays off if those native subagents are
*cheap*. Research §2.2/§2.13: `CLAUDE_CODE_SUBAGENT_MODEL=claude-haiku-4-5-20251001`
routes a Claude session's native subagents to Haiku — a documented **40–70%
saving on multi-agent workflows**.

- **Change:** set `CLAUDE_CODE_SUBAGENT_MODEL=claude-haiku-4-5-20251001` in the
  **Conductor's** spawn environment (the Conductor PTY spawn, and keep the
  existing `env_remove("npm_config_prefix")` scrub next to it — both spawn sites
  per the CLAUDE.md gotcha). Do **not** set it globally for every session; a
  worker that *is* a specialist may need a stronger subagent model.
- **Persona reminder (SPEC-H):** fan-out reads / exploration / summarization →
  the Conductor's own native Haiku subagents (near-free, shared cache); reserve
  `fleet_spawn` for a *different* agent/model, a $0 local model, a durable
  human-visible session, or long-lived worktree work (baseline invariant 6).

### 7.4 Cross-agent context file: AGENTS.md (amends SPEC-A worktree provisioning §2.4)

`AGENTS.md` is the emerging cross-tool context standard (research §6.3/§8.1):
**Codex, `agy`, and OpenCode all read it; only Claude uses `CLAUDE.md`.** A
Tier-2/3 worker with no MCP channel still reads `AGENTS.md` — so it is the
standard way to hand a non-Claude worker structured direction.

- **Change to §2.4's worktree provisioning step** (the block that calls
  `hooks::install_profile`): when the worker is fleet-spawned with a `Mission`
  (SPEC-C), write the mission `objective` + `boundaries` + `output_shape` into
  `<worktree>/AGENTS.md` as a `## Fleet mission` block (append if a root
  `AGENTS.md` was inherited via the worktree; create otherwise). For a **Claude**
  worker, write the same block into `CLAUDE.md` instead (Claude ignores
  `AGENTS.md`). This gives Tier-2/3 workers a real brief channel without MCP, and
  keeps one source of truth (AGENTS.md = universal rules; CLAUDE.md extends).
- **Non-fleet sessions untouched:** only sessions with a `Mission` record get the
  injected block — a manual session's `AGENTS.md`/`CLAUDE.md` is never rewritten.

### 7.5 Concrete `model_tier` → model mappings (amends SPEC-B)

SPEC-B says "map `model_tier` → concrete model per adapter" but leaves the table
abstract. Fill it from the July-2026 benchmark reference (research §1, §7.2),
pinning **full model IDs** (aliases drift — research §2.13):

| `model_tier` | Claude | OpenCode | Codex | Antigravity / Gemini |
|---|---|---|---|---|
| **cheap / bulk** | `claude-haiku-4-5-20251001` | local model (**$0**) or Zen free (DeepSeek V4 Flash Free / GLM 4.7) | `gpt-5-mini` ($0.25/$2) | `gemini-3-flash` ($0.50/$3) |
| **standard** | `claude-sonnet-5` | `anthropic/claude-sonnet-5` or `gemini-3-flash` | `codex-mini-latest` ($1.50/$6) | `gemini-3.5-flash` |
| **hard** | `claude-opus-4-8` (+ `xhigh`) | `anthropic/claude-opus-4-8` | `gpt-5.5` | `gemini-3.1-pro` |

**Findings to encode in the routing heuristic (SPEC-H), not just the table:**
- **Gemini 3 Flash beats Gemini 3 Pro on SWE-bench Verified (78% vs 76.2%)** —
  the *cheaper* model is the better agentic-coding choice. Map bulk/standard
  coding to Flash, never default to Pro for cost "safety."
- **Terminal / shell / DevOps / git-heavy tasks → Codex GPT-5.5** (#1
  Terminal-Bench 2.1, 83.4%).
- **GitHub-issue-shaped code fixes / complex multi-file reasoning → Claude Opus
  4.8** (#1 SWE-bench Verified 88.6% / Pro 69.2%).
- **Untrusted code / contributor PRs → Codex** (kernel-level sandbox; research
  §6.2) — a routing signal, even though sandboxing isn't a Conduit feature yet.

### 7.6 Caching + Batch discipline (amends baseline §7 usage / SPEC-G, SPEC-H)

- **Prompt caching (90% off cache reads; research §2.11):** keep the Conductor's
  stable prefix — `CONDUCTOR_PERSONA` + the project `CLAUDE.md`/`AGENTS.md` —
  **byte-identical across spawns** so it caches. Do **not** interpolate volatile
  data (timestamps, session ids, live roster) into the cached prefix; put that in
  the per-turn tail. This compounds with §7.3 (native subagents share the
  Conductor's cache).
- **Batch API (50% off; research §2.11):** for non-interactive, latency-tolerant
  fleet work (overnight audits, bulk mechanical passes) prefer batch where the
  adapter supports it — a persona routing *hint*, not a hard gate.
- **SPEC-G surfacing:** the transcript already carries `message.usage.cache_*`
  (parsed in §4.1). Break out **cache-read vs fresh** input tokens in the usage
  meter so the human can *see* caching working — this is the honest signal that
  §7.6's discipline is paying off, at no extra parse cost.

### 7.7 OpenCode LSP feedback loop (bonus — amends SPEC-A OpenCode card / SPEC-E)

Research §5.7: OpenCode is the only major CLI that feeds **LSP diagnostics**
(compiler/type errors) back to the model after each edit — reducing correction
round-trips. This is high-value on **Conduit's own TS + Rust stack**. No new
Conduit code beyond ensuring the worker's worktree carries the project's LSP
config (it does, via the inherited worktree). **Action:** add "type-heavy /
mechanical edits on a typed codebase (TS, Rust)" to the OpenCode **capability
card**'s `when_to_use` (SPEC-E / Phase 7) so the Conductor routes such work to
OpenCode. Tracked, non-blocking.

### 7.8 Where each lever lands in the plan (index)

| Lever | Amends | Plan phase |
|---|---|---|
| §7.0/§7.1 agy-before-Gemini + reconciliation spike | §1.3, SPEC-A | Phase 4 (Antigravity, pulled before Gemini) + Gemini-last phase |
| §7.2 effort field + ladder | SPEC-B, SPEC-H | Phase 6 (field), Phase 10 (persona ladder) |
| §7.3 `CLAUDE_CODE_SUBAGENT_MODEL` | §3, SPEC-H | Phase 2 (spawn env) + Phase 10 (persona) |
| §7.4 AGENTS.md/CLAUDE.md mission block | SPEC-A §2.4 | Phase 2 (worktree provisioning) |
| §7.5 concrete tier mappings | SPEC-B | Phase 6 |
| §7.6 caching + batch + cache-token surfacing | §7, SPEC-G, SPEC-H | Phase 8 (surfacing) + Phase 10 (persona) |
| §7.7 OpenCode LSP card trigger | SPEC-E | Phase 7 |
