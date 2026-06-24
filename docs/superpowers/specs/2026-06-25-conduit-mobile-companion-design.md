# Conduit mobile companion — design

- **Date:** 2026-06-25
- **Status:** Approved (design); pending implementation plan
- **Topic:** Pair a phone to a running desktop Conduit and continue a live `claude` session from it over the internet, by mirroring the real PTY to the phone and typing back into it.

## Context

Conduit runs a real `claude` CLI per session in a PTY (`pty.rs`). Rust owns the PTY; the webview's `xterm.js` renders. Bytes cross as base64 over a Tauri `Channel` (the session's *sink*). The reader thread streams to a **swappable** sink, and `spawn` re-points a live reader at a new channel on reload (re-attach). `hooks.rs` runs a local `tiny_http` listener that emits per-session status (running / done / needs-you) and to-dos. The recent session-resume feature pins Claude's session id to Conduit's UUID and resumes the transcript (`<uuid>.jsonl`) on cold spawn.

The phone is a **thin remote**: it does not run `claude`. Compute stays on the laptop; the phone attaches to the laptop's PTY over a tunnel.

## Decisions (from brainstorm)

1. **Interaction = terminal mirror.** Stream the real xterm to the phone; type into the live TTY. On-brand ("real terminals, not a chat UI") and closest to existing plumbing.
2. **Transport = tunnel (Tailscale-style) for v1.** WireGuard gives audited E2E with ~zero infra. **Future:** a self-hostable Cloudflare Worker relay (Durable Object + WS hibernation) for frictionless, no-daemon pairing.
3. **Client = Tauri v2 mobile app** (iOS first), reusing the React + `xterm.js` frontend. Rust side stays thin. (React Native rejected: loses `xterm.js` reuse — no DOM.)
4. **Shape = session-list home → full-screen mirror.** A phone can't split groups; the `hooks.rs`-driven session list becomes navigation, the mirror the detail view.
5. **Pairing = QR + X25519 + per-device token.** Desktop shows a QR (tunnel address + one-time code + laptop pubkey); phone runs an X25519 exchange, stores a long-lived token in the Keychain; bridge attaches it as a sink. Revocable from desktop. v1 wire encryption = WireGuard; **app-layer E2E added at the relay milestone** (the X25519 key, redundant on Tailscale, becomes load-bearing when a relay can see bytes).

## Scope

**v1 core:** session list + live status · terminal mirror + typing · mobile key-bar (`esc/tab/ctrl/arrows/⏎/^C`) · reconnect/keep-alive · push (needs-you/done) · pairing + E2E.

**Later:** read-only files viewer · git graph / Changes · to-dos panel · start-a-new-session from phone · CF Worker relay (removes the Tailscale dependency).

**Constraints accepted (documented, not solved):** laptop must be awake + online; Tailscale on both devices (v1); Apple Developer account required (Tauri iOS + APNs).

## Architecture

```
Laptop (desktop Conduit)            Tunnel            Phone (Tauri mobile)
  PtyManager (claude PTY)        Tailscale/WireGuard    WS client (webview JS)
    ↓ reader thread                   ⇅ E2E             ↓ bytes / ↑ keystrokes
  Fan-out sink  ── webview xterm                        xterm renderer (reused)
       └──────── Mobile Bridge (WS) ←────────────────→  session list + key-bar
  hooks.rs → needs-you/done → bridge                    Keychain · Camera · APNs
  Pairing store + APNs sender   ── later: CF Worker relay (app-layer E2E)
```

Green-field vs reuse: the **only** change to existing behavior is the fan-out sink; everything else is new modules or reused frontend.

### Laptop — components

- **`pty.rs` fan-out (change).** `sink: Sink` → a subscriber list; the reader broadcasts each base64 frame to all subscribers. Webview re-attach = replace its slot; phone attach = add a slot. **Invariant:** a slow/stalled phone subscriber (bounded buffer, drop-oldest) must never starve or block the desktop subscriber. Desktop output must remain byte-for-byte unchanged.
- **`bridge.rs` WS server (new).** Sibling to `hooks.rs` but WebSocket (bidirectional, latency-sensitive). Control messages: `list` (sessions + status), `attach{session_id}`, `input{session_id,data}` → `pty.write`, `resize{session_id,cols,rows}` → `pty.resize`, `spawn{session_id}` (cold-start/resume on demand). Binds to the **tunnel interface** (never `0.0.0.0`); every connection is token-gated.
- **Pairing store (new).** `devices.json`: per-device token hash, X25519 pubkey, APNs push token, name, last-seen. Tauri commands `pairing_begin` (returns QR payload), `pairing_devices`, `pairing_revoke`.
- **APNs sender (new).** On a `hooks.rs` needs-you/done event, push to paired devices (HTTP/2 + JWT signed by the APNs p8 key).

### Phone — components (new Tauri mobile app)

- React shell: `SessionListScreen`, `TerminalScreen`, `PairingScreen` (camera QR).
- **Terminal IO abstraction:** `Terminal.tsx` reused unchanged behind a small *byte-source / keystroke-sink* interface; `WebSocketTransport` is the mobile implementation, the existing Tauri-Channel transport is the desktop one. One renderer, two transports — mobile inherits future terminal fixes for free.
- `MobileKeyBar`: accessory key row above the soft keyboard (Claude's TUI needs esc/tab/arrows).
- Rust (thin): Keychain (token + derived key), camera/QR, APNs registration.

## Data flow

- **Continue a closed session (headline):** phone foreground → WS connect + auth → `list` → tap session → if not running, `spawn` → `attach` → base64 output → `xterm.write()` renders the **resumed** conversation → type → `input` → `pty.write`. The `spawn` path reuses the existing `claude_invocation` resume logic verbatim — the phone *remotes a trigger* for the continue feature already shipped.
- **Push wake:** laptop hook fires needs-you → APNs push → tap notification → app opens to that session → attach.
- **Concurrent desktop + phone:** both are subscribers of one fan-out; both render; either types into the one shared TTY.

## Error handling

- **WS drop:** auto-reconnect with backoff; on re-attach, winsize-nudge to force a full repaint (same as webview reload). TTY is source of truth → no state lost, screen redraws.
- **Slow phone:** per-subscriber bounded buffer, drop-oldest; isolated from the desktop subscriber.
- **Token revoked/invalid:** bridge refuses attach → phone routes to re-pair.
- **Process exited:** reader emits `[process exited]`; bridge forwards; phone offers `spawn` (resume).
- **Two-place typing:** interleaves into one PTY — accepted, documented.
- **Bind/port conflict:** port-range scan, mirroring `hooks.rs`.
- **Pairing code:** one-time, short TTL, spent on first handshake.

## Milestones (hardest-risk-first)

- **M0 — Fan-out sink** (`pty.rs`): desktop unchanged; unit tests for multi-subscriber + isolation. Pure refactor.
- **M1 — Bridge WS server** on loopback: prove mirror+type from a throwaway laptop browser tab. De-risks streaming with zero mobile code.
- **M2 — Terminal IO abstraction + `WebSocketTransport`**; `Terminal.tsx` reused.
- **M3 — Tauri mobile scaffold:** session list + terminal screen + key-bar over LAN/tailnet.
- **M4 — Pairing:** QR + X25519 + token, bind to tunnel interface, revoke UI.
- **M5 — Spawn-on-demand:** wire phone "continue" to the resume path.
- **M6 — Push (APNs):** requires Apple Developer key.

Reconnect/keep-alive threaded throughout.

## Testing

Mirror existing TDD style (temp dirs, pure helpers; cf. `pty.rs`/`hooks.rs` test modules):

- **Rust units:** fan-out (all subscribers get identical bytes; unsubscribe; a blocked subscriber doesn't stall others), token verify/revoke, QR-payload encode, APNs JWT signing.
- **Bridge integration:** spawn a session, attach two WS clients, assert both receive output and either's input reaches the PTY.
- **Manual (irreducible):** real pair → mirror → type; background → push → reopen to the right session; reconnect after a forced network drop; concurrent desktop + phone.

## Risks / to verify during implementation

- **Mirror feel (latency/repaint) at M1** — the one novel risk; answered before any mobile code.
- **Fan-out without regressing desktop** — desktop sink path must stay identical; backpressure isolation is the subtle part.
- **APNs from the laptop** — direct HTTP/2 + JWT push needs the p8 key + bundle id; self-contained but externally dependent.
- **Tauri v2 mobile maturity** for the reused frontend (xterm in mobile webview, soft-keyboard interplay with the key-bar).

## References

- PTY sink / re-attach: `src-tauri/src/pty.rs`
- Hook listener + status events: `src-tauri/src/hooks.rs`
- Session resume (the `spawn` reuse): `docs/superpowers/specs/2026-06-24-session-resume-persistence-design.md`
- Future relay: Cloudflare Worker + Durable Object (WebSocket hibernation)
