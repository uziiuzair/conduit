# Conduit Plugin System — Increment #2: Privileged Capability Tier ("Tier-P")

**Status:** Design / approved for planning
**Date:** 2026-07-16
**Builds on:** [`2026-07-15-conduit-plugin-system-design.md`](./2026-07-15-conduit-plugin-system-design.md) (increment #1: substrate + Sandboxed tier)
**Branch:** `feat/plugins`
**Worked example / first consumer:** Mobile multi-provider remote access
([`2026-07-15-mobile-multi-provider-access-design.md`](./2026-07-15-mobile-multi-provider-access-design.md),
handoff `docs/superpowers/handoffs/2026-07-16-mobile-multi-provider-to-plugin-system.md`).

---

## 1. Why Tier-P exists

Increment #1 built the plugin **substrate** (folder-drop loader, manifest, permission grants,
Web Worker sandbox, permission-gated RPC bridge) and proved it with two zero-UI, zero-privilege
capabilities: **commands** and **hooks**. That tier is safe for an open marketplace because a
worker is deny-all — no DOM, no process spawn, no credentials, no network except a gated
`host.fetch`.

Real features need more: inject UI, run a companion process, hold a secret, drive the mobile
bridge. Mobile multi-provider access needs **all four at once**, which makes it the ideal
stress test. Tier-P defines those higher-privilege capabilities and the trust model that keeps
them from becoming a malware vector on a marketplace.

**Design through-line: one runtime, two trust tiers.** Every plugin is still JS orchestration
in a Web Worker over the same permission-gated RPC bridge. A tier is nothing but *which host
methods the gate unlocks*. The privileged work itself — spawning a process, reading the
Keychain, talking to the bridge, running the X25519 handshake — executes in **core Rust or a
core-supervised sidecar**, never in the plugin's worker. UI is **declarative** (core renders
native React), so no untrusted DOM ever reaches the main thread. This is what lets a
high-capability plugin like mobile-access exist without a second execution model.

---

## 2. Trust tiers & the capability split (human sign-off b)

Two tiers, and — critically — the privileged tier is itself **split by install trust**. Some
privileged capabilities are safe to grant to a marketplace plugin behind an informed-consent
dialog; two of them are code-execution / agent-control vectors and are **trusted-install only**
until code-signing + review exist.

| Capability | Tier | Marketplace-grantable (with consent)? | Why |
| --- | --- | --- | --- |
| `commands`, `hooks:*`, `notifications`, `clipboard:write`, `net` | Sandboxed | ✅ (increment #1) | Deny-all worker; no ambient authority. |
| `ui:contribute` | Privileged | ✅ | Declarative schema only; core renders. No arbitrary DOM/code. |
| `status` | Privileged | ✅ | Declarative status dots + titlebar pill. |
| `storage` | Privileged | ✅ | Namespaced, isolated per-plugin key-value. Non-secret. |
| `secrets` (own namespace only) | Privileged | ✅ | Keychain put/get scoped to the plugin's own keys; cannot read others'. |
| **`sidecar`** | Privileged | ❌ **Trusted-only** | Spawns an arbitrary Node/binary process = **native code execution**. |
| **`bridge`** | Privileged | ❌ **Trusted-only** | `input`/`spawn`/`kill` on live agent sessions = **agent control**. |

**Trusted install** = first-party / bundled with the app, or a future explicit "developer /
trusted" install path gated behind a hard consent (distinct from the ordinary marketplace
consent). The marketplace installer **refuses to grant `sidecar` or `bridge`** to a
non-trusted plugin even if the user clicks yes — the grant is unavailable, not merely warned.

Each capability carries metadata in `permissions.ts`:
```ts
{ id, tier: 'sandboxed' | 'privileged', marketplaceGrantable: boolean, trustedOnly: boolean,
  label, riskLine, methods, events }
```

**Mobile-access is first-party**, so it's unaffected by the split — it may hold `sidecar` +
`bridge`. The split exists to keep those two off the open marketplace for everyone else.

---

## 3. UI contribution mechanism (Q2; follow-ups #1, #2, #5)

**Decision: declarative, schema-driven contributions rendered by core.** Not module
federation, not runtime-injected React components (unsafe for untrusted code, brittle across
React 19 minor versions), not a raw DOM handle. A sandboxed-**iframe** escape hatch for truly
bespoke panels is deferred to a later increment; Tier-P does not need it. **This supersedes the
increment-#1 "iframe + component registry" out-of-scope note** (cross-linked there).

A plugin contributes UI by declaring **views** built from a fixed **widget vocabulary** the
core renders with native React widgets and a consistent look.

### 3.1 Widget vocabulary
`text`, `secret` (masked input, never echoed to logs), `select`, `button`, `qr`, `status`,
`note`, `group`. Extensible, but every widget type is core-implemented — a plugin never ships a
renderer.

### 3.2 List contributions + per-row actions (follow-up #1)
A plugin adds rows to a **core-owned additive list** (e.g. `mobile-access.providers`). Row schema:
```jsonc
{
  "id": "conn-abc",
  "label": "matrix.org — @me:matrix.org",
  "description": "Generic Matrix",
  "icon": "matrix",
  "statusDotBinding": "conn-abc.status",     // drives the per-row dot (see §4)
  "actions": [                                // ⋯ overflow menu + optional inline primaries
    { "id": "pause",      "label": "Pause",       "icon": "pause" },
    { "id": "repair",     "label": "Re-pair",     "icon": "refresh" },
    { "id": "edit",       "label": "Edit",        "opensForm": "matrix-config" },
    { "id": "disconnect", "label": "Disconnect",  "style": "danger", "confirm": true }
  ]
}
```
Triggering an action sends `list.action(listId, rowId, actionId)` to the plugin worker (or
opens the referenced form directly for `opensForm`). `confirm: true` gets a core-rendered
confirm step for destructive actions. Covers your Pause / Re-pair / Disconnect / Edit menu.

### 3.3 Forms
A form is a JSON-Schema-shaped list of widgets (`contributes.forms["matrix-config"]`). Core
renders it, validates, and on submit sends `form.submit(formId, values)` to the worker.
`secret` fields route their value to the secret store (§7), never through plain `storage` and
never into `form.submit` logs. Homeserver+login (Matrix) and the Direct QR panel are both
forms.

### 3.4 Stateful / dynamic widgets + host→plugin events (follow-up #2)
UI is **stateful and plugin-driven**. The plugin owns widget state and pushes patches:
`ui.update(viewId, widgetId, patch)` → core re-renders. Cheap local animation (a countdown)
runs in core from a declarative field, so there's no per-second message chatter:
- `qr` widget fields: `payload`, `expiresAt` (core renders a live countdown locally),
  `state: "pending" | "paired"`, plus a `regenerate` action. The Direct pairing flow is:
  plugin sets `payload`+`expiresAt`+`state:"pending"` → user scans → **core emits a
  `bridge.pairing.completed` event** → plugin flips `state:"paired"` via `ui.update`, and core
  swaps the QR for a "paired ✓" affordance.

**Confirmed: UI bindings ride the event bus, which is generalized beyond hooks (§5).** The
increment-#1 `events.ts` fan-out (hooks-only) becomes a typed **plugin event bus** carrying
hook events *and* UI-interaction events (`list.action`, `form.submit`) *and* capability events
(`bridge.pairing.completed`, `sidecar.state`). Delivery is still grant-filtered per plugin.

---

## 4. Status / indicator contribution (`status`)
A plugin contributes:
- **Per-row status dots** — bound by `statusDotBinding`; the plugin pushes
  `status.set(key, { level: "ok"|"warn"|"error"|"idle", tooltip })`.
- **An aggregate titlebar pill** — declared once (`contributes.status.pill`), mirroring
  `ClaudeStatusPill` → `ClaudePopover`. The plugin pushes the pill's level + a small popover
  model (list of rows + summary). Core renders it in the titlebar next to the Claude pill.

---

## 5. Plugin event bus (generalizes `events.ts`)
`events.ts` becomes a typed bus with multiple **sources**, each gated by a capability:

| Event | Source | Gated by |
| --- | --- | --- |
| `session.*`, `fleet.*`, `lifecycle.*` | store / fleet / `HookBus` | `hooks:*` (Tier S) |
| `list.action`, `form.submit`, `ui.*` | core UI | `ui:contribute` |
| `bridge.session.*`, `bridge.pairing.completed` | `bridge.rs` (silo-filtered) | `bridge` |
| `sidecar.state`, `sidecar.exit` | sidecar supervisor | `sidecar` |

The host subscribes each source once and fans events out only to workers whose grants cover
them. Payloads stay sanitized (ids/labels/timestamps; never secrets or raw transcript text).

---

## 6. Managed sidecars (Q3; follow-ups #3, #4) — trusted-only

### 6.1 Plural + lazy (follow-up #3)
`contributes.sidecar` (singular, always-on) is **replaced by `contributes.sidecars` (array),
each independently lazy-startable**:
```jsonc
"sidecars": [
  { "id": "matrix",     "runtime": "node",   "entry": "sidecars/matrix-adapter/index.js",
    "autostart": false, "env": { "…": "…" }, "cwd": "sidecars/matrix-adapter",
    "net": ["*.matrix.org", "{homeserver}"] },
  { "id": "cloudflared","runtime": "binary", "cmd": "cloudflared",
    "args": ["tunnel", "--url", "ws://127.0.0.1:8455"], "autostart": false }
]
```
- `runtime: "node"` (the matrix-adapter) or `"binary"` (a shelled CLI like `cloudflared` /
  `tailscale` — satisfies the light-app "shell out, don't add Rust crates" rule).
- `autostart: false` ⇒ **lazy**: nothing runs until the plugin calls `sidecar.start(id)`. The
  Matrix adapter starts on the first Matrix connection and stops (`sidecar.stop(id)`) when the
  last is removed — **zero Node running at zero connections**, honoring the light-app contract.

### 6.2 Lifecycle & the npm_config_prefix scrub
Core spawns/supervises/restarts/stops each sidecar (reusing `pty.rs`'s child-process
machinery). Crash ⇒ supervised restart with backoff; plugin disable ⇒ `SIGTERM` then kill.
**Every sidecar spawn calls `env_remove("npm_config_prefix")`** — the same CLAUDE.md gotcha
that `pty.rs` and the `lib.rs` titler already handle; the sidecar spawner is a third spawn site
and must keep it. `env` and `cwd` come from the manifest; `{...}` placeholders resolve from the
plugin's config (e.g. `{homeserver}`).

### 6.3 Sidecar ↔ core IPC + outbound net (follow-up #4)
- **IPC = newline-delimited JSON-RPC over the sidecar's stdio.** The sidecar calls host methods
  (`bridge.*`, `secrets.get`, `storage.*`) by writing JSON-RPC requests to **stdout**; core
  reads them, **enforces the owning plugin's grants** (a sidecar can never exceed its plugin's
  capability set), executes, and writes replies to the sidecar's **stdin**. `stderr` is captured
  as logs (never contains secrets). No extra socket, no port to discover. This mirrors how the
  worker's RPC is gated — same permission check, different transport.
- **Outbound network: yes, the sidecar makes its own egress.** It is a separate OS process, so
  the increment-#1 **worker CSP lockdown does not constrain it** (CSP binds the webview, not a
  child process). The Matrix adapter opens its own HTTPS to the homeserver directly. Egress
  hosts are declared per-sidecar (`net: [...]`) purely for **consent disclosure** at install —
  this unrestricted-egress-by-a-child-process property is precisely why `sidecar` is
  **trusted-only**.

---

## 7. Secret store (Q4) — `secrets`
Keychain-backed, namespaced per plugin.
```
secrets.set(key, value)    // key namespaced to plugin id
secrets.get(key)           // → value, in memory only
secrets.delete(key)
```
- Backed by the macOS `security` CLI (the same discipline as the plan-usage OAuth read in
  `claude_usage.rs`): held in memory, **never written to `state.json`, never logged**.
- **Own-namespace only** — a plugin cannot read another plugin's keys; this is what keeps
  `secrets` marketplace-grantable.
- The sidecar fetches secrets at runtime via the stdio RPC (§6.3), so tokens never sit in its
  `env` or on disk. Matrix access token + Direct X25519 **pairing credential** (the plugin's
  copy for the QR — the private key half stays core, §9) live here.

---

## 8. Namespaced persistent state (Q6) — `storage`
Per-plugin isolated key-value, **not** the global `state.json` blob:
```
storage.get(key)   storage.set(key, value)   storage.list()
```
Backed by a plugin-scoped slice/file keyed by plugin id. Non-secret config only (secrets → §7).
The `MobileConnection` records (provider, label, homeserver, status, secret-store *references*)
persist here.

---

## 9. Bridge client (Q5) — `bridge` — trusted-only
A **stable bridge-client handle**, ending the hardcoded port scan.
- Core hands the plugin a bound handle (supplies the URL + auth for `bridge.rs`; the sidecar's
  `bridge.ts` `discoverBridgeUrl` 8455–8475 scan is deleted). Methods mirror the bridge ops:
  `list / attach / input / spawn / kill / git`, each subject to grant.
- **Silo gate enforced core-side.** Siloed / `suppress_remote` sessions (`lib.rs:228-231`) are
  filtered by core **before** any event or list result reaches a plugin — a plugin can never
  observe or drive a siloed session.
- **X25519 pairing (`bridge.pairing.*`)** — `bridge.pairing.begin()` runs the **core** handshake
  and returns the plugin-side credential to encode in the Direct QR; `bridge.pairing.completed`
  arrives as an event. The crypto + interface binding stay in core Rust (§10).

---

## 10. Core / plugin boundary (Q1)
Encoded as the handoff requested:
- **A plugin cannot ship native/Rust in-process. JS worker + optional managed sidecar only.**
  No `libloading`/dynamic-lib in core (there is none today, and the light-app + safety rules
  keep it that way). Native reach = a `runtime: "binary"` sidecar shelling out to a CLI.
- Therefore the **Direct path splits** exactly as anticipated: **core Rust owns the X25519
  pairing handshake, the bridge transport, and interface binding** (`bridge.rs:279-280`,
  replacing the dev-grade `==` token); the **plugin drives the pairing UI** and carries the
  credential in its QR via `bridge.pairing.*`.
- The **silo gate** and the **account/spawn env redirect** stay core.
- **Light-app contract:** the plugin host adds **zero weight to the core Tauri/Rust binary** —
  no new heavy crates, no bundled runtime. Sidecars are external processes; tunnels are shelled
  CLIs. The worker runtime and declarative renderer are frontend-only.

---

## 11. Worked example — the Mobile Access provider plugin
End-to-end, exercising every Tier-P capability at once (the design's stress test):

- **Manifest:** `permissions: ["ui:contribute","status","storage","secrets","sidecar","bridge"]`
  (first-party ⇒ trusted-only caps allowed); `contributes.lists["mobile-access.providers"]`,
  `contributes.forms` (matrix-config, direct-pair), `contributes.status.pill`,
  `contributes.sidecars` (matrix=node lazy, cloudflared=binary lazy).
- **Providers as rows:** BadgerClaw, Matrix (generic), Direct each register rows with the
  ⋯-menu actions from §3.2; `MatrixCredentialSource` makes BadgerClaw + generic Matrix
  interchangeable behind one row type.
- **Matrix connect:** user fills the matrix-config form → token stored via `secrets.set` →
  plugin `sidecar.start("matrix")` (first connection) → the Node adapter opens its own HTTPS to
  the homeserver and calls `bridge.*` over stdio RPC to relay sessions → per-row dot + titlebar
  pill via `status`. Removing the last Matrix connection ⇒ `sidecar.stop("matrix")`.
- **Direct connect:** `bridge.pairing.begin()` (core X25519) → plugin shows the `qr` widget with
  `payload`+`expiresAt`; optional `sidecar.start("cloudflared")` for tunnel egress → scan →
  `bridge.pairing.completed` event → QR flips to "paired ✓".
- **Persistence:** `MobileConnection` list in `storage`; secrets in the Keychain store; nothing
  sensitive in `state.json`.

If Tier-P exposes exactly these seams, the mobile feature drops in as a plugin with no bespoke
core code beyond the boundary items in §10.

---

## 12. Change map (delta over increment #1)

**Rust:**
- `plugins.rs` gains: sidecar supervisor (spawn/env-scrub/restart/stop, stdio JSON-RPC pump,
  grant enforcement on sidecar calls), secret-store commands (Keychain via `security`),
  namespaced-storage commands, and a bridge-client shim that binds `bridge.rs` + enforces the
  silo gate for plugin callers.
- `bridge.rs`: expose the stable client handle + `pairing.begin/completed`; land the X25519
  milestone (replaces `==` token).
- `store.rs`: per-plugin namespaced storage slice; `PluginRecord` gains tier + trusted flag.

**Frontend:**
- `src/plugins/`: extend the RPC dispatcher with the Tier-P methods; generalize `events.ts`
  into the typed event bus; add the declarative UI renderer (`ui/` — widget components, list,
  forms, qr, status/pill) and `ui.update`/`status.set` plumbing.
- New components: `MobileAccessPanel` is *not* core — it is the plugin's declared list/forms
  rendered by the generic core renderer + a titlebar pill host.
- `permissions.ts`: add Tier-P caps with `{ tier, marketplaceGrantable, trustedOnly }`; the
  consent dialog groups sandboxed vs privileged and hard-gates trusted-only caps.

---

## 13. Testing
- **Rust:** unit-test the grant enforcement for sidecar stdio calls (a sidecar cannot exceed its
  plugin's caps), the secret-store namespacing (no cross-plugin read), the silo filter on the
  bridge shim, and the npm_config_prefix scrub at the sidecar spawn site.
- **Frontend/manual:** drive the bundled Mobile Access plugin end-to-end (§11) in the dev app
  (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev`): row actions, form submit, secret round-trip, lazy
  sidecar start/stop, QR pairing → paired transition, titlebar pill, and a marketplace
  (non-trusted) plugin being **denied** `sidecar`/`bridge` grants.

---

## 14. Open questions (resolve in planning)
1. `runtime: "binary"` manifest shape for shelled CLIs vs. reusing an existing sidecar form.
2. Trusted-install UX: how a first-party/bundled plugin is marked trusted, and whether a
   "developer trust" toggle exists before code-signing lands.
3. Whether `status` pill contributions from multiple plugins stack or share one titlebar slot.
4. Exact JSON-RPC method names for the sidecar stdio protocol (align with the worker RPC names).
