import { useState } from "react";
import { useStore } from "../store";
import { fmtTokens } from "./ClaudeStatusPill";
import type { PlanWindow } from "../store";

/** "claude-haiku-4-5-20251001" → "haiku-4-5" (drop vendor prefix + date suffix). */
function shortModel(m: string): string {
  return m.replace(/^claude-/, "").replace(/-\d{6,}$/, "");
}

/** RFC3339 string → "3:41pm" (today) / "Mon" (later). Never throws. */
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

function Meter({ w }: { w: PlanWindow }) {
  const pct = Math.round(w.pctUsed * 100);
  const cls = pct >= 90 ? "hot" : pct >= 70 ? "warn" : "";
  const reset = shortReset(w.resetsAt);
  return (
    <div className="claude-meter">
      <div className="claude-meter-head">
        <span>{w.label}</span>
        <span>{pct}%{reset ? ` · ${reset}` : ""}</span>
      </div>
      <div className="claude-meter-bar">
        <div className={`claude-meter-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Persistent usage panel pinned to the bottom of the sidebar, above the add-bar. */
export function ClaudeUsagePanel() {
  const usage = useStore((s) => s.claudeUsage);
  const connectPlan = useStore((s) => s.connectPlanUsage);
  const [connecting, setConnecting] = useState(false);

  if (!usage) return null; // nothing fetched yet

  const onConnect = async () => {
    setConnecting(true);
    try { await connectPlan(); } finally { setConnecting(false); }
  };

  const hasPlan = usage.plan && usage.plan.length > 0;

  return (
    <div className="claude-usage-panel">
      <div className="claude-usage-head">Claude usage</div>

      {hasPlan ? (
        usage.plan!.map((w) => <Meter key={w.label} w={w} />)
      ) : (
        <>
          {usage.local && usage.local.totalTokens > 0 ? (
            <>
              <div className="claude-pop-row">
                <span className="name">Today</span>
                <span>{fmtTokens(usage.local.totalTokens)} tokens</span>
              </div>
              {usage.local.tokensByModel.slice(0, 2).map((m) => (
                <div className="claude-pop-row" key={m.model}>
                  <span className="name claude-pop-muted">{shortModel(m.model)}</span>
                  <span className="claude-pop-muted">{fmtTokens(m.tokens)}</span>
                </div>
              ))}
            </>
          ) : (
            <div className="claude-pop-muted">No usage data yet.</div>
          )}
          <button className="claude-connect-btn" onClick={onConnect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect plan usage"}
          </button>
          {usage.planSource === "unavailable" && (
            <div className="claude-pop-muted" style={{ marginTop: 6 }}>
              Plan limits unavailable — showing local usage.
            </div>
          )}
        </>
      )}
    </div>
  );
}
