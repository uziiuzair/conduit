import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";
import { monaco, languageFor, setLastFocusedEditor } from "../monaco/setup";
import * as registry from "../monaco/registry";
import { useStore, activeGroup, baseName, type FileContent } from "../store";
import { hasFormatter } from "../format/options";
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
  // Diff-with-HEAD overlay (lazy createDiffEditor; the plain editor never unmounts).
  const diffHostRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const diffOriginalRef = useRef<monaco.editor.ITextModel | null>(null);
  // Gutter change stripes (working tree vs HEAD), swapped per model.
  const gutterRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

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
  // Diff-with-HEAD toggle. Pane-scoped and sticky across tab switches like the
  // markdown preview; the original (HEAD) side is fetched per active path.
  const [diffOn, setDiffOnState] = useState(false);
  const diffOnRef = useRef(false);
  const setDiffOn = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setDiffOnState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      diffOnRef.current = next;
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
  // Same guard for the diff overlay: while it covers the pane, programmatic focus
  // belongs to the diff's modified editor, never the hidden plain editor.
  const covered = useCallback(
    () => previewCovers() || diffOnRef.current,
    [previewCovers],
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
    diffEditorRef.current?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
  }, [wordWrap]);
  useEffect(() => {
    const size = EDITOR_BASE_FONT + fontZoom;
    editorRef.current?.updateOptions({ fontSize: size, lineHeight: editorLineHeight(size) });
    diffEditorRef.current?.updateOptions({
      fontSize: size,
      lineHeight: editorLineHeight(size),
    });
  }, [fontZoom]);

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
      if (visibleRef.current) {
        editor.layout();
        diffEditorRef.current?.layout();
      }
    });
    ro.observe(hostRef.current);

    return () => {
      // Persist the outgoing view state, then dispose the EDITOR only (never the model).
      const p = currentPathRef.current;
      if (p) registry.setViewState(p, groupId, editor.saveViewState());
      contentSubRef.current?.dispose();
      ro.disconnect();
      diffEditorRef.current?.dispose();
      diffEditorRef.current = null;
      diffOriginalRef.current?.dispose();
      diffOriginalRef.current = null;
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
      // Hot-exit restore: a backup from the previous run is applied on top of the
      // fresh disk model, leaving the buffer dirty by construction (undo returns to
      // disk). Only a CLEAN model may be seeded — a pre-existing edited model (file
      // already open elsewhere) must never be clobbered. One-shot per path.
      if (entry.model && editable && !registry.dirtyOf(activePath)) {
        const backup = useStore.getState().consumeHotExit(activePath);
        if (backup !== undefined && backup !== fc.content) {
          const m = entry.model as unknown as Monaco.editor.ITextModel;
          m.pushEditOperations(
            [],
            [{ range: m.getFullModelRange(), text: backup }],
            () => null,
          );
          // The contentSub isn't attached yet, so settle the store by hand.
          setDirty(activePath, registry.dirtyOf(activePath));
        }
      }
      refreshModelStatus(); // after restoreViewState so the chips show the restored cursor
      if (visibleRef.current) {
        ed.layout();
        if (!covered() && isActiveGroupRef.current) ed.focus();
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
      diffEditorRef.current?.layout();
      if (currentPathRef.current && !covered() && isActiveGroupRef.current) ed.focus();
    });
  }, [visible, covered]);

  // Jump to a line when a terminal Cmd+Click opened this file with a reveal target. Fires once
  // the model for the reveal path is set (so it survives the async read_file), whether the file
  // was freshly opened or already open, then clears the one-shot flag (even for a model-less
  // binary/error tab). If the user leaves the target tab before its model loads, the companion
  // effect below invalidates the pending reveal so it can't surprise-jump on a later return.
  useEffect(() => {
    if (!pendingReveal || pendingReveal.path !== activePath) return;
    if (load.kind !== "ready") return;
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (ed && model) {
      const line = Math.min(Math.max(pendingReveal.line, 1), model.getLineCount());
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: Math.max(pendingReveal.col, 1) });
      ed.focus();
    }
    clearPendingReveal();
  }, [pendingReveal, activePath, load, clearPendingReveal]);

  // Invalidate a pending reveal/diff if the user leaves this tab (switch/unmount) before its
  // model loads, so a deferred request can't fire when they return to this file much later.
  useEffect(() => {
    const leavingPath = activePath;
    return () => {
      const s = useStore.getState();
      if (s.pendingReveal?.path === leavingPath) s.clearPendingReveal();
      if (s.pendingDiff?.path === leavingPath) s.clearPendingDiff();
    };
  }, [activePath]);

  // ---- Diff with HEAD -------------------------------------------------------

  const fcReady = load.kind === "ready" ? load.fc : null;
  const hasModel = !!activePath && !!fcReady && !fcReady.binary && fcReady.error === null;
  const showDiff = diffOn && hasModel;

  // Consume a one-shot diff request aimed at this pane's active file (Changes-row
  // click arms "on"; the View-menu item arms "toggle"). Active group only — the
  // same file can be visible in two groups and both panes see the request.
  const pendingDiff = useStore((s) => s.pendingDiff);
  const clearPendingDiff = useStore((s) => s.clearPendingDiff);
  useEffect(() => {
    if (!pendingDiff || pendingDiff.path !== activePath) return;
    if (!isActiveGroupRef.current || load.kind !== "ready") return;
    setDiffOn((v) => (pendingDiff.mode === "toggle" ? !v : true));
    clearPendingDiff();
  }, [pendingDiff, activePath, load, setDiffOn, clearPendingDiff]);

  // Mount/refresh the diff overlay: lazy-create the diff editor, fetch the HEAD
  // side, pair it with the LIVE registry model as the modified side (edits in the
  // diff are real buffer edits — dirty/save/quit-guard all just work).
  useEffect(() => {
    if (!showDiff || !activePath) return;
    let alive = true;
    const path = activePath;
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";

    void invoke<string>("git_show_head", { dir, path })
      .then((original) => {
        if (!alive || currentPathRef.current !== path || !diffOnRef.current) return;
        const entry = registry.model(path);
        const host = diffHostRef.current;
        if (!entry?.model || !host) return;
        if (!diffEditorRef.current) {
          const prefs = useStore.getState();
          const size = EDITOR_BASE_FONT + prefs.fontZoom;
          diffEditorRef.current = monaco.editor.createDiffEditor(host, {
            automaticLayout: false,
            fontFamily: '"SF Mono", SFMono-Regular, Menlo, monospace',
            fontSize: size,
            lineHeight: editorLineHeight(size),
            wordWrap: prefs.wordWrap ? "on" : "off",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderSideBySide: true,
            originalEditable: false,
          });
          // ⌘S inside the diff's modified editor saves like the plain editor does.
          diffEditorRef.current
            .getModifiedEditor()
            .addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
              const p = currentPathRef.current;
              if (p) void saveFile(p);
            });
          diffEditorRef.current.getModifiedEditor().onDidFocusEditorText(() => {
            const st = useStore.getState();
            if (activeGroup(st.layouts[projectId])?.id !== groupId) {
              st.setActiveGroup(projectId, groupId);
            }
          });
        }
        diffOriginalRef.current?.dispose();
        diffOriginalRef.current = monaco.editor.createModel(
          original,
          (entry.model as unknown as monaco.editor.ITextModel).getLanguageId(),
          monaco.Uri.parse(`conduit-git://HEAD/${encodeURIComponent(path)}`),
        );
        diffEditorRef.current.setModel({
          original: diffOriginalRef.current,
          modified: entry.model as unknown as monaco.editor.ITextModel,
        });
        diffEditorRef.current.updateOptions({
          readOnly: !!fcReady && fcReady.readOnly,
        });
        if (visibleRef.current) {
          diffEditorRef.current.layout();
          if (isActiveGroupRef.current) diffEditorRef.current.getModifiedEditor().focus();
        }
      })
      .catch((e) => {
        if (!alive) return;
        setDiffOn(false);
        void invoke("notify_user", {
          title: "Diff",
          body: String(e),
        }).catch(() => {});
      });

    return () => {
      alive = false;
      // Detach + drop the throwaway original; the modified side is the registry
      // model and must NEVER be disposed here.
      diffEditorRef.current?.setModel(null);
      diffOriginalRef.current?.dispose();
      diffOriginalRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDiff, activePath]);

  // Hand focus back to the plain editor when the diff closes.
  useEffect(() => {
    if (diffOn || !visibleRef.current) return;
    if (currentPathRef.current && !previewCovers() && isActiveGroupRef.current) {
      editorRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffOn]);

  // ---- Gutter change stripes (vs HEAD) ---------------------------------------
  // Refreshed on model swap and every time the buffer settles CLEAN (save, reload,
  // discard convergence) — deliberately not per keystroke or watcher tick; stripes
  // mark "changed since HEAD" and may drift during active typing.
  const isDirtyNow = useStore((s) => (activePath ? !!s.dirty[activePath] : false));
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !activePath || load.kind !== "ready" || !hasModel) {
      gutterRef.current?.clear();
      return;
    }
    if (isDirtyNow) return; // keep the last stripes while typing
    let alive = true;
    const path = activePath;
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    void invoke<{ kind: string; start: number; count: number }[]>("git_diff_hunks", {
      dir,
      path,
    })
      .then((hunks) => {
        if (!alive || currentPathRef.current !== path) return;
        const model = ed.getModel();
        if (!model) return;
        const decos = hunks.map((h) => {
          const line = Math.min(Math.max(h.start, 1), model.getLineCount());
          const endLine = Math.min(
            Math.max(h.start + Math.max(h.count, 1) - 1, 1),
            model.getLineCount(),
          );
          return {
            range: new monaco.Range(line, 1, h.kind === "deleted" ? line : endLine, 1),
            options: {
              isWholeLine: false,
              linesDecorationsClassName: `gutter-${h.kind}`,
            },
          };
        });
        if (!gutterRef.current) gutterRef.current = ed.createDecorationsCollection();
        gutterRef.current.set(decos);
      })
      .catch(() => {
        if (alive) gutterRef.current?.clear(); // not a repo / outside it — no stripes
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, load, isDirtyNow, hasModel]);

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
    if (!covered()) ed?.focus();
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
        {!!activePath && !noModel && !!fc && (
          <button
            className="md-toggle-btn"
            onClick={() => setDiffOn((v) => !v)}
            title="Toggle diff with HEAD"
          >
            {diffOn ? "Editor" : "± Diff"}
          </button>
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
        {!!activePath && !noModel && !!fc && !fc.readOnly && hasFormatter(activePath) && (
          <button
            className="md-toggle-btn"
            onClick={() => {
              // Clicking a toolbar button doesn't focus/activate its pane's group, but
              // formatActiveDocument resolves its target via the globally active group —
              // in a split layout that would format the WRONG pane. Activate this pane's
              // group first so the subsequent read sees the right target.
              const st = useStore.getState();
              if (activeGroup(st.layouts[projectId])?.id !== groupId) {
                st.setActiveGroup(projectId, groupId);
              }
              void st.formatActiveDocument();
            }}
            title="Format document (⇧⌥F)"
          >
            Format
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
        {/* Always mounted (the diff editor is created lazily into it); visibility is
            CSS-only so toggling never re-creates editors — same keep-alive discipline
            as everything else in this app. */}
        <div ref={diffHostRef} className={`diff-host ${showDiff ? "" : "hidden"}`} />
        <div ref={hostRef} className={`code-host ${noModel ? "empty" : ""}`} />
      </div>
    </div>
  );
}
