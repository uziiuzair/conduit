import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { fuzzyFilter, type FuzzyMatch } from "../fuzzy";
import { dirPrefix, joinPath } from "../paths";

const RESULT_LIMIT = 50;

interface Props {
  projectId: string;
  /** Project root the file list is relative to. */
  dir: string;
  onClose: () => void;
}

/** Render `path` with the fuzzy-matched chars highlighted. */
function Highlighted({ path, indices }: { path: string; indices: number[] }) {
  if (indices.length === 0) return <>{path}</>;
  const marks = new Set(indices);
  return (
    <>
      {[...path].map((ch, i) =>
        marks.has(i) ? (
          <span key={i} className="palette-mark">
            {ch}
          </span>
        ) : (
          ch
        ),
      )}
    </>
  );
}

/**
 * ⌘P Go to File — fuzzy filter over `git ls-files` (bounded walk outside repos).
 * Enter opens as a PREVIEW tab, same semantics as a single tree click. The empty
 * query shows the MRU list so ⌘P↵ bounces between recent files.
 */
export function QuickOpen({ projectId, dir, onClose }: Props) {
  const openFile = useStore((s) => s.openFile);
  const recent = useStore((s) => s.recentFiles[projectId]);
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    invoke<string[]>("list_project_files", { dir })
      .then((f) => {
        if (alive) setFiles(f);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [dir]);

  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo<FuzzyMatch[]>(() => {
    if (query.trim()) return fuzzyFilter(query.trim(), files, RESULT_LIMIT);
    // Empty query: MRU, shown project-relative when under the root.
    const prefix = dirPrefix(dir);
    return (recent ?? [])
      .filter((p) => p.startsWith(prefix))
      .map((p) => ({ path: p.slice(prefix.length), score: 0, indices: [] }))
      .slice(0, RESULT_LIMIT);
  }, [query, files, recent, dir]);

  // Clamp the selection whenever the result set shrinks under it.
  const selIdx = Math.min(sel, Math.max(0, results.length - 1));

  const open = (rel: string) => {
    openFile(projectId, joinPath(dir, rel), { preview: true });
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel(Math.min(selIdx + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel(Math.max(selIdx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[selIdx];
      if (hit) open(hit.path);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // Keep the selected row scrolled into view as the arrows move it.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${selIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selIdx]);

  return (
    <div className="dialog-overlay palette-overlay" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Go to file…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <div className="palette-list" ref={listRef}>
          {results.map((r, i) => (
            <div
              key={r.path}
              data-idx={i}
              className={`palette-row${i === selIdx ? " selected" : ""}`}
              onMouseDown={(e) => e.preventDefault() /* keep input focus */}
              onClick={() => open(r.path)}
            >
              <span className="palette-file">
                <Highlighted path={r.path} indices={r.indices} />
              </span>
            </div>
          ))}
          {results.length === 0 && (
            <div className="palette-empty">
              {query.trim() ? "No matching files" : "No recent files — start typing"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
