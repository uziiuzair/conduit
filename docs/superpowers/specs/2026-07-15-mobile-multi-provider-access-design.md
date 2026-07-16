# Mobile multi-provider access — design

**Status:** proposed (2026-07-15)
**Scope:** Let Conduit reach its sessions from a phone through **more than one transport at
once**, decoupled from any single vendor. Take Fahed's Matrix/BadgerClaw OTA path, extract a
**credential seam** so BadgerClaw and a generic Matrix account are interchangeable, and add a
first-party **Direct** path (the bridge exposed over LAN/tunnel with real pairing). Surface all
of it as an **additive list of mobile connections** in Settings, each with its own provider and
status. BadgerClaw + generic Matrix + Direct can all be live simultaneously.

## Problem

Remote mobile access already exists, but only in one shape and coupled to one vendor:

- Fahed's `origin/feat/matrix-adapter` branch ships an OTA path: a Node/TS sidecar
  (`sidecars/matrix-adapter/`) logs the desktop onto a **Matrix homeserver** as an E2EE bot;
  the phone is BadgerClaw (an Element X fork). The transport is outbound-only (loopback WS to
  the bridge + HTTPS to the homeserver), so it works behind NAT with no open ports.
- That path is **hard-wired to BadgerClaw** — homeserver `badger.signout.io`, an appservice
  owning the `@*_bot` namespace, and a token-minting backend `api.badger.signout.io`.
  BadgerClaw is a separate product (owned by Fahed). Conduit should not *depend* on it, but we
  also don't want to throw away a working, push-capable, finished-client integration.
- The only first-party path (`bridge.rs` LAN mode) is **same-wifi only** and gated by a
  **dev-grade shared token** (`token_ok`, exact `==`, `bridge.rs:281`). There is no real
  pairing, no encryption of its own, and no remote reach.

We want: keep BadgerClaw as *one* option, make a **generic Matrix** account a peer option, add
a **Direct** first-party option, and let a user run any combination — without forking the relay
logic or bloating the Conduit binary.

## Goals

1. **Credential seam.** One Matrix sidecar, a `MatrixCredentialSource` interface with two
   implementations (`BadgerClawProvider`, `GenericMatrixProvider`). Only credential
   acquisition varies; `relay`/`bridge`/`protocol`/`render` stay shared.
2. **Additive multi-connection model.** A user can register N named mobile connections, each
   bound to a provider, each with independent status and lifecycle. Not a single radio.
3. **Direct first-party path.** Expose the bridge beyond loopback with **real pairing**
   (QR encoding the wss URL + a one-time X25519-derived secret), retiring the dev `==` token
   for any non-loopback use. Transport reach via an external tunnel (`cloudflared` favored) or
   a mesh VPN (Tailscale/Headscale) — chosen by the user, not bundled.
4. **UX.** A Settings → **Mobile Access** panel: additive list, provider picker, per-provider
   pairing, status dots, and a titlebar pill mirroring the `ClaudeStatusPill` pattern.
5. **Off by default.** No mobile connection exists until the user adds one. Today's behavior is
   unchanged for anyone who never opens the panel.
6. **Light app held.** No new Rust HTTP/mesh crates. The Matrix path stays a Node sidecar (its
   existing cost); the Direct path is Rust binding an interface + shelling out to
   `cloudflared`/`tailscale` — crate-free, consistent with the lean-deps rule.

## Non-goals (deferred)

- **The native Direct mobile client.** The Direct path defines pairing + transport; the
  full-fidelity terminal app that consumes the raw bridge protocol is a separate track. Until
  it exists, "Direct" is LAN/tunnel reach for a future/native client, not a shipped phone UI.
- **Self-hosted push.** A self-hosted Matrix homeserver needs its own push gateway (sygnal);
  v1 documents this as the operator's cost. matrix.org and BadgerClaw supply push for free.
- **Replacing BadgerClaw.** It remains a first-class provider. This design de-*couples*, it
  does not remove.
- **Waking the approval broker.** `broker.rs` remains dormant; a Conduit-side producer is a
  separate effort (see the mobile-chat-pivot record). The seam here doesn't block it.

## Current architecture (ground truth, verified on `main` @ bef274a)

- **The bridge is the neutral substrate.** `src-tauri/src/bridge.rs` serves a WebSocket
  (first free port `8455..=8475`). `handle_conn` is per-connection, so multiple clients can
  attach at once — a Matrix sidecar and a Direct client are both just bridge clients.
- **Remote-control protocol is already merged to main.** `bridge.rs` carries `Spawn`, `Kill`,
  `Git`/`gitresult` client messages (`bridge.rs:52-165`) plus `git.rs`/`store.rs` helpers.
  This is shared infrastructure every transport reuses.
- **Bind + auth today:** default loopback `127.0.0.1` (`bridge_host`, `bridge.rs:260-266`);
  `CONDUIT_BRIDGE_TOKEN` set → binds `0.0.0.0` and requires `?token=` (`accept_ws`,
  `bridge.rs:288-307`). The token check is **dev-grade `==`** and the file itself flags the
  gap: "the real pairing milestone replaces this with an X25519-derived credential"
  (`bridge.rs:279-280`; doc ref `bridge.rs:6`).
- **The sidecar is NOT on main.** `sidecars/matrix-adapter/` exists only on
  `origin/feat/matrix-adapter`. Its `matrix.ts`/`relay.ts`/`bridge.ts`/`protocol.ts`/
  `render.ts` are homeserver-agnostic (`@vector-im/matrix-bot-sdk` + rust-sdk crypto); only
  `badgerclaw.ts` (PKCE login + `/refresh-matrix-token` + `redeemPairCode`) is
  BadgerClaw-specific. **This is the code the credential seam refactors** — so this design
  depends on that branch landing first (see Sequencing).
- **Silo gate exists.** `suppress_remote` (`lib.rs:228-231`) keeps siloed/private sessions off
  any mobile-bridge viewer. Multi-provider must respect it unchanged.
- **Approval broker is present but dormant.** `broker.rs` + `hooks.rs` `handle_approve` exist;
  `presence.attach()` is never called, so the intercept path is inert. Out of scope here.
- **Existing UI seams to mirror:** Settings panels `UsagePrefsPanel.tsx` / `AccountList.tsx`
  (registry-list + per-item config pattern); status pill `ClaudeStatusPill.tsx` →
  `ClaudePopover.tsx`. The Mobile Access panel is a sibling of these.

## Design

### 1. Credential seam (`MatrixCredentialSource`)

Extract, in the sidecar, a single interface:

```ts
interface MatrixSession {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;   // reused across restarts to preserve E2EE identity
}
interface MatrixCredentialSource {
  acquire(): Promise<MatrixSession>;
  refresh?(): Promise<MatrixSession>;   // BadgerClaw token refresh; no-op for plain login
}
```

- `BadgerClawProvider` — the existing `badgerclaw.ts` behind the interface (PKCE +
  `refresh-matrix-token` + `redeemPairCode`). Unchanged behavior.
- `GenericMatrixProvider` — plain Matrix: homeserver URL + (user/password login **or** a
  pasted access token) → `MatrixSession`. No appservice, no vendor backend.

`createMatrixClient` (`matrix.ts`) takes a `MatrixSession`; everything downstream
(`relay.ts` `/conduit …` commands, `bridge.ts` loopback WS, crypto store) is untouched.
This mirrors Conduit's own `ProviderAdapter::account_env` seam in `agent.rs`: vary only the
narrow provider method, share the core. **Rule: never fork `relay.ts`/`render.ts`.**

### 2. Providers

| Provider | Transport | Client | Pairing | Push | Infra |
| --- | --- | --- | --- | --- | --- |
| **BadgerClaw** | Matrix via `badger.signout.io` | BadgerClaw app | PKCE browser | Yes (APNs) | None (vendor) |
| **Matrix** | Matrix, any homeserver | stock Element | homeserver + login form; owner-mxid allowlist | matrix.org yes / self-host DIY | matrix.org none / self-host VPS |
| **Direct** | bridge over LAN/tunnel | native client (future) | **QR: wss URL + one-time X25519 secret** | DIY | none (`cloudflared`) or VPS (Headscale) |

### 3. Connection model + persistence

A **mobile connection** is a persisted record, not a global mode:

```
MobileConnection {
  id, label,
  provider: "badgerclaw" | "matrix" | "direct",
  status: Off | Connecting | Connected | Error(reason),   // runtime, not persisted
  // provider-specific config:
  matrix?: { homeserverUrl, userId, ownerMxids: string[] },   // tokens/secrets NOT here
  direct?: { publicUrl?, pairedDeviceIds: string[] },
}
```

Records persist in `state.json` (list). **Secrets never persist in `state.json`** — Matrix
access tokens live in the sidecar's existing `~/.conduit/matrix-adapter/` store (mode 0600);
the Direct X25519 pairing secret follows the Keychain/in-memory discipline used for the OAuth
token (never logged, never written to `state.json`). This keeps the existing secrets rule.

### 4. UX — Settings → Mobile Access (additive list)

- **Empty state:** explainer + `+ Add mobile connection`.
- **Provider picker:** three cards (BadgerClaw "easiest, nothing to host" / Matrix "any
  homeserver, stock Element" / Direct "first-party, full terminal, LAN now").
- **Populated list:** one row per connection — status dot, provider, identity (bot mxid /
  wss target), `⋯` menu (Pause · Re-pair · Disconnect · Matrix: Edit homeserver).
- **Pairing:** BadgerClaw = PKCE browser. Matrix = homeserver + login/token form, then "DM the
  bot / invite to a room; only your mxid is allowed." Direct = **QR** encoding wss URL +
  one-time X25519 secret (5-min expiry) + typed fallback `conduit.pair/XXXX`.
- **Indicators:** per-row dot; aggregate **titlebar pill** ("2 mobile connections") →
  opens the panel, mirroring `ClaudeStatusPill` → `ClaudePopover`.
- **Silo:** siloed sessions show a `🔒 hidden from mobile` tag; enforced by the existing
  `suppress_remote` path — never surfaced on any connection.
- **Phone loop (chat providers, identical for BadgerClaw & Matrix):** `/conduit list · use ·
  changes · diff · new · kill · todos · watch · stop` (already in `relay.ts`), replies as
  bubbles, push on turn end.

### 5. Auth model (read straight — this is the security surface)

Each connection authenticates independently on the one bridge:

- **Matrix / BadgerClaw:** authorization is the **owner-mxid allowlist** (default-closed).
  Room membership grants nothing; only allowlisted mxids reach a PTY. Content is Matrix E2EE.
  This is unchanged from Fahed's model and is safe to run as-is.
- **Direct:** MUST NOT ship over any non-loopback interface on the dev `==` token. It is gated
  on the **X25519 pairing milestone** (`bridge.rs:279-280`): the QR carries a one-time secret;
  the handshake proves possession of a paired key; `token_ok` is replaced by a real credential
  check. LAN-with-`==` remains available only as an explicitly-labeled dev shortcut.
- **Multiple transports on one bridge is safe** because each connection passes its own gate;
  the bridge does not widen trust by having two clients. The silo gate applies to all.

### 6. Light-app accounting

- Level-1 (credential seam) adds **one provider module** to an existing sidecar — ~zero
  weight, no Rust change.
- Direct path: Rust binds an interface + reads `tailscale`/tunnel state via `curl`/CLI, and
  generates/verifies an X25519 credential (a small, already-implied crypto dep for pairing —
  not an HTTP/mesh stack). Transport reach is an **external** `cloudflared`/`tailscale`/
  Headscale the user installs. No `reqwest`/`tokio`, consistent with lean-deps.

## Sequencing / dependencies

1. **Blocked on Fahed's sidecar landing on main.** `sidecars/matrix-adapter/` is only on
   `origin/feat/matrix-adapter` and is the code the credential seam refactors. Either that
   branch merges first, or this branch rebases onto it. Decide before implementation
   (Open question O1).
2. **Level 1 (credential seam + Matrix provider + additive-list UI + BadgerClaw/Matrix)** is
   the first shippable increment. It needs no bridge change.
3. **Level 2 (Direct path)** is gated on the **X25519 pairing** work in `bridge.rs`; do that
   before any internet-facing Direct connection. Ships as a later increment.

## Open questions

- **O1 — sidecar landing:** merge `feat/matrix-adapter` to main first, or rebase this branch
  onto it? (Affects whether the seam refactor is "edit main" or "edit a stacked branch".)
- **O2 — Matrix login UX:** support interactive password login, or access-token paste only, in
  v1? (Token-paste is simpler + avoids handling passwords; password login is friendlier.)
- **O3 — Direct transport default:** ship the Direct path with `cloudflared` guidance
  (zero-infra, third-party) first, and treat Tailscale/Headscale as documented alternatives?
- **O4 — versioning:** this is a user-facing feature set → a MINOR bump on ship. Confirm it's
  one increment (multi-provider mobile access) not several.

## Verification

- **Rust:** unit-test the X25519 pairing credential (generate/verify, expiry, one-time use) as
  a pure function; `cargo test`. No wiring tests.
- **Sidecar:** the existing `vitest` covers `protocol.ts`/`render.ts`; add tests for the
  `MatrixCredentialSource` selection + `GenericMatrixProvider.acquire()`.
- **Frontend:** `pnpm exec tsc --noEmit` + launch the app; verify two connections (BadgerClaw
  + Matrix) show as two live rows, QR renders for Direct, and siloed sessions stay hidden.
  Never claim the UI works from a typecheck alone.
