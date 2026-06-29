# Multi-Agent CLI Support — UX Design

- **Date:** 2026-06-29
- **Status:** Draft for review
- **Scope:** UX for running OpenAI Codex CLI, Google Gemini CLI, and OpenCode side-by-side with Claude Code inside Conduit.
- **Companion work:** a feasibility/architecture study (same session) established that Conduit's terminal engine is already agent-agnostic and the work reduces to a per-agent **provider adapter** plus the UX in this doc. See §9 for the adapter recap.

---

## 1. Goal & context

Conduit today runs many real `claude` CLI sessions side-by-side in keep-alive PTYs. We want to also run other terminal coding agents. The feasibility study found:

- The PTY engine (`src-tauri/src/pty.rs`), the persisted `Session`/`Project` model, and the keep-alive `TerminalView` are **agent-agnostic** — they spawn `$SHELL -i -l -c <script>` and never exec a binary literally named `claude`.
- Coupling is concentrated in the **command string** plus four satellite features (resume detection, hooks→status pipeline, ambient status/usage widgets, the titler).
- The strategic v1 agent set is **Claude Code (baseline) + Codex CLI + Gemini CLI + OpenCode** — all four are true interactive TUIs, all have a headless one-shot for titling, and all four ship Claude-shaped hooks, so the per-session live-status panel can light up for each.

This document specifies only the **UX**: where the agent is chosen, how a session shows which agent it runs, and the onboarding/settings flow that detects installed binaries and wires MCP servers.

## 2. Locked decisions

Validated interactively (terminal Q&A + browser mockups):

| Decision | Choice | Why |
| --- | --- | --- |
| **Selection scope** | One **global default** agent, overridable **per session** | Simple mental model; keeps Conduit's per-session flexibility. |
| **Onboarding** | **First-run wizard + persistent Settings panel** | Best discoverability for a feature that needs binary detection; changeable later. |
| **MCP management** | **Shared registry, per-agent enable toggles**, written into each agent's native config | Define a server once, fan it out; least duplication. |
| **Agent picker layout** | **Tile grid** in the New Session dialog | Most legible; tiles also carry the "default" tag and install-status dot, sharing one visual language with onboarding. |
| **Sidebar identity** | **Leading agent glyph** (replaces the generic terminal icon) | Per-row identity at zero extra width; shape+letter+color keeps it accessible. |

## 3. Surfaces

### 3.1 Agent picker — New Session dialog
**File:** `src/components/NewSessionDialog.tsx`

- A **2×2 tile grid** sits above the existing Name field. Each tile: agent glyph + name, an optional **"default"** tag, and an **install-status dot**.
- The **global default** is pre-selected. Uninstalled agents render **disabled** ("not installed") and cannot be picked; a link routes to onboarding/install.
- On create, the chosen agent id is added to the existing `onCreate({ name, useWorktree })` payload → `addSession` → Rust `add_session` → `pty_spawn`, where the adapter is selected. **The agent is fixed at spawn.**
- **States:** default tag · selected (accent ring) · disabled (uninstalled) · hover · keyboard focus ring.
- **Keyboard/a11y:** the grid is a `radiogroup`; arrow keys move selection, Enter creates, Esc cancels (existing handlers). Each tile has an accessible label including install status.

### 3.2 Per-session agent identity — SessionRow
**File:** `src/components/Sidebar.tsx` (`SessionRow`)

- A **14px agent glyph** (rounded square: letter monogram + per-agent tint) **replaces** the generic `TerminalIcon` at the row's leading edge.
- The right-side **status accessory is unchanged** (`running` dot · `needs you` · `compacting` · activity pill · `done`).
- **Accessibility:** identity is conveyed by **shape + letter + color** (not color alone); the glyph carries a `title`/`aria-label` of the agent name.

### 3.3 First-run onboarding wizard
**New component**, e.g. `src/components/onboarding/AgentSetup.tsx` (mounted from `App.tsx`).

- **Trigger:** first launch when no agent setup has been completed (a persisted flag in `store.ts` / `state.json`). Also reachable any time from Settings.
- **Four steps** with a progress stepper: **Welcome → Agents → MCP servers → Done.**
- **Agents step (the core):**
  - A Rust command (e.g. `detect_agents`) scans the **login-shell PATH** for each adapter's binary and returns name · binary · version · resolved path · found?.
  - Each row: radio (selects the **global default**) · glyph · name · meta (`binary · vX · /path`) · status pill (**✓ on PATH** / **✗ not found**) · action.
  - **Uninstalled** agents are greyed, show **Install ▸** (opens the agent's install docs), and are **ineligible as default** until detected.
  - A **Re-scan PATH** control handles "I just installed it."
- **PATH rule (architectural):** Conduit only runs binaries already on the user's **login-shell PATH** — it mirrors the existing login-shell spawn + `npm_config_prefix` scrub and does **not** bundle or install agents in v1.
- **Skip** is allowed (falls back to Claude if present). **Done** summarizes and offers "Create your first session."

### 3.4 Settings panel + MCP matrix
**New component**; entry point: a **⚙ gear** added to the Sidebar **add-bar** (beside `ThemeSwitcher`, `src/components/Sidebar.tsx`).

- **Tabs:** Agents · MCP servers · General.
- **Agents tab:** reuses the wizard's detection list (change default, re-scan, install links) — same component as wizard step 2.
- **MCP servers tab (= wizard step 3):** a **matrix** — rows are the **shared server registry**, columns are **installed agents**, cells are **toggles**. A not-installed agent's column is **disabled** (consistent with detection).
  - **Add server:** name · command/URL · transport (`stdio` | `http`) · env.
  - **Import from agent…** seeds the registry from an agent's existing config so users don't retype servers they already have.
  - Edit / remove a server.
- **Write behavior:** toggling a cell writes the server into that agent's **native** MCP config — Claude `.mcp.json`, Codex `config.toml`, Gemini `settings.json`, OpenCode `opencode.json`. Conduit manages **only the entries it owns** (marked/namespaced), never clobbering user-authored entries, and writes atomically. Configs are read on explicit user action; **secret env values are never logged**.
- **General tab:** minimal in v1 (candidate for YAGNI removal until it has real contents).

## 4. Data model & component changes (grounded in current files)

- **`src/store.ts`:** `Session` gains `agent: AgentId` (default `"claude"` for `state.json` back-compat). The existing Claude ambient slice either generalizes to per-agent state or stays Claude-only in v1 and is gated by the selected session's agent (see §5).
- **`src-tauri/src/store.rs`:** `Session` gains the `agent` field; back-compat default on deserialize.
- **`src-tauri/src/pty.rs`:** `claude_invocation`/`claude_script` become a per-adapter `build_invocation` (selected by `agent`). Keep the `npm_config_prefix` scrub and `|| <bare>` fallback for all adapters.
- **`src-tauri/src/lib.rs`:** `pty_spawn` branches on the adapter (titler command, hooks install); `claude_title` becomes per-adapter with the existing `heuristic_name()` fallback.
- **`src/App.tsx`:** the single `hook` event listener is already a generic pipeline (`setStatus`/`setActivity`/`applyTodos`); per-adapter event-name and tool-label maps feed it. v1 covers Claude + the three agents with Claude-shaped hooks.
- **`src/components/Sidebar.tsx`:** gate the unconditionally-mounted `ClaudeStatusWarning` / `ClaudeUsagePanel` / `ClaudeStatusPill` so they appear only when relevant; add the ⚙ gear.
- **New components:** onboarding wizard, Settings modal, `AgentTile`, `AgentGlyph`, `McpMatrix`, `AgentDetectionList`.

## 5. States, edge cases & invariants

- **Keep-alive PTY invariant (load-bearing):** the `agent` is selected **at spawn only**. The new field must **never** cause `TerminalView`/`xterm` to remount — that kills the PTY. The picker is pre-spawn; the sidebar glyph is render-only.
- **Uninstalled agent:** cannot start a session (tile disabled). A session whose agent later disappears shows an "agent not found" glyph state with re-scan/install; the terminal still surfaces the shell's own error.
- **Changing the global default:** affects only **future** sessions; existing sessions keep their agent.
- **Ambient widgets for non-Claude agents:** in v1, service-status and plan-usage are **Claude-only and hidden** for other agents (they fail open today); per-session hook status may light up for the Tier-1 agents. No empty Claude widgets shown for a Codex/Gemini/OpenCode session.
- **MCP write failures / missing config dir:** inline error; writes are atomic so a config is never left partially corrupt.
- **Accessibility (desktop):** visible focus rings on tiles/toggles; `radiogroup` semantics; color-not-only (glyph letter+shape); full keyboard nav; disabled semantics on uninstalled agents; multi-step progress indicator with Back; errors placed near their field.
- **Empty/loading:** PATH-scan spinner during detection; empty MCP registry → "Add your first MCP server" empty state.

## 6. Visual system

- **Tokens (reuse `src/theme.css`):** `--accent: #ce8a6e`, `--sidebar-bg: #1b1917`, `--panel-bg: #151110`, `--text-bright: #ece8e4`, lines `#2a2724`.
- **Agent glyph:** rounded square; 14px in the sidebar, 20–22px in tiles/wizard; letter monogram with a per-agent tint. **Monograms are placeholders for real brand marks** (replace with official logos following each brand's guidelines; do not recolor official marks).
- **Motion:** 150–300ms transitions; wizard steps slide; honor `prefers-reduced-motion`.

## 7. Out of scope (v1) / future

- **Tier-2 terminal-only agents** (Aider, Crush, Amp): spawn + title only, no ambient — later.
- **Per-agent usage/service-status widgets** (only Claude in v1; a Codex analog is feasible later).
- **Per-project default agent**, fan-out (race N agents on one task), container backends.
- **Layer-2 user-editable JSON provider profiles** (add agents without recompiling).

## 8. Open questions

1. Ship with monogram glyphs or real agent logos in v1?
2. The global default lives in `state.json` (persisted) — confirm.
3. "Import from agent" for MCP — merge into the registry, or replace it?
4. Is the **General** settings tab needed in v1, or cut until it has contents (YAGNI)?

## 9. Appendix — provider adapter (from the feasibility study)

The UX above sits on a Rust `ProviderAdapter` seam that replaces the hardcoded `claude` command in `pty.rs`: per adapter it supplies the spawn/resume invocation, env overrides, headless title command, workdir/worktree strategy, and optional capabilities (hooks, service-status, usage). **Support tiers** are a property of an adapter's optional capabilities, not a hardcoded list. Suggested phased rollout: **Phase 0** adapter seam (Claude-only, pure refactor) → **Phase 1** first sibling + picker + widget gating → **Phase 2** first hooks agent (status panel) → **Phase 3** ambient widgets per-provider + the Settings/MCP surfaces in this doc.
