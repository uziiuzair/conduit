import { useMemo, useState } from "react";
import {
  useStore,
  globalSelectedSessionId,
  findSession,
  resolvedAccountKey,
  accountKey,
  type AgyUsage,
  type ClaudeAccountUsage,
  type UsagePrefs,
} from "../store";
import { AgentGlyph } from "./AgentGlyph";
import { fmtTokens } from "./ClaudeStatusPill";
import type { AgentId } from "../agents";

/** A window's kind, used both for the prefs filter and for labeling. */
type WinKind = "fiveHour" | "weekly" | "weeklyOpus" | "context";
/** A normalized meter across agents: "remaining" (Claude plan / agy quota) or "used" (context). */
interface UWindow {
  key: string;
  label: string;
  kind: WinKind;
  /** Pool this window belongs to (agy has redundant pools: "Gemini Models", "Claude & GPT
   *  Models"). Used to ignore a whole unavailable pool in the summary metric. */
  group: string;
  mode: "remaining" | "used";
  value: number; // 0..1 (remaining fraction, or used fraction for context)
  resetsAt: string | null;
  disabled: boolean;
}

/** The single "how healthy is this account" number for the summary/sort/low-alert. It's the
 *  minimum remaining across windows, BUT a pool whose windows are all disabled or at 0 is
 *  treated as structurally unavailable (e.g. agy's Claude/GPT pool on a Pro tier) and ignored
 *  -- so one unavailable pool can't paint an otherwise-healthy account red. A genuinely low
 *  window in a live pool still drives the number down. */
function summaryRemaining(windows: UWindow[]): number {
  const byGroup = new Map<string, UWindow[]>();
  for (const w of windows) {
    if (w.mode !== "remaining") continue;
    const arr = byGroup.get(w.group) ?? [];
    arr.push(w);
    byGroup.set(w.group, arr);
  }
  if (byGroup.size === 0) return 1;
  const groupMins: number[] = [];
  for (const ws of byGroup.values()) {
    const live = ws.filter((w) => !w.disabled);
    if (live.length === 0) continue; // whole pool disabled
    if (Math.max(...live.map((w) => w.value)) <= 0) continue; // whole pool exhausted/unavailable
    groupMins.push(Math.min(...live.map((w) => w.value)));
  }
  return groupMins.length ? Math.min(...groupMins) : 0;
}
interface URow {
  agent: AgentId;
  key: string; // account key
  accountId: string | null;
  label: string;
  windows: UWindow[];
  /** Claude only: present when plan limits couldn't be fetched (offer a Connect button). */
  connectable: boolean;
  planSource?: string;
  tier?: string | null;
  /** Claude local token total (from stats-cache.json), shown even before plan-connect. */
  localTotal?: number;
  /** Least remaining across non-context, non-disabled windows (1 = healthy / unknown). */
  minRemaining: number;
}

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

function claudeKind(label: string): WinKind {
  if (label.includes("Opus")) return "weeklyOpus";
  if (label.toLowerCase().includes("week")) return "weekly";
  return "fiveHour";
}
function agyKind(label: string): WinKind {
  return label.toLowerCase().includes("week") ? "weekly" : "fiveHour";
}

function claudeRow(entry: ClaudeAccountUsage): URow {
  const plan = entry.usage.plan;
  const windows: UWindow[] = (plan ?? []).map((w, i) => ({
    key: `${w.label}-${i}`,
    label: w.label,
    kind: claudeKind(w.label),
    group: "plan", // Claude's windows are distinct limits, treated as one pool.
    mode: "remaining",
    value: Math.max(0, Math.min(1, 1 - w.pctUsed)),
    resetsAt: w.resetsAt,
    disabled: false,
  }));
  return {
    agent: "claude",
    key: accountKey(entry.accountId),
    accountId: entry.accountId,
    label: entry.label,
    windows,
    connectable: plan == null,
    planSource: entry.usage.planSource,
    localTotal: entry.usage.local.totalTokens,
    minRemaining: summaryRemaining(windows),
  };
}

function agyRow(u: AgyUsage): URow {
  const windows: UWindow[] = [];
  for (const g of u.groups) {
    const short = g.displayName.startsWith("Gemini")
      ? "Gemini"
      : g.displayName.startsWith("Claude")
        ? "Claude/GPT"
        : g.displayName;
    for (const b of g.buckets) {
      windows.push({
        key: b.bucketId,
        label: `${short} ${b.label}`,
        kind: agyKind(b.label),
        group: g.displayName,
        mode: "remaining",
        value: Math.max(0, Math.min(1, b.remainingFraction)),
        resetsAt: b.resetsAt,
        disabled: b.disabled,
      });
    }
  }
  if (u.context && u.context.contextWindowSize > 0) {
    windows.push({
      key: "context",
      label: "Context",
      kind: "context",
      group: "context",
      mode: "used",
      value: Math.max(0, Math.min(1, u.context.usedPercentage / 100)),
      resetsAt: null,
      disabled: false,
    });
  }
  return {
    agent: "antigravity",
    key: accountKey(u.accountId),
    accountId: u.accountId,
    label: u.email ? u.email.split("@")[0] : "Antigravity",
    windows,
    connectable: false,
    tier: u.planTier,
    minRemaining: summaryRemaining(windows),
  };
}

function Meter({ w, threshold }: { w: UWindow; threshold: number }) {
  const pct = Math.round(w.value * 100);
  const reset = shortReset(w.resetsAt);
  const text = w.disabled ? "disabled" : w.mode === "used" ? `${pct}% used` : `${pct}% left`;
  // Bar fills with consumption: "remaining" windows show the used amount (100 - remaining),
  // "used"/context windows already track consumption. Label still reads "% left".
  const fillPct = w.disabled ? 0 : w.mode === "remaining" ? 100 - pct : pct;
  // Smooth ramp: tint the fill from the agent's base color (var(--meter-base)) toward muted
  // red as it approaches full. Ramp begins where the amber warn tier used to (100 - 2*threshold)
  // and hits full red at 100%, so the Settings low-threshold slider still steers the onset.
  const rampStart = Math.max(0, 100 - Math.min(50, threshold * 200));
  const redWeight = w.disabled
    ? 0
    : Math.round(Math.max(0, Math.min(1, (fillPct - rampStart) / (100 - rampStart || 1))) * 100);
  // disabled keeps its gray (via the class); ctx keeps its dimmed opacity.
  const fillClass = w.disabled ? "disabled" : w.mode === "used" ? "ctx" : "";
  return (
    <div className="usage-meter">
      <div className="usage-meter-head">
        <span>{w.label}</span>
        <span>
          {text}
          {reset ? ` · ${reset}` : ""}
        </span>
      </div>
      <div className="usage-meter-bar">
        <div
          className={`usage-meter-fill ${fillClass}`}
          style={{
            width: `${fillPct}%`,
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
          {connectFailed && (
            <div className="usage-local">
              No sign-in found for this account. Open a session on it and run claude to sign in,
              or re-add the correct .claude folder.
            </div>
          )}
        </>
      ) : wins.length === 0 ? (
        <div className="usage-hint">No windows match your filter.</div>
      ) : (
        wins.map((w) => <Meter key={w.key} w={w} threshold={threshold} />)
      )}
    </div>
  );
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
  let rows: URow[] = [...claudeUsage.map(claudeRow), ...Object.values(agyMap).map(agyRow)];
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
                title={`${r.agent === "antigravity" ? "agy" : "Claude"} · ${r.label}`}
              >
                <AgentGlyph id={r.agent} size={12} />
                <span className={`usage-dot ${summaryDotClass(r, threshold)}`} />
                <span className="usage-summary-label">{r.label}</span>
                {r.connectable ? "—" : `${Math.round(r.minRemaining * 100)}%`}
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
