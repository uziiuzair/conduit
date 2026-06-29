import { useStore } from "../store";

/**
 * Opt-out control for anonymous usage telemetry. Framed positively (checked =
 * sharing on) to avoid a confusing double negative. Shared by Settings and the
 * onboarding wizard. The store flag drives the engagement heartbeat in App.
 */
export function TelemetryToggle() {
  const telemetryOptOut = useStore((s) => s.telemetryOptOut);
  const setTelemetryOptOut = useStore((s) => s.setTelemetryOptOut);

  return (
    <label className="telemetry-toggle">
      <input
        type="checkbox"
        checked={!telemetryOptOut}
        onChange={(e) => setTelemetryOptOut(!e.target.checked)}
      />
      <span>Share anonymous usage statistics</span>
    </label>
  );
}
