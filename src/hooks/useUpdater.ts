import { useEffect } from "react";
import { useStore } from "../store";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const LAUNCH_DELAY_MS = 8_000; // let startup settle before the first check

/**
 * Background update checker. Mirrors useClaudeAmbient: a first check shortly
 * after launch, then every 6h, paused while the window is hidden. All checks are
 * background (non-manual), so a "Later"-skipped version stays quiet.
 *
 * Main-window-only (multi-window profiles): the updater relaunches the WHOLE app, so one
 * banner is the right amount regardless of how many profile windows are open — a
 * secondary polling too would mean every open window independently checks and could each
 * surface its own "update available" banner for the same relaunch. Switch mode has no
 * secondary windows, so `isMain` is always true there and this is unchanged.
 */
export function useUpdater(): void {
  const checkForUpdates = useStore((s) => s.checkForUpdates);
  // `windowProfile` starts at its main/Default default and only resolves to this
  // window's real identity once `load()`'s `window_profile` IPC round trip settles (see
  // the plugin-init effect's own comment on the same race, above in App.tsx) — so `isMain`
  // must be a DEP, not read once at mount: a secondary window's first render still
  // reports `isMain: true`, and without re-running this effect when the real value
  // arrives, a secondary would start (and never stop) the full updater loop.
  const isMain = useStore((s) => s.windowProfile.isMain);

  useEffect(() => {
    if (!isMain) return;
    let interval: ReturnType<typeof setInterval> | null = null;
    let launchTimer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      void checkForUpdates();
    };

    const start = () => {
      if (interval != null) return;
      tick(); // check immediately on (re)start, mirroring useClaudeAmbient
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

    // Defer the first check so startup isn't blocked; then poll while visible,
    // paused while hidden. No check ever fires while the window is hidden.
    launchTimer = setTimeout(() => {
      if (!document.hidden) start();
    }, LAUNCH_DELAY_MS);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (launchTimer != null) clearTimeout(launchTimer);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMain]);
}
