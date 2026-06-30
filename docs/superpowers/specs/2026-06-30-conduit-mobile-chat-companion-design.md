# Conduit mobile companion — chat + inline status (design)

- **Date:** 2026-06-30
- **Status:** Approved (design); front-end shell in progress, backend pending review
- **Supersedes the interaction model of:** `2026-06-25-conduit-mobile-companion-design.md`
  (that spec's transport/pairing/push milestones M4–M6 are reused; its M0/M1 PTY
  fan-out + loopback bridge are already merged to `main` and remain the foundation.)
- **Topic:** Pair a phone to a running desktop Conduit and **drive a live `claude`
  session from a chat UI** — instead of mirroring the raw terminal — while surfacing
  every status/action inline and answering tool approvals from the phone.

## The pivot (why this differs from the 2026-06-25 spec)

The earlier spec chose a **terminal mirror**: stream the real xterm bytes to the phone,
reuse `xterm.js`, type into the live TTY. On-brand, but it carries the hardest
complexity (byte-perfect mirroring, desktop-authoritative TTY sizing, reflow/garble when
two viewers share one window size) and it foreclosed React Native (no DOM → no xterm).

This spec replaces the **interaction model** with a **per-agent chat feed + inline status
actions**. Consequences:

- **Deletes the hardest risks.** Structured messages have no cursor, columns, or escape
  codes to replay. The sizing/reflow problem disappears.
- **Reopens the client choice.** With no xterm to host, **React Native** becomes viable
  (and chosen) — best native feel, gestures, push, Keychain.
- **Creates one new risk — approvals** — which we de-risked with a prototype (below).

Everything else (the fan-out sink, the loopback bridge, session-resume/`spawn`, pairing,
tunnel, APNs) is reused.

## Decisions

1. **Interaction = per-agent chat feed with inline status actions.** Chat bubbles for
   user/assistant turns; tool calls, todos, and lifecycle events render inline as a
   **compact timeline** (slim one-line entries on a thread rail, expandable on tap).
2. **Client = React Native (Expo).** Mobile-specific screens; the desktop's React/xterm
   stack is *not* reused (no terminal). The three Warm themes ARE reused (see §Themes).
3. **v1 capability = monitor + approve + prompt.** Triage list, live status/chat feed,
   approve/deny tool requests, send a new prompt. No full-interactive-TUI features
   (option menus, plan-mode acceptance, inline diffs) in v1.
4. **Chat only for v1.** The merged M1 raw-byte bridge stays in the codebase but the
   phone shows only the chat/status UI. A raw-terminal toggle is a possible later add.
5. **Approvals = opt-in blocking `PreToolUse` broker.** Default OFF → desktop behaves
   exactly as today (TUI approvals). When ON, a request fans out to a new desktop
   approval card AND the phone; **first responder wins**; the native TUI prompt is
   suppressed.

## Prototype evidence (de-risk, 2026-06-30)

A throwaway spike (headless `claude --settings` with a `PreToolUse` hook on `Bash`)
confirmed the core mechanism:

- The hook **fires with exactly the payload an approval card needs**: `tool_name`,
  `tool_input` (e.g. `{command, description}`), `session_id`, **`transcript_path`**,
  `cwd`, `tool_use_id`.
- It **blocks the session arbitrarily long** — the run paused 42 s until an external
  decision file appeared, no error.
- A structured `{"hookSpecificOutput":{"permissionDecision":"allow"}}` was **honored
  end-to-end** (tool ran, `permission_denials: []`, completed).

**Still to verify (interactive):** that a long block doesn't visually hang/garble the
real xterm and that `allow` cleanly suppresses Claude's native in-terminal prompt. Cheap
desktop-only test; gates the backend phase.

`PreToolUse` hooks are the one structured-permission mechanism that **works in
interactive mode** (stream-json / SDK `canUseTool` are headless-only). This is what lets
us keep the load-bearing interactive PTY while adding structured approvals — the same
shape the VS Code extension uses (augment the live session, don't replace it).

## Architecture

```
  DESKTOP (Conduit)                                   PHONE (React Native / Expo)
  claude PTY (interactive, keep-alive)                Projects screen → Chat screen
     │ writes                                           · compact timeline + bubbles
     ▼                                                  · approval cards · composer
  <uuid>.jsonl transcript ───────read──┐                        │ WebSocket (structured)
  hooks.rs (verbs + approval broker) ─┐ │                       │
     ▲ blocking PreToolUse decision   │ ▼   read channel ◀──────┤
  bridge.rs  ◀──────────────────────── control channel ◀────────┘
     │  pty.write(prompt)  /  approval decision → hooks broker
     ▼ types into / unblocks the one shared live session
```

The phone never sees raw terminal bytes. Three signals that today **dead-end at the
desktop webview** are forwarded over the bridge; one reverse path (decisions) is added.

### Read channel (what the phone shows)

- **Chat content** ← the session's `~/.claude/projects/<slug>/<uuid>.jsonl` transcript
  (user/assistant turns, `tool_use`, `tool_result`). The bridge tails the file; on attach
  it sends recent history. Path is obtained from any hook payload's `transcript_path`
  (Conduit also pins the UUID, so it's deterministic).
- **Live status** ← existing hook verbs (`prompt`/`pretool`/`tooluse`/`todos`/`stop`/
  `notification`/…) forwarded to bridge subscribers, for real-time "running Bash…",
  "needs you", "done", and `n/m` todo progress *between* transcript writes.

### Control channel (what the phone can do)

- **Send a prompt** → `prompt{session_id,text}` → `pty.write` types the message + Enter
  into the live session. Desktop sees it; transcript records it; feed updates.
- **Approve / deny** → `approval_decision{request_id, allow|deny, reason?}` → the broker
  releases the blocking `PreToolUse` hook with the structured decision.

### Approval broker (the one consequential change)

`hooks.rs` gains an approval-broker role, **only active when remote approval is enabled**:

- The installed `PreToolUse` hook (for tools that would prompt) POSTs the request and
  **holds the connection open** (long-poll) until a decision arrives.
- The broker fans the pending request to (a) a new small **desktop approval card** and
  (b) all attached phones, via the bridge. **First decision wins**; others collapse.
- The hook returns the structured decision → the native TUI prompt is pre-empted.
- **Default OFF** (no approval hook installed) → desktop approvals stay in the TUI,
  unchanged. This preserves the sacred terminal UX for users who never pair a phone.

### Bridge protocol changes (`bridge.rs`)

Add structured message types alongside the existing raw-byte ones (which stay for the
desktop/loopback path):

- **server→client:** `sessions` (now **with names + status** — fixes today's bare-id
  gap), `history` (transcript backfill on attach), `chat` (new transcript entries),
  `status` (hook verb event), `approval_request{request_id,session_id,tool_name,tool_input}`.
- **client→server:** `attach{session_id}`, `prompt{session_id,text}`,
  `approval_decision{request_id,allow|deny,reason?}`.

## Mobile app (React Native / Expo)

- **Screens:** `ProjectsScreen` (triage list grouped project → agent, status pills,
  "n need you" summary) → `ChatScreen` (compact timeline, bubbles, inline approval card,
  composer). Lightweight in-app navigation (no heavy nav deps for v1 shell).
- **Status vocabulary** mirrors the desktop sidebar exactly: needs-you / running +
  activity / compacting / done / idle, plus todo `n/m`.
- **Themes:** the three Warm schemes (`warm-near-black`, `warm-dim`, `warm-light`) are
  ported to an RN token module + `ThemeProvider` + on-device switcher. See §Themes.
- **Transport:** WebSocket to the bridge. v1 dev uses LAN/tailnet address; pairing +
  tunnel come in the transport milestone.

### Themes (§) — keep the three schemes in lockstep

`src/themes.ts` `THEMES[id].cssVars` is a flat color-token map (the xterm/prism parts are
irrelevant to chat). The RN app consumes the **same raw palettes**. To prevent drift,
extract the three palettes into a shared, framework-neutral token source that both
`themes.ts` and the RN theme module read (or generate the RN module from it). v1 shell may
start with a copied map, but the spec's intent is a single source of truth.

## Scope

**v1 in:** Projects triage · per-agent chat feed (transcript + live status inline) ·
approve/deny via broker · send a prompt · 3 themes · reconnect/keep-alive · pairing +
tunnel (reuse 2026-06-25 M4) · APNs push for needs-you/done (reuse M6).

**v1 out (later):** full-interactive TUI features (option menus, plan-mode accept, inline
file diffs before approval, image attach) · raw-terminal toggle · multi-device presence ·
CF Worker relay.

**Front-end shell (this autonomous session):** runnable Expo app, both screens, 3 themes,
mock data + simulated interactions. No backend wiring (separate reviewed phase).

## Milestones (hardest-risk-first)

- **P0 — Front-end shell** *(this session)*: Expo app, themes, both screens, mock data.
  Validates the design on a real device with zero backend risk.
- **P1 — Structured bridge + broker** *(reviewed)*: transcript reader, hook→bridge
  forwarding, approval broker (blocking PreToolUse + decision endpoint), new bridge
  messages, session list with names+status, **+ interactive-mode approval verification**,
  + small desktop approval card. The novel-risk phase.
- **P2 — Wire the RN app** to the structured bridge over LAN/tailnet; real chat + approve
  + prompt against a live session.
- **P3 — Pairing + transport** (reuse 2026-06-25 M4): bind tunnel interface, QR + X25519 +
  per-device token, revoke UI.
- **P4 — Push (APNs)** (reuse 2026-06-25 M6): needs-you/done → paired devices. Apple
  Developer key required.

## Error handling

- **WS drop:** auto-reconnect with backoff; on reattach, re-request `history` + current
  `sessions`. Transcript is source of truth → no state lost.
- **Pending approval when phone disconnects:** broker keeps the desktop card live; a
  reconnecting phone re-receives open `approval_request`s. Timeout → default deny with a
  reason Claude can read.
- **Two-place approval race:** first decision wins; the broker is the single arbiter.
- **Prompt while agent busy:** `pty.write` interleaves into the one PTY (documented;
  same as typing on desktop).
- **Process exited:** reader emits end marker; phone offers `spawn` (resume) later.

## Testing

- **Rust units:** transcript-entry parsing (jsonl → chat model), approval broker
  (allow/deny/timeout, first-responder, fan-out), bridge `sessions` now carries
  name+status. Mirror existing `pty.rs`/`hooks.rs` test style.
- **RN pure logic:** hook-verb → display mapping, theme resolution, mock event reducer.
- **Manual (irreducible):** interactive-mode approval feel; real pair → chat → approve →
  prompt; reconnect mid-pending-approval.

## Risks / to verify

- **Interactive-mode approval** (long block + native-prompt suppression) — gates P1.
- **Transcript tail latency/ordering** vs. hook timing — interleave content (transcript)
  with live status (hooks) without dupes/races.
- **Broker without regressing desktop** — must be a true no-op when disabled.
- **RN ↔ themes drift** — enforce the shared token source.
- **Tauri-vs-RN repo shape** — RN app lives outside the Tauri build; CI/release implications.

## References

- Prior (terminal-mirror) spec: `docs/superpowers/specs/2026-06-25-conduit-mobile-companion-design.md`
- Merged foundation: `src-tauri/src/pty.rs` (fan-out), `src-tauri/src/bridge.rs` (WS), `mobile/` (browser proto)
- Hooks: `src-tauri/src/hooks.rs`; status mapping `src/App.tsx`; themes `src/themes.ts`
- Approval mechanism (Claude Code docs): PreToolUse hook `permissionDecision` allow/deny/ask
