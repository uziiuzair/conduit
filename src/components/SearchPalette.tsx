import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { joinPath } from "../paths";

const DEBOUNCE_MS = 250;

interface SearchHit {
  path: string;
  line: number;
  col: number;
  text: string;
}
interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
  backend: string;
}

interface Props {
  projectId: string;
  /** Directory the search runs under (hit paths are relative to it). */
  dir: string;
  onClose: () => void;
}

/** The matched line with the (case-insensitive, literal) query highlighted once. */
function HitLine({ text, query }: { text: string; query: string }) {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  const line = text.trimStart();
  const j = i - (text.length - line.length);
  if (i < 0 || j < 0) return <>{line}</>;
  return (
    <>
      {line.slice(0, j)}
      <span className="palette-mark">{line.slice(j, j + query.length)}</span>
      {line.slice(j + query.length)}
    </>
  );
}

/**
 * ⌘⇧F Find in Files — literal content search shelled to rg / git grep / grep.
 * Hits are grouped by file; Enter/click opens the file at the hit line via the
 * same pendingReveal plumbing terminal path-clicks use. No replace, by design.
 */
export function SearchPalette({ projectId, dir, onClose }: Props) {
  const openFile = useStore((s) => s.openFile);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResult(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    const seq = ++seqRef.current;
    const t = setTimeout(() => {
      invoke<SearchResult>("search_content", { dir, query: q })
        .then((r) => {
          if (seq !== seqRef.current) return; // stale response
          setResult(r);
          setSel(0);
        })
        .catch(() => {
          if (seq === seqRef.current) setResult({ hits: [], truncated: false, backend: "error" });
        })
        .finally(() => {
          if (seq === seqRef.current) setBusy(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, dir]);

  const hits = result?.hits ?? [];
  const selIdx = Math.min(sel, Math.max(0, hits.length - 1));

  /** Group consecutive hits by file for headers, keeping flat indices for keys. */
  const groups = useMemo(() => {
    const out: { path: string; items: { hit: SearchHit; idx: number }[] }[] = [];
    hits.forEach((hit, idx) => {
      const last = out[out.length - 1];
      if (last && last.path === hit.path) last.items.push({ hit, idx });
      else out.push({ path: hit.path, items: [{ hit, idx }] });
    });
    return out;
  }, [hits]);

  const open = (hit: SearchHit) => {
    const abs = joinPath(dir, hit.path);
    openFile(projectId, abs, { preview: true, reveal: { line: hit.line, col: hit.col } });
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel(Math.min(selIdx + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel(Math.max(selIdx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[selIdx];
      if (hit) open(hit);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${selIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selIdx]);

  const q = query.trim();
  return (
    <div className="dialog-overlay palette-overlay" onClick={onClose}>
      <div
        className="palette palette-search"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Find in files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <div className="palette-list" ref={listRef}>
          {groups.map((g) => (
            <div key={`${g.path}:${g.items[0].idx}`}>
              <div className="palette-group">{g.path}</div>
              {g.items.map(({ hit, idx }) => (
                <div
                  key={idx}
                  data-idx={idx}
                  className={`palette-row${idx === selIdx ? " selected" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => open(hit)}
                >
                  <span className="palette-line">{hit.line}</span>
                  <span className="palette-text">
                    <HitLine text={hit.text} query={q} />
                  </span>
                </div>
              ))}
            </div>
          ))}
          {hits.length === 0 && (
            <div className="palette-empty">
              {busy
                ? "Searching…"
                : q.length < 2
                  ? "Type at least 2 characters"
                  : result
                    ? "No matches"
                    : ""}
            </div>
          )}
        </div>
        {result && (result.truncated || hits.length > 0) && (
          <div className="palette-status">
            {hits.length} {hits.length === 1 ? "match" : "matches"}
            {result.truncated ? " (truncated — refine the query)" : ""}
          </div>
        )}
      </div>
    </div>
  );
}
