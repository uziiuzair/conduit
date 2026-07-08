import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";
import { monaco, languageFor, setLastFocusedEditor } from "../monaco/setup";
import * as registry from "../monaco/registry";
import { useStore, activeGroup, baseName, type FileContent } from "../store";
import { LanguageSelector } from "./LanguageSelector";
import { MarkdownPreview } from "./MarkdownPreview";
import { ImagePreview } from "./ImagePreview";

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

// Base editor font metrics; the View-menu zoom offsets both (lineHeight is an absolute
// px value in Monaco, so it must scale with the size or zoomed text clips).
const EDITOR_BASE_FONT = 12;
const editorLineHeight = (fontSize: number) => Math.round(fontSize * 1.5);

// Raster formats the image preview can render as a data: URL. SVG is deliberately
// absent — it reads as an editable text buffer.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
const isImagePath = (p: string) => IMAGE_EXT.test(p);

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

  // Only the ACTIVE group's pane may grab keyboard focus. Restoring from a maximized
  // group flips `visible` on every hidden pane at once — without this gate the last
  // pane's reveal rAF would steal focus from the editor the user is typing in.
  const isActiveGroup = useStore((s) => activeGroup(s.layouts[projectId])?.id === groupId);
  const isActiveGroupRef = useRef(isActiveGroup);
  useEffect(() => {
    isActiveGroupRef.current = isActiveGroup;
  }, [isActiveGroup]);

  const [load, setLoad] = useState<LoadState>({ kind: "none" });
  // Markdown preview toggle. Pane-scoped and sticky across tab switches (like VS Code's
  // preview column); it only takes effect while the active model's language is markdown.
  // The ref mirror lets the create-once editor command and the focus guards read it.
  const [previewOn, setPreviewOnState] = useState(false);
  const previewOnRef = useRef(false);
  const setPreviewOn = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setPreviewOnState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      previewOnRef.current = next;
      return next;
    });
  }, []);
  // True when the preview overlay is covering this pane's editor — used to keep
  // programmatic focus off the covered editor (keystrokes would edit it invisibly).
  const previewCovers = useCallback(
    () =>
      previewOnRef.current &&
      editorRef.current?.getModel()?.getLanguageId() === "markdown",
    [],
  );
  // Displayed/active Monaco language id for the breadcrumb selector. Session-scoped:
  // seeded by languageFor() on load, but reflects the CONCRETE model's language so a
  // manual override (setModelLanguage) survives tab switches back to this file.
  const [langId, setLangId] = useState("plaintext");

  // Breadcrumb status chips (Ln/Col · indentation · EOL). Cursor events are wired
  // editor-scoped in the create-once effect (they survive model swaps); the
  // model-derived pieces are re-read here on swap / option change / EOL toggle.
  const [cursor, setCursor] = useState<{ ln: number; col: number } | null>(null);
  const [eol, setEol] = useState<"LF" | "CRLF">("LF");
  const [indent, setIndent] = useState("");
  const refreshModelStatus = useCallback(() => {
    const ed = editorRef.current;
    const m = ed?.getModel();
    if (!ed || !m) {
      setCursor(null);
      setIndent("");
      return;
    }
    setEol(m.getEOL() === "\r\n" ? "CRLF" : "LF");
    // Read the RESOLVED options: attach-time indentation auto-detection can override
    // the create-time tabSize, so the create option is not the truth.
    const o = m.getOptions();
    setIndent(o.insertSpaces ? `Spaces: ${o.indentSize}` : `Tab: ${o.tabSize}`);
    const pos = ed.getPosition();
    setCursor(pos ? { ln: pos.lineNumber, col: pos.column } : { ln: 1, col: 1 });
  }, []);

  // View-menu editor prefs, fanned out reactively to this pane's live editor.
  const wordWrap = useStore((s) => s.wordWrap);
  const fontZoom = useStore((s) => s.fontZoom);
  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
  }, [wordWrap]);
  useEffect(() => {
    const size = EDITOR_BASE_FONT + fontZoom;
    editorRef.current?.updateOptions({ fontSize: size, lineHeight: editorLineHeight(size) });
  }, [fontZoom]);

  // Non-blocking disk-conflict banner state, driven by useFileWatch's poll (App-level).
  const conflict = useStore((s) => (activePath ? s.conflict[activePath] : undefined));
  const clearConflict = useStore((s) => s.clearConflict);
  const requestCloseTab = useStore((s) => s.requestCloseTab);

  // External-change "Reload": overwrite the buffer with disk content, discarding the
  // user's edits, then clear the banner. Preserves undo via pushEditOperations.
  const onReload = useCallback(async () => {
    const p = activePath;
    if (!p) return;
    const fc = await invoke<FileContent>("read_file", { path: p });
    // A save that started while read_file was in flight owns the buffer — bail
    // rather than clobber it (mirrors the watcher's post-await re-check).
    if (registry.saving.has(p)) return;
    if (fc.error === null && !fc.binary && !fc.readOnly) {
      const entry = registry.model(p);
      const m = entry?.model as unknown as Monaco.editor.ITextModel | undefined;
      if (m) {
        // Same reconciliation window as the watcher's silent reload: suppress the
        // transitional dirty dispatch, then settle the store explicitly — the buffer
        // now matches disk, so it must read clean (the old code left it dirty).
        registry.saving.add(p);
        try {
          m.pushEditOperations(
            [],
            [{ range: m.getFullModelRange(), text: fc.content }],
            () => null,
          );
          registry.setSaved(p, { mtimeMs: fc.mtimeMs, size: fc.size });
        } finally {
          registry.saving.delete(p);
        }
        setDirty(p, registry.dirtyOf(p));
      }
    }
    clearConflict(p);
  }, [activePath, clearConflict, setDirty]);

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
    // Seed zoom/wrap from the store snapshot; the reactive effects above keep them
    // current afterwards (this closure runs once).
    const prefs = useStore.getState();
    const initialFont = EDITOR_BASE_FONT + prefs.fontZoom;
    const editor = monaco.editor.create(hostRef.current, {
      model: null,
      automaticLayout: false,
      fontFamily: '"SF Mono", SFMono-Regular, Menlo, monospace',
      fontSize: initialFont,
      lineHeight: editorLineHeight(initialFont),
      wordWrap: prefs.wordWrap ? "on" : "off",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      // Whitespace stays invisible except inside a selection — enough to spot stray
      // tabs/trailing spaces while reviewing without ambient dot noise.
      renderWhitespace: "selection",
      tabSize: 2,
      padding: { top: 12, bottom: 6 },
      // Already monaco 0.55's default (its outlineModel source falls back to the
      // indentation model when no symbol providers exist) — pinned explicitly so an
      // upstream default flip can't silently turn it off.
      stickyScroll: { enabled: true },
      guides: { bracketPairs: "active" },
    });
    editorRef.current = editor;

    // Cmd/Ctrl+S saves the active file. Fires only when THIS editor has focus, so it can
    // never collide with xterm (which binds only Shift+Enter / Cmd+Backspace).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const p = currentPathRef.current;
      if (p) void saveFile(p);
    });

    // ⇧⌘V opens the markdown preview (VS Code's binding). Editor-focused only; the
    // preview overlay binds the same chord itself to toggle back.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyV, () => {
      if (editor.getModel()?.getLanguageId() === "markdown") setPreviewOn(true);
    });

    // Track last-focused editor for menu-triggered actions (e.g. Find) that dispatch
    // after focus has moved away from the editor (App.tsx's "menu" listener). Focusing
    // the editor body also makes ITS group the active group — otherwise ⌃Tab/⌘1-9/
    // ⇧⌘M/File▸Save would keep targeting whichever tab strip was clicked last.
    editor.onDidFocusEditorText(() => {
      setLastFocusedEditor(editor);
      const st = useStore.getState();
      if (activeGroup(st.layouts[projectId])?.id !== groupId) {
        st.setActiveGroup(projectId, groupId);
      }
    });

    // Status-chip feeds. Editor-scoped events fire across model swaps; the callbacks
    // only touch refs + setState, so wiring them in the create-once closure is safe.
    editor.onDidChangeCursorPosition((e) =>
      setCursor({ ln: e.position.lineNumber, col: e.position.column }),
    );
    editor.onDidChangeModelOptions(() => refreshModelStatus());
    editor.onDidChangeModelContent(() => {
      const m = editor.getModel();
      if (m) setEol(m.getEOL() === "\r\n" ? "CRLF" : "LF");
    });

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

    if (!activePath) {
      currentPathRef.current = null;
      editor?.setModel(null);
      setLoad({ kind: "none" });
      setLangId("plaintext");
      refreshModelStatus();
      return;
    }
    currentPathRef.current = activePath;
    setLoad({ kind: "loading" });

    void loadFile(activePath).then((fc) => {
      if (!alive || currentPathRef.current !== activePath) return;
      setLoad({ kind: "ready", fc });
      const ed = editorRef.current;
      if (!ed) return;

      // No model at all for binary / error tabs — banner only (or the image preview).
      if (fc.binary || fc.error !== null) {
        ed.setModel(null);
        setLangId(languageFor(activePath));
        refreshModelStatus();
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
      refreshModelStatus(); // after restoreViewState so the chips show the restored cursor
      if (visibleRef.current) {
        ed.layout();
        if (!previewCovers() && isActiveGroupRef.current) ed.focus();
      }

      // Dirty tracking: dispatch setDirty only when the store disagrees with the
      // model. The comparison MUST be against the store itself, not a local ref —
      // saveFile clears store.dirty without any content event, and a stale local
      // edge-detector would never re-dispatch after a save-then-edit, silently
      // defeating the quit guard / Save All / tab dot that all read store.dirty.
      // While registry.saving marks the path (own save's trim edits, the watcher's
      // silent reload, the conflict banner's Reload) the events are transitional —
      // dirtyOf is true only until setSaved lands, which emits nothing — so
      // dispatching would strand store.dirty; those flows settle the store themselves.
      if (entry.model) {
        contentSubRef.current = entry.model.onDidChangeContent(() => {
          if (registry.saving.has(activePath)) return;
          const next = registry.dirtyOf(activePath);
          if (next !== !!useStore.getState().dirty[activePath]) {
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
      if (currentPathRef.current && !previewCovers() && isActiveGroupRef.current) ed.focus();
    });
  }, [visible, previewCovers]);

  const fc = load.kind === "ready" ? load.fc : null;
  // Binary raster images skip the banner: the ImagePreview overlay renders instead.
  const isImage = !!activePath && !!fc && fc.binary && isImagePath(activePath);
  const banner = ((): { text: string; error?: boolean } | null => {
    if (!fc) return null;
    if (fc.error !== null) return { text: `Could not read file: ${fc.error}`, error: true };
    if (fc.binary) return isImage ? null : { text: "Binary file — not shown." };
    if (fc.truncated) return { text: "Showing first 24 MB (read-only)." };
    if (fc.readOnly) return { text: fc.size > EDIT_CAP ? "Read-only: large file." : "Read-only: non-UTF-8 encoding." };
    return null;
  })();
  const noModel = !!fc && (fc.binary || fc.error !== null);

  // LF/CRLF chip click: undo-preserving EOL flip; flows through the version-id dirty
  // mechanism like any other edit. Read-only buffers keep the chip display-only.
  const onToggleEol = () => {
    const ed = editorRef.current;
    const m = ed?.getModel();
    if (!m || fc?.readOnly) return;
    m.pushEOL(
      m.getEOL() === "\n"
        ? monaco.editor.EndOfLineSequence.CRLF
        : monaco.editor.EndOfLineSequence.LF,
    );
    refreshModelStatus();
    if (!previewCovers()) ed?.focus();
  };
  // Follows the breadcrumb's language id, so a manual retag to/from markdown shows or
  // hides the whole preview affordance, exactly like the tokenizer switch.
  const isMarkdown = langId === "markdown";
  const showPreview = previewOn && isMarkdown && !!activePath && !!fc && !noModel;

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
        {!!activePath && !!fc && !noModel && (
          <>
            {cursor && (
              <span className="status-chip" title="Cursor position">
                Ln {cursor.ln}, Col {cursor.col}
              </span>
            )}
            {indent && (
              <span className="status-chip" title="Indentation">
                {indent}
              </span>
            )}
            <button
              className="md-toggle-btn"
              onClick={onToggleEol}
              disabled={fc.readOnly}
              title={fc.readOnly ? "End of line (read-only)" : "Toggle end-of-line sequence"}
            >
              {eol}
            </button>
          </>
        )}
        {isMarkdown && !!activePath && !noModel && (
          <button
            className="md-toggle-btn"
            onClick={() => setPreviewOn((v) => !v)}
            title="Toggle Markdown preview (⇧⌘V)"
          >
            {previewOn ? "Source" : "Preview"}
          </button>
        )}
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
        {showPreview && activePath && (
          <MarkdownPreview
            path={activePath}
            visible={visible}
            onClose={() => {
              setPreviewOn(false);
              editorRef.current?.focus();
            }}
          />
        )}
        {isImage && activePath && <ImagePreview path={activePath} />}
        <div ref={hostRef} className={`code-host ${noModel ? "empty" : ""}`} />
      </div>
    </div>
  );
}
