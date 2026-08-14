import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import type { ContinuityFeed } from "../continuityFeed";

/** Slower than the board's 1.5 s: a decision log is a memory, not a live wire. */
const POLL_MS = 4000;

/**
 * Keeps a project's continuity feed fresh.
 *
 * Deliberately NOT folded into useBoard: that hook is gated on `board_enabled` and polls at
 * 1.5 s for card state. The panels are gated only on continuity's database being reachable,
 * so they keep their own cadence and their own gate.
 */
export function useContinuityFeed(projectId: string | null, enabled: boolean) {
  const setContinuityFeed = useStore((s) => s.setContinuityFeed);

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      const feed = await invoke<ContinuityFeed>("continuity_feed", { projectId });
      setContinuityFeed(projectId, feed);
    } catch (e) {
      console.error("[continuity] continuity_feed failed", e);
    }
  }, [projectId, setContinuityFeed]);

  useEffect(() => {
    if (!enabled || !projectId) return;
    void reload();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [enabled, projectId, reload]);

  return { reload };
}
