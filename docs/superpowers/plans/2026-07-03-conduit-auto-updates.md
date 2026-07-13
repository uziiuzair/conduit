# Conduit Auto-Updates (macOS OTA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Conduit macOS desktop app update itself — background-check GitHub Releases, verify a minisign-signed universal build, and install on the user's consent — with releases produced by CI on a version-tag push.

**Architecture:** Adopt Tauri v2's official updater (`tauri-plugin-updater`) pulling a stable `latest.json` from GitHub Releases; verify with a minisign key; download + install via the JS updater API and relaunch via `tauri-plugin-process`. The frontend mirrors the existing ambient pattern (`useClaudeAmbient` → store slice → notice component). A tiny tested Rust `updates.rs` owns the "should I re-notify for this version" semver decision. CI (`tauri-action`) builds a signed + notarized universal artifact and generates the manifest.

**Tech Stack:** Tauri v2, Rust, `tauri-plugin-updater` / `tauri-plugin-process`, React 19 + TypeScript + Zustand, `@tauri-apps/plugin-updater` / `@tauri-apps/plugin-process`, GitHub Actions + `tauri-apps/tauri-action`.

**Spec:** `docs/superpowers/specs/2026-07-03-conduit-auto-updates-design.md`

---

## Testing convention (read first)

Per `CLAUDE.md`, this repo has **Rust unit tests but no frontend test runner**. So:

- **Rust tasks** follow strict TDD: write a failing `#[cfg(test)]` test, run `cargo test` to see it fail, implement, run to see it pass, commit.
- **Frontend tasks** are verified with `pnpm exec tsc --noEmit`, `pnpm build`, and **launching the app** under the dev data-dir isolation:

  ```bash
  CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
  ```

  Never claim a UI change works from a typecheck alone.

All work happens on branch `feat/auto-updates` (already created). Commit after every task.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src-tauri/src/updates.rs` (create) | Pure `is_newer` semver compare + `update_should_notify` command. Unit-tested. |
| `src-tauri/src/lib.rs` (modify) | Register updater + process plugins; register `updates` module + command. |
| `src-tauri/Cargo.toml` (modify) | Add `tauri-plugin-updater`, `tauri-plugin-process`. |
| `src-tauri/tauri.conf.json` (modify) | `bundle.createUpdaterArtifacts` + `plugins.updater` (endpoint + pubkey). |
| `src-tauri/capabilities/default.json` (modify) | Add `updater:default`, `process:default`. |
| `package.json` (modify) | Add `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`. |
| `src/store.ts` (modify) | `updater` slice: state + `checkForUpdates` / `installUpdate` / `dismissUpdate`. |
| `src/hooks/useUpdater.ts` (create) | Background cadence (launch delay + interval + visibility). |
| `src/components/UpdateNotice.tsx` (create) | Non-blocking banner: Install & Relaunch / Later / View notes + progress. |
| `src/components/AboutPanel.tsx` (modify) | Manual "Check for updates" row + status text. |
| `src/App.tsx` (modify) | Mount `useUpdater()` + `<UpdateNotice />`. |
| `src/theme.css` (modify) | Styles for the update banner. |
| `.github/workflows/release.yml` (create) | Tag-triggered signed/notarized universal release + manifest. |
| `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md` (modify) | Update/auto-update docs + release & rollback runbook. |

---

## Task 0: Generate the updater signing key (one-time setup)

This is an operations step, not code. It produces the minisign keypair the updater verifies against and the values that go into config + CI secrets. **Do this once; keep the private key safe.**

- [ ] **Step 1: Generate the keypair**

Run:

```bash
pnpm tauri signer generate -w ~/.tauri/conduit-updater.key
```

When prompted, set a password (remember it). This prints:
- a path to the **private key** file (`~/.tauri/conduit-updater.key`), and
- a **public key** string (a base64 blob, printed as `Public key: dW50cnVzdGVk…`).

- [ ] **Step 2: Record the three secret values**

You will paste these later:
- **Public key** (the `Public key:` blob) → `tauri.conf.json` in Task 3.
- **Private key contents** (`cat ~/.tauri/conduit-updater.key`) → GitHub secret `TAURI_SIGNING_PRIVATE_KEY` (Task 8).
- **Password** you chose → GitHub secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (Task 8).

Store the private key + password in your password manager. **Never commit them.** There is nothing to test or commit in this task.

---

## Task 1: Add updater + process Rust dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the two plugin crates**

In `src-tauri/Cargo.toml`, under `[dependencies]`, after the existing `tauri-plugin-window-state = "2"` line, add:

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

- [ ] **Step 2: Fetch + compile the new deps**

Run:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
```

Expected: compiles successfully (downloads the two crates + deps). This also refreshes `Cargo.lock`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(updater): add tauri-plugin-updater + tauri-plugin-process deps

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Pure `is_newer` semver kernel + `update_should_notify` command (TDD)

The updater plugin only surfaces an update when the remote version is newer than the running one. Our extra rule is "don't re-nag for a version the user clicked *Later* on." That decision is a pure function we can test.

**Files:**
- Create: `src-tauri/src/updates.rs`
- Modify: `src-tauri/src/lib.rs` (register module + command)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/updates.rs` with ONLY the tests + empty function signatures so it fails to pass (not fails to compile):

```rust
//! Auto-update helper logic. The `tauri-plugin-updater` plugin owns fetching the
//! manifest, comparing the running version, verifying the minisign signature, and
//! installing. The only decision that's ours: when the user clicked "Later" on a
//! version, don't re-notify until something strictly newer appears.

/// True if `candidate` is a strictly newer semver than `baseline`.
/// Tolerant: missing components count as 0; non-numeric junk on a component
/// counts as 0 so a malformed string never spuriously reads as "newer".
pub fn is_newer(candidate: &str, baseline: &str) -> bool {
    let _ = (candidate, baseline);
    unimplemented!()
}

/// The frontend calls this after the plugin reports an available `remote` version.
/// Returns true if we should surface the notice: always, unless the user skipped
/// this-or-newer already.
#[tauri::command]
pub fn update_should_notify(remote_version: String, skipped_version: Option<String>) -> bool {
    match skipped_version {
        None => true,
        Some(skipped) => is_newer(&remote_version, &skipped),
    }
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_patch_minor_major() {
        assert!(is_newer("0.5.1", "0.5.0"));
        assert!(is_newer("0.6.0", "0.5.9"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.5.0", "0.5.0"));
        assert!(!is_newer("0.5.0", "0.5.1"));
    }

    #[test]
    fn tolerates_missing_components_and_junk() {
        assert!(is_newer("0.5", "0.4.9")); // "0.5" == 0.5.0 > 0.4.9
        assert!(!is_newer("0.5", "0.5.0")); // equal
        assert!(!is_newer("garbage", "0.0.1")); // junk → 0.0.0, not newer
        assert!(is_newer("0.0.2", "garbage")); // baseline junk → 0.0.0
    }
}
```

Note `update_should_notify` is already implemented (it's trivial and delegates to `is_newer`); only `is_newer` is stubbed with `unimplemented!()` so the tests fail at runtime.

- [ ] **Step 2: Wire the module so it compiles, then run tests to confirm they fail**

In `src-tauri/src/lib.rs`, add the module declaration next to the others (after `mod transcript;`, before `mod worktree;` — keep alphabetical-ish grouping):

```rust
mod updates;
```

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml updates
```

Expected: FAIL — both tests panic with `not implemented` from `unimplemented!()`.

- [ ] **Step 3: Implement `is_newer`**

Replace the `is_newer` body in `src-tauri/src/updates.rs`:

```rust
pub fn is_newer(candidate: &str, baseline: &str) -> bool {
    fn parts(v: &str) -> (u64, u64, u64) {
        let mut it = v
            .split('.')
            .map(|c| c.trim().parse::<u64>().unwrap_or(0));
        (
            it.next().unwrap_or(0),
            it.next().unwrap_or(0),
            it.next().unwrap_or(0),
        )
    }
    parts(candidate) > parts(baseline)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml updates
```

Expected: PASS (2 tests).

- [ ] **Step 5: Register the command**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![ … ]`, add on its own line after `telemetry::telemetry_ping,`:

```rust
            updates::update_should_notify,
```

- [ ] **Step 6: Confirm the whole crate builds**

Run:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
```

Expected: builds clean.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/updates.rs src-tauri/src/lib.rs
git commit -m "feat(updater): add tested is_newer + update_should_notify command

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Register plugins + configure the updater endpoint & capabilities

**Files:**
- Modify: `src-tauri/src/lib.rs` (register plugins)
- Modify: `src-tauri/tauri.conf.json` (bundle + plugins.updater)
- Modify: `src-tauri/capabilities/default.json` (permissions)

- [ ] **Step 1: Register the two plugins**

In `src-tauri/src/lib.rs`, in `pub fn run()`, extend the plugin chain. Replace:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
```

with:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
```

- [ ] **Step 2: Configure the updater in `tauri.conf.json`**

In `src-tauri/tauri.conf.json`, add `"createUpdaterArtifacts": true` to the `bundle` object (after `"active": true,`), and add a top-level `"plugins"` object (a sibling of `"app"` and `"bundle"`). Paste the **public key from Task 0** where indicated:

```jsonc
  "bundle": {
    "active": true,
    "createUpdaterArtifacts": true,
    "targets": ["app"],
    // …unchanged…
  },
  "plugins": {
    "updater": {
      "pubkey": "PASTE_PUBLIC_KEY_FROM_TASK_0",
      "endpoints": [
        "https://github.com/uziiuzair/conduit/releases/latest/download/latest.json"
      ]
    }
  }
```

(The `pubkey` value is the exact `Public key:` blob printed by `pnpm tauri signer generate` in Task 0 — it is a real generated value, not a placeholder to invent.)

- [ ] **Step 3: Grant the capabilities**

In `src-tauri/capabilities/default.json`, add two permissions to the `permissions` array:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:default",
    "dialog:default",
    "notification:default",
    "window-state:default",
    "updater:default",
    "process:default"
  ]
}
```

- [ ] **Step 4: Build and launch to confirm the app still boots with the plugins registered**

Run:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

Expected: the app builds and opens as normal (no updater UI yet). Close it. A malformed `pubkey` would panic at startup — a clean boot confirms the key parsed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/tauri.conf.json src-tauri/capabilities/default.json
git commit -m "feat(updater): register updater+process plugins, configure endpoint & caps

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Add the JS updater/process plugin packages

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the two JS plugin packages**

Run:

```bash
pnpm add @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

Expected: both added to `dependencies` in `package.json` and `pnpm-lock.yaml` updated.

- [ ] **Step 2: Typecheck**

Run:

```bash
pnpm exec tsc --noEmit
```

Expected: PASS (no usages yet, just confirms the packages resolve).

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(updater): add @tauri-apps/plugin-updater + plugin-process

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Add the `updater` store slice

Mirrors the Claude ambient slice. The non-serializable `Update` handle is held in a module-level variable; the store holds only display metadata + phase.

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1: Add types + imports near the top of `src/store.ts`**

After the existing imports at the top of the file, add:

```ts
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
```

Then, next to the other exported interfaces (e.g. after the `ClaudeUsage` interface block around line 117), add:

```ts
// ---- Auto-update ----
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string;
  date?: string;
}
export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "error";

const SKIPPED_VERSION_KEY = "conduit.skippedVersion";
```

- [ ] **Step 2: Add the module-level handle + a helper**

Immediately below the `SKIPPED_VERSION_KEY` const (still at module scope, not inside the store), add:

```ts
/** The live Update handle from the updater plugin. Not serializable, so it lives
 *  outside the store; the store holds only the display metadata + phase. */
let pendingUpdate: Update | null = null;
```

- [ ] **Step 3: Add slice fields to the `AppState` interface**

In the `AppState` interface, right after the Claude ambient block:

```ts
  claudeStatus: ClaudeStatus | null;
  claudeUsage: ClaudeUsage | null;
  planConnected: boolean;
```

add:

```ts
  // ---- Auto-update ----
  updateInfo: UpdateInfo | null;
  updatePhase: UpdatePhase;
  updateProgress: number; // 0..1 while downloading
  updateError: string | null;
  /** Check for updates. `manual` = user-initiated (surface "up to date" and ignore skip). */
  checkForUpdates: (opts?: { manual?: boolean }) => Promise<void>;
  /** Download + install the pending update, then relaunch. */
  installUpdate: () => Promise<void>;
  /** "Later" — hide the notice and remember this version so we don't re-nag. */
  dismissUpdate: () => void;
```

- [ ] **Step 4: Initialize the slice fields in the store return object**

In the object returned by `create<AppState>((set, get) => { … return { … } })`, next to the existing `claudeStatus: null,` initializers (around line 402), add:

```ts
    claudeStatus: null,
    claudeUsage: null,
    planConnected: readPlanConnected(),
    updateInfo: null,
    updatePhase: "idle",
    updateProgress: 0,
    updateError: null,
```

- [ ] **Step 5: Implement the three actions**

Next to the `refreshClaudeStatus` / `refreshClaudeUsage` actions (around line 753), add:

```ts
    checkForUpdates: async (opts) => {
      const manual = opts?.manual ?? false;
      set({ updatePhase: "checking", updateError: null });
      try {
        const update = await check();
        if (!update) {
          pendingUpdate = null;
          set({ updateInfo: null, updatePhase: "idle" });
          return;
        }
        // Respect a prior "Later" unless this is a manual check.
        const skipped = localStorage.getItem(SKIPPED_VERSION_KEY);
        const shouldNotify = manual
          ? true
          : await invoke<boolean>("update_should_notify", {
              remoteVersion: update.version,
              skippedVersion: skipped,
            });
        if (!shouldNotify) {
          pendingUpdate = update;
          set({ updateInfo: null, updatePhase: "idle" });
          return;
        }
        pendingUpdate = update;
        set({
          updateInfo: {
            version: update.version,
            currentVersion: update.currentVersion,
            notes: update.body ?? "",
            date: update.date ?? undefined,
          },
          updatePhase: "available",
        });
      } catch (e) {
        // Network/offline/no-manifest: fail quiet on background checks; the manual
        // path surfaces the error so the About panel can show it.
        pendingUpdate = null;
        set({ updatePhase: "error", updateError: String(e) });
      }
    },

    installUpdate: async () => {
      if (!pendingUpdate) return;
      set({ updatePhase: "downloading", updateProgress: 0, updateError: null });
      try {
        let downloaded = 0;
        let total = 0;
        await pendingUpdate.downloadAndInstall((ev) => {
          switch (ev.event) {
            case "Started":
              total = ev.data.contentLength ?? 0;
              break;
            case "Progress":
              downloaded += ev.data.chunkLength;
              set({ updateProgress: total > 0 ? downloaded / total : 0 });
              break;
            case "Finished":
              set({ updateProgress: 1 });
              break;
          }
        });
        // Installed to disk; restart into the new version. This tears down PTYs —
        // the notice copy warns about that before the user clicks Install.
        await relaunch();
      } catch (e) {
        set({ updatePhase: "error", updateError: String(e) });
      }
    },

    dismissUpdate: () => {
      const v = get().updateInfo?.version;
      if (v) localStorage.setItem(SKIPPED_VERSION_KEY, v);
      set({ updateInfo: null, updatePhase: "idle" });
    },
```

- [ ] **Step 6: Typecheck**

Run:

```bash
pnpm exec tsc --noEmit
```

Expected: PASS. (If `invoke` is not already imported in `store.ts`, confirm it is — the Claude actions already use it, so it should be.)

- [ ] **Step 7: Commit**

```bash
git add src/store.ts
git commit -m "feat(updater): add updater store slice (check/install/dismiss)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Add the `useUpdater` background cadence hook

Mirrors `useClaudeAmbient`: check shortly after launch, then on an interval, pausing while the window is hidden.

**Files:**
- Create: `src/hooks/useUpdater.ts`

- [ ] **Step 1: Create the hook**

Create `src/hooks/useUpdater.ts`:

```ts
import { useEffect } from "react";
import { useStore } from "../store";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const LAUNCH_DELAY_MS = 8_000; // let startup settle before the first check

/**
 * Background update checker. Mirrors useClaudeAmbient: a first check shortly
 * after launch, then every 6h, paused while the window is hidden. All checks are
 * background (non-manual), so a "Later"-skipped version stays quiet.
 */
export function useUpdater(): void {
  const checkForUpdates = useStore((s) => s.checkForUpdates);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    let launchTimer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      void checkForUpdates();
    };

    const start = () => {
      if (interval != null) return;
      interval = setInterval(tick, CHECK_INTERVAL_MS);
    };
    const stop = () => {
      if (interval != null) {
        clearInterval(interval);
        interval = null;
      }
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    launchTimer = setTimeout(() => {
      tick();
      if (!document.hidden) start();
    }, LAUNCH_DELAY_MS);

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (launchTimer != null) clearTimeout(launchTimer);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
```

- [ ] **Step 2: Typecheck**

Run:

```bash
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useUpdater.ts
git commit -m "feat(updater): add useUpdater background cadence hook

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Add the `UpdateNotice` banner + wire it into `App.tsx`

A non-blocking banner. **Critical architecture rule:** it is a plain sibling element in the layout — it must never wrap, reparent, or conditionally unmount the terminal stack.

**Files:**
- Create: `src/components/UpdateNotice.tsx`
- Modify: `src/App.tsx` (mount hook + component)
- Modify: `src/theme.css` (styles)

- [ ] **Step 1: Create the component**

Create `src/components/UpdateNotice.tsx`:

```tsx
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";

const REPO_RELEASES = "https://github.com/uziiuzair/conduit/releases/latest";

/**
 * Non-blocking "update available / downloading" banner. Rendered as a plain
 * overlay sibling in App — never wraps the terminal stack (that would kill live
 * PTYs). Installing relaunches Conduit, which the copy states explicitly.
 */
export function UpdateNotice() {
  const info = useStore((s) => s.updateInfo);
  const phase = useStore((s) => s.updatePhase);
  const progress = useStore((s) => s.updateProgress);
  const install = useStore((s) => s.installUpdate);
  const dismiss = useStore((s) => s.dismissUpdate);

  // Only show when there's an available update (or it's mid-download).
  if (!info || (phase !== "available" && phase !== "downloading")) return null;

  const downloading = phase === "downloading";
  const pct = Math.round(progress * 100);

  return (
    <div className="update-notice" role="dialog" aria-live="polite">
      <div className="update-notice-body">
        <div className="update-notice-title">
          Conduit {info.version} is available
        </div>
        <div className="update-notice-sub">
          Installing restarts Conduit and ends running agent sessions.{" "}
          <span
            className="update-notice-link"
            role="link"
            tabIndex={0}
            onClick={() => void invoke("open_external", { url: REPO_RELEASES }).catch(() => {})}
            onKeyDown={(e) =>
              e.key === "Enter" &&
              void invoke("open_external", { url: REPO_RELEASES }).catch(() => {})
            }
          >
            Release notes
          </span>
        </div>
      </div>
      {downloading ? (
        <div className="update-notice-progress" aria-label={`Downloading ${pct}%`}>
          <div className="update-notice-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : (
        <div className="update-notice-actions">
          <button className="update-notice-later" onClick={dismiss}>
            Later
          </button>
          <button className="update-notice-install" onClick={() => void install()}>
            Install &amp; Relaunch
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount the hook + component in `App.tsx`**

In `src/App.tsx`, add the imports near the other component/hook imports:

```tsx
import { UpdateNotice } from "./components/UpdateNotice";
import { useUpdater } from "./hooks/useUpdater";
```

Inside `App()`, next to the existing `useTelemetry(telemetryOptOut);` call, add:

```tsx
  // Background auto-update checks (launch + every 6h while visible).
  useUpdater();
```

Then render `<UpdateNotice />` as the **last child of `app-root`**, immediately before its closing `</div>` (so it overlays without touching the workspace/terminal subtree):

```tsx
      <div
        className="detail"
        style={{ ["--right-w" as string]: `${rightWidth}px` }}
      >
        <WorkspaceCenter
          projects={projects}
          projectId={selectedProjectId}
          home={home}
        />
        <div
          className={`resizer ${dragging ? "dragging" : ""}`}
          onMouseDown={startResize}
        />
        <RightColumn projects={projects} projectId={selectedProjectId} />
      </div>
      <UpdateNotice />
    </div>
  );
```

- [ ] **Step 3: Add styles to `src/theme.css`**

Append to `src/theme.css`:

```css
/* ---- Auto-update notice ---- */
.update-notice {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 1000;
  width: 340px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--panel, #1a1b26);
  border: 1px solid var(--border, #2a2c3a);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  color: var(--text, #c0caf5);
}
.update-notice-title {
  font-weight: 600;
  font-size: 13px;
}
.update-notice-sub {
  margin-top: 4px;
  font-size: 12px;
  opacity: 0.8;
  line-height: 1.4;
}
.update-notice-link {
  color: var(--accent, #7aa2f7);
  cursor: pointer;
  text-decoration: underline;
}
.update-notice-actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.update-notice-later,
.update-notice-install {
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid var(--border, #2a2c3a);
  background: transparent;
  color: var(--text, #c0caf5);
}
.update-notice-install {
  background: var(--accent, #7aa2f7);
  border-color: var(--accent, #7aa2f7);
  color: #0b0d16;
  font-weight: 600;
}
.update-notice-progress {
  margin-top: 12px;
  height: 6px;
  border-radius: 3px;
  background: var(--border, #2a2c3a);
  overflow: hidden;
}
.update-notice-progress-fill {
  height: 100%;
  background: var(--accent, #7aa2f7);
  transition: width 0.15s ease;
}
```

- [ ] **Step 4: Typecheck + build**

Run:

```bash
pnpm exec tsc --noEmit && pnpm build
```

Expected: both PASS.

- [ ] **Step 5: Launch to confirm no regression + no terminal breakage**

Run:

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

Verify: the app opens normally, a session's terminal still spawns and survives tab/group changes (the notice is not visible yet — no update available in dev — but its presence in the tree must not disturb terminals). Close the app.

- [ ] **Step 6: Commit**

```bash
git add src/components/UpdateNotice.tsx src/App.tsx src/theme.css
git commit -m "feat(updater): add non-blocking update notice + wire background checks

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Add a manual "Check for updates" row to the About panel

**Files:**
- Modify: `src/components/AboutPanel.tsx`

- [ ] **Step 1: Extend the About panel with a manual check + status line**

Replace the contents of `src/components/AboutPanel.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { useStore } from "../store";

const REPO_URL = "https://github.com/uziiuzair/conduit";
const SITE_URL = "https://ooozzy.com";

function openExternal(url: string) {
  void invoke("open_external", { url }).catch(() => {});
}

export function AboutPanel() {
  const [version, setVersion] = useState("");
  const phase = useStore((s) => s.updatePhase);
  const info = useStore((s) => s.updateInfo);
  const error = useStore((s) => s.updateError);
  const check = useStore((s) => s.checkForUpdates);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const link = (url: string, label: string) => (
    <a
      className="about-link"
      role="link"
      tabIndex={0}
      onClick={() => openExternal(url)}
      onKeyDown={(e) => e.key === "Enter" && openExternal(url)}
    >
      {label}
    </a>
  );

  // Status text for the manual check. "available"/"downloading" are handled by the
  // global UpdateNotice; here we cover checking / up-to-date / error.
  const status = (): string => {
    if (phase === "checking") return "Checking…";
    if (phase === "downloading") return "Downloading…";
    if (phase === "available" && info) return `Update available: ${info.version}`;
    if (phase === "error") return error ? `Check failed: ${error}` : "Check failed";
    return version ? "You're up to date." : "";
  };

  return (
    <div className="about-panel">
      <div className="about-wordmark">Conduit</div>
      <p className="settings-intro">
        Multiple real Claude Code terminals across your projects, in one window.
      </p>
      <p className="about-credit">
        Built with love by Uzair Hayat at {link(SITE_URL, "Ooozzy")}.
      </p>
      <div className="about-rows">
        <div className="about-row">
          <span className="about-key">Version</span>
          <span className="about-val">{version || "..."}</span>
        </div>
        <div className="about-row">
          <span className="about-key">Updates</span>
          <span className="about-val about-updates">
            <button
              className="about-check-btn"
              onClick={() => void check({ manual: true })}
              disabled={phase === "checking" || phase === "downloading"}
            >
              Check for updates
            </button>
            <span className="about-update-status">{status()}</span>
          </span>
        </div>
        <div className="about-row">
          <span className="about-key">Source</span>
          {link(REPO_URL, "github.com/uziiuzair/conduit")}
        </div>
        <div className="about-row">
          <span className="about-key">License</span>
          <span className="about-val">MIT</span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add minimal styles to `src/theme.css`**

Append:

```css
.about-updates {
  display: flex;
  align-items: center;
  gap: 10px;
}
.about-check-btn {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid var(--border, #2a2c3a);
  background: transparent;
  color: var(--text, #c0caf5);
}
.about-check-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.about-update-status {
  font-size: 12px;
  opacity: 0.75;
}
```

- [ ] **Step 3: Typecheck + build**

Run:

```bash
pnpm exec tsc --noEmit && pnpm build
```

Expected: both PASS.

- [ ] **Step 4: Launch and click the button**

Run:

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

Open Settings → About, click **Check for updates**. In dev with no reachable higher release, expect either "You're up to date." or "Check failed: …" (both acceptable — it proves the wiring). Close the app.

- [ ] **Step 5: Commit**

```bash
git add src/components/AboutPanel.tsx src/theme.css
git commit -m "feat(updater): manual 'Check for updates' in About panel

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Release CI workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Store the GitHub Actions secrets**

In the GitHub repo → Settings → Secrets and variables → Actions → New repository secret, add all of:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/conduit-updater.key` (Task 0) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password from Task 0 |
| `APPLE_CERTIFICATE` | base64 of your Developer ID `.p12` (`base64 -i cert.p12 | pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <Name> (<TEAMID>)` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | an app-specific password (appleid.apple.com) |
| `APPLE_TEAM_ID` | your 10-char team id |

- [ ] **Step 2: Create the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  release:
    runs-on: macos-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install Rust (stable) with both apple targets
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-apple-darwin,x86_64-apple-darwin

      - name: Install frontend dependencies
        run: pnpm install --frozen-lockfile

      - name: Build, sign, notarize, and publish release
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        with:
          args: --target universal-apple-darwin
          tagName: ${{ github.ref_name }}
          releaseName: "Conduit ${{ github.ref_name }}"
          releaseBody: "See the assets below. Release notes:"
          releaseDraft: false
          prerelease: false
          includeUpdaterJson: true
```

Notes for the implementer (do not paste into the file):
- `includeUpdaterJson: true` makes tauri-action generate + upload `latest.json` with both `darwin-aarch64` and `darwin-x86_64` keys pointing at the universal artifact.
- `releaseDraft: false` + `prerelease: false` are required so `releases/latest/download/latest.json` (the app's endpoint) resolves to this release.
- The in-app "Release notes" the user sees come from the manifest `notes`, which tauri-action fills from `releaseBody`. For a real release, replace `releaseBody` with the version's changelog (or edit the GitHub Release body before publishing).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): signed+notarized universal macOS release on tag push

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Docs — README, CONTRIBUTING (release + rollback runbook), CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document auto-update in `README.md`**

In `README.md`, add a new `## Updating` section immediately before `## How it works`:

```markdown
## Updating

From **0.5.0** onward, Conduit updates itself on macOS. It checks GitHub Releases
in the background (and on demand via **Settings → About → Check for updates**);
when a newer signed release exists, a notice offers **Install & Relaunch**.
Updates are Developer ID–signed, notarized, and minisign-verified before install.

> Because auto-update only exists from 0.5.0, existing users must download 0.5.0
> once by hand from the [Releases page](https://github.com/uziiuzair/conduit/releases).
> Every version after that updates in place.
```

- [ ] **Step 2: Add the release + rollback runbook to `CONTRIBUTING.md`**

Append to `CONTRIBUTING.md` a new section:

```markdown
## Cutting a release (maintainers)

Releases are built + signed + notarized by CI on a version tag.

1. Bump the version in all three files (see the table in `CLAUDE.md`):
   `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
2. `cargo build --manifest-path src-tauri/Cargo.toml` (refreshes `Cargo.lock`).
3. Update `CHANGELOG.md`.
4. Commit, then tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
5. The **Release** workflow builds a universal macOS app, signs + notarizes it,
   generates `latest.json`, and publishes the GitHub Release. Confirm the release
   is **published** (not draft/prerelease) — the app's updater endpoint,
   `releases/latest/download/latest.json`, only resolves to a published release.

### If a bad release ships (rollback = roll forward)

Tauri has no auto-rollback. To pull a bad version:

1. On GitHub, mark the bad release **prerelease** or delete it, so it stops being
   "latest".
2. Fix the issue and cut a higher patch (`vX.Y.Z+1`). Because the endpoint tracks
   "latest," every user moves forward on their next check.
3. Consent-before-install already limits the blast radius to users who clicked
   Install before you rolled forward.
```

- [ ] **Step 3: Add a CHANGELOG entry**

In `CHANGELOG.md`, add a new top entry (match the file's existing heading style; use `0.5.0`):

```markdown
## 0.5.0

- **Auto-updates (macOS).** Conduit now checks GitHub Releases in the background
  and via Settings → About, and installs signed + notarized updates on your
  consent. This is the first self-updating build — update to it once by hand;
  future versions update in place.
```

- [ ] **Step 4: Commit**

```bash
git add README.md CONTRIBUTING.md CHANGELOG.md
git commit -m "docs(updater): document auto-update, release ritual, and rollback

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: Version bump to the 0.5.0 seed release

The three version files must stay in lockstep (per `CLAUDE.md`). This is the "seed" build users download once.

**Files:**
- Modify: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`

- [ ] **Step 1: Bump all three to `0.5.0`**

- `package.json`: `"version": "0.5.0"`
- `src-tauri/tauri.conf.json`: `"version": "0.5.0"`
- `src-tauri/Cargo.toml`: the `[package]` `version = "0.5.0"` on line 3 (not a dependency)

- [ ] **Step 2: Refresh `Cargo.lock`**

Run:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 3: Verify all three agree**

Run:

```bash
grep -E '"?version"?\s*[:=]\s*"[0-9]' package.json src-tauri/tauri.conf.json; sed -n '3p' src-tauri/Cargo.toml
```

Expected: every line shows `0.5.0`.

- [ ] **Step 4: Commit**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(release): bump to 0.5.0 (first auto-updating seed build)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: End-to-end updater verification (manual)

Proves the full loop before you rely on it. Uses a scratch manifest advertising a fake-higher version so a lower local build detects → downloads → verifies → relaunches.

- [ ] **Step 1: Produce a real signed artifact for a higher version**

Temporarily bump the three version files to `0.5.1`, then build a signed updater artifact locally (set the signing env from Task 0):

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/conduit-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<password from Task 0>"
pnpm tauri build --bundles app
```

This emits `src-tauri/target/release/bundle/macos/Conduit.app.tar.gz` and a `Conduit.app.tar.gz.sig` next to it.

- [ ] **Step 2: Host a scratch manifest**

Upload `Conduit.app.tar.gz` somewhere reachable (a throwaway GitHub release on a scratch repo, or a gist-backed raw URL) and write a `latest.json`:

```json
{
  "version": "0.5.1",
  "notes": "E2E updater test",
  "pub_date": "2026-07-03T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of Conduit.app.tar.gz.sig>",
      "url": "<public URL of Conduit.app.tar.gz>"
    },
    "darwin-x86_64": {
      "signature": "<contents of Conduit.app.tar.gz.sig>",
      "url": "<public URL of Conduit.app.tar.gz>"
    }
  }
}
```

- [ ] **Step 3: Point a lower build at the scratch manifest and run it**

Revert the version files to `0.5.0`. Temporarily set the `plugins.updater.endpoints[0]` in `tauri.conf.json` to the scratch `latest.json` URL. Build + run a release build (the updater is inert in `tauri dev`):

```bash
pnpm tauri build --bundles app
open src-tauri/target/release/bundle/macos/Conduit.app
```

- [ ] **Step 4: Verify the loop**

Expected: within ~8s of launch (or via About → Check for updates) the notice appears for `0.5.1`; clicking **Install & Relaunch** shows the progress bar, then the app relaunches and About shows `0.5.1`. If the minisign signature or pubkey mismatched, install fails — that's the verification working.

- [ ] **Step 5: Revert the scratch endpoint**

Restore `plugins.updater.endpoints[0]` to the real GitHub URL. Confirm no diff remains:

```bash
git diff --stat
```

Expected: no changes to `tauri.conf.json` (endpoint restored). Nothing to commit if clean.

---

## Self-review notes

- **Spec coverage:** Config/keys/plumbing (Tasks 1,3,4) · minisign + `should_notify` (Task 2) · CI (Task 9) · frontend UX check/notice/manual (Tasks 5–8) · security/rollback docs (Task 10) · seed 0.5.0 (Task 11) · E2E test (Task 12). All spec sections map to tasks.
- **Type consistency:** `UpdateInfo` / `UpdatePhase` / `checkForUpdates` / `installUpdate` / `dismissUpdate` / `updateInfo` / `updatePhase` / `updateProgress` / `updateError` are defined in Task 5 and consumed identically in Tasks 7–8. Rust `is_newer` / `update_should_notify` defined in Task 2, command name matches the `invoke("update_should_notify", …)` call in Task 5.
- **No code placeholders:** the only substitution tokens are genuine secrets/keys the maintainer generates (the minisign pubkey in Task 3 and the Apple/CI secrets in Task 9), each with the exact command that produces them.
```
