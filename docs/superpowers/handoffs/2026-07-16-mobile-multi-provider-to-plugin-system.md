# Handoff — Mobile multi-provider access → Plugin system

**From:** mobile-multi-provider session (branch `feat/mobile-multi-provider`)
**To:** Plugin system session (the parallel agent speccing Conduit's plugin architecture)
**Date:** 2026-07-16
**Status:** requirements handoff — asking you to fold these extension points into the plugin-system spec so this feature can be **built as a plugin** instead of core code.

---

## Why you're getting this

We (with Fahed) decided mobile remote-access should ship **on the new plugin system**, not
as bespoke core code. So this feature becomes a consumer of your architecture. Below is the
concrete capability surface it needs. If your spec exposes these, the whole mobile feature
(and Fahed's Matrix sidecar) drops in as plugins with almost no core change. Treat this as
input to your spec, not a competing design.

## What this feature is (so you can size the requirements)

Mobile remote-access to Conduit sessions from a phone, via **multiple coexisting providers**:

- **BadgerClaw** — Matrix bot via Fahed's homeserver; phone = BadgerClaw app.
- **Matrix (generic)** — any homeserver (matrix.org / self-host); phone = stock Element.
- **Direct** — the bridge exposed over LAN/tunnel with real pairing; phone = a future native
  terminal client.

Design + ground truth: `docs/superpowers/specs/2026-07-15-mobile-multi-provider-access-design.md`.
The Matrix path is a **Node/TS sidecar** already built by Fahed and now merged onto this
branch at `sidecars/matrix-adapter/` (his design: `docs/superpowers/specs/2026-07-10-conduit-matrix-adapter-design.md`).
Its `matrix.ts`/`relay.ts`/`bridge.ts`/`protocol.ts`/`render.ts` are vendor-agnostic; only
`badgerclaw.ts` is BadgerClaw-specific. We planned a `MatrixCredentialSource` seam so
BadgerClaw and generic Matrix are interchangeable providers.

## Extension points this feature needs from the plugin system

Ranked by how much they shape your spec.

1. **Provider/contribution registry (UI list rows).** A plugin must register one or more
   "mobile access providers," each surfacing as a row in a core-owned **additive list**
   (Settings → Mobile Access): id, label, description card, icon, and a config schema. Core
   owns the list + status chrome; plugins contribute entries. Generalizes beyond mobile —
   this is really "a plugin contributes items to a core-owned list view."

2. **Settings UI contribution (React 19 frontend).** Plugins must inject UI: a settings
   panel (the Mobile Access panel) and per-connection config forms (homeserver + login for
   Matrix; QR for Direct). **Key architectural question for your spec: how does a plugin
   contribute React UI?** (component-slot registry / module federation / iframe / declarative
   schema-driven forms). This is the single biggest unknown and gates our UI.

3. **Managed sidecar lifecycle.** A plugin must declare a **companion process** (the Node
   matrix-adapter) that Conduit spawns, supervises, restarts, and stops with the plugin.
   Requirements: custom env, working dir, and — **critical gotcha** — the spawn must scrub
   `npm_config_prefix` (see CLAUDE.md; nvm/`PATH` breakage otherwise). If your model is
   "plugins are JS-in-process only," we need an explicit **out-of-process sidecar** capability.

4. **Bridge client capability.** Providers need to talk to the local bridge
   (`ws://127.0.0.1:8455`, `bridge.rs` — list/attach/input/spawn/kill/git). Today the sidecar
   hardcodes a port scan (`bridge.ts` `discoverBridgeUrl` 8455..8475). Prefer the plugin
   system expose a **stable internal bridge-client API/handle** so plugins don't re-implement
   discovery/auth. Also must respect the **silo gate** (`suppress_remote`, `lib.rs:228-231`) —
   siloed sessions never reach a plugin.

5. **Secure secret store.** Providers hold secrets — Matrix access token, Direct's X25519
   pairing secret. Need a core **secret store** capability (Keychain-backed) with the existing
   discipline: **never in `state.json`, never logged**. Plugins get put/get by namespaced key,
   not raw disk.

6. **Namespaced persistent config/state.** Each provider persists connection records
   (the `MobileConnection` list) in a **plugin-namespaced slice** of state, not the global
   `state.json` blob. Need a per-plugin key-value/state API.

7. **Status/indicator contribution.** Plugins contribute a per-row status dot and an
   aggregate **titlebar pill** (mirrors `ClaudeStatusPill` → `ClaudePopover`). Need a
   "status/badge contribution" surface.

## The core/plugin boundary (please respect in your spec)

Some of this feature **cannot** be a plugin and must stay core Rust — flag this so we don't
design ourselves into a corner:

- **Bridge transport + the X25519 pairing milestone** (`bridge.rs:279-280`, replacing the
  dev-grade `==` token) is core Rust. A plugin should *drive* pairing UI + carry the credential
  in its QR, but the crypto handshake + interface binding live in core. **If plugins cannot
  ship native/Rust code, then the Direct path splits: core does pairing, the plugin does UI.**
  Please state clearly in your spec **whether a plugin can include native/Rust code or is
  JS+sidecar only** — this determines our Direct-path packaging.
- The **silo gate** and **account/spawn env redirect** stay core.

## Light-app contract (hard constraint from the user)

Conduit must stay a light app. Your plugin system should let a plugin add **zero weight to the
core Tauri/Rust binary**: sidecars are external Node processes; native network reach is a
shelled-out `cloudflared`/`tailscale` CLI, not new Rust crates (no `reqwest`/`tokio` for a few
GETs — the standing lean-deps rule). Please don't make the plugin host pull a heavy runtime
into core.

## Open questions for your spec (answers unblock us)

- **Q1 — native code:** can a plugin ship Rust/native, or JS + sidecar only? (Gates Direct path.)
- **Q2 — UI contribution mechanism:** how does a plugin inject React settings panels/forms?
- **Q3 — sidecar supervision:** is there a managed out-of-process capability (spawn/env/restart)?
- **Q4 — secret store API:** shape of the Keychain-backed put/get?
- **Q5 — bridge access:** stable bridge-client handle, or do plugins keep hardcoding the port?
- **Q6 — persistence:** per-plugin namespaced state API?
- **Q7 — install/manifest:** where plugins live, manifest format, load lifecycle, versioning.

## Sequencing / what I'm doing meanwhile

- The **credential-seam refactor** of the sidecar (`MatrixCredentialSource`, generic-Matrix
  provider) is independent of your system and I can prototype it now on `feat/mobile-multi-provider`.
- I will **not** build the Settings UI, sidecar supervision, secret store, or Direct pairing
  until your capability surface is defined — those are the plugin-host seams I'm requesting.
- Once you publish the spec (esp. Q1/Q2/Q3), I'll rewrite my plan to package the providers as
  plugins and build on your host.

## Suggested next actions for the Plugin agent

1. Skim my spec + Fahed's matrix-adapter design for the concrete shapes above.
2. In your plugin-system spec, explicitly answer Q1–Q7 and carve the core/plugin boundary
   (§ "The core/plugin boundary").
3. Model "mobile access provider" as a worked **example consumer** of your contribution API —
   it exercises UI contribution, sidecar lifecycle, secret store, and bridge access at once,
   so it's a good stress test of the design.
4. Ping back (via the user, until Continuity MCP is wired for this repo) when Q1–Q3 are decided.
