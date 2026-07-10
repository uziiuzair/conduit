# conduit-matrix-adapter

A sidecar that logs your Conduit desktop onto Matrix as a **BadgerClaw bot**, so the
BadgerClaw iOS app becomes Conduit's phone UI — E2EE chat, push notifications, the
whole Element timeline — with **zero changes to Conduit or BadgerClaw**.

```
BadgerClaw iOS ⇄ Matrix (E2EE, push) ⇄ conduit-matrix (this) ⇄ ws://127.0.0.1 bridge ⇄ Conduit
```

Design record: `docs/superpowers/specs/2026-07-10-conduit-matrix-adapter-design.md`.

## Setup (once)

1. In the **BadgerClaw app**: Bot Management → create a bot (runtime *OpenClaw*),
   then generate a **pair code** for it.
2. On the Mac that runs Conduit:

   ```bash
   cd sidecars/matrix-adapter
   pnpm install && pnpm build
   node dist/index.js login                  # browser sign-in + register this Mac
   node dist/index.js pair BCK-XXXX-XXXX     # owner defaults to your account
   ```

   `login` is required once — BadgerClaw only pairs bots to a registered host
   machine. It does **not** install BadgerClaw's gateway/plugin; the adapter is the
   runtime. See `SETUP.md` for the full walkthrough.

3. Run it alongside Conduit (a LaunchAgent or `tmux` is fine):

   ```bash
   node dist/index.js run
   ```

4. In the app, invite the bot to a room (or DM it). Then:

   ```
   /conduit list         # sessions on the desktop
   /conduit use 2        # bind this room to session 2
   fix the failing test  # ← anything else is sent to that session as a prompt
   ```

The session's transcript streams back: assistant replies as messages, tool activity
as compact notices, a typing indicator while the agent works, and an alert when the
session needs your input.

## Notes & limits

- **Conduit must be running** — sessions live inside the desktop app (no headless
  mode). The adapter itself is outbound-only (loopback + HTTPS): no open ports.
- Only allowlisted `--owner` mxids can command the bot or reach the terminal.
  Room membership alone grants nothing.
- Never delete `~/.conduit/matrix-adapter/crypto/` — phones pin the bot's E2EE
  identity; wiping it triggers "identity reset" warnings. Re-pair if that happens.
- Attach works for **running** sessions only (the bridge has no remote spawn yet).
- Replies arrive as complete messages (the transcript is line-granular; no token
  streaming).
