import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";

const HEARTBEAT_MS = 5 * 60 * 1000; // ping every 5 min while focused
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // new GA4 session after 30 min idle

function send(
  kind: "app_open" | "app_heartbeat",
  sessionId: string,
  engagementMsec: number,
) {
  // Fire-and-forget; Rust gates + swallows. Never let telemetry surface errors.
  void invoke("telemetry_ping", { kind, sessionId, engagementMsec }).catch(() => {});
}

/**
 * Drives the anonymous engagement heartbeat. Lifecycle only — identity,
 * credentials, payload, and gating all live in Rust (telemetry_ping).
 *
 * @param optedOut when true, the hook does nothing. The real source of this
 *   value is parked (settings/onboarding); callers pass `false` for now.
 */
export function useTelemetry(optedOut: boolean = false): void {
  const sessionId = useRef("");
  const lastActivity = useRef(0);
  const lastPing = useRef(0);

  useEffect(() => {
    if (optedOut) return;
    let disposed = false;

    const startSession = () => {
      sessionId.current = crypto.randomUUID();
      const now = Date.now();
      lastActivity.current = now;
      lastPing.current = now;
      send("app_open", sessionId.current, 1);
    };

    const engage = () => {
      const now = Date.now();
      if (now - lastActivity.current >= SESSION_TIMEOUT_MS) {
        startSession();
        return;
      }
      const delta = now - lastPing.current;
      lastPing.current = now;
      lastActivity.current = now;
      send("app_heartbeat", sessionId.current, delta);
    };

    const tick = () => {
      if (disposed) return;
      if (document.visibilityState === "visible" && document.hasFocus()) {
        engage();
      }
    };

    const onFocus = () => {
      if (disposed) return;
      engage();
    };

    startSession();
    const timer = window.setInterval(tick, HEARTBEAT_MS);
    window.addEventListener("focus", onFocus);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [optedOut]);
}
