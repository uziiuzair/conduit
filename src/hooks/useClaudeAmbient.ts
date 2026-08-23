import { useEffect } from "react";
import { useStore } from "../store";

/** status.claude.com + the local agy snapshot: cheap, and worth being current. */
const FAST_POLL_MS = 60_000;
/**
 * Plan quota, per account, over the network.
 *
 * Deliberately much slower than the status tick. `/api/oauth/usage` rate-limits, the real
 * `claude` CLI competes with us for the same budget, and at 60s per account this app was a
 * large part of why it throttled -- a throttled poll used to blank that account's meters,
 * so the panel disagreed with itself minute to minute. Both windows it reports are measured
 * in hours; five minutes is far more resolution than they have.
 */
const USAGE_POLL_MS = 5 * 60_000;

/**
 * Polls Claude status (60s) and plan usage (5 min) while the window is visible, pausing on
 * hidden. On mount, if the user had connected plan usage in a previous session, silently
 * rehydrate the Rust token cache via connectPlanUsage() so plan limits reappear without a
 * button click.
 */
export function useClaudeAmbient(): void {
  const refreshStatus = useStore((s) => s.refreshClaudeStatus);
  const refreshUsage = useStore((s) => s.refreshClaudeUsage);
  const refreshAgy = useStore((s) => s.refreshAgyUsage);
  const refreshCommandCode = useStore((s) => s.refreshCommandCodeUsage);
  const connectPlan = useStore((s) => s.connectPlanUsage);
  const planConnected = useStore((s) => s.planConnected);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    // Epoch ms of the last quota fetch, so resuming a hidden window does not re-fetch on
    // every alt-tab. Without this, switching apps was itself a poll.
    let lastUsageAt = 0;

    const pollUsage = () => {
      lastUsageAt = Date.now();
      void refreshUsage();
      // Command Code reads its own API with a key already on disk, so unlike Claude there
      // is no connect step to gate this on -- it either answers or reports why it cannot.
      // Grouped with Claude because it is the other one going over the network.
      void refreshCommandCode();
    };

    const tick = () => {
      void refreshStatus();
      // agy usage is mostly pushed via the hook event, but re-pull the snapshot map too so a
      // refresh (e.g. after enabling tracking) shows without waiting for the next agy tick.
      // Local read, so it stays on the fast tick.
      void refreshAgy();
      if (Date.now() - lastUsageAt >= USAGE_POLL_MS) pollUsage();
    };

    const start = () => {
      if (timer != null) return;
      tick();
      timer = setInterval(tick, FAST_POLL_MS);
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
