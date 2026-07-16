import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../store";
import type { BoardSnapshot, ContinuityView } from "../store";

const POLL_MS = 1500;

/** Loads a project's board and keeps it fresh via the `board-changed` event plus a light
 *  poll (re-fetch) for teammate/git edits. Only active while `enabled`. */
export function useBoard(projectId: string | null, enabled: boolean) {
  const setBoard = useStore((s) => s.setBoard);
  const setContinuity = useStore((s) => s.setContinuity);

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      const snap = await invoke<BoardSnapshot>("list_board", { projectId });
      setBoard(projectId, snap);
    } catch (e) {
      console.error("[board] list_board failed", e);
    }
    try {
      const view = await invoke<ContinuityView>("list_continuity", { projectId });
      setContinuity(projectId, view);
    } catch (e) {
      console.error("[continuity] list_continuity failed", e);
    }
  }, [projectId, setBoard, setContinuity]);

  useEffect(() => {
    if (!enabled || !projectId) return;
    let un: (() => void) | undefined;
    let cancelled = false;
    listen<{ projectId: string }>("board-changed", (ev) => {
      if (ev.payload.projectId === projectId) reload();
    }).then((u) => { if (cancelled) u(); else un = u; });
    return () => { cancelled = true; if (un) un(); };
  }, [enabled, projectId, reload]);

  useEffect(() => {
    if (!enabled || !projectId) return;
    reload();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [enabled, projectId, reload]);

  return { reload };
}
