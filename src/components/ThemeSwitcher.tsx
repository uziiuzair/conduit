import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { THEMES, type ThemeId, type ThemePref } from "../themes";

const ORDER: ThemeId[] = ["warm-light", "warm-dim", "warm-near-black"];

/** Small swatch trio: panel bg / sidebar bg / accent. */
function Swatches({ id }: { id: ThemeId }) {
  const v = THEMES[id].cssVars;
  return (
    <span className="theme-swatches">
      <span style={{ background: v["--panel-bg"] }} />
      <span style={{ background: v["--sidebar-bg"] }} />
      <span style={{ background: v["--accent"] }} />
    </span>
  );
}

export function ThemeSwitcher() {
  const themePref = useStore((s) => s.themePref);
  const activeThemeId = useStore((s) => s.activeThemeId);
  const setThemePref = useStore((s) => s.setThemePref);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (pref: ThemePref) => {
    setThemePref(pref);
    setOpen(false);
  };

  return (
    <div className="theme-switcher" ref={wrapRef}>
      {open && (
        <div className="theme-popover" onClick={(e) => e.stopPropagation()}>
          <div className="theme-popover-title">Theme</div>
          {ORDER.map((id) => (
            <button key={id} className="theme-row" onClick={() => pick(id)}>
              <Swatches id={id} />
              <span className="theme-row-label">{THEMES[id].label}</span>
              {themePref === id && <span className="theme-check">✓</span>}
            </button>
          ))}
          <div className="theme-popover-divider" />
          <button className="theme-row" onClick={() => pick("auto")}>
            <Swatches id={activeThemeId} />
            <span className="theme-row-label">Auto · match macOS</span>
            {themePref === "auto" && <span className="theme-check">✓</span>}
          </button>
        </div>
      )}
      <button
        className="theme-btn"
        title="Theme"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        ◐
      </button>
    </div>
  );
}
