# Multi-Agent CLI Support — UX Design

- **Date:** 2026-06-29
- **Status:** Draft v2 (revised after adversarial review)
- **Scope:** UX for running OpenAI Codex CLI, Google Gemini CLI, and OpenCode side-by-side with Claude Code inside Conduit.
- **Companion work:** a feasibility/architecture study (same session) established that Conduit's terminal engine is already agent-agnostic and the work reduces to a per-agent **provider adapter** plus the UX in this doc. See §9 for the adapter recap and the v1/phase mapping.

---

## 1. Goal & context

Conduit today runs many real `claude` CLI sessions side-by-side in keep-alive PTYs. We want to also run other terminal coding agents. The feasibility study found:

- The PTY engine (`src-tauri/src/pty.rs`), the persisted `Session`/`Project` model, and the keep-alive `TerminalView` are **agent-agnostic** — they spawn `$SHELL -i -l -c <script>` and never exec a binary literally named `claude`.
- Coupling is concentrated in the **command string** plus four satellite features (resume detection, hooks→status pipeline, ambient status/usage widgets, the titler).
- The v1 agent set is **Claude Code (baseline) + Codex CLI + Gemini CLI + OpenCode** — all four are true interactive TUIs, all have a headless one-shot for titling, and all four ship Claude-shaped hooks, so per-session status can light up for each (best-effort; see §5).

This document specifies only the **UX**: where the agent is chosen, how a session shows which agent it runs, and the onboarding/settings flow that detects installed binaries and wires MCP servers.

## 2. Locked decisions

Validated interactively (terminal Q&A + browser mockups):

| Decision | Choice | Why |
| --- | --- | --- |
| **Selection scope** | One **global default** agent, overridable **per session** | Simple mental model; keeps Conduit's per-session flexibility. |
| **Onboarding** | **First-run wizard + persistent Settings panel** | Best discoverability for a feature that needs binary detection; changeable later. |
| **MCP management** | **Shared registry, per-agent enable toggles**, written into each agent's native config | Define a server once, fan it out; least duplication. |
| **Agent picker layout** | **Tile grid** in the New Session dialog | Most legible; tiles also carry the "default" tag and detection state, sharing one visual language with onboarding. |
| **Sidebar identity** | **Leading agent glyph** (replaces the generic terminal icon) | Per-row identity at zero extra width; shape+letter+color keeps it accessible. |

## 3. Surfaces

### 3.0 Detection states (shared vocabulary)

Both the picker and onboarding render the result of a single Rust `detect_agents` scan. An agent is in exactly one state:

| State | Meaning | Pill | Eligible as default / spawnable |
| --- | --- | --- | --- |
| **ready** | binary on PATH and version ≥ adapter minimum | `✓ ready` | yes |
| **not ready** | on PATH but version below minimum, or a quick health/auth probe failed | `▲ needs setup` | no — shows a "Sign in / update" hint |
| **not found** | binary not on the login-shell PATH | `✗ not found` | no — shows `Install ▸` |
| **scan error** | `detect_agents` itself failed (shell init error/timeout) | `⚠ scan failed` | no — shows `Retry` |

**Auth note:** unlike Claude (already logged in), Codex and Gemini may require a one-time login. "ready" means *runnable*, not *authenticated*; the agent's own login prompt appears in the PTY on first use. The probe is best-effort and never blocks detection.

### 3.1 Agent picker — New Session dialog
**File:** `src/components/NewSessionDialog.tsx`

- A **2×2 tile grid** sits above the existing Name field. Each tile: agent glyph + name, optional **"default"** tag, and the **detection-state pill** (§3.0).
- **Pre-selection / effective default:** the picker pre-selects the stored global default **if it's `ready`**. If the stored default is `not found`/`not ready`, it pre-selects the first `ready` agent and shows a one-line notice ("Default *Gemini* isn't ready — using *Claude*"). The stored default value is **not silently rewritten**, so it returns if the agent is reinstalled.
- **Non-ready tiles** are disabled (cannot be picked). A disabled tile's `Install ▸`/`Sign in` link **opens docs in the external browser and leaves the dialog intact** (Name + worktree state preserved); a **Re-scan** control re-runs detection so a now-ready tile enables in place — no dialog teardown, no lost input.
- **Zero-agent state:** if no agent is `ready`, the dialog shows a blocked empty state ("No agents ready — Set up agents") routing to onboarding, instead of an all-disabled grid with a pre-selected disabled tile. Create is disabled.
- On create, the chosen agent id is added to the existing `onCreate({ name, useWorktree })` payload and persisted on the Session (see §4 for the spawn data path).
- **States:** default tag · selected (accent ring) · disabled (non-ready) · hover · keyboard focus ring.
- **Keyboard/a11y:** the grid is a `radiogroup`; arrow keys move selection (skipping disabled tiles), Enter creates, Esc cancels (existing handlers). Each tile's accessible label includes its detection state.

### 3.2 Per-session agent identity — SessionRow
**File:** `src/components/Sidebar.tsx` (`SessionRow`)

- A **14px agent glyph** (rounded square: letter monogram + per-agent tint) **replaces** the generic `TerminalIcon` at the row's leading edge.
- The right-side **status accessory is unchanged** (`running` dot · `needs you` · `compacting` · activity pill · `done`).
- **Accessibility:** identity is conveyed by **shape + letter + color** (not color alone); the glyph carries a `title`/`aria-label` of the agent name.

### 3.3 First-run onboarding wizard
**New component**, e.g. `src/components/onboarding/AgentSetup.tsx` (mounted from `App.tsx`).

- **Trigger:** first launch when the persisted `agentSetupComplete` flag (in `store.ts` / `state.json`) is false. Also reachable any time from Settings.
- **Dismissal:** the wizard is dismissable (Esc / X / Skip setup). Dismissing **without finishing leaves `agentSetupComplete` false** but suppresses auto-relaunch for the rest of the app session (so it doesn't nag), and it stays reopenable from Settings. Only reaching **Done** sets the flag true.
- **Four steps** with a progress stepper: **Welcome → Agents → MCP servers → Done.**
- **Agents step (the core):**
  - `detect_agents` scans the **login-shell PATH** and returns, per adapter, name · binary · version · resolved path · detection state (§3.0).
  - Each row: radio (selects the global default) · glyph · name · meta (`binary · vX · /path`) · state pill · action (`Install ▸` / `Sign in` / `Retry`).
  - Only `ready` agents are selectable as default. **Next is not gated on choosing a default** — "No default (choose per session)" is an explicit selectable option, not a silent empty state.
  - A **Re-scan PATH** control re-runs detection; a `scan error` shows a distinct retry affordance with a short cause hint (not conflated with "not found").
  - **Zero-agent banner:** if nothing is `ready`, a persistent banner ("No agents detected — install one to start") with install links + Re-scan; the user can still finish the wizard but will hit the picker's zero-agent state until they install one.
- **MCP step is optional** (Skip → Done).
- **PATH rule (architectural):** Conduit only runs binaries already on the user's **login-shell PATH** — it mirrors the existing login-shell spawn + `npm_config_prefix` scrub and does **not** bundle or install agents in v1.
- **Done:** summarizes and offers **"Create your first session"**, which opens `NewSessionDialog` with the chosen default pre-selected and Name focused (single creation path).

### 3.4 Settings panel + MCP matrix
**New component**; entry point: a **⚙ gear** added to the Sidebar **add-bar** (beside `ThemeSwitcher`, `src/components/Sidebar.tsx`).

- **Tabs:** Agents · MCP servers. (No "General" tab in v1 — see §7.)
- **Agents tab:** reuses the wizard's detection list (change default, re-scan, install/sign-in links) — same component as wizard step 2.
- **MCP servers tab (= wizard step 3):** a **matrix** — rows are the **shared server registry**, columns are `ready` agents, cells are **toggles**. A non-ready agent's column is **disabled** (consistent with detection).
  - **Registry is keyed by unique server name.** **Add server** with an existing name is blocked with an inline error.
  - **Add-server form** (name · transport `stdio`|`http` · command *or* URL · env): transport-conditional required fields (command for stdio, URL for http), `key=value` env validation, duplicate/empty-name errors placed near their field, **Save disabled until valid**.
  - **Import from agent…** seeds the registry from an agent's existing config (**merge**, resolving Open Q3). On a name collision with a *differing* definition it shows a per-server reconcile choice: keep existing / overwrite / import-as-renamed.
  - **Edit / remove propagation:** editing a server **re-writes it to every agent where it's currently enabled**; removing it **un-writes its Conduit-owned entry from every enabled agent's config**, behind a confirm dialog that lists the affected agents. User-authored entries are never touched.
- **Per-cell write feedback:** a toggle triggers a native-config write. The cell shows a **pending spinner** while writing, settles to on/off on success, and **reverts + shows an inline error (with retry)** on failure. Writes are **atomic** (never leave a config partially corrupt). Partial failures across a multi-cell flip are surfaced per cell, not as one global toast.
- **Write targets (ASSUMPTIONS — verify before implementing):** the per-agent native MCP config locations are **not yet confirmed against current docs** and must be validated by a spike (see §8): Claude project MCP `.mcp.json` (**separate** from the `settings.local.json` Conduit already manages for hooks), Codex `~/.codex/config.toml`, Gemini `~/.gemini/settings.json`, OpenCode `opencode.json`. Confirm path, project-vs-home scope, and the MCP-server key shape for Codex/Gemini/OpenCode first.
- **Secrets:** configs are read on explicit user action; **env secret values are never logged**.
- **Matrix a11y/keyboard:** implemented as an ARIA `grid` with **roving tabindex** (arrow keys move between cells, Space toggles), each cell associated with its server-row and agent-column header for screen readers.

## 4. Data model & component changes (grounded in current files)

- **`src/store.ts`:** `Session` gains `agent: AgentId`. The Claude ambient slice **stays Claude-only in v1** and is gated by the selected session's agent (see §5) — it does **not** generalize to per-agent state in v1. Add persisted `agentSetupComplete: boolean` and `defaultAgent: AgentId | null`, both in `state.json`.
- **`src-tauri/src/store.rs`:** `Session` gains `agent`. A bare `#[serde(default)]` on a `String` yields `""`, **not** `"claude"` — so use `#[serde(default = "default_agent")]` (returning `"claude"`) **or** model `agent` as an `AgentId` enum with `#[derive(Default)] #[default] Claude`. (The struct already uses `#[serde(default)]` on `use_worktree`/`worktree_path`/`branch`, so the back-compat pattern exists; just don't rely on the empty-string default.)
- **`src-tauri/src/pty.rs`:** `claude_invocation`/`claude_script` become a per-adapter `build_invocation` (selected by `agent`). Keep the `npm_config_prefix` scrub and `|| <bare>` fallback for all adapters.
- **Spawn data path (correction):** `add_session` (`lib.rs`) only **persists** the Session; `pty_spawn` is a **separate** Tauri command invoked later when `TerminalView` mounts, and today receives only `session_id`/`working_directory`/`cols`/`rows`/`worktree_name`. So the chosen agent must be (a) persisted on the Session by `add_session`, then (b) read **at spawn**. Implement (b) by having `pty_spawn` **look up the persisted Session by `session_id` in the Store** (it already receives `session_id`), keeping adapter selection server-side and the `TerminalView` call signature unchanged.
- **`src/App.tsx` hook pipeline:** the single `hook` event listener is a sound per-agent gating point, but it keys on **Claude-specific event names** (`prompt`/`todos`/`tooluse`/`pretool`/`precompact`/`sessionstart`/`sessionend`/`stop`/`notification`) and `toolActivity()` maps **Claude tool names**. Generalization therefore needs **two per-adapter maps** — an event-name normalization map and a tool-label map feeding `toolActivity` — not just a single swap. The dispatch shape is reusable; the string vocabulary is Claude-specific.
- **`src/components/Sidebar.tsx`:** gate the unconditionally-mounted `ClaudeStatusWarning` / `ClaudeUsagePanel` / `ClaudeStatusPill` so they appear only when relevant; add the ⚙ gear.
- **New components:** onboarding wizard, Settings modal, `AgentTile`, `AgentGlyph`, `McpMatrix`, `AgentDetectionList`.

## 5. States, edge cases & invariants

- **Keep-alive PTY invariant (load-bearing):** the `agent` is selected **at spawn only**. The new field must **never** cause `TerminalView`/`xterm` to remount — that kills the PTY. The picker is pre-spawn; the sidebar glyph is render-only.
- **Agent disappears after a session exists:** the row shows an "agent not found" glyph state. Since the agent is fixed at spawn, recovery is explicit: once the agent is re-detected the session can resume if its PTY is alive; otherwise offer an inline **"recreate this session with *agent*"** action (delete + recreate) so the user isn't left guessing.
- **Changing the global default:** affects only **future** sessions; existing sessions keep their agent.
- **Per-session hook status:** v1 targets per-session status for **all four agents** via their hook systems (best-effort). Where an agent's hook wiring isn't complete, status degrades to coarse idle/running from PTY signals rather than disappearing. (§1 and §4 use the same commitment.)
- **Ambient widgets for non-Claude agents:** service-status and plan-usage are **Claude-only in v1 and hidden** for other agents (they fail open today). No empty Claude widgets are shown for a Codex/Gemini/OpenCode session.
- **MCP write failures / missing config dir:** inline per-cell error; writes are atomic.
- **Accessibility (desktop):** visible focus rings; `radiogroup` for the picker and an ARIA `grid` with roving tabindex for the matrix (§3.4); color-not-only (glyph letter+shape); full keyboard nav; disabled semantics on non-ready agents; multi-step progress with Back; errors placed near their field.
- **Empty/loading:** PATH-scan spinner during detection; distinct `scan error` state; empty MCP registry → "Add your first MCP server".
- **Tier-1** (used below and in §9) = **the four v1 agents** that ship Claude-shaped hooks. This is a convenience label for the v1 roster; per §9 tiers are ultimately capability-derived, not a hardcoded list.

## 6. Visual system

- **Tokens (reuse `src/theme.css`):** `--accent: #ce8a6e`, `--sidebar-bg: #1b1917`, `--panel-bg: #151110`, `--text-bright: #ece8e4`, lines `#2a2724`.
- **Agent glyph:** rounded square; 14px in the sidebar, 20–22px in tiles/wizard; letter monogram with a per-agent tint. **Monograms are placeholders for real brand marks** (replace with official logos following each brand's guidelines; do not recolor official marks).
- **Motion:** 150–300ms transitions; wizard steps slide; honor `prefers-reduced-motion`.

## 7. Out of scope (v1) / future

- **"General" Settings tab** — cut from v1 until it has real contents (YAGNI). Reintroduce when there's something to put in it.
- **Tier-2 terminal-only agents** (Aider, Crush, Amp): spawn + title only, no ambient — later.
- **Per-agent usage/service-status widgets** (only Claude in v1; a Codex analog is feasible later).
- **Per-project default agent**, fan-out (race N agents on one task), container backends.
- **Layer-2 user-editable JSON provider profiles** (add agents without recompiling).

## 8. Open questions

1. Ship with monogram glyphs or real agent logos in v1?
2. **Spike (blocking the MCP write path):** confirm each agent's current MCP config location + schema — file path, project-vs-home scope, and the server-entry key shape — for **Codex, Gemini, and OpenCode** (and Claude's `.mcp.json` vs the `settings.local.json` we manage for hooks). The four filenames in §3.4 are assumptions until this lands.
3. Health/auth probe depth for the "not ready" state — just a `--version`/min-version check, or a lightweight auth check too? (Deeper = more accurate, more latency and per-agent code.)

*(Resolved during review: global default persists in `state.json`; MCP "Import from agent" merges; "General" tab cut.)*

## 9. Appendix — provider adapter & v1 scope (from the feasibility study)

The UX above sits on a Rust `ProviderAdapter` seam that replaces the hardcoded `claude` command in `pty.rs`: per adapter it supplies the spawn/resume invocation, env overrides, headless title command, workdir/worktree strategy, and optional capabilities (hooks, service-status, usage). **Support tiers are capability-derived, not a hardcoded list**; "Tier-1" (§5) is just shorthand for the four v1 agents that happen to ship hooks.

**Phased rollout and what "v1" means:** **v1 = Phases 0–3**, and the surfaces in this doc land across them: **Phase 0** adapter seam (Claude-only, pure refactor) → **Phase 1** first sibling + the picker (§3.1) + sidebar identity (§3.2) + ambient-widget gating → **Phase 2** first hooks agent (per-session status) → **Phase 3** onboarding (§3.3) + the Settings/MCP surfaces (§3.4) per-provider. Where the body says "in v1," it means somewhere within Phases 0–3, not all at Phase 0.
