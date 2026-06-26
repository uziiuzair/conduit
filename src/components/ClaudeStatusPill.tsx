import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useClaudeAmbient } from "../hooks/useClaudeAmbient";
import { ClaudePopover } from "./ClaudePopover";

/** Maps a Statuspage indicator to a dot class + a short human label. */
export function indicatorMeta(indicator: string | undefined): { cls: string; label: string } {
  switch (indicator) {
    case "none": return { cls: "ok", label: "All systems operational" };
    case "minor": return { cls: "minor", label: "Minor issues" };
    case "major": return { cls: "major", label: "Major outage" };
    case "critical": return { cls: "critical", label: "Critical outage" };
    default: return { cls: "unknown", label: "Status unknown" };
  }
}

/** Compact "1.2M" / "820K" token formatter. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "K";
  return String(n);
}

export function ClaudeStatusPill() {
  useClaudeAmbient(); // pill is always mounted → drives polling

  const status = useStore((s) => s.claudeStatus);
  const usage = useStore((s) => s.claudeUsage);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const meta = indicatorMeta(status?.indicator);

  // Compact usage figure: plan 5-hour % if live, else today's local token total.
  let usageLabel = "";
  if (usage?.plan && usage.plan.length > 0) {
    usageLabel = Math.round(usage.plan[0].pctUsed * 100) + "%";
  } else if (usage?.local && usage.local.totalTokens > 0) {
    usageLabel = fmtTokens(usage.local.totalTokens);
  }

  return (
    <div className="claude-pill-wrap" ref={wrapRef}>
      {open && (
        <div className="claude-popover" onClick={(e) => e.stopPropagation()}>
          <ClaudePopover />
        </div>
      )}
      <button
        className="claude-pill"
        title={meta.label}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        <span className={`claude-dot ${meta.cls}`} />
        {usageLabel && <span className="claude-pill-usage">{usageLabel}</span>}
      </button>
    </div>
  );
}
