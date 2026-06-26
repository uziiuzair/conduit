import { useStore } from "../store";
import { indicatorMeta } from "./ClaudeStatusPill";

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

/** Status-only popover (service components + active incidents). Usage lives in
 *  the persistent ClaudeUsagePanel at the bottom of the sidebar. */
export function ClaudePopover() {
  const status = useStore((s) => s.claudeStatus);
  const meta = indicatorMeta(status?.indicator);

  const components = [...(status?.components ?? [])].sort(
    (a, b) => priorityRank(a.name) - priorityRank(b.name),
  );

  return (
    <div>
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
    </div>
  );
}
