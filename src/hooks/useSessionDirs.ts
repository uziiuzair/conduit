import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";

const FAST_POLL_MS = 1000;
/** Confirmed worktrees are re-checked only every Nth tick (the deletion sweep). */
const SWEEP_EVERY_TICKS = 5;

/**
 * The ONE resolver that fills `sessionDirs` (observed effective dir per session).
 * Rules per session:
 *  - no worktreePath           → project.path, written once, never polled
 *  - worktreePath, no entry    → PENDING: poll dir_exists(worktreePath) each tick;
 *                                write worktreePath when it appears. No entry is
 *                                written while pending — effectiveDirOf falls back to
 *                                project.path for panels, and the missing entry keeps
 *                                the companion shell's dirReady false.
 *  - entry === worktreePath    → confirmed: sweep every 5th tick; if the dir is gone,
 *                                fall back to project.path (entry stays present, so
 *                                the shell respawns there instead of going blank).
 *  - entry === project.path,   → the deleted-worktree state; the pending rule above
 *    worktreePath set            keeps polling, so a recreated worktree re-confirms.
 * Entries for sessions that no longer exist are pruned each tick. Local stat every
 * second for the handful of unconfirmed sessions is negligible; no visibility pause
 * needed (unlike the 60 s network poll in useClaudeAmbient).
 */
export function useSessionDirs(): void {
  useEffect(() => {
    let tickCount = 0;
    let running = false;
    let cancelled = false;

    const tick = async () => {
      if (running) return; // a slow tick must not overlap the next interval fire
      running = true;
      tickCount++;
      try {
        const { projects, setSessionDir, pruneSessionDirs } = useStore.getState();
        const liveIds = new Set<string>();
        for (const project of projects) {
          for (const session of project.sessions) {
            liveIds.add(session.id);
            // Re-read inside the loop: earlier iterations may have written entries.
            const entry = useStore.getState().sessionDirs[session.id];
            const wt = session.worktreePath;
            if (!wt) {
              if (entry !== project.path) setSessionDir(session.id, project.path);
              continue;
            }
            if (entry === wt) {
              if (tickCount % SWEEP_EVERY_TICKS !== 0) continue;
              // IPC failure must not demote a confirmed worktree (shell would flap
              // to the project root and back); only a real "gone" answer does.
              const exists = await invoke<boolean>("dir_exists", { path: wt }).catch(
                () => true,
              );
              if (cancelled) return;
              if (!exists) setSessionDir(session.id, project.path);
            } else {
              const exists = await invoke<boolean>("dir_exists", { path: wt }).catch(
                () => false,
              );
              if (cancelled) return;
              if (exists) setSessionDir(session.id, wt);
            }
          }
        }
        // Prune entries for sessions that were deleted; the map must not grow forever.
        // Safe only because this hook is the sole writer of sessionDirs.
        pruneSessionDirs(liveIds);
      } finally {
        running = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), FAST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
}
