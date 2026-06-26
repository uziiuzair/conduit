import { useStore } from "../store";

// Dev-relevant components — a degradation here is worth warning about even if the
// overall indicator hasn't tripped yet.
const KEY = ["Claude Code", "Claude API", "claude.ai"];

/** A banner pinned at the top of the sidebar that appears ONLY when Claude's service
 *  status is degraded (overall indicator minor/major/critical, or a key component not
 *  operational). Renders nothing when all is well or status is unknown. */
export function ClaudeStatusWarning() {
  const status = useStore((s) => s.claudeStatus);
  // No data, or the fetch failed → don't show a scary banner for "we couldn't reach it".
  if (!status || !status.ok) return null;

  const degradedKey = status.components.filter(
    (c) => KEY.some((k) => c.name.startsWith(k)) && c.status !== "operational",
  );
  const indicatorIssue =
    status.indicator === "minor" ||
    status.indicator === "major" ||
    status.indicator === "critical";

  if (!indicatorIssue && degradedKey.length === 0) return null;

  const severe = status.indicator === "major" || status.indicator === "critical";
  const cls = severe ? "critical" : "minor";

  // Prefer naming a degraded key component; else fall back to the overall description.
  const headline =
    degradedKey.length > 0
      ? `${degradedKey[0].name.replace(/\s*\(.*\)/, "")} — ${degradedKey[0].status.replace(/_/g, " ")}`
      : status.description || "Claude service issue";

  const link = status.incidents[0]?.shortlink || "https://status.claude.com";

  return (
    <a
      className={`claude-warning ${cls}`}
      href={link}
      target="_blank"
      rel="noreferrer"
      title="Open status.claude.com"
    >
      <span className="claude-warning-icon">⚠</span>
      <span className="claude-warning-text">{headline}</span>
    </a>
  );
}
