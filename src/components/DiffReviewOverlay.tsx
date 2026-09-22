// The IDE openDiff review pane (2026-09-23 spec). Covers the session's terminal the
// way SessionChat does — an absolutely positioned sibling inside `.term-host` — so
// the xterm underneath stays mounted and attached (keep-alive rule).
//
// The MODIFIED side is editable on purpose: the protocol's accept reply carries the
// final contents back to claude (`[FILE_SAVED, <contents>]`), which is how edits made
// during review reach the file. Conduit itself NEVER writes the file — claude does,
// from the returned text.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";
import { monaco, languageFor } from "../monaco/setup";
import { useStore, baseName, type FileContent } from "../store";
import type { PendingDiff } from "../ideBridge";

const EDITOR_BASE_FONT = 13;

export function DiffReviewOverlay({ diff }: { diff: PendingDiff }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{ o: Monaco.editor.ITextModel; m: Monaco.editor.ITextModel } | null>(
    null,
  );
  const ideDiffResolved = useStore((s) => s.ideDiffResolved);
  const fontZoom = useStore((s) => s.fontZoom);
  const [busy, setBusy] = useState(false);

  const settle = (keep: boolean) => {
    if (busy) return;
    setBusy(true);
    const contents = keep
      ? (modelsRef.current?.m.getValue() ?? diff.newFileContents)
      : null;
    void invoke("ide_diff_verdict", {
      sessionId: diff.sessionId,
      diffId: diff.diffId,
      keep,
      contents,
    }).finally(() => ideDiffResolved(diff.sessionId, diff.diffId));
  };

  // One diff editor per mounted overlay; the component remounts per diffId (key on
  // the caller), so create-once-in-an-effect with [] deps is correct here.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    const language = languageFor(diff.newFilePath);
    // Original = what is on disk NOW (empty for a new file). Read through the same
    // command CodeEditorPane uses so caps/binary handling stay consistent.
    void invoke<FileContent>("read_file", { path: diff.oldFilePath })
      .then((fc) => (fc.error || fc.binary ? "" : fc.content))
      .catch(() => "")
      .then((original) => {
        if (!alive || !hostRef.current) return;
        const size = EDITOR_BASE_FONT + useStore.getState().fontZoom;
        const o = monaco.editor.createModel(original, language);
        const m = monaco.editor.createModel(diff.newFileContents, language);
        modelsRef.current = { o, m };
        const ed = monaco.editor.createDiffEditor(hostRef.current, {
          automaticLayout: true,
          fontFamily: '"SF Mono", SFMono-Regular, Menlo, monospace',
          fontSize: size,
          lineHeight: Math.round(size * 1.5),
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          renderSideBySide: true,
          originalEditable: false,
        });
        ed.setModel({ original: o, modified: m });
        editorRef.current = ed;
      });
    return () => {
      alive = false;
      editorRef.current?.dispose();
      editorRef.current = null;
      modelsRef.current?.o.dispose();
      modelsRef.current?.m.dispose();
      modelsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff.diffId]);

  // Font-zoom changes just restyle the live editor — never recreate it.
  useEffect(() => {
    const size = EDITOR_BASE_FONT + fontZoom;
    editorRef.current?.updateOptions({ fontSize: size, lineHeight: Math.round(size * 1.5) });
  }, [fontZoom]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        settle(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff.diffId, busy]);

  return (
    <div className="diff-review-overlay">
      <div className="diff-review-header">
        <span className="diff-review-title">
          Claude proposes changes — <strong>{baseName(diff.newFilePath)}</strong>
        </span>
        <span className="diff-review-tab" title={diff.tabName}>
          {diff.tabName}
        </span>
        <div className="diff-review-actions">
          <button disabled={busy} onClick={() => settle(false)}>
            Reject
          </button>
          <button className="primary" disabled={busy} onClick={() => settle(true)}>
            Keep
          </button>
        </div>
      </div>
      <div ref={hostRef} className="diff-review-editor" />
    </div>
  );
}
