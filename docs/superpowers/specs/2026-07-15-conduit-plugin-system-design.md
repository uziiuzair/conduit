# Conduit Plugin System — Increment #1 Design

**Status:** Design / approved for planning
**Date:** 2026-07-15
**Scope:** Substrate (loader + manifest + permissions + sandbox) plus two capabilities — **commands** and **hooks**.
**Branch:** `feat/plugins`

---

## 1. Motivation

Make Conduit extensible and customizable the way Obsidian is: a community of third-party
authors ships plugins that users install to add behavior to the app. The north-star vision
is that *everything* is extendable. This document designs only the first increment.

The full platform spans four extension surfaces plus theming:

| Surface | What it lets a plugin do | Increment |
| --- | --- | --- |
| **Commands** | Register named commands (palette + hotkeys) | **#1 (this doc)** |
| **Hooks / automation** | React to app/agent events and run logic | **#1 (this doc)** |
| **UI panels / views** | Add custom tabs/panels | future |
| **Agent providers** | Add a new AI-CLI adapter | future |
| **Themes** | Restyle the app | future |

Each future surface gets its own spec → plan → implementation cycle. This spec builds the
**substrate** all of them ride on, and proves it with the two surfaces that require **no
untrusted UI rendering** — the smallest slice that de-risks the hard security core first.

---

## 2. Decisions locked during brainstorming

1. **Trust model — community marketplace.** Plugins are untrusted third-party code. This
   drives a real permission/sandbox story (unlike a notes app, Conduit spawns processes,
   runs `claude` with the user's credentials, and can read a Keychain OAuth token, so the
   blast radius of a malicious plugin is severe).
2. **Execution — sandboxed + capability manifest.** A plugin declares every capability it
   needs; nothing is ambient; the host enforces grants.
3. **Runtime — Web Worker + permission-gated RPC bridge.** Chosen over a QuickJS/WASM VM
   (heavier, worse author DX) and over full-access renderer JS (unsafe on a high-privilege
   app). The runtime sits behind a thin `SandboxHost` interface so a QuickJS backend can be
   swapped in later without touching the bridge or permission layer.
4. **Install-time informed consent (zero-trust).** On install the user sees each requested
   permission in plain language *and* a "what this lets the plugin do to your Conduit" risk
   line. A plugin update that adds a permission requires re-consent. Grants are viewable and
   revocable per plugin.
5. **Increment #1 install path — folder drop.** Plugins install by placing a folder in the
   plugins directory (Obsidian manual-install style). The hosted marketplace
   (browse/publish/install-from-registry/signing) is a deliberately deferred later increment;
   the manifest and permission model are designed to support it.

---

## 3. Scope

### In scope (increment #1)
- Plugin **package format** (folder + `manifest.json` + `main.js`).
- **Discovery + loading** from the plugins directory.
- **Manifest parsing + validation** (Rust, pure, unit-tested).
- **Web Worker sandbox** — one worker per enabled plugin.
- **Permission-gated RPC bridge** (`host.request`) — the single chokepoint.
- **Permission taxonomy** for the two capabilities plus a couple of low-risk utilities.
- **Install consent dialog** + re-consent on escalation + revoke.
- **Commands capability** — command registry, a command palette, hotkey binding.
- **Hooks capability** — deliver a filtered subset of app/agent events to plugins.
- **Security hardening** — CSP lockdown, gated network, credential isolation, worker
  watchdog, global kill switch.
- **Persistence** — enabled state + granted permissions + per-plugin settings storage.
- A bundled **example plugin** for manual smoke testing.

### Out of scope (future increments, listed so the substrate anticipates them)
- Hosted marketplace: registry, publishing, install-from-registry, signature verification.
- UI panels / custom views (iframe runtime + a frontend component registry that replaces the
  hardcoded `App.tsx` tree and `Settings.tsx` NAV array).
- Agent-provider plugins (a *declarative adapter manifest* over the `ProviderAdapter` seam —
  not sandboxed JS, because adapters spawn processes with the user's credentials).
- Themes (inject a `Theme` into `THEMES` and open the closed `ThemeId` union; target the
  `:root` CSS-var contract in `theme.css`).
- QuickJS/WASM hardening swap behind `SandboxHost`.

---

## 4. Package format

One folder per plugin under the plugins directory:

```
<data_dir>/plugins/<plugin-id>/
  manifest.json     # metadata + declared capabilities + permissions
  main.js           # single ES-module bundle (the plugin author's code)
  data.json         # (created at runtime) the plugin's own persisted settings
```

**Plugins directory:** `<data_dir>/plugins/`, where `data_dir()` honors
`CONDUIT_DATA_DIR_NAME` (`src-tauri/src/store.rs`). This keeps the dev build
(`ConduitTauri-dev`) and the installed app's plugin sets isolated, exactly like `state.json`.

`main.js` must be a **single self-contained ES module** (the author bundles their deps). The
host does not run a package manager or resolve imports for plugins.

---

## 5. Manifest schema

```jsonc
{
  "id": "com.author.word-count",     // reverse-DNS, [a-z0-9.-], unique, == folder name
  "name": "Word Count",              // display name
  "version": "1.0.0",                // semver
  "author": "Jane Dev",
  "description": "Counts words in the active session transcript.",
  "minAppVersion": "0.14.0",         // refuse to load on older Conduit
  "main": "main.js",                 // entry file, relative to folder
  "permissions": [                   // every capability the plugin will use
    "commands",
    "hooks:session"
  ],
  "contributes": {                   // declarative registrations (host reads without running code)
    "commands": [
      { "id": "word-count.recount", "title": "Word Count: Recount", "hotkey": "Cmd+Shift+W" }
    ],
    "hooks": ["session.start", "session.stop"]
  }
}
```

### Validation rules (enforced in Rust, before a worker ever spawns)
- `id` matches `^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$` and equals the folder name.
- `version` and `minAppVersion` are valid semver; `minAppVersion` ≤ current app version, else
  the plugin is listed as **incompatible** and cannot be enabled.
- `main` resolves inside the plugin folder (no `..`/absolute escape).
- Every entry in `permissions` is a known permission id (unknown ⇒ reject with a clear error).
- Every `contributes.commands[].id` is namespaced under the plugin id's leaf (recommended,
  warned if not) and unique within the manifest.
- Every `contributes.hooks[]` event is a known event id whose required permission is present
  in `permissions` (declaring a hook you lack permission for ⇒ reject).
- A capability used at runtime that wasn't declared in `contributes`/`permissions` is denied.

Manifest parsing/validation is a **pure function** returning `Result<PluginManifest, Vec<ManifestError>>`
so it can be unit-tested exhaustively.

---

## 6. Architecture

### 6.1 Components

**Backend (Rust) — new module `src-tauri/src/plugins.rs`:**
- `list_plugins()` — scan the plugins dir, parse + validate each manifest, return a
  `Vec<PluginDescriptor>` (manifest + on-disk path + validation status + compatibility).
- `read_plugin_source(id)` — return the `main.js` text to the host (host creates the worker).
- `set_plugin_enabled(id, bool)`, `set_plugin_grants(id, perms, version)` — persist state.
- `plugin_storage_read(id)` / `plugin_storage_write(id, json)` — per-plugin `data.json`,
  path-scoped so a plugin can never read another's storage.
- `remove_plugin(id)`, `open_plugins_dir()`.
- Registered in the `generate_handler!` list in `lib.rs`.

**Backend persistence — `src-tauri/src/store.rs`:**
- Extend `PersistState` with `plugins: Vec<PluginRecord>` where
  `PluginRecord { id, enabled, granted_permissions, consented_version }`.

**Frontend — new `src/plugins/` module:**
- `host.ts` — `PluginHost`: owns the lifecycle, the RPC **dispatcher** (the permission gate),
  and the `SandboxHost` it drives. The dispatcher is the durable heart of the whole system.
- `sandbox.ts` — `SandboxHost` interface + `WorkerSandbox` implementation (spawn/terminate,
  postMessage plumbing, watchdog ping). QuickJS would be a second implementation here.
- `worker-runtime.ts` — the bootstrap that runs *inside* each worker: receives `main.js`,
  constructs the `conduit` SDK object bound to this worker's message port, calls the plugin's
  `onload`/`onunload`.
- `sdk.ts` — the `conduit` object plugin authors program against (`conduit.commands.register`,
  `conduit.hooks.on`, `conduit.storage`, `conduit.net.fetch`, `conduit.notify`, …). Thin
  wrapper over `postMessage` so authors never touch raw messaging.
- `commands.ts` — the frontend **command registry** (new; none exists today) and hotkey map.
- `permissions.ts` — the permission taxonomy: id → `{ label, description, riskLine, methods }`.
- `events.ts` — the mapping from `HookBus`/frontend events to plugin-facing event ids +
  payload sanitizers.

**Frontend — UI:**
- `src/components/PluginsPanel.tsx` — a new **Plugins** tab in Settings (add to the `NAV`
  array + `SettingsTab` union + the panel switch in `Settings.tsx`). Lists installed plugins,
  enable/disable toggle, per-plugin permission view + revoke, error state, "Open plugins
  folder", global "Disable all plugins" kill switch.
- `src/components/PluginConsentDialog.tsx` — the install/enable consent screen and the
  escalation re-consent screen.
- `src/components/CommandPalette.tsx` — a `Cmd+Shift+P` command palette listing registered
  commands (built alongside, distinct from the existing file-oriented `QuickOpen`/`SearchPalette`).

**Store — `src/store.ts`:** add a `plugins` slice (discovered descriptors + runtime status)
and actions `enablePlugin`, `disablePlugin`, `grantPermissions`, `revokePermission`,
`refreshPlugins`, `setAllPluginsEnabled`.

### 6.2 The bridge (the security core)

```
 Worker (untrusted plugin)                 Host main thread
 ─────────────────────────                 ───────────────────────────────
 conduit.commands.register(id, cb)
 conduit.net.fetch(url) ───────────▶  PluginHost.dispatch(pluginId, method, params)
                                         1. grants = record.granted_permissions
                                         2. required = PERMISSION_OF[method]
                                         3. required ∈ grants ?  no ─▶ reject("permission denied")
                                         4. method-specific arg validation / allowlist
                                         5. forward to invoke() / store / HookBus
        ◀────────── result | error ────────────────────────┘

 conduit.hooks.on("session.stop", cb) ◀─ HookBus/frontend event, delivered ONLY if the
                                          plugin holds the event's required permission
```

Key properties:
- A worker has **no** `@tauri-apps/api`, no IPC handle, no `window`. `host.request` is the
  *only* path into the app. This inverts today's default (any renderer code can call all ~85
  Tauri commands) to **deny-all, add-back-by-grant** — the property that makes a marketplace
  safe on a high-privilege app.
- Every bridge method is explicitly enumerated and mapped to a required permission in
  `permissions.ts`. There is no generic "call any command" method.
- Privileged commands (spawn PTY, read Keychain/OAuth token, account config, updater, fleet
  control) are **never** exposed through the bridge in increment #1.

### 6.3 Lifecycle

```
 discover ─▶ (validate manifest) ─▶ installed/disabled
    disabled ──enable──▶ [needs consent? show dialog] ──granted──▶ spawn Worker ─▶ onload ─▶ running
    running  ──disable─▶ onunload ─▶ worker.terminate()  ─▶ disabled
    running  ──crash/timeout─▶ worker.terminate() ─▶ errored (toast + per-plugin log)
    any ──remove──▶ onunload + terminate + delete folder + drop record
```

- **Enable** = (consent if the granted set doesn't already cover the manifest's declared
  permissions for the consented version) → spawn worker → deliver source → call `onload`.
- **Disable** = call `onunload` (best-effort, time-boxed) → `worker.terminate()` (hard kill).
- **Crash containment:** any throw/reject in a worker is caught at the bridge, surfaced as a
  toast + written to a per-plugin log, and the plugin is marked errored — the app never
  crashes. A watchdog pings each worker; a worker that fails to answer within a timeout is
  terminated and marked errored.

---

## 7. Permission model

### 7.1 Taxonomy (increment #1)

Minimal by design; more permissions arrive with the surfaces that need them.

| Permission | Bridge methods it unlocks | Plain-language label | Risk line (shown at install) |
| --- | --- | --- | --- |
| `commands` | `commands.register`, `commands.unregister` | Add commands to the palette and bind hotkeys | Can add menu commands and intercept keyboard shortcuts you press. |
| `hooks:session` | receive `session.start`, `session.stop`, `session.rename` | See when sessions start, stop, or are renamed | Can observe which sessions you open and close and their titles. |
| `hooks:fleet` | receive `fleet.spawn`, `fleet.stop` | See fleet/Conductor spawn and stop events | Can observe orchestration activity across your projects. |
| `hooks:lifecycle` | receive sanitized agent-lifecycle hook events | See agent activity signals | Can observe agent run/stop/notification signals (no transcript contents). |
| `notifications` | `notify(title, body)` | Show desktop notifications | Can pop system notifications (potential nuisance/spoofing). |
| `clipboard:write` | `clipboard.write(text)` | Write to the clipboard | Can replace your clipboard contents. |
| `net` | `net.fetch(url, init)` | Make network requests to declared hosts | Can send data to the internet — **only to hosts listed in the manifest** (see 8.2). |

Reserved (declared now, unlockable only in later increments): `fs:read`, `fs:write`,
`sessions:read`, `sessions:write`, `ui:panel`, `agent:provider`, `theme`. Requesting a
reserved permission in increment #1 lists the plugin as needing a newer capability set and
blocks enable with a clear message.

### 7.2 Enforcement
Deny-by-default. The dispatcher (6.2) checks the method's required permission against the
plugin's `granted_permissions` on **every** call. Event delivery is filtered the same way.

### 7.3 Consent (zero-trust)
- On first enable (or when a plugin's declared permissions exceed the consented set), show
  `PluginConsentDialog`: plugin identity, version, and a row per requested permission with its
  **label** and **risk line** from the table above. `net` additionally lists the exact hosts
  from the manifest. The user grants (all-or-nothing for enable) or cancels.
- Grants persist as `PluginRecord.granted_permissions` + `consented_version`.
- **Escalation:** if an updated `main.js`/manifest declares a permission not in the consented
  set, the plugin will not run until the user re-consents to the new, diffed permission list
  (added permissions highlighted).
- **Revoke:** the Plugins panel shows granted permissions per plugin; revoking any disables
  the plugin (it must be re-consented to run again).

---

## 8. Security hardening

### 8.1 CSP lockdown
`tauri.conf.json` currently sets `app.security.csp: null`. Increment #1 sets a restrictive
CSP whose `connect-src` allows only the Tauri IPC origin and the app's own internal
localhost servers — so a worker's **ambient** `fetch`/`WebSocket` cannot reach the internet.
All plugin network access is forced through the gated bridge (8.2). (This CSP change is
verified against the existing app — xterm, Monaco, updater, and the internal HTTP servers —
before merge.)

### 8.2 Gated network (`net` permission)
`net.fetch` is the only network path. The manifest must declare an allowlist of hosts under
the `net` permission (e.g. `"permissions": [{ "net": ["api.example.com"] }]`); the dispatcher
rejects requests to any other host. The consent dialog shows the allowlist. This turns "can
exfiltrate anything" into "can talk to the specific hosts you approved."

### 8.3 Credential isolation
The bridge exposes **no** method that returns or uses the Keychain OAuth token, account
config, provider credentials, or that spawns a PTY. These remain reachable only from trusted
first-party code paths, never from a worker.

### 8.4 Resource + failure limits
- Watchdog ping/terminate for unresponsive workers (7/6.3).
- Per-plugin error isolation; a bad plugin never crashes the app.
- **Global kill switch** in the Plugins panel ("Disable all plugins") and a
  `CONDUIT_DISABLE_PLUGINS=1` env escape hatch for recovery.

### 8.5 Supply chain (increment #1 posture)
Folder-drop install means the user vouches for the code, exactly like Obsidian manual
installs. Signature verification and a trusted registry come with the marketplace increment.
The consent screen is the primary user-facing safety control until then.

---

## 9. Data model & persistence

- **Rust (`store.rs`):** `PersistState.plugins: Vec<PluginRecord>`
  (`{ id, enabled, granted_permissions: Vec<String>, consented_version: String }`), serialized
  into the existing single JSON state file. No secrets are stored here.
- **Per-plugin settings:** `plugin_storage_read/write` back a `data.json` inside the plugin's
  own folder, path-scoped by plugin id so isolation holds.
- **Zustand (`store.ts`):** a `plugins` slice holding discovered descriptors + live status
  (`enabled | disabled | errored | incompatible | needs-consent`) and the actions in 6.1.

---

## 10. Backend (Rust) changes — summary

- New `src-tauri/src/plugins.rs` (module declared in `lib.rs`), commands listed in 6.1,
  appended to the `generate_handler!` array.
- `store.rs` `PersistState` gains the `plugins` field + getters/setters.
- Manifest model + `parse_manifest` / `validate_manifest` pure functions with `#[cfg(test)]`
  unit tests (the primary automated test surface for this increment).
- No new outbound HTTP client (respects the "shell out to curl / no reqwest" rule); the
  plugin network path lives in the **frontend** worker bridge, not Rust.

---

## 11. Frontend changes — summary

- New `src/plugins/` module (`host.ts`, `sandbox.ts`, `worker-runtime.ts`, `sdk.ts`,
  `commands.ts`, `permissions.ts`, `events.ts`).
- New components: `PluginsPanel.tsx`, `PluginConsentDialog.tsx`, `CommandPalette.tsx`.
- `Settings.tsx`: add the **Plugins** tab (union + `NAV` + panel switch).
- `App.tsx`: on boot, ask the store to load + start enabled plugins; wire the command palette
  toggle and global hotkey dispatch; subscribe `PluginHost` to the relevant frontend events.
- `store.ts`: the `plugins` slice + actions.
- The SDK (`sdk.ts` + `worker-runtime.ts`) is bundled and injected into each worker so authors
  get a typed `conduit` object; a `@conduit/plugin` type package (`.d.ts`) is published for
  author tooling (types only, later refinement).

---

## 12. Capability detail — Commands

- `commands.ts` holds a registry: `Map<commandId, { pluginId, title, hotkey?, }>`.
- A plugin calls `conduit.commands.register(id, callback)`; the SDK sends `commands.register`
  with `{ id, title, hotkey }` (title/hotkey come from the manifest `contributes`, the
  callback stays in the worker). The host records the entry.
- `CommandPalette.tsx` (`Cmd+Shift+P`) lists all registered commands; selecting one sends
  `command.invoke(id)` to the owning worker, which runs the stored callback.
- Hotkeys: a hotkey map binds declared accelerators; on match the host invokes the command.
  Conflicts with native menu accelerators and with other plugins are detected at register time
  and surfaced (later-registered loses, warned in the panel).

## 13. Capability detail — Hooks

- `events.ts` maps internal sources to plugin-facing events with **sanitized** payloads:
  - `session.start|stop|rename` ← frontend session state / store (`hooks:session`).
  - `fleet.spawn|stop` ← the existing `"fleet-spawn"` channel / fleet state (`hooks:fleet`).
  - `lifecycle.*` ← the Rust `HookBus` (`hookbus.rs`) agent-lifecycle events, stripped of
    transcript/prompt contents (`hooks:lifecycle`).
- `PluginHost` subscribes to these sources once, then fans each event out only to workers
  whose grants include the event's permission. Payloads carry ids/titles/timestamps, never
  secrets or raw transcript text.

---

## 14. Testing strategy

- **Rust (automated):** unit tests for manifest parse + validation (valid, bad id, bad semver,
  path escape, unknown permission, undeclared hook, incompatible `minAppVersion`) and for the
  permission→method map. Run with `cargo test`.
- **Frontend (no runner):** `pnpm exec tsc --noEmit` + `pnpm build`, then **launch the app**
  (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`) and drive a bundled **example
  plugin** (`word-count`) through the full path:
  1. drop → appears in Plugins panel as disabled/needs-consent;
  2. enable → consent dialog shows the two permissions with risk lines;
  3. grant → worker spawns, command appears in the palette, hotkey fires it;
  4. a `session.stop` hook fires and the plugin reacts;
  5. a call to an **undeclared** method is rejected at the bridge;
  6. disable → worker terminates; re-enable with an added permission → re-consent prompt.

## 15. Version bump

A shipped user-facing feature ⇒ **MINOR**. At ship time bump `0.13.0 → 0.14.0` across the
three version files, run `cargo build` to sync `Cargo.lock`, and add a `CHANGELOG.md` entry.
`minAppVersion: "0.14.0"` in examples reflects this. (Bump happens at ship, not during
implementation.)

---

## 16. Open questions (resolve during planning/implementation)

1. **Command palette reuse:** build `CommandPalette` fresh vs. generalize `QuickOpen`. Leaning
   fresh + minimal to avoid entangling file-open logic.
2. **Net allowlist manifest shape:** `permissions: ["net"]` + a separate `netHosts: [...]`
   field, vs. an object form `{ "net": ["host"] }`. Pick one during planning; the consent UI
   depends on it.
3. **SDK delivery:** inline the SDK into the worker bootstrap vs. `importScripts` of a
   host-served blob. Leaning inline (simplest, no extra origin surface).
4. **CSP compatibility:** confirm the locked CSP doesn't break xterm/Monaco/updater/internal
   servers before merge (8.1).
5. **Watchdog thresholds:** ping interval + terminate timeout values.
