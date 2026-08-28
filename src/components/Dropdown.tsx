import { Fragment, useEffect, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  label: string;
  /** Render this option dimmed and unpickable (e.g. a placeholder row). */
  disabled?: boolean;
  /**
   * Section this option belongs to — the `<optgroup>` this component replaces. A run of
   * consecutive options sharing a group gets one non-interactive header row above it, so
   * the grouping has to be expressed by ORDER, exactly as `<optgroup>` required.
   */
  group?: string;
  /** Tooltip for the row, i.e. the native `<option title>`. */
  hint?: string;
}

/**
 * Fully custom dropdown — replaces every native `<select>` in the app. A styled
 * `<select>` still opens the OS popup menu, which is exactly the system UI Conduit
 * bans from its chrome; this draws its own popover (ThemeSwitcher's pattern:
 * outside-mousedown + Escape close, stopPropagation so sidebar/global click handlers
 * don't eat the toggle).
 *
 * Values are plain strings; use "" for the "unset" option like the selects it
 * replaces did. `up` opens the menu above the trigger (needed at the sidebar footer).
 */
export function Dropdown({
  value,
  options,
  onChange,
  className = "",
  title,
  up = false,
  disabled = false,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  /** Extra class on the wrapper for site-specific sizing (e.g. "dd-fill"). */
  className?: string;
  title?: string;
  up?: boolean;
  disabled?: boolean;
}) {
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

  const current = options.find((o) => o.value === value);

  return (
    <div className={`dd ${className}`} ref={wrapRef}>
      <button
        type="button"
        className={`dd-trigger ${open ? "open" : ""}`}
        title={title}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <span className="dd-label">{current?.label ?? value}</span>
        <svg className="dd-caret" width="10" height="6" viewBox="0 0 10 6" aria-hidden>
          <path
            d="M1 1l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className={`dd-menu ${up ? "up" : ""}`} onClick={(e) => e.stopPropagation()}>
          {options.map((o, i) => (
            <Fragment key={o.value}>
              {o.group && o.group !== options[i - 1]?.group && (
                <div className="dd-group">{o.group}</div>
              )}
              <button
                type="button"
                className={`dd-row ${o.value === value ? "sel" : ""}`}
                disabled={o.disabled}
                title={o.hint}
                onClick={() => {
                  setOpen(false);
                  if (o.value !== value) onChange(o.value);
                }}
              >
                <span className="dd-check">{o.value === value ? "✓" : ""}</span>
                <span className="dd-row-label">{o.label}</span>
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
