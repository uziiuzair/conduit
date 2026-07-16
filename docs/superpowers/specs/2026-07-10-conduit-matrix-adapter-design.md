# Conduit → Matrix Adapter (BadgerClaw companion) — Design

**Date:** 2026-07-10 · **Status:** implemented alongside this spec (side project,
`sidecars/matrix-adapter/`, own branch, no PR planned)

## 1. Problem

The user is away from the desk ~4h/day with only a phone. Conduit's sessions live
inside the desktop GUI process (no headless mode; PTYs are children of the app), its
mobile bridge is loopback/LAN-only, and its Expo companion app is a mock shell. But
the user already ships **BadgerClaw** — an Element X fork chatting over Matrix (E2EE,
APNs push) with AI bots that are ordinary Matrix users, provisioned by
`badgerclaw-api` through a Matrix **appservice** that owns the `@*_bot` namespace.

So: don't build a new phone pipeline. Log Conduit itself onto Matrix. A small
**sidecar** runs next to the desktop app, connects to the existing mobile bridge on
loopback, and appears in BadgerClaw as a first-class bot. The phone gets E2EE chat,
push, and the whole Element timeline for free; Conduit and BadgerClaw both stay
unmodified.

```
BadgerClaw iOS ⇄ Matrix homeserver ⇄ [adapter: matrix-bot-sdk + E2EE]
                                          ⇅ ws://127.0.0.1:8455 (bridge.rs)
                                      Conduit desktop (sessions/PTYs)
```

## 2. Identity & pairing (reusing BadgerClaw's own flow)

The `@*_bot` localparts are an **exclusive appservice namespace** — the adapter
cannot self-register. It rides the existing pair-code flow instead, exactly like a
BadgerClaw host machine:

1. In the BadgerClaw app: create a bot (runtime "openclaw" is fine — the adapter IS
   the runtime), then generate a pair code (`POST /api/v1/pairing/create` happens
   app-side).
2. `conduit-matrix pair BCK-XXXX-XXXX --owner @you:badger.signout.io` — the adapter
   calls `POST {api}/api/v1/pairing/redeem {code}` (unauthenticated by design) and
   receives `{homeserver, access_token, user_id, device_id, bot_name}`.
3. Credentials persist to `~/.conduit/matrix-adapter/credentials.json` (mode 0600).

**Device stability is load-bearing:** BadgerClaw trusts bots via TOFU cross-signing
pinning. The adapter keeps `device_id` + the rust-sdk crypto store forever; wiping
them makes every phone show an "identity reset" violation banner. Re-pairing is the
recovery path and is documented as such.

No BadgerClaw API bearer is stored (redeem doesn't return one), so the adapter
cannot call `refresh-matrix-token`; if the Matrix token dies, the user re-pairs.
Accepted for v1.

## 3. Matrix client

Same stack as badgerclaw-plugin, so every behavior BadgerClaw expects is native:

- `@vector-im/matrix-bot-sdk` (Element fork) with `SimpleFsStorageProvider` +
  `RustSdkCryptoStorageProvider` (vodozemac, sqlite) — **E2EE always on**.
- Auto-join on invite (rooms are created phone-side by the Element X fork).
- **Sender allowlist**: only configured owner mxids may command the bot or type into
  sessions; others get silence. Default-closed — `--owner` is required at pair time.
- Output conventions BadgerClaw already renders: `m.text` bubbles, `m.notice` for
  adapter/system chatter, typing indicators while the agent runs.

## 4. Bridge client

`bridge.rs` facts the adapter is built around:

- Discovery: probe `ws://127.0.0.1:8455..8475` (first socket that answers `list`
  wins); `CONDUIT_BRIDGE_URL` env overrides (for the LAN-token mode).
- **One attach per connection** — the adapter holds one control connection (for
  `list`) plus one connection per bound session.
- `input.data` is raw PTY keystrokes: a prompt is `text + "\r"`; multi-line text is
  wrapped in bracketed paste (`ESC[200~ … ESC[201~`) so the Claude CLI treats it as
  one paste, then `\r` submits.
- On attach the bridge replays the FULL transcript as `history` — the adapter
  deliberately drops it (the phone wants new activity, not a 500-message dump) and
  reports only a count. New lines then stream as `chat {item}`.
- `output` (base64 PTY bytes) frames are discarded — the transcript tail is the chat
  source of truth; rendering a raw TTY into a chat timeline is noise.
- `status {event}` hook events drive presence: `pretool`/`prompt` → typing
  indicator; `stop`/`sessionend` → typing off; `notification` → an alert message
  (m.text so it pushes) that the session needs input.

## 5. Room ↔ session model

A room binds to **at most one Conduit session**; bindings persist in
`settings.json` and re-attach automatically when the adapter or Conduit restarts.
Commands (owner-only, any room the bot is in):

```
/conduit list            projects + sessions with indices and running flags
/conduit use <n | id>    bind this room to a session (re-bind replaces)
/conduit detach          unbind
/conduit status          binding + bridge connectivity
/conduit help
```

Everything else the owner types in a bound room is forwarded verbatim to the
session's PTY as a prompt. `/bot …` is left alone — that namespace belongs to
BadgerClaw's server-side handler.

Chat-item rendering (from `transcript.rs` shapes):

- `bubble/assistant` → `m.text` (plain body; markdown-to-HTML is a later polish).
- `bubble/user` → `m.notice` "💻 typed on desktop: …", EXCEPT when it echoes a
  prompt the adapter itself just sent (dedup by exact text within a 60 s window).
- `event` items → coalesced `m.notice` lines ("⚙ ran `npm test`", "⚙ edited
  `store.ts`"), batched per drain to avoid one-notice-per-tool spam.
- `usage` items → dropped (v1).

## 6. Security posture

- The adapter makes **outbound connections only**: loopback WS to Conduit and HTTPS
  to the homeserver. No listening sockets, no inbound firewall holes, works behind
  NAT. The Mac must be awake and online — inherent to Conduit's PTY-in-GUI design.
- Prompt injection boundary: only allowlisted mxids reach the PTY. Room membership
  is not authority — an invited stranger can read what the room shows but cannot
  type into the terminal.
- Credentials/crypto stores live under `~/.conduit/matrix-adapter/` (0600/0700).
  The Matrix access token never appears in logs.

## 7. Non-goals / known limits (v1)

- No raw terminal mirror on the phone (chat timeline only — attach Conduit's own
  future mobile app for that).
- No streaming partial responses: transcript lines land whole, so replies arrive as
  complete bubbles (BadgerClaw's `m.replace` draft-edit trick needs token streams
  the bridge doesn't expose).
- No spawn/stop of sessions from the phone — the bridge has no `spawn` yet (its
  spec defers it to M5); `/conduit list` shows only what the desktop is running.
- No `refresh-matrix-token` (needs the API bearer) — re-pair on auth failure.
- One adapter process per Mac, one bot identity (multiple sessions via rooms).

## 8. Package layout

`sidecars/matrix-adapter/` — self-contained npm package (NOT wired into the app
build): TypeScript, `conduit-matrix` bin with `pair`/`run` subcommands. Pure logic
(command parsing, chat-item rendering, bridge-frame parsing) lives in dependency-free
modules with vitest coverage; the Matrix and WS edges stay thin.
