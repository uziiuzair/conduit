import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as registry from "../monaco/registry";
import { renderMarkdown, schemeOf } from "../markdown";
import { useStore } from "../store";

interface MarkdownPreviewProps {
  path: string;
  /** Pane visibility (CSS-only, like the editor) — refocus the preview on reveal. */
  visible: boolean;
  /** Toggle back to source (⇧⌘V from inside the preview, mirroring the editor). */
  onClose(): void;
}

// Overlays the editor host (which stays mounted underneath — same never-unmount
// discipline as the rest of the pane) and renders the LIVE buffer, not the disk file:
// it re-renders from the shared registry model on every edit, debounced one beat.
const RENDER_DEBOUNCE_MS = 150;

export function MarkdownPreview({ path, visible, onClose }: MarkdownPreviewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState("");
  const saveFile = useStore((s) => s.saveFile);

  useEffect(() => {
    const m = registry.model(path)?.model;
    if (!m) {
      setHtml("");
      return;
    }
    setHtml(renderMarkdown(m.getValue()));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = m.onDidChangeContent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setHtml(renderMarkdown(m.getValue())), RENDER_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      sub.dispose();
    };
  }, [path]);

  // Own the keyboard while shown: without this, keystrokes would fall through to the
  // still-mounted editor underneath and silently edit the covered buffer.
  useEffect(() => {
    if (visible) rootRef.current?.focus();
  }, [visible, path]);

  // Sanitized markup can only contain http(s)/mailto/scheme-less hrefs (markdown.ts).
  // Never navigate the webview: http(s) goes to the system browser, the rest is inert.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    const scheme = schemeOf(href);
    if (scheme === "http" || scheme === "https") {
      void invoke("open_external", { url: href }).catch(() => {});
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.shiftKey && e.code === "KeyV") {
      e.preventDefault();
      onClose();
    } else if (!e.shiftKey && !e.altKey && e.code === "KeyS") {
      e.preventDefault();
      void saveFile(path);
    }
  };

  return (
    <div
      ref={rootRef}
      className="md-preview"
      tabIndex={-1}
      role="document"
      onClick={onClick}
      onAuxClick={onClick}
      onKeyDown={onKeyDown}
    >
      <div className="md-preview-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
