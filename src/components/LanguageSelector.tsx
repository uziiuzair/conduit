import { useEffect, useMemo, useRef, useState } from "react";
import { monaco } from "../monaco/setup";

interface LanguageSelectorProps {
  value: string; // current monaco language id
  onChange: (id: string) => void;
  disabled?: boolean;
}

interface LangEntry {
  id: string;
  label: string;
}

/**
 * VSCode-like language-mode picker for the editor breadcrumb: shows the current
 * language and, on click, opens a searchable dropdown of every Monaco language
 * registered via setup.ts's basic-languages imports. Session-scoped only — no
 * persistence; auto-detection (languageFor) still sets the initial language per file.
 */
export function LanguageSelector({ value, onChange, disabled }: LanguageSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const langs = useMemo<LangEntry[]>(
    () =>
      monaco.languages
        .getLanguages()
        .map((l) => ({ id: l.id, label: (l.aliases && l.aliases[0]) || l.id }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return langs;
    return langs.filter((l) => l.id.toLowerCase().includes(q) || l.label.toLowerCase().includes(q));
  }, [langs, query]);

  const currentLabel = useMemo(() => langs.find((l) => l.id === value)?.label ?? value, [langs, value]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="lang-select" ref={rootRef}>
      <button
        className="lang-select-btn"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title="Select language mode"
      >
        {currentLabel}
        <span className="lang-select-caret">▾</span>
      </button>
      {open && (
        <div className="lang-select-menu">
          <input
            ref={inputRef}
            className="lang-select-search"
            placeholder="Select language…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="lang-select-list">
            {filtered.map((l) => (
              <button
                key={l.id}
                className={`lang-select-item${l.id === value ? " active" : ""}`}
                onClick={() => pick(l.id)}
              >
                <span className="lang-select-item-label">{l.label}</span>
                <span className="lang-select-item-id">{l.id}</span>
              </button>
            ))}
            {filtered.length === 0 && <div className="lang-select-empty">No match</div>}
          </div>
        </div>
      )}
    </div>
  );
}
