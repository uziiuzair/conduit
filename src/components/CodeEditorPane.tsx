import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";
import { monaco, languageFor, setLastFocusedEditor } from "../monaco/setup";
import * as registry from "../monaco/registry";
import { useStore, baseName, type FileContent } from "../store";
import { LanguageSelector } from "./LanguageSelector";

interface CodeEditorPaneProps {
  projectId: string;
  groupId: string;
  visible: boolean;
  style?: React.CSSProperties;
}

// Non-blocking overlay for the disk-conflict / deleted banners: absolutely positioned
// over the editor HOST only (not the breadcrumb), so it never reflows/obscures the
// filename + language selector and never requires unmounting the editor.
const bannerStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  zIndex: 5,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 8px",
  fontSize: 12,
  color: "inherit",
  background: "rgba(190, 150, 40, 0.20)",
  borderBottom: "1px solid rgba(255, 255, 255, 0.14)",
};

const bannerBtn: React.CSSProperties = {
  fontSize: 12,
  padding: "2px 8px",
  cursor: "pointer",
  color: "inherit",
  background: "rgba(255, 255, 255, 0.10)",
  border: "1px solid rgba(255, 255, 255, 0.22)",
  borderRadius: 4,
};

// Wraps just the editor HOST (not the breadcrumb) in a positioning context so the
// conflict banner overlays the top of the editor viewport only — never the filename +
// language selector above it — without touching the .code-host CSS/flex sizing.
const hostWrapStyle: React.CSSProperties = {
  position: "relative",
  flex: "1 1 auto",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

// Per-path load-result cache so banners survive tab switches without re-reading. Phase 2's
// reload path will refresh this; for Phase 1 a file is read once per open.
const EDIT_CAP = 8 * 1024 * 1024;
const fileCache = new Map<string, FileContent>();
async function loadFile(path: string): Promise<FileContent> {
  const cached = fileCache.get(path);
  if (cached) return cached;
  let fc: FileContent;
  try {
    fc = await invoke<FileContent>("read_file", { path });
  } catch (e) {
    fc = { content: "", truncated: false, binary: false, readOnly: true, size: 0, mtimeMs: 0, error: String(e) };
  }
  fileCache.set(path, fc);
  return fc;
}

type LoadState = { kind: "none" } | { kind: "loading" } | { kind: "ready"; fc: FileContent };

export function CodeEditorPane({ projectId, groupId, visible, style }: CodeEditorPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const contentSubRef = useRef<{ dispose(): void } | null>(null);
  const prevDirtyRef = useRef(false);
  const currentPathRef = useRef<string | null>(null);
  const visibleRef = useRef(visible);

  const setDirty = useStore((s) => s.setDirty);
  const saveFile = useStore((s) => s.saveFile);

  // Derive THIS group's active file path from the store (null when the active tab is a
  // session or the group is empty).
  const activePath = useStore((s) => {
    const g = s.layouts[projectId]?.groups.find((x) => x.id === groupId);
    if (!g || !g.activeRef) return null;
    const tab = g.tabs.find((t) => t.ref === g.activeRef);
    return tab && tab.kind === "file" ? tab.ref : null;
  });

  const [load, setLoad] = useState<LoadState>({ kind: "none" });
  // Displayed/active Monaco language id for the breadcrumb selector. Session-scoped:
  // seeded by languageFor() on load, but reflects the CONCRETE model's language so a
  // manual override (setModelLanguage) survives tab switches back to this file.
  const [langId, setLangId] = useState("plaintext");

  // Non-blocking disk-conflict banner state, driven by useFileWatch's poll (App-level).
  const conflict = useStore((s) => (activePath ? s.conflict[activePath] : undefined));
  const clearConflict = useStore((s) => s.clearConflict);
  const requestCloseTab = useStore((s) => s.requestCloseTab);
  const pendingReveal = useStore((s) => s.pendingReveal);
  const clearPendingReveal = useStore((s) => s.clearPendingReveal);

  // External-change "Reload": overwrite the buffer with disk content, discarding the
  // user's edits, then clear the banner. Preserves undo via pushEditOperations.
  const onReload = useCallback(async () => {
    const p = activePath;
    if (!p) return;
    const fc = await invoke<FileContent>("read_file", { path: p });
    if (fc.error === null && !fc.binary && !fc.readOnly) {
      const entry = registry.model(p);
      const m = entry?.model as unknown as Monaco.editor.ITextModel | undefined;
      if (m) {
        m.pushEditOperations(
          [],
          [{ range: m.getFullModelRange(), text: fc.content }],
          () => null,
        );
        registry.setSaved(p, { mtimeMs: fc.mtimeMs, size: fc.size });
      }
    }
    clearConflict(p);
  }, [activePath, clearConflict]);

  // "Keep mine": adopt the new disk stat as the baseline WITHOUT touching the saved
  // version id, so the watcher stops nagging until the next external change.
  const onKeepMine = useCallback(() => {
    if (activePath && conflict && conflict !== "deleted") registry.setBaseline(activePath, conflict);
    if (activePath) clearConflict(activePath);
  }, [activePath, conflict, clearConflict]);

  // "Keep buffer" on a deleted file: adopt a {0,0} sentinel baseline so the very next
  // watcher tick (which will stat the still-missing file as {exists:false}) does not
  // immediately re-flag "deleted" — see useFileWatch's baseline-aware guard.
  const onKeepDeleted = useCallback(() => {
    if (!activePath) return;
    registry.setBaseline(activePath, { mtimeMs: 0, size: 0 });
    clearConflict(activePath);
  }, [activePath, clearConflict]);

  // Create the editor exactly once (mirrors Terminal.tsx create-once).
  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.create(hostRef.current, {
      model: null,
      automaticLayout: false,
      fontFamily: '"SF Mono", SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 18,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: "none",
      tabSize: 2,
      padding: { top: 12, bottom: 6 },
    });
    editorRef.current = editor;

    // Cmd/Ctrl+S saves the active file. Fires only when THIS editor has focus, so it can
    // never collide with xterm (which binds only Shift+Enter / Cmd+Backspace).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const p = currentPathRef.current;
      if (p) void saveFile(p);
    });

    // Track last-focused editor for menu-triggered actions (e.g. Find) that dispatch
    // after focus has moved away from the editor (App.tsx's "menu" listener).
    editor.onDidFocusEditorText(() => setLastFocusedEditor(editor));

    const ro = new ResizeObserver(() => {
      if (visibleRef.current) editor.layout();
    });
    ro.observe(hostRef.current);

    return () => {
      // Persist the outgoing view state, then dispose the EDITOR only (never the model).
      const p = currentPathRef.current;
      if (p) registry.setViewState(p, groupId, editor.saveViewState());
      contentSubRef.current?.dispose();
      ro.disconnect();
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap models on active-file change: save outgoing view state -> setModel -> restore.
  useEffect(() => {
    let alive = true;
    const editor = editorRef.current;
    const prev = currentPathRef.current;
    if (editor && prev && prev !== activePath) {
      registry.setViewState(prev, groupId, editor.saveViewState());
    }
    contentSubRef.current?.dispose();
    contentSubRef.current = null;
    prevDirtyRef.current = false;

    if (!activePath) {
      currentPathRef.current = null;
      editor?.setModel(null);
      setLoad({ kind: "none" });
      setLangId("plaintext");
      return;
    }
    currentPathRef.current = activePath;
    setLoad({ kind: "loading" });

    void loadFile(activePath).then((fc) => {
      if (!alive || currentPathRef.current !== activePath) return;
      setLoad({ kind: "ready", fc });
      const ed = editorRef.current;
      if (!ed) return;

      // No model at all for binary / error tabs — banner only.
      if (fc.binary || fc.error !== null) {
        ed.setModel(null);
        setLangId(languageFor(activePath));
        return;
      }
      // Editable only when nothing forbids it; large/non-UTF-8/truncated -> read-only model.
      const editable = !fc.readOnly;
      const entry = registry.ensureModel(activePath, {
        value: fc.content,
        languageId: languageFor(activePath),
        readOnly: fc.readOnly,
        baseline: { mtimeMs: fc.mtimeMs, size: fc.size },
      });
      ed.setModel(entry.model as unknown as monaco.editor.ITextModel);
      ed.updateOptions({ readOnly: !editable });
      // Reflect the CONCRETE model's language, not just languageFor(): if this file was
      // already open with a manually-overridden language, the override persists on the
      // shared registry model and should win over re-running auto-detection here.
      setLangId(ed.getModel()?.getLanguageId() ?? languageFor(activePath));
      const vs = registry.getViewState(activePath, groupId) as
        | monaco.editor.ICodeEditorViewState
        | undefined;
      if (vs) ed.restoreViewState(vs);
      if (visibleRef.current) {
        ed.layout();
        ed.focus();
      }

      // Dirty tracking: dispatch setDirty ONLY on a clean<->dirty transition.
      prevDirtyRef.current = registry.dirtyOf(activePath);
      if (entry.model) {
        contentSubRef.current = entry.model.onDidChangeContent(() => {
          const next = registry.dirtyOf(activePath);
          if (next !== prevDirtyRef.current) {
            prevDirtyRef.current = next;
            setDirty(activePath, next);
          }
        });
      }
    });

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  // Relayout + focus on reveal (mirrors Terminal.tsx).
  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) return;
    const ed = editorRef.current;
    if (!ed) return;
    requestAnimationFrame(() => {
      ed.layout();
      if (currentPathRef.current) ed.focus();
    });
  }, [visible]);

  // Jump to a line when a terminal Cmd+Click opened this file with a reveal target. Fires once
  // the model for the reveal path is set (so it survives the async read_file), whether the file
  // was freshly opened or already open. Clears the one-shot flag once the target tab is loaded —
  // even a binary/error tab with no model — so a stale reveal can never linger.
  useEffect(() => {
    if (!pendingReveal || pendingReveal.path !== activePath) return;
    if (load.kind !== "ready") return;
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (ed && model) {
      const line = Math.min(Math.max(pendingReveal.line, 1), model.getLineCount());
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: pendingReveal.col });
      ed.focus();
    }
    clearPendingReveal();
  }, [pendingReveal, activePath, load, clearPendingReveal]);

  const fc = load.kind === "ready" ? load.fc : null;
  const banner = ((): { text: string; error?: boolean } | null => {
    if (!fc) return null;
    if (fc.error !== null) return { text: `Could not read file: ${fc.error}`, error: true };
    if (fc.binary) return { text: "Binary file — not shown." };
    if (fc.truncated) return { text: "Showing first 24 MB (read-only)." };
    if (fc.readOnly) return { text: fc.size > EDIT_CAP ? "Read-only: large file." : "Read-only: non-UTF-8 encoding." };
    return null;
  })();
  const noModel = !!fc && (fc.binary || fc.error !== null);

  // Applies a manual language override to the active file's CONCRETE model (session-scoped,
  // no persistence). Bails silently when there's no model to retag (empty group / binary /
  // error tab) — the selector is disabled in that case anyway.
  const onLangChange = (id: string) => {
    const m = editorRef.current?.getModel();
    if (m) {
      monaco.editor.setModelLanguage(m, id);
      setLangId(id);
    }
  };

  return (
    <div className={`code-pane ${visible ? "visible" : "hidden"}`} style={style}>
      <div className="code-breadcrumb">
        <span className="code-crumb-name">{activePath ? baseName(activePath) : ""}</span>
        <span className="code-crumb-spacer" />
        <LanguageSelector value={langId} onChange={onLangChange} disabled={noModel || !activePath} />
      </div>
      {banner && <div className={`code-banner ${banner.error ? "error" : ""}`}>{banner.text}</div>}
      <div style={hostWrapStyle}>
        {visible && activePath && conflict === "deleted" ? (
          <div style={bannerStyle} role="status">
            <span style={{ flex: 1 }}>File deleted on disk.</span>
            <button style={bannerBtn} onClick={onKeepDeleted}>
              Keep buffer (save recreates)
            </button>
            <button
              style={bannerBtn}
              onClick={() => void requestCloseTab(projectId, groupId, activePath)}
            >
              Close tab
            </button>
          </div>
        ) : visible && activePath && conflict ? (
          <div style={bannerStyle} role="status">
            <span style={{ flex: 1 }}>File changed on disk.</span>
            <button style={bannerBtn} onClick={() => void onReload()}>
              Reload
            </button>
            <button style={bannerBtn} onClick={onKeepMine}>
              Keep mine
            </button>
          </div>
        ) : null}
        <div ref={hostRef} className={`code-host ${noModel ? "empty" : ""}`} />
      </div>
    </div>
  );
}
