import { useEffect } from "react";
import { useStore } from "../store";

const POLL_MS = 60_000;

/**
 * Polls Claude status + usage every 60s, but only while the window is visible
 * (pauses on hidden, refreshes immediately on resume). On mount, if the user had
 * connected plan usage in a previous session, silently rehydrate the Rust token
 * cache via connectPlanUsage() so plan limits reappear without a button click.
 */
export function useClaudeAmbient(): void {
  const refreshStatus = useStore((s) => s.refreshClaudeStatus);
  const refreshUsage = useStore((s) => s.refreshClaudeUsage);
  const refreshAgy = useStore((s) => s.refreshAgyUsage);
  const connectPlan = useStore((s) => s.connectPlanUsage);
  const planConnected = useStore((s) => s.planConnected);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      void refreshStatus();
      void refreshUsage();
      // agy usage is mostly pushed via the hook event, but re-pull the snapshot map too so a
      // refresh (e.g. after enabling tracking) shows without waiting for the next agy tick.
      void refreshAgy();
    };

    const start = () => {
      if (timer != null) return;
      tick();
      timer = setInterval(tick, POLL_MS);
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

    // Rehydrate each previously-connected account's plan-usage token cache once on mount
    // (the Rust token cache is memory-only, so it's empty after a restart).
    for (const [key, ok] of Object.entries(planConnected)) {
      if (ok) void connectPlan(key === "default" ? null : key);
    }

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
