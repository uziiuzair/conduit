# Mobile Multi-Provider Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship phone access to Conduit sessions through multiple coexisting providers (BadgerClaw, generic Matrix, Direct), packaged as a first-party **Privileged plugin** on the Tier-P plugin host.

**Architecture:** The feature is a *consumer* of the plugin system. A first-party plugin registers provider rows into a core-owned list, contributes declarative forms + a status pill, and drives two lazy sidecars (the existing Node `matrix-adapter`, and `cloudflared` for Direct) plus the core X25519 bridge pairing. The only vendor-agnostic core logic is a `MatrixCredentialSource` seam inside the sidecar that makes BadgerClaw and generic Matrix interchangeable.

**Tech Stack:** TypeScript (sidecar, `@vector-im/matrix-bot-sdk`; plugin worker), vitest (sidecar tests), the Tier-P plugin host (Rust `plugins.rs` + `src/plugins/*`), Rust `bridge.rs` (X25519 pairing).

**Design refs:** spec `docs/superpowers/specs/2026-07-15-mobile-multi-provider-access-design.md`; Tier-P `docs/superpowers/specs/2026-07-16-conduit-plugin-system-tier-p-privileged-design.md`; handoff `docs/superpowers/handoffs/2026-07-16-mobile-multi-provider-to-plugin-system.md`.

---

## ⚠️ Dependency & sequencing (read first)

This plan has a hard external dependency and is deliberately split:

- **Increment #1 (plugin substrate + Sandboxed tier: commands/hooks)** is **built and merged** (local `main` `d4cb15bf`, this branch). `src/plugins/*`, `src-tauri/src/plugins.rs`, `permissions.ts`, `events.ts` exist.
- **Tier-P host capabilities are SPECCED, NOT BUILT.** `ui:contribute`, `status`, `storage`, `secrets`, `sidecar`, `bridge`, the declarative UI renderer, the sidecar supervisor + stdio JSON-RPC, and the `bridge.pairing.*` X25519 core work **do not exist in code yet** (Tier-P spec §12 change map). They are **plugin-system work, a separate subsystem** — they must be their own implementation plan owned by the plugin effort, **not built inside this feature's plan**.

**Therefore:**
- **Phase 0 (credential seam)** is fully independent — buildable and shippable **now**, zero Tier-P dependency. **Start here.**
- **Phases 1–5** each declare `DEPENDS ON:` the specific Tier-P host capability. They are written against the exact Tier-P spec API shapes so they're ready the moment the host lands, but **must not begin until the named capability is implemented.** The plugin *worker* code (manifest, `main.js` calling `host.request(...)`) is concrete here; the host methods it calls are the dependency.

**Recommendation surfaced to the human:** commission a separate **"Tier-P host implementation" plan** (from §12 of the Tier-P spec) before Phases 1–5. Track that plan as the blocker. This plan owns only the *consumer* (the Mobile Access plugin) + the sidecar seam.

**Decisions baked in (defaults):** O2 Matrix login = **access-token paste** (no password handling in v1); O3 Direct transport = **`cloudflared`-first**; O4 = **one MINOR bump** on Level-1 ship.

---

## File Structure

**Phase 0 — sidecar (buildable now), under `sidecars/matrix-adapter/`:**
- Create `src/credential-source.ts` — the `MatrixCredentialSource` interface + `GenericMatrixProvider` + `BadgerClawProvider` + `resolveCredentialSource()`. One responsibility: turn provider config → a Matrix `Credentials`.
- Modify `src/index.ts` — route `run()`/`connect()` through the resolved credential source instead of the hardcoded BadgerClaw path.
- Create `test/credential-source.test.ts` — vitest unit tests (pure logic; network stubbed).

**Phases 1–5 — the plugin (Tier-P-dependent), under `examples/plugins/mobile-access/`** (dev location; final bundled/trusted-install path is Tier-P open-Q2):
- Create `manifest.json` — permissions, `contributes.lists/forms/status/sidecars`.
- Create `main.js` — the worker orchestration (provider rows, form/action handlers, sidecar + secret + bridge + status calls).
- Modify `sidecars/matrix-adapter/src/bridge.ts` — replace `discoverBridgeUrl` scan with the host-supplied bridge handle over stdio RPC.
- Modify `sidecars/matrix-adapter/src/index.ts` — read credentials via injected secret source (stdio `secrets.get`) instead of `loadCredentials()` disk read.

---

## Phase 0 — Credential seam (NO Tier-P dependency — build now)

### Task 0.1: Define the `MatrixCredentialSource` interface

**Files:**
- Create: `sidecars/matrix-adapter/src/credential-source.ts`
- Test: `sidecars/matrix-adapter/test/credential-source.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/credential-source.test.ts
import { describe, it, expect } from "vitest";
import { validateMatrixSession } from "../src/credential-source.js";

describe("validateMatrixSession", () => {
  it("accepts a complete session", () => {
    expect(() =>
      validateMatrixSession({
        homeserver: "https://matrix.org",
        userId: "@me:matrix.org",
        accessToken: "syt_abc",
        deviceId: "DEV1",
      }),
    ).not.toThrow();
  });
  it("rejects a non-https homeserver", () => {
    expect(() =>
      validateMatrixSession({ homeserver: "matrix.org", userId: "@me:matrix.org", accessToken: "t", deviceId: null }),
    ).toThrow(/homeserver must be an https/i);
  });
  it("rejects a userId without a leading @", () => {
    expect(() =>
      validateMatrixSession({ homeserver: "https://matrix.org", userId: "me:matrix.org", accessToken: "t", deviceId: null }),
    ).toThrow(/user id/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecars/matrix-adapter && pnpm vitest run test/credential-source.test.ts`
Expected: FAIL — `validateMatrixSession` is not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/credential-source.ts
import type { Credentials } from "./config.js";

/** A Matrix session, provider-agnostic. Superset-compatible with `Credentials`. */
export interface MatrixSession {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string | null;
  botName?: string | null;
  botId?: string | null;
}

export function validateMatrixSession(s: MatrixSession): void {
  if (!/^https:\/\//i.test(s.homeserver)) throw new Error("homeserver must be an https URL");
  if (!s.userId.startsWith("@")) throw new Error("user id must look like @name:server");
  if (!s.accessToken) throw new Error("access token is required");
}

/** Anything that can produce a Matrix session for the relay. `acquire` may hit the
 *  network (BadgerClaw) or just validate injected input (generic). */
export interface MatrixCredentialSource {
  readonly provider: "badgerclaw" | "matrix";
  acquire(): Promise<Credentials>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecars/matrix-adapter && pnpm vitest run test/credential-source.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecars/matrix-adapter/src/credential-source.ts sidecars/matrix-adapter/test/credential-source.test.ts
git commit -m "feat(matrix-adapter): MatrixCredentialSource interface + session validation"
```

### Task 0.2: `GenericMatrixProvider` (access-token paste — O2 default)

**Files:**
- Modify: `sidecars/matrix-adapter/src/credential-source.ts`
- Test: `sidecars/matrix-adapter/test/credential-source.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { GenericMatrixProvider } from "../src/credential-source.js";

describe("GenericMatrixProvider", () => {
  it("returns Credentials from validated input", async () => {
    const p = new GenericMatrixProvider({
      homeserver: "https://matrix.org",
      userId: "@me:matrix.org",
      accessToken: "syt_abc",
      deviceId: "DEV1",
    });
    expect(p.provider).toBe("matrix");
    const creds = await p.acquire();
    expect(creds).toMatchObject({ homeserver: "https://matrix.org", userId: "@me:matrix.org", accessToken: "syt_abc", deviceId: "DEV1", botId: null });
  });
  it("throws on invalid input before returning", async () => {
    const p = new GenericMatrixProvider({ homeserver: "http://x", userId: "@a:b", accessToken: "t", deviceId: null });
    await expect(p.acquire()).rejects.toThrow(/https/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd sidecars/matrix-adapter && pnpm vitest run test/credential-source.test.ts`
Expected: FAIL — `GenericMatrixProvider` not exported.

- [ ] **Step 3: Implement**

```ts
// append to src/credential-source.ts
export class GenericMatrixProvider implements MatrixCredentialSource {
  readonly provider = "matrix" as const;
  constructor(private readonly input: MatrixSession) {}
  async acquire(): Promise<Credentials> {
    validateMatrixSession(this.input);
    return {
      homeserver: this.input.homeserver,
      userId: this.input.userId,
      accessToken: this.input.accessToken,
      deviceId: this.input.deviceId,
      botName: this.input.botName ?? null,
      botId: this.input.botId ?? null,
    };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd sidecars/matrix-adapter && pnpm vitest run test/credential-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecars/matrix-adapter/src/credential-source.ts sidecars/matrix-adapter/test/credential-source.test.ts
git commit -m "feat(matrix-adapter): GenericMatrixProvider (access-token login)"
```

### Task 0.3: `BadgerClawProvider` — wrap the existing flow behind the seam

**Files:**
- Modify: `sidecars/matrix-adapter/src/credential-source.ts`
- Test: `sidecars/matrix-adapter/test/credential-source.test.ts`

- [ ] **Step 1: Write the failing test** (inject the BadgerClaw fetchers so no network runs)

```ts
import { BadgerClawProvider } from "../src/credential-source.js";
import type { Credentials } from "../src/config.js";

describe("BadgerClawProvider", () => {
  it("delegates to the injected refresh fn and tags provider", async () => {
    const fake: Credentials = { homeserver: "https://badger.signout.io", userId: "@bot:badger.signout.io", accessToken: "t", deviceId: "D", botName: "b", botId: "id" };
    const p = new BadgerClawProvider(async () => fake);
    expect(p.provider).toBe("badgerclaw");
    expect(await p.acquire()).toBe(fake);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd sidecars/matrix-adapter && pnpm vitest run test/credential-source.test.ts`
Expected: FAIL — `BadgerClawProvider` not exported.

- [ ] **Step 3: Implement** (thin adapter; the real network fns from `badgerclaw.ts` are injected by the caller so this stays unit-testable)

```ts
// append to src/credential-source.ts
export class BadgerClawProvider implements MatrixCredentialSource {
  readonly provider = "badgerclaw" as const;
  /** `mint` is `() => refreshMatrixToken(account, bot, deviceId)` or the redeem flow,
   *  bound by the caller in index.ts — keeps network out of this unit. */
  constructor(private readonly mint: () => Promise<Credentials>) {}
  acquire(): Promise<Credentials> {
    return this.mint();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd sidecars/matrix-adapter && pnpm vitest run test/credential-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecars/matrix-adapter/src/credential-source.ts sidecars/matrix-adapter/test/credential-source.test.ts
git commit -m "feat(matrix-adapter): BadgerClawProvider behind the credential seam"
```

### Task 0.4: Route `index.ts run()` through a resolved credential source

**Files:**
- Modify: `sidecars/matrix-adapter/src/index.ts:210-227` (the `run()` fn)
- Modify: `sidecars/matrix-adapter/src/config.ts` (add `provider` to persisted `Credentials` so `run` knows which source to rebuild — default `"badgerclaw"` for back-compat)

- [ ] **Step 1: Add a `provider` tag to `Credentials`**

In `config.ts`, extend the interface (default undefined ⇒ treat as badgerclaw):

```ts
export interface Credentials {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string | null;
  botName: string | null;
  botId: string | null;
  provider?: "badgerclaw" | "matrix"; // NEW — which source produced this session
}
```

- [ ] **Step 2: In `index.ts run()`, build the source from the persisted creds** (generic just re-validates the stored session; badgerclaw stays the refresh path). Replace the body of `run()` after `loadCredentials()`:

```ts
const source: MatrixCredentialSource =
  creds.provider === "matrix"
    ? new GenericMatrixProvider(creds)
    : new BadgerClawProvider(async () => creds); // stored bot session; refresh handled in connect()
const session = await source.acquire();
const client = await createMatrixClient(session);
```

(Add `import { GenericMatrixProvider, BadgerClawProvider, type MatrixCredentialSource } from "./credential-source.js";`)

- [ ] **Step 3: Add a `matrix-login` CLI command** so a generic Matrix session can be saved without BadgerClaw.

**Defect correction (found in the Phase-0 final review):** the owner allowlist must hold a **human** mxid distinct from the relay's own account. `run()` builds `new Relay(client, creds.userId)` and `relay.ts onMessage` drops the relay's *own* messages AND any non-allowlisted sender — so allowlisting the bot's `--user` yields an **uncommandable relay** on a fresh generic login. Add an `--owner` flag (mirroring `connect`/`pair`), allowlist that, warn on self-owner, via a pure tested helper:

```ts
// in credential-source.ts (unit-tested):
export function resolveMatrixLoginOwner(
  userId: string,
  ownerArg: string | null,
): { owner: string; selfOwner: boolean } {
  const owner = ownerArg ?? userId;
  return { owner, selfOwner: owner === userId };
}
```

```ts
async function matrixLogin(args: string[]): Promise<void> {
  const homeserver = argValue(args, "--homeserver");
  const userId = argValue(args, "--user");
  const accessToken = argValue(args, "--token");
  if (!homeserver || !userId || !accessToken) {
    console.error("usage: conduit-matrix matrix-login --homeserver <https-url> --user <@bot:server> --token <access-token> [--owner <@you:server>]");
    process.exit(1);
  }
  const { owner, selfOwner } = resolveMatrixLoginOwner(userId, argValue(args, "--owner"));
  if (!owner.startsWith("@")) {
    console.error(`--owner must be a Matrix id like @you:server (got ${owner})`);
    process.exit(1);
  }
  const creds = await new GenericMatrixProvider({ homeserver, userId, accessToken, deviceId: null }).acquire();
  saveCredentials({ ...creds, provider: "matrix" });
  const settings = loadSettings();
  if (!settings.owners.includes(owner)) settings.owners.push(owner);
  saveSettings(settings);
  if (selfOwner) {
    console.warn(`warning: owner ${owner} is the relay's own account — it will not be commandable. Re-run with --owner <your personal @mxid>.`);
  }
  console.log(`saved generic Matrix session for ${userId}; owner allowlist: ${settings.owners.join(", ")}; run: conduit-matrix run`);
}
```

Wire it into the `cmd` dispatch (`cmd === "matrix-login" ? matrixLogin(rest) : …`).

- [ ] **Step 4: Verify** — typecheck + tests + a dry `matrix-login` with a throwaway token

Run: `cd sidecars/matrix-adapter && pnpm exec tsc --noEmit && pnpm vitest run`
Expected: typecheck clean, all vitest green.

- [ ] **Step 5: Commit**

```bash
git add sidecars/matrix-adapter/src/index.ts sidecars/matrix-adapter/src/config.ts
git commit -m "feat(matrix-adapter): resolve credential source at run; add matrix-login command"
```

**Phase 0 done ⇒ the sidecar drives BadgerClaw or a generic homeserver interchangeably, no plugin host needed.** This is the credential seam the Tier-P spec §11 references.

---

## Phase 1 — Mobile Access plugin scaffold

**DEPENDS ON:** Tier-P host capabilities `ui:contribute`, `storage`; the declarative renderer + `contributes.lists`/`forms` (Tier-P spec §3, §8). Do not start until built.

**Files:** Create `examples/plugins/mobile-access/manifest.json`, `examples/plugins/mobile-access/main.js`.

- [ ] **Step 1** — write `manifest.json` per Tier-P §11:

```json
{
  "id": "mobile-access",
  "name": "Mobile Access",
  "version": "0.1.0",
  "minAppVersion": "0.14.0",
  "trusted": true,
  "permissions": ["ui:contribute", "status", "storage", "secrets", "sidecar", "bridge"],
  "contributes": {
    "lists": { "mobile-access.providers": { "title": "Mobile Access", "addLabel": "Add mobile connection" } },
    "forms": {
      "matrix-config": { "title": "Matrix connection", "widgets": [
        { "id": "homeserver", "type": "text",   "label": "Homeserver", "placeholder": "https://matrix.org" },
        { "id": "userId",     "type": "text",   "label": "User ID",   "placeholder": "@you:matrix.org" },
        { "id": "token",      "type": "secret", "label": "Access token" },
        { "id": "save",       "type": "button", "label": "Connect", "submit": true }
      ] },
      "direct-pair": { "title": "Pair a device", "widgets": [
        { "id": "qr",    "type": "qr",   "label": "Scan in the app" },
        { "id": "regen", "type": "button", "label": "Regenerate" }
      ] }
    },
    "status": { "pill": { "id": "mobile-access.pill", "label": "Mobile" } },
    "sidecars": [
      { "id": "matrix",      "runtime": "node",   "entry": "sidecars/matrix-adapter/dist/index.js", "autostart": false, "cwd": "sidecars/matrix-adapter", "net": ["*.matrix.org", "{homeserver}", "badger.signout.io"] },
      { "id": "cloudflared", "runtime": "binary", "cmd": "cloudflared", "args": ["tunnel", "--url", "ws://127.0.0.1:8455"], "autostart": false }
    ]
  }
}
```

- [ ] **Step 2** — `main.js`: on load, read stored connections from `storage` and register a provider row per connection + the three "add" provider cards. Uses the increment-#1 worker `host.request` bridge.

```js
// examples/plugins/mobile-access/main.js
const LIST = "mobile-access.providers";
export async function onload(host) {
  const conns = (await host.request("storage.get", { key: "connections" })) ?? [];
  for (const c of conns) await addRow(host, c);
  host.on("list.action", (e) => e.listId === LIST && handleAction(host, e));
  host.on("form.submit", (e) => handleForm(host, e));
}
async function addRow(host, c) {
  await host.request("ui.list.upsertRow", { listId: LIST, row: {
    id: c.id, label: c.label, description: providerLabel(c.provider), icon: c.provider,
    statusDotBinding: `${c.id}.status`,
    actions: [
      { id: "pause", label: "Pause", icon: "pause" },
      { id: "repair", label: "Re-pair", icon: "refresh" },
      { id: "edit", label: "Edit", opensForm: "matrix-config" },
      { id: "disconnect", label: "Disconnect", style: "danger", confirm: true },
    ],
  } });
}
function providerLabel(p) { return p === "badgerclaw" ? "BadgerClaw" : p === "matrix" ? "Generic Matrix" : "Direct"; }
```

- [ ] **Step 3** — load it in the dev app and confirm the empty list + "Add mobile connection" render.

Run: `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`, install the plugin, open Settings → Mobile Access.
Expected: the additive list renders with the add affordance; no rows yet.

- [ ] **Step 4: Commit**

```bash
git add examples/plugins/mobile-access/
git commit -m "feat(mobile-access): plugin scaffold — provider list + forms manifest"
```

---

## Phase 2 — Matrix connect flow (Matrix + BadgerClaw rows)

**DEPENDS ON:** `secrets`, `sidecar` (lazy start/stop), `status`, `bridge` (Tier-P §6, §7, §9).

- [ ] **Step 1** — handle `form.submit` for `matrix-config`: store the token via `secrets.set`, persist a non-secret `MobileConnection` via `storage.set`, add the row, and lazily start the Matrix sidecar if this is the first Matrix/BadgerClaw connection.

```js
async function handleForm(host, e) {
  if (e.formId !== "matrix-config") return;
  const id = `conn-${e.values.userId}`;
  await host.request("secrets.set", { key: `${id}.token`, value: e.values.token });
  const conn = { id, provider: "matrix", label: `${e.values.homeserver} — ${e.values.userId}`, homeserver: e.values.homeserver, userId: e.values.userId };
  const conns = (await host.request("storage.get", { key: "connections" })) ?? [];
  conns.push(conn); await host.request("storage.set", { key: "connections", value: conns });
  await addRow(host, conn);
  if (conns.filter((c) => c.provider !== "direct").length === 1) await host.request("sidecar.start", { id: "matrix" });
  await host.request("status.set", { key: `${id}.status`, value: { level: "ok", tooltip: "connected" } });
}
```

- [ ] **Step 2** — handle `list.action` `disconnect`: delete the secret, drop the connection, stop the Matrix sidecar when the last Matrix/BadgerClaw connection is removed (honors the light-app zero-Node-at-zero-connections rule).

```js
async function handleAction(host, e) {
  if (e.actionId !== "disconnect") return; // pause/repair/edit handled separately
  await host.request("secrets.delete", { key: `${e.rowId}.token` });
  let conns = (await host.request("storage.get", { key: "connections" })) ?? [];
  conns = conns.filter((c) => c.id !== e.rowId);
  await host.request("storage.set", { key: "connections", value: conns });
  await host.request("ui.list.removeRow", { listId: LIST, rowId: e.rowId });
  if (conns.filter((c) => c.provider !== "direct").length === 0) await host.request("sidecar.stop", { id: "matrix" });
}
```

- [ ] **Step 3** — Verify end-to-end in the dev app: add a matrix.org connection with a real access token → Matrix sidecar starts → the row dot goes green → a session list reaches Element. Remove it → sidecar stops. **Never claim it works from typecheck alone (repo rule).**

- [ ] **Step 4: Commit**

```bash
git add examples/plugins/mobile-access/main.js
git commit -m "feat(mobile-access): Matrix/BadgerClaw connect + lazy sidecar lifecycle"
```

---

## Phase 3 — Sidecar ↔ host stdio RPC (drop disk creds + port scan)

**DEPENDS ON:** Tier-P sidecar supervisor + stdio JSON-RPC (spec §6.3) and the bridge handle (§9).

- [ ] **Step 1** — In `sidecars/matrix-adapter/src/bridge.ts`, delete `discoverBridgeUrl` (the 8455–8475 scan) and take the bridge URL+auth handed in over the stdio RPC `bridge.handle` call. **Test:** a unit test that the client uses the injected handle and never scans.
- [ ] **Step 2** — In `index.ts`, fetch the Matrix access token via stdio `secrets.get` (`${connId}.token`) instead of `loadCredentials()` reading `credentials.json`; keep the crypto store on disk (E2EE identity must persist — `matrix.ts` note). **Test:** the credential source is constructed from the injected secret, not the disk file.
- [ ] **Step 3** — Verify the relay still drives sessions with tokens supplied only via RPC (nothing sensitive in the sidecar `env` or `credentials.json`).
- [ ] **Step 4: Commit** — `refactor(matrix-adapter): bridge handle + secrets via host stdio RPC`.

---

## Phase 4 — Direct provider (Level 2)

**DEPENDS ON:** core X25519 pairing in `bridge.rs` (`bridge.pairing.begin/completed`, Tier-P §9/§10) — the single biggest core item; and the `cloudflared` binary sidecar.

- [ ] **Step 1** — add a "Direct" provider card; on add, call `bridge.pairing.begin()` (core X25519) → receive the plugin-side credential → open the `direct-pair` form with the `qr` widget (`payload` = pairing URL+credential, `expiresAt` = now+5min).
- [ ] **Step 2** — optionally `sidecar.start("cloudflared")` for remote egress; show the public URL in the QR payload when the tunnel is up.
- [ ] **Step 3** — subscribe to `bridge.pairing.completed`; on the event, `ui.update("direct-pair", "qr", { state: "paired" })` and persist the Direct `MobileConnection`.
- [ ] **Step 4** — `regenerate` action re-runs `bridge.pairing.begin()` and refreshes `payload`+`expiresAt`.
- [ ] **Step 5** — Verify in the dev app: QR renders with a live countdown, a paired device flips it to "paired ✓", tunnel egress reachable. Commit — `feat(mobile-access): Direct provider — X25519 QR pairing + cloudflared`.

---

## Phase 5 — Trusted-install marking, version bump, changelog

**DEPENDS ON:** Tier-P open-Q2 (how a first-party plugin is marked trusted).

- [ ] **Step 1** — mark `mobile-access` trusted/bundled per the mechanism Tier-P lands; confirm a non-trusted copy is **denied** `sidecar`/`bridge` grants (spec §2, §13).
- [ ] **Step 2** — bump version in the three lockstep files (`package.json`, `src-tauri/Cargo.toml` line 3, `src-tauri/tauri.conf.json`) — one **MINOR** (O4). Run `cargo build --manifest-path src-tauri/Cargo.toml` so `Cargo.lock` updates.
- [ ] **Step 3** — add a matching `CHANGELOG.md` entry (`## X.Y.0 — YYYY-MM-DD`, `Added — Mobile access …`), no contributor names.
- [ ] **Step 4** — pre-PR checks: `pnpm exec tsc --noEmit`, `pnpm build`, `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo clippy`, and launch the app. Commit.

---

## Self-Review

**Spec coverage vs `2026-07-15-mobile-multi-provider-access-design.md`:**
- Credential seam (§Design 1) → Phase 0. ✅
- Additive-list panel + row actions (§Design 4, UX) → Phase 1. ✅
- BadgerClaw + generic Matrix providers (§Design 2) → Phase 0 + Phase 2. ✅
- Secrets off `state.json` (§Design 3, §5) → Phase 2 (`secrets.set`), Phase 3 (token via RPC). ✅
- Lazy sidecars / light-app (§Design 6) → Phase 2 start/stop. ✅
- Direct + QR/X25519 (§Design 3, Level 2) → Phase 4. ✅
- Silo gate respected → enforced core-side by the Tier-P bridge shim (spec §9); no plugin task can widen it. ✅
- Version/changelog (O4) → Phase 5. ✅

**Placeholder scan:** Phase 0 steps carry complete code + exact commands. Phases 1–5 carry concrete plugin/manifest code and reference **only** Tier-P host methods defined in the Tier-P spec (`ui.*`, `list.action`, `form.submit`, `sidecar.start/stop`, `secrets.*`, `status.set`, `bridge.pairing.*`); those are the declared external dependency, gated per phase.

**Type consistency:** `MatrixSession`/`Credentials` shapes match `config.ts`; `provider` tag added once (Task 0.4) and reused; `MobileConnection` fields (`id/provider/label/homeserver/userId`) consistent across Phases 1–4.

**Known gap (intentional):** Phases 1–5 cannot produce "expected output" until the Tier-P host is implemented — that is the declared dependency, not a plan defect. Phase 0 is fully executable today.

---

## Execution Handoff

Only **Phase 0** is executable now; Phases 1–5 are blocked on the Tier-P host implementation (see the dependency section). Recommend: execute Phase 0 now, and commission the separate Tier-P host plan before Phases 1–5.
