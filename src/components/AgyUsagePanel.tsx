import { useStore } from "../store";
import type { AgyBucket } from "../store";

/** RFC3339 → "3:41pm" (today) / "Mon" (later). Never throws. */
function shortReset(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { weekday: "short" });
}

/** A single quota window. agy reports fraction REMAINING; the bar mirrors that. */
function Meter({ b }: { b: AgyBucket }) {
  const pct = Math.round(b.remainingFraction * 100);
  // Low remaining is the alarming end here (unlike Claude's pct-used meter).
  const cls = b.disabled ? "disabled" : pct <= 10 ? "hot" : pct <= 30 ? "warn" : "";
  const reset = shortReset(b.resetsAt);
  return (
    <div className="agy-meter">
      <div className="agy-meter-head">
        <span>{b.label}</span>
        <span>
          {b.disabled ? "disabled" : `${pct}% left`}
          {reset ? ` · ${reset}` : ""}
        </span>
      </div>
      <div className="agy-meter-bar">
        <div
          className={`agy-meter-fill ${cls}`}
          style={{ width: `${b.disabled ? 0 : pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Persistent Antigravity usage panel, pinned to the bottom of the sidebar for agy
 * sessions (violet, to distinguish it from Claude's). Data is pushed by agy's own
 * status-line command hook via the Rust hook server; empty until the tracking toggle is
 * on and an agy session has run at least once.
 */
export function AgyUsagePanel() {
  const usage = useStore((s) => s.agyUsage);
  const tracking = useStore((s) => s.agyUsageTracking);
  const setTracking = useStore((s) => s.setAgyUsageTracking);

  const hasData = usage && usage.groups.length > 0;

  return (
    <div className="agy-usage-panel">
      <div className="agy-usage-head">
        <span>Antigravity usage</span>
        {usage?.planTier && <span className="agy-tier-chip">{usage.planTier}</span>}
      </div>

      {hasData ? (
        <>
          {usage!.groups.map((g) => (
            <div className="agy-group" key={g.displayName}>
              <div className="agy-group-label">{g.displayName}</div>
              {g.buckets.map((b) => (
                <Meter key={b.bucketId} b={b} />
              ))}
            </div>
          ))}
          {usage!.context && usage!.context.contextWindowSize > 0 && (
            <div className="agy-meter agy-context">
              <div className="agy-meter-head">
                <span>Context</span>
                <span>{Math.round(usage!.context.usedPercentage)}% used</span>
              </div>
              <div className="agy-meter-bar">
                <div
                  className="agy-meter-fill ctx"
                  style={{ width: `${Math.min(100, usage!.context.usedPercentage)}%` }}
                />
              </div>
            </div>
          )}
        </>
      ) : tracking ? (
        <div className="agy-usage-hint">
          Waiting for agy — open an agy session and send a prompt to populate usage.
        </div>
      ) : (
        <>
          <div className="agy-usage-hint">
            Usage tracking is off. Enable it to show agy quota here.
          </div>
          <button className="agy-enable-btn" onClick={() => void setTracking(true)}>
            Enable usage tracking
          </button>
        </>
      )}
    </div>
  );
}
