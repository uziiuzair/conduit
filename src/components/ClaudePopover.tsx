import { useState } from "react";
import { useStore } from "../store";
import { indicatorMeta, fmtTokens } from "./ClaudeStatusPill";
import type { PlanWindow } from "../store";

// Component names carry parenthetical hosts (e.g. "Claude API (api.anthropic.com)"),
// so rank by prefix, not exact match.
const PRIORITY = ["Claude Code", "Claude API", "claude.ai"];
function priorityRank(name: string): number {
  const i = PRIORITY.findIndex((p) => name.startsWith(p));
  return i === -1 ? 99 : i;
}

function componentDotClass(status: string): string {
  if (status === "operational") return "ok";
  if (status === "degraded_performance" || status === "under_maintenance") return "minor";
  if (status === "partial_outage") return "major";
  if (status === "major_outage") return "critical";
  return "unknown";
}

/** Numeric epoch → "3:41pm" (today) / "Mon" (later). Detects sec vs ms. Never throws. */
function shortReset(epoch: number | null): string {
  if (epoch == null || !isFinite(epoch)) return "";
  const ms = epoch < 1e12 ? epoch * 1000 : epoch; // seconds vs milliseconds
  const d = new Date(ms);
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
        <span>{pct}%{reset ? ` · resets ${reset}` : ""}</span>
      </div>
      <div className="claude-meter-bar">
        <div className={`claude-meter-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function ClaudePopover() {
  const status = useStore((s) => s.claudeStatus);
  const usage = useStore((s) => s.claudeUsage);
  const connectPlan = useStore((s) => s.connectPlanUsage);
  const [connecting, setConnecting] = useState(false);

  const meta = indicatorMeta(status?.indicator);

  const components = [...(status?.components ?? [])].sort(
    (a, b) => priorityRank(a.name) - priorityRank(b.name),
  );

  const onConnect = async () => {
    setConnecting(true);
    try { await connectPlan(); } finally { setConnecting(false); }
  };

  return (
    <div>
      {/* ---- Status ---- */}
      <div className="claude-pop-title">
        <span className={`claude-dot ${meta.cls}`} />
        <span>{status?.description || meta.label}</span>
      </div>

      {components.length > 0 && (
        <div className="claude-pop-section">
          {components.map((c) => (
            <div className="claude-pop-row" key={c.name}>
              <span className={`claude-dot ${componentDotClass(c.status)}`} />
              <span className="name">{c.name}</span>
              <span className="claude-pop-muted">{c.status.replace(/_/g, " ")}</span>
            </div>
          ))}
        </div>
      )}

      {status?.incidents && status.incidents.length > 0 && (
        <div className="claude-pop-section">
          {status.incidents.map((i) => (
            <div className="claude-incident" key={i.name}>
              <div>{i.name}</div>
              <div className="claude-pop-muted">
                {i.status}
                {i.shortlink ? <> · <a href={i.shortlink} target="_blank" rel="noreferrer">details</a></> : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- Usage ---- */}
      <div className="claude-pop-section">
        <div className="claude-pop-title">Usage</div>

        {usage?.plan && usage.plan.length > 0 ? (
          usage.plan.map((w) => <Meter key={w.label} w={w} />)
        ) : (
          <>
            {usage?.local && usage.local.totalTokens > 0 ? (
              <>
                <div className="claude-pop-row">
                  <span className="name">Today</span>
                  <span>{fmtTokens(usage.local.totalTokens)} tokens</span>
                </div>
                {usage.local.tokensByModel.slice(0, 4).map((m) => (
                  <div className="claude-pop-row" key={m.model}>
                    <span className="name claude-pop-muted">{m.model}</span>
                    <span className="claude-pop-muted">{fmtTokens(m.tokens)}</span>
                  </div>
                ))}
                <div className="claude-pop-row claude-pop-muted">
                  <span className="name">Sessions {usage.local.sessions}</span>
                  <span>Messages {usage.local.messages}</span>
                </div>
              </>
            ) : (
              <div className="claude-pop-muted">No local usage data yet.</div>
            )}
            <button className="claude-connect-btn" onClick={onConnect} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect plan usage"}
            </button>
            {usage?.planSource === "unavailable" && (
              <div className="claude-pop-muted" style={{ marginTop: 6 }}>
                Plan limits unavailable — showing local usage.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
