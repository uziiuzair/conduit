import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
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
  // Polling now lives in the always-mounted UsagePanel (the pill only shows for Claude
  // sessions, but usage must refresh for every account regardless of what's selected).
  const status = useStore((s) => s.claudeStatus);
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
      </button>
    </div>
  );
}
