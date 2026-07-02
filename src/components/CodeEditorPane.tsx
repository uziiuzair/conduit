import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { monaco, languageFor } from "../monaco/setup";
import * as registry from "../monaco/registry";
import { useStore, baseName, type FileContent } from "../store";
import { LanguageSelector } from "./LanguageSelector";

interface CodeEditorPaneProps {
  projectId: string;
  groupId: string;
  visible: boolean;
  style?: React.CSSProperties;
}

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
      <div ref={hostRef} className={`code-host ${noModel ? "empty" : ""}`} />
    </div>
  );
}
