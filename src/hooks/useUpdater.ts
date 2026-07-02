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
