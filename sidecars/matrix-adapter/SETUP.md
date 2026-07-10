# Setup: drive Conduit on this Mac from BadgerClaw on your phone

Goal: sit on the train with your phone, open the **BadgerClaw** app, and talk to the
Conduit sessions running on your Mac at home/desk — send prompts, watch replies, get
a push when a session needs you. All over Matrix (E2EE), no new iOS app, no VPS.

```
 iPhone (BadgerClaw) ──Matrix, E2EE, push──►  conduit-matrix  ──ws://127.0.0.1──►  Conduit (this Mac)
```

**The one hard rule:** this Mac must stay **awake and online**. Conduit's sessions are
processes *inside* the desktop app — the adapter mirrors them, it can't keep them
alive. If the Mac sleeps, the sessions freeze until it wakes. See §6 for keeping it up.

---

## 0. Prerequisites (already true on this Mac)

- Node 22+ and `pnpm` (you have both).
- The BadgerClaw iOS app, signed in, with your Matrix user id handy
  (in the app: Settings → your profile → user id, it looks like
  `@you:badger.signout.io`).
- **A Conduit build that includes the bridge fix.** ⚠️ Important: the Conduit
  currently *installed* on this Mac has an older mobile bridge that crashes on every
  session-list request — the adapter can't talk to it. You must run Conduit built
  from the `feat/matrix-adapter` branch. See §1.

---

## 1. Run a Conduit that the adapter can talk to

The fix lives on `feat/matrix-adapter` (commit that adds `state::<Arc<Store>>()` in
`bridge.rs`). Two ways to get it:

**A — Quick, for today (run from source):**

```bash
cd /Users/fahedyasin/Documents2/Conduit/conduit
git checkout feat/matrix-adapter
# Quit the installed Conduit.app FIRST — otherwise the dev build shares and can
# clobber its project/session state.
pnpm install
pnpm tauri dev            # uses your real projects/sessions
```

**B — Durable (build a real .app once, replace the installed one):**

```bash
cd /Users/fahedyasin/Documents2/Conduit/conduit
git checkout feat/matrix-adapter
pnpm install
pnpm tauri build         # outputs src-tauri/target/release/bundle/macos/Conduit.app
# Drag that Conduit.app into /Applications, replacing the old one.
```

Either way, when Conduit starts you'll see in its logs:

```
conduit: mobile bridge on ws://127.0.0.1:8456
```

That loopback WebSocket is what the adapter connects to. Because the adapter runs on
the **same Mac**, loopback is all you need — no `CONDUIT_BRIDGE_TOKEN`, no open ports,
nothing exposed to the network.

---

## 2. Build the adapter

```bash
cd /Users/fahedyasin/Documents2/Conduit/conduit/sidecars/matrix-adapter
pnpm install
pnpm build
```

---

## 3. Register this Mac as a host (one time)

BadgerClaw's backend only lets a bot be paired to a **registered host machine**, so
before pairing you sign in once and register this Mac. (This is the equivalent of
`badgerclaw login`, but it does **not** install BadgerClaw's gateway/plugin daemon —
your adapter is the only thing that will run the bot.)

```bash
cd /Users/fahedyasin/Documents2/Conduit/conduit/sidecars/matrix-adapter
node dist/index.js login
```

A browser opens to sign in to BadgerClaw; approve it. The command then registers this
Mac and prints your account id + instance id. Session is saved to
`~/.conduit/matrix-adapter/account.json` (mode 0600).

> Being signed into the **iOS app** is not the same as registering this Mac — the
> host machine needs its own registration, which is what this step does.

## 4. Create the bot and connect to it

1. In the **BadgerClaw app**: **Bot Management → New Bot**.
   - Pick a name (e.g. `Conduit`).
   - **Runtime: OpenClaw.** (Not Hermes — Hermes would make BadgerClaw try to run a
     Docker container as the agent. Your adapter *is* the runtime; OpenClaw is the
     "an external client backs this bot" option. Also: don't run BadgerClaw's own
     OpenClaw plugin for this bot — the adapter owns it.)
2. On this Mac, connect to it **by name** (no pair code needed):

   ```bash
   node dist/index.js connect Conduit
   ```

   `connect` uses your logged-in account to mint the bot's Matrix session directly
   (BadgerClaw's `refresh-matrix-token`). Run `node dist/index.js connect` with no
   name to list your bots first. The owner defaults to your account id — that's who's
   allowed to command the bot and type into your terminal (room membership alone
   grants nothing); add more with `--owner @someone:badger.signout.io`.

   Bot credentials land in `~/.conduit/matrix-adapter/` (mode 0600). Re-running
   `connect` for the same bot reuses its E2EE device id, so the phone won't see an
   identity-reset warning.

   > **Why `connect`, not a pair code?** The pair-code flow (`pair <BCK-…>`) routes
   > through BadgerClaw's host-pairing backend, which currently 500s for this
   > sidecar setup. `connect` sidesteps pairing entirely and is the supported path
   > here. `pair` is kept only as a fallback.

---

## 5. Run it and use it

```bash
cd /Users/fahedyasin/Documents2/Conduit/conduit/sidecars/matrix-adapter
node dist/index.js run
```

Leave it running alongside Conduit. Then, on your **phone**:

1. In BadgerClaw, open a chat with the bot (invite the bot's user id to a room, or
   DM it).
2. Drive it:

   | You type | What happens |
   |---|---|
   | `/conduit list` | Lists projects + sessions on the desktop, numbered, with running/idle |
   | `/conduit use 2` | Binds *this room* to session #2 |
   | *(anything else)* | Sent to the bound session as a prompt (and runs) |
   | `y` / `n` | Answers Claude's y/n approval prompts (they stream here) |
   | `/conduit stop` | Interrupts the running agent (Ctrl-C) |
   | `/conduit key <name>` | Sends a control key: esc, enter, up, down, left, right, tab, ctrl-c, y, n |
   | `/conduit send <text>` | Types text into the session *without* running it |
   | `/conduit todos` | Shows the session's current plan/checklist |
   | `/conduit watch on` | Pings this room when a turn finishes while you're away |
   | `/conduit status` | Binding, live activity, tools this turn, token/cost, watch state |
   | `/conduit detach` | Unbinds this room |
   | `/conduit help` | The command list |

   Bindings persist — restart the adapter or Conduit and the room re-attaches itself.

What you'll see back in the room:
- The assistant's replies as normal messages (they push to your phone).
- Tool activity as compact notices (`⚙ ran npm test`, `⚙ edited store.ts`).
- A **live checklist** that ticks off as the agent works its plan (one edited message).
- A **typing indicator** while the session is working.
- An **alert message** (which pushes) when a session needs your input.
- With `watch on`: a `✅ finished a turn` ping (plan progress + cost) when you're away.

Tip: one room ↔ one session. Make a separate room per session you want to follow.

---

## 6. Keep it connected while you travel

Three things must stay up on this Mac: **it must not sleep**, **Conduit must run**,
**the adapter must run**.

**Stop the Mac sleeping** (lid closed / idle). Simplest is to wrap the adapter in
`caffeinate`, which prevents system sleep as long as it's running:

```bash
caffeinate -s node dist/index.js run
```

(Closing the laptop lid still sleeps unless external power + display, or you use a
tool like Amphetamine set to keep-awake. A Mac mini / always-plugged desktop is
ideal here.)

**Auto-start the adapter on login** with a LaunchAgent. Create
`~/Library/LaunchAgents/com.conduit.matrix-adapter.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.conduit.matrix-adapter</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-s</string>
    <string>/usr/local/bin/node</string>
    <string>/Users/fahedyasin/Documents2/Conduit/conduit/sidecars/matrix-adapter/dist/index.js</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/conduit-matrix.log</string>
  <key>StandardErrorPath</key><string>/tmp/conduit-matrix.err</string>
</dict>
</plist>
```

Adjust the `node` path (`which node`) and load it:

```bash
launchctl load ~/Library/LaunchAgents/com.conduit.matrix-adapter.plist
```

Conduit itself you'd add to **System Settings → General → Login Items** so it
relaunches too. (Conduit still needs a real login session — a locked-but-awake Mac
is fine; a logged-out one is not.)

---

## 7. Troubleshooting

- **`/conduit list` says the bridge is unreachable.** Conduit isn't running, or
  it's the *old* installed build whose bridge crashes on list. Confirm you're
  running the `feat/matrix-adapter` build (§1) and that its log shows
  `mobile bridge on ws://127.0.0.1:8456`.
- **Adapter prints "Conduit bridge not found."** Same cause. Check with
  `lsof -nP -iTCP:8455-8475 -sTCP:LISTEN` — you want the *patched* Conduit process
  listening. If a stale old Conduit is squatting the port, quit it.
- **The bot doesn't respond to your messages.** Your Matrix id isn't on the owner
  allowlist. Re-run `pair … --owner @you:badger.signout.io`. Also note the bot only
  reacts to plain text you send; it ignores `/bot …` (that's BadgerClaw's own
  namespace).
- **Phone shows an "identity reset / unverified" warning for the bot.** The
  adapter's crypto store was wiped or moved. Don't delete
  `~/.conduit/matrix-adapter/crypto/`. If it happened, re-pair and re-verify.
- **Replies arrive as whole messages, not streaming.** Expected — the bridge exposes
  the transcript line-by-line, not token streams, so there's no live-typing edit.
- **You can't start a *new* session from the phone.** Also expected for now — the
  adapter attaches to sessions already running on the desktop. Start sessions in
  Conduit on the Mac; the phone drives them.

---

## 8. What this is and isn't (so there are no surprises)

- **Outbound-only & private:** the adapter opens connections *out* (loopback to
  Conduit, HTTPS to the Matrix homeserver). It listens on nothing, opens no firewall
  holes, and works behind NAT. Your terminal is reachable only by the owner id you
  allowlisted, over Matrix E2EE.
- **The Mac is the single point of presence.** This is the "desk Mac / Mac mini that
  stays home" pattern. If your only always-on machine is the laptop that sleeps in
  your bag, this won't hold a connection there — that's the case the VPS + Hermes
  bots were for (a separate track).
- **Design record:** `docs/superpowers/specs/2026-07-10-conduit-matrix-adapter-design.md`.
- **Overview & command reference:** `README.md` in this directory.
