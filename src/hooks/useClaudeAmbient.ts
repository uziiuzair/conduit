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
  const connectPlan = useStore((s) => s.connectPlanUsage);
  const planConnected = useStore((s) => s.planConnected);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      void refreshStatus();
      void refreshUsage();
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

    // Rehydrate plan-usage token cache once on mount if previously connected.
    if (planConnected) void connectPlan();

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
