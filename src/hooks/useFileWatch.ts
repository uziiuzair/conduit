import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";
import { useStore } from "../store";
import type { FileContent, FileStat } from "../store";
import * as registry from "../monaco/registry";

const WATCH_POLL_MS = 1500;

/** Every open file-tab path across all projects' layouts, deduped. */
function openFilePaths(): string[] {
  const seen = new Set<string>();
  for (const layout of Object.values(useStore.getState().layouts)) {
    for (const g of layout.groups) {
      for (const t of g.tabs) {
        if (t.kind === "file") seen.add(t.ref);
      }
    }
  }
  return [...seen];
}

/**
 * Single app-level file watcher (mounted once in App, like useClaudeAmbient).
 * While the window is visible, every ~1500ms it stats each open file path and,
 * when the disk {mtimeMs,size} diverges from the registry baseline:
 *   - clean buffer  -> SILENT reload via pushEditOperations (undo preserved)
 *   - dirty buffer  -> store.conflict[path] = stat   (Reload / Keep mine banner)
 *   - exists:false  -> store.conflict[path] = "deleted"   (deleted banner)
 * Skips any path with an in-flight save (registry.saving) to close the
 * save-vs-poll-tick race, and only watches revealed, editable models.
 */
export function useFileWatch(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let running = false;

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        for (const path of openFilePaths()) {
          if (registry.saving.has(path)) continue; // own-save in flight
          const entry = registry.model(path);
          // Only a revealed, editable model can be silently reloaded; binary /
          // read-only / not-yet-revealed tabs have no buffer to diff.
          if (!entry || entry.model == null || entry.readOnly) continue;
          const base = registry.baseline(path);
          if (!base) continue;

          let stat: FileStat;
          try {
            stat = await invoke<FileStat>("stat_file", { path });
          } catch {
            continue;
          }
          const store = useStore.getState();

          if (!stat.exists) {
            // Skip re-flagging once the baseline is already the {0,0} deleted sentinel
            // (set by CodeEditorPane's "Keep buffer" action) — otherwise every tick
            // after Keep-buffer would immediately re-raise the same deleted banner.
            if (base.mtimeMs !== 0 || base.size !== 0) {
              if (store.conflict[path] !== "deleted") store.setConflict(path, "deleted");
            }
            continue;
          }
          if (stat.mtimeMs === base.mtimeMs && stat.size === base.size) continue;

          if (registry.dirtyOf(path)) {
            // Dirty buffer -> non-blocking banner; don't re-set the same stat.
            const cur = store.conflict[path];
            if (
              cur &&
              cur !== "deleted" &&
              cur.mtimeMs === stat.mtimeMs &&
              cur.size === stat.size
            )
              continue;
            store.setConflict(path, { mtimeMs: stat.mtimeMs, size: stat.size });
            continue;
          }

          // Clean buffer -> silent reload, preserving undo history.
          const fc = await invoke<FileContent>("read_file", { path });
          if (fc.error !== null || fc.binary || fc.readOnly) {
            // Became binary / oversized / unreadable: surface a banner instead of
            // silently pushing partial/lossy content.
            store.setConflict(path, { mtimeMs: stat.mtimeMs, size: stat.size });
            continue;
          }
          const m = entry.model as unknown as Monaco.editor.ITextModel;
          m.pushEditOperations(
            [],
            [{ range: m.getFullModelRange(), text: fc.content }],
            () => null,
          );
          // Baseline + saved point from the SAME read that produced the content.
          registry.setSaved(path, { mtimeMs: fc.mtimeMs, size: fc.size });
          store.clearConflict(path);
        }
      } finally {
        running = false;
      }
    };

    const start = () => {
      if (timer == null) {
        void tick();
        timer = setInterval(() => void tick(), WATCH_POLL_MS);
      }
    };
    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, []);
}
