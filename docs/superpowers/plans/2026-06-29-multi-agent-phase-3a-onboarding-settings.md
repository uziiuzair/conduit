# Multi-Agent Phase 3a — Settings panel + persisted default + onboarding wizard

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** A ⚙ **Settings** panel (Agents tab: detection list, set the default, re-scan), a **persisted user-chosen default agent** the New Session picker uses, and a first-run **onboarding wizard** (Welcome → Agents → Done).

**Architecture:** Frontend-only. App-level prefs persist in `localStorage` (mirrors `themePref`). Detection already exists (`store.agents` / `loadAgents`, loaded at startup). Settings + Onboarding are `.dialog-overlay` modals reusing `AgentGlyph` and a shared `AgentList` row renderer. No Rust changes.

**Tech Stack:** React 19 + TS. **No frontend test runner** — verify with `pnpm exec tsc --noEmit` + `pnpm build` + launching the app.

**Run dev SAFELY:** `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`

**Scope:** Settings *Agents* tab + default + onboarding only. **Deferred to Phase 3b:** the MCP servers tab/matrix + per-adapter MCP writers (Rust). OpenCode still deferred everywhere.

---

## File Structure
- **Modify** `src/store.ts` — `defaultAgent` + `agentSetupComplete` state + `setDefaultAgent`/`completeAgentSetup` (localStorage-backed).
- **Modify** `src/components/NewSessionDialog.tsx` — use `defaultAgent` from the store (replaces the `DEFAULT_AGENT` const in 3 spots).
- **Create** `src/components/AgentList.tsx` — shared detection-row list (glyph · name · binary/path · status · "set default" radio), used by Settings + Onboarding.
- **Create** `src/components/Settings.tsx` — ⚙ modal, Agents tab.
- **Create** `src/components/Onboarding.tsx` — first-run wizard.
- **Modify** `src/components/Sidebar.tsx` — ⚙ button in the add-bar → opens Settings.
- **Modify** `src/App.tsx` — mount `<Onboarding/>` when `!agentSetupComplete`.
- **Append** `src/theme.css` — settings/wizard/agent-list styles.

---

## Task 1: Persisted default agent + setup flag

**Files:** `src/store.ts`, `src/components/NewSessionDialog.tsx`

- [ ] **Step 1:** In `store.ts`, add localStorage helpers near the top (after imports):
```ts
const DEFAULT_AGENT_KEY = "conduit.defaultAgent";
const SETUP_DONE_KEY = "conduit.agentSetupComplete";
function readDefaultAgent(): AgentId {
  const v = localStorage.getItem(DEFAULT_AGENT_KEY);
  return AGENTS.some((a) => a.id === v) ? (v as AgentId) : DEFAULT_AGENT;
}
```
(Update the agents import to also bring `AGENTS`: `import { AGENTS, type AgentId, type AgentInfo, DEFAULT_AGENT } from "./agents";`.)
- [ ] **Step 2:** Add to the `AppState` interface (near `agents`):
```ts
  defaultAgent: AgentId;
  agentSetupComplete: boolean;
  setDefaultAgent: (id: AgentId) => void;
  completeAgentSetup: () => void;
```
- [ ] **Step 3:** Add to the initial state object (near `agents: null,`):
```ts
    defaultAgent: readDefaultAgent(),
    agentSetupComplete: localStorage.getItem(SETUP_DONE_KEY) === "1",
```
and add the actions (near `loadAgents`):
```ts
    setDefaultAgent: (id) => {
      localStorage.setItem(DEFAULT_AGENT_KEY, id);
      set({ defaultAgent: id });
    },
    completeAgentSetup: () => {
      localStorage.setItem(SETUP_DONE_KEY, "1");
      set({ agentSetupComplete: true });
    },
```
- [ ] **Step 4:** In `NewSessionDialog.tsx`, read the persisted default and use it in all 3 `DEFAULT_AGENT` spots:
```ts
const defaultAgent = useStore((s) => s.defaultAgent);
const [agent, setAgent] = useState<AgentId>(defaultAgent);
// in the pre-selection effect: `if (!ready.has(defaultAgent))`
// in the tile tag: `{a.id === defaultAgent && <span className="df">default</span>}`
```
Drop the now-unused `DEFAULT_AGENT` import if nothing else uses it (keep `AGENTS`, `agentMeta`).
- [ ] **Step 5: Typecheck** `pnpm exec tsc --noEmit` → PASS. **Commit** `feat(store): persist a user-chosen default agent`.

---

## Task 2: Shared `AgentList` + Settings modal + ⚙ entry

**Files:** Create `src/components/AgentList.tsx`, `src/components/Settings.tsx`; modify `src/components/Sidebar.tsx`; append `src/theme.css`.

- [ ] **Step 1:** Create `src/components/AgentList.tsx` — the reusable detection list:
```tsx
import { useStore } from "../store";
import { AGENTS, type AgentId } from "../agents";
import { AgentGlyph } from "./AgentGlyph";

/** Detection rows: glyph · name · binary/path · status · "default" radio.
 *  `allowNoDefault` adds a "Choose per session" option (used in onboarding). */
export function AgentList({ allowNoDefault = false }: { allowNoDefault?: boolean }) {
  const detected = useStore((s) => s.agents);
  const loadAgents = useStore((s) => s.loadAgents);
  const defaultAgent = useStore((s) => s.defaultAgent);
  const setDefaultAgent = useStore((s) => s.setDefaultAgent);
  const info = (id: AgentId) => detected?.find((d) => d.id === id);
  const ready = (id: AgentId) => !detected || info(id)?.found === true;

  return (
    <div className="agent-list">
      {AGENTS.map((a) => {
        const d = info(a.id);
        const ok = ready(a.id);
        return (
          <div key={a.id} className={`agent-list-row ${ok ? "" : "off"} ${defaultAgent === a.id ? "def" : ""}`}>
            <button
              className="agent-radio"
              role="radio"
              aria-checked={defaultAgent === a.id}
              aria-label={`Set ${a.label} as default`}
              disabled={!ok}
              onClick={() => ok && setDefaultAgent(a.id)}
            />
            <AgentGlyph id={a.id} size={20} />
            <div className="agent-list-main">
              <div className="agent-list-name">{a.label}</div>
              <div className="agent-list-meta">
                {d?.found ? `${d.binary} · ${d.path ?? "on PATH"}` : `${a.id} · not found on PATH`}
              </div>
            </div>
            {ok ? (
              defaultAgent === a.id ? <span className="agent-tag">default</span> : <span className="agent-stat ok">ready</span>
            ) : (
              <span className="agent-stat no">not installed</span>
            )}
          </div>
        );
      })}
      <button className="agent-rescan" onClick={() => void loadAgents()}>Re-scan PATH</button>
      {allowNoDefault && <div className="agent-list-note">You can also pick an agent per session in the New Session dialog.</div>}
    </div>
  );
}
```
- [ ] **Step 2:** Create `src/components/Settings.tsx`:
```tsx
import { useEffect } from "react";
import { AgentList } from "./AgentList";

export function Settings({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog settings" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <div className="settings-tabs"><span className="settings-tab on">Agents</span></div>
          <button className="settings-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="settings-body">
          <p className="settings-intro">Conduit runs whichever of these are installed on your PATH. Pick the default for new sessions.</p>
          <AgentList />
        </div>
      </div>
    </div>
  );
}
```
(The "MCP servers" tab is added in Phase 3b — single tab for now.)
- [ ] **Step 3:** In `Sidebar.tsx`, add a ⚙ button to the add-bar (beside `ThemeSwitcher`) that opens `Settings`. Add `const [showSettings, setShowSettings] = useState(false);` in `Sidebar()`, a `<button className="settings-btn" title="Settings" onClick={() => setShowSettings(true)}>⚙</button>` in the `.add-bar` before `<ThemeSwitcher />`, and `{showSettings && <Settings onClose={() => setShowSettings(false)} />}` near `<SessionContextMenu />`. Import `Settings`.
- [ ] **Step 4:** Append CSS to `src/theme.css` (settings modal + agent-list rows; use existing tokens). Include `.settings`, `.settings-head/-tabs/-tab/-close/-body/-intro`, `.agent-list`, `.agent-list-row(.off/.def)`, `.agent-radio`, `.agent-list-main/-name/-meta`, `.agent-tag`, `.agent-stat(.ok/.no)`, `.agent-rescan`, `.settings-btn`. Match the warm-dark palette (accent `#ce8a6e`, panel `#151110`, lines `#2a2724`).
- [ ] **Step 5: Typecheck + build** `pnpm exec tsc --noEmit && pnpm build`. **Commit** `feat(ui): Settings panel with agent detection + default picker`.

---

## Task 3: First-run onboarding wizard

**Files:** Create `src/components/Onboarding.tsx`; modify `src/App.tsx`.

- [ ] **Step 1:** Create `src/components/Onboarding.tsx` — a 3-step wizard reusing `AgentList`:
```tsx
import { useState } from "react";
import { useStore } from "../store";
import { AgentList } from "./AgentList";

export function Onboarding() {
  const completeAgentSetup = useStore((s) => s.completeAgentSetup);
  const agents = useStore((s) => s.agents);
  const [step, setStep] = useState(0);
  const anyReady = !agents || agents.some((a) => a.found);
  const steps = ["Welcome", "Agents", "Done"];

  return (
    <div className="dialog-overlay">
      <div className="dialog wizard" role="dialog" aria-modal="true">
        <div className="wizard-steps">
          {steps.map((s, i) => (
            <span key={s} className={`wizard-step ${i === step ? "cur" : ""} ${i < step ? "done" : ""}`}>{s}</span>
          ))}
          <button className="settings-close" onClick={completeAgentSetup} aria-label="Skip setup">Skip ✕</button>
        </div>
        <div className="settings-body">
          {step === 0 && (
            <div className="wizard-welcome">
              <h3>Run multiple agents in Conduit</h3>
              <p className="settings-intro">Conduit can drive Claude Code, Codex, and Gemini side by side. Let's see what's installed and pick a default.</p>
            </div>
          )}
          {step === 1 && (
            <>
              <p className="settings-intro">Conduit scanned your PATH. Choose a default agent — you can still switch per session.</p>
              <AgentList allowNoDefault />
              {!anyReady && <div className="dialog-note">No agents detected — install one (Claude/Codex/Gemini) and Re-scan.</div>}
            </>
          )}
          {step === 2 && (
            <div className="wizard-welcome">
              <h3>You're set</h3>
              <p className="settings-intro">Open a project and hit New session — your default is pre-selected. Change agents anytime in ⚙ Settings.</p>
            </div>
          )}
        </div>
        <div className="dialog-actions">
          {step > 0 && <button onClick={() => setStep((s) => s - 1)}>Back</button>}
          {step < 2
            ? <button className="primary" onClick={() => setStep((s) => s + 1)}>Continue ▸</button>
            : <button className="primary" onClick={completeAgentSetup}>Done</button>}
        </div>
      </div>
    </div>
  );
}
```
- [ ] **Step 2:** In `App.tsx`, mount it on first run. Add `const agentSetupComplete = useStore((s) => s.agentSetupComplete);`, import `Onboarding`, and render `{!agentSetupComplete && <Onboarding />}` inside the `app-root` div (after `<Sidebar/>`/the columns). (Detection is already loaded via `loadAgents()` at startup.)
- [ ] **Step 3:** Append wizard CSS to `theme.css` (`.wizard`, `.wizard-steps`, `.wizard-step(.cur/.done)`, `.wizard-welcome`).
- [ ] **Step 4: Typecheck + build** `pnpm exec tsc --noEmit && pnpm build`. **Commit** `feat(ui): first-run onboarding wizard (agents + default)`.

---

## Task 4: Verify + live smoke

- [ ] **Step 1: Gates** `pnpm exec tsc --noEmit && pnpm build`.
- [ ] **Step 2: Live smoke** (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev` — fresh profile = `agentSetupComplete` false → wizard shows):
  - Wizard appears on launch; Welcome → Agents (detected agents listed; not-installed greyed; pick a default or "choose per session") → Done. After Done it doesn't reappear on relaunch (flag persisted).
  - ⚙ in the sidebar add-bar opens Settings → Agents tab shows the same list; changing the default updates the New Session picker's pre-selected tile + "default" tag.
  - Re-scan works after installing an agent.
- [ ] **Step 3:** No `cargo` involved (frontend-only). Commit any smoke fixes.

---

## Deferred to Phase 3b
- MCP servers tab/matrix + per-adapter MCP writers (Rust: Claude `.mcp.json`, Codex `codex mcp add`, Gemini shared `.gemini/settings.json`), the wizard's MCP step, add-server form, collision/propagation/async-write states. OpenCode everywhere.
