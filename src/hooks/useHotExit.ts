import { useEffect } from "react";
import { useStore } from "../store";

const FLUSH_MS = 3000;

/**
 * Hot exit's backup cadence (mounted once in App, like useFileWatch): while any
 * buffer is dirty, flush the dirty set to the app-data backup every few seconds,
 * plus immediately when the window is hidden. When the dirty set empties, one
 * final flush writes the empty set so stale backups can't outlive their edits.
 * The quit path does its own awaited flush — this hook is the crash net.
 */
export function useHotExit(): void {
  useEffect(() => {
    let hadDirty = false;
    let inFlight = false;

    const tick = () => {
      if (inFlight) return;
      const s = useStore.getState();
      const has = Object.keys(s.dirty).length > 0;
      if (!has && !hadDirty) return; // steady-state clean: nothing to write
      hadDirty = has;
      inFlight = true;
      void s.flushHotExit().finally(() => {
        inFlight = false;
      });
    };

    const timer = setInterval(tick, FLUSH_MS);
    const onVisibility = () => {
      if (document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
