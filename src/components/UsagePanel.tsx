import { useMemo, useState } from "react";
import {
  useStore,
  globalSelectedSessionId,
  findSession,
  resolvedAccountKey,
  type UsagePrefs,
} from "../store";
// The row shapes and the "how full is this account" arithmetic live outside this file so
// the ROUTER can share them -- see usageRows.ts.
import {
  agyRow,
  claudeRow,
  commandCodeRow,
  meterView,
  type URow,
  type UsageMetric,
  type UWindow,
} from "../usageRows";
import { AgentGlyph } from "./AgentGlyph";
import { fmtTokens } from "./ClaudeStatusPill";
import { agentMeta, type AgentId } from "../agents";

/** RFC3339 → "3:41pm" (today) / "Mon" (later). Never throws. */
function shortReset(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { weekday: "short" });
}

/**
 * One meter, laid out like the agents lay out their own: `label ······ 18% used · resets 3:50pm`,
 * bar underneath filling in the same direction the number counts.
 *
 * The number and the bar both come from a single `meterView` call, which is the whole point
 * of that function — they used to be computed separately here and pointed opposite ways.
 */
function Meter({ w, metric, threshold }: { w: UWindow; metric: UsageMetric; threshold: number }) {
  const v = meterView(w, metric);
  const reset = shortReset(w.resetsAt);
  const text = w.disabled ? "disabled" : `${v.pct}% ${v.word}`;
  const fillPct = w.disabled ? 0 : v.fraction * 100;
  // Smooth ramp: tint the fill from the agent's base color (var(--meter-base)) toward muted
  // red as CONSUMPTION approaches full. Keyed on severity, not on the drawn fraction, so a
  // meter reading "left" still reddens when it runs low instead of when it runs full. Ramp
  // begins where the amber warn tier used to (100 - 2*threshold) and hits full red at 100%,
  // so the Settings low-threshold slider still steers the onset.
  const severityPct = v.severity * 100;
  const rampStart = Math.max(0, 100 - Math.min(50, threshold * 200));
  const redWeight = w.disabled
    ? 0
    : Math.round(
        Math.max(0, Math.min(1, (severityPct - rampStart) / (100 - rampStart || 1))) * 100,
      );
  // disabled keeps its gray (via the class); context keeps its dimmed opacity, because it
  // is not a quota and should not compete with the windows that are.
  const fillClass = w.disabled ? "disabled" : w.quota ? "" : "ctx";
  return (
    <div className="usage-meter">
      <div className="usage-meter-head">
        <span>{w.label}</span>
        <span>
          {text}
          {reset ? ` · resets ${reset}` : ""}
        </span>
      </div>
      <div className="usage-meter-bar">
        <div
          className={`usage-meter-fill ${fillClass}`}
          style={{
            // Scaled rather than width-sized — see .usage-meter-fill.
            transform: `scaleX(${fillPct / 100})`,
            background: `color-mix(in srgb, var(--red) ${redWeight}%, var(--meter-base))`,
          }}
        />
      </div>
    </div>
  );
}

function RowBlock({
  row,
  prefs,
  threshold,
}: {
  row: URow;
  prefs: UsagePrefs;
  threshold: number;
}) {
  const connectPlanUsage = useStore((s) => s.connectPlanUsage);
  // planConnected[key] === false means we tried and found no readable sign-in for this
  // account (undefined = never attempted).
  const connectFailed = useStore((s) => s.planConnected[row.key] === false);
  const wins = row.windows.filter((w) => prefs.windows[w.kind]);
  return (
    <div className={`usage-row ${row.agent}`}>
      <div className="usage-row-head">
        <AgentGlyph id={row.agent} size={13} />
        <span className="usage-row-label">{row.label}</span>
        {row.tier && <span className="usage-tier-chip">{row.tier}</span>}
      </div>
      {row.connectable ? (
        <>
          {row.localTotal ? (
            <div className="usage-local">{fmtTokens(row.localTotal)} tokens used (local)</div>
          ) : null}
          <button className="usage-connect-btn" onClick={() => void connectPlanUsage(row.accountId)}>
            {connectFailed || row.planSource === "unavailable" ? "Retry plan usage" : "Connect plan usage"}
          </button>
          {connectFailed ? (
            <div className="usage-local">
              No sign-in found for this account. Open a session on it and run claude to sign in,
              or re-add the correct .claude folder.
            </div>
          ) : row.planSource === "unavailable" ? (
            <div className="usage-local">
              Plan limits unreachable (offline, or the saved sign-in expired). Running a Claude
              session on this account refreshes its sign-in; if it doesn't recover on its own,
              click Retry plan usage.
            </div>
          ) : null}
        </>
      ) : wins.length === 0 ? (
        <div className="usage-hint">No windows match your filter.</div>
      ) : (
        wins.map((w) => (
          <Meter key={w.key} w={w} metric={prefs.metric} threshold={threshold} />
        ))
      )}
    </div>
  );
}

/**
 * The one number the collapsed summary shows, in the SAME direction as the expanded
 * meters. `minRemaining` is the row's worst window, so under "used" that is its most-used
 * one -- the collapsed and expanded views must not disagree about which way is worse.
 */
function summaryText(row: URow, metric: UsageMetric): string {
  return metric === "used"
    ? `${Math.round((1 - row.minRemaining) * 100)}% used`
    : `${Math.round(row.minRemaining * 100)}% left`;
}

/** Dot color for the summary layout, from a row's least-remaining window. */
function summaryDotClass(row: URow, threshold: number): string {
  if (row.minRemaining <= threshold) return "hot";
  if (row.minRemaining <= Math.min(0.5, threshold * 2)) return "warn";
  return "ok";
}

/**
 * The unified, user-configurable usage bar. Shows every active account's quota (Claude +
 * agy) keyed per account, rendered per the user's UsagePrefs (layout / window filter / sort
 * / low threshold). Replaces the two agent-gated panels; with the default "selected" layout
 * and a single account it looks exactly like the pre-multi-account panel.
 */
export function UsagePanel() {
  const claudeUsage = useStore((s) => s.claudeUsage);
  const agyMap = useStore((s) => s.agyUsageByAccount);
  const commandCodeUsage = useStore((s) => s.commandCodeUsage);
  const prefs = useStore((s) => s.usagePrefs);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const setSettingsTab = useStore((s) => s.setSettingsTab);
  // Selected session's agent + account (for the "selected" layout). Select STABLE values
  // (a primitive id + the store's own array/object refs) and derive the object via useMemo
  // -- a selector that returns a fresh object every call makes Zustand's useSyncExternalStore
  // loop forever ("Maximum update depth exceeded" / React #185).
  const selectedSessionId = useStore((s) => globalSelectedSessionId(s));
  const projects = useStore((s) => s.projects);
  const defaultAccounts = useStore((s) => s.defaultAccounts);
  const selected = useMemo(() => {
    if (!selectedSessionId) return null;
    const found = findSession(projects, selectedSessionId);
    if (!found) return null;
    return {
      agent: found.session.agent,
      key: resolvedAccountKey(defaultAccounts, found.project, found.session),
    };
  }, [selectedSessionId, projects, defaultAccounts]);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const threshold = Math.max(0, Math.min(1, prefs.lowThresholdPct / 100));

  // Build all rows, then sort.
  let rows: URow[] = [
    ...claudeUsage.map(claudeRow),
    ...Object.values(agyMap).map(agyRow),
    // A signed-out account has no windows to draw and nothing actionable in this panel,
    // so it is left out entirely rather than rendered as an empty row.
    ...commandCodeUsage.filter((u) => u.usage.windows?.length).map(commandCodeRow),
  ];
  rows.sort((a, b) =>
    prefs.sort === "label"
      ? a.label.localeCompare(b.label)
      : a.minRemaining - b.minRemaining,
  );

  const openSettings = () => {
    setSettingsTab("usage");
    setShowSettings(true);
  };

  // ---- "selected": just the selected session's account+agent (today's single panel) ----
  if (prefs.layout === "selected") {
    const row = selected
      ? rows.find((r) => r.agent === selected.agent && r.key === selected.key) ??
        rows.find((r) => r.agent === selected.agent)
      : null;
    return (
      <div className="usage-panel">
        <Header onGear={openSettings} />
        <ConnectAllStrip />
        {row ? (
          <RowBlock row={row} prefs={prefs} threshold={threshold} />
        ) : (
          <SelectedEmptyHint agent={selected?.agent} />
        )}
      </div>
    );
  }

  // ---- "lowAlertOnly": only accounts at/below the low threshold ----
  if (prefs.layout === "lowAlertOnly") {
    const low = rows.filter((r) => r.minRemaining <= threshold);
    return (
      <div className="usage-panel">
        <Header onGear={openSettings} count={rows.length} />
        <ConnectAllStrip />
        {low.length === 0 ? (
          <div className="usage-hint">All accounts healthy (above {prefs.lowThresholdPct}%).</div>
        ) : (
          low.map((r) => (
            <RowBlock key={`${r.agent}:${r.key}`} row={r} prefs={prefs} threshold={threshold} />
          ))
        )}
      </div>
    );
  }

  // ---- "summary": one line per account (agent glyph + health dot + min remaining) ----
  if (prefs.layout === "summary" && !summaryOpen) {
    return (
      <div className="usage-panel">
        <Header onGear={openSettings} count={rows.length} onToggle={() => setSummaryOpen(true)} open={false} />
        <ConnectAllStrip />
        {rows.length === 0 ? (
          <div className="usage-hint">No usage yet.</div>
        ) : (
          <div className="usage-summary" onClick={() => setSummaryOpen(true)}>
            {rows.map((r) => (
              <span
                key={`${r.agent}:${r.key}`}
                className={`usage-summary-item ${r.agent}`}
                title={`${agentMeta(r.agent).label} · ${r.label}`}
              >
                <AgentGlyph id={r.agent} size={12} />
                <span className={`usage-dot ${summaryDotClass(r, threshold)}`} />
                <span className="usage-summary-label">{r.label}</span>
                {r.connectable ? "—" : summaryText(r, prefs.metric)}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---- "stacked" (and expanded "summary"): every account, full meters ----
  return (
    <div className="usage-panel">
      <Header
        onGear={openSettings}
        count={rows.length}
        onToggle={prefs.layout === "summary" ? () => setSummaryOpen(false) : undefined}
        open
      />
      <ConnectAllStrip />
      {rows.length === 0 ? (
        <div className="usage-hint">No usage yet.</div>
      ) : (
        rows.map((r) => (
          <RowBlock key={`${r.agent}:${r.key}`} row={r} prefs={prefs} threshold={threshold} />
        ))
      )}
    </div>
  );
}

/** One-click strip: connect every Claude account's plan usage + enable agy tracking. Hidden
 *  once every Claude account is connected AND agy tracking is on (nothing left to do). */
function ConnectAllStrip() {
  const claudeUsage = useStore((s) => s.claudeUsage);
  const agyTracking = useStore((s) => s.agyUsageTracking);
  const connectAll = useStore((s) => s.connectAllUsage);
  const [busy, setBusy] = useState(false);
  const anyClaudeConnectable = claudeUsage.some((c) => c.usage.plan == null);
  if (!anyClaudeConnectable && agyTracking) return null;
  return (
    <button
      className="usage-connect-all"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await connectAll();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Connecting…" : agyTracking ? "Connect all accounts" : "Connect all (incl. agy)"}
    </button>
  );
}

/** Empty-state hint for the "selected" layout: distinguishes agy-tracking-off (offer enable)
 *  from tracking-on-but-no-data-yet (just needs a prompt). */
function SelectedEmptyHint({ agent }: { agent?: AgentId }) {
  const agyTracking = useStore((s) => s.agyUsageTracking);
  const setAgyTracking = useStore((s) => s.setAgyUsageTracking);
  if (agent === "antigravity") {
    return agyTracking ? (
      <div className="usage-hint">Send a message in this agy session to populate usage.</div>
    ) : (
      <div className="usage-hint">
        agy usage tracking is off.
        <button className="usage-connect-btn" onClick={() => void setAgyTracking(true)}>
          Enable agy usage
        </button>
      </div>
    );
  }
  return <div className="usage-hint">No usage yet for this session's account.</div>;
}

function Header({
  onGear,
  count,
  onToggle,
  open,
}: {
  onGear: () => void;
  count?: number;
  onToggle?: () => void;
  open?: boolean;
}) {
  return (
    <div className="usage-head">
      <span>Usage{typeof count === "number" && count > 1 ? ` · ${count} accounts` : ""}</span>
      <span className="usage-head-actions">
        {onToggle && (
          <button className="usage-icon-btn" onClick={onToggle} title={open ? "Collapse" : "Expand"}>
            {open ? "▾" : "▸"}
          </button>
        )}
        <button className="usage-icon-btn" onClick={onGear} title="Usage display settings">
          ⚙
        </button>
      </span>
    </div>
  );
}
