import { useEffect, useRef } from "react";
import { Terminal as Xterm, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { invoke, Channel } from "@tauri-apps/api/core";
import { currentTerminalTheme, registerTerminal } from "../themes";
import { useStore, type SessionRole } from "../store";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Base terminal font size; the View-menu zoom offsets it (editors scale from their own
// 12px base in CodeEditorPane — the two surfaces deliberately keep their 1px gap).
const TERM_BASE_FONT = 13;

interface Props {
  sessionId: string;
  projectId: string;
  workingDirectory: string;
  visible: boolean;
  /** Slug to pass as `claude --worktree <slug>` for an isolated session. */
  worktreeName?: string;
  /** Plain login shell instead of launching `claude` (the bottom-panel terminal). */
  shellOnly?: boolean;
  /** "conductor" attaches the fleet MCP server + persona at spawn; default "worker". */
  role?: SessionRole;
  /**
   * Grab keyboard focus when this terminal becomes visible. The center agent terminal
   * wants this so switching Claude tabs lands your cursor in Claude. The secondary
   * right-panel shell opts out (except when the user explicitly opens the Terminal tab)
   * so it never steals focus from the agent on a session switch. Defaults to true.
   */
  focusOnReveal?: boolean;
  /** Clicking into the terminal body makes its editor group the active group (center
   *  terminals only — the right-panel shell has no group and omits this). */
  onFocusGroup?: () => void;
  /** Positioning applied to the host (e.g. left/width % for the active group's slot). */
  style?: React.CSSProperties;
}

/**
 * One live terminal. Ports TerminalPane.swift + the rendering half of the
 * keep-alive trick: this component is mounted for the whole life of the session
 * and NEVER unmounts on tab switch — visibility is toggled via CSS by the parent.
 * The PTY is spawned lazily the first time the terminal becomes visible (matching
 * SwiftTerm's lazy launch and sidestepping fit()-on-hidden = 0×0).
 */
export function TerminalView({
  sessionId,
  projectId,
  workingDirectory,
  visible,
  worktreeName,
  shellOnly = false,
  role,
  focusOnReveal = true,
  onFocusGroup,
  style,
}: Props) {
  const innerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const resizeTimer = useRef<number | null>(null);
  const disposedRef = useRef(false);

  const restoreOnOpen = useStore((s) => s.restoreSessionsOnOpen);
  const selectedProjectId = useStore((s) => s.selectedProjectId);

  // Spawn the PTY exactly once (guarded by spawnedRef). Shared by the reveal path and the
  // eager restore-on-open path, so a restored session can come back live (and resume — Claude
  // via --resume, agy via --conversation) without the user clicking its tab first.
  const spawnPty = (cols: number, rows: number) => {
    if (spawnedRef.current) return;
    spawnedRef.current = true;
    const channel = new Channel<string>();
    channel.onmessage = (msg) => {
      if (disposedRef.current) return;
      termRef.current?.write(b64ToBytes(msg));
    };
    void invoke("pty_spawn", {
      sessionId,
      workingDirectory,
      cols,
      rows,
      shellOnly,
      worktreeName: worktreeName ?? null,
      role: role ?? "worker",
      // A backend-spawned worker carries a first prompt; consumed once here.
      initialPrompt: useStore.getState().takePendingPrompt(sessionId) ?? null,
      onEvent: channel,
    }).catch((e) => termRef.current?.write(`\r\n[spawn error: ${e}]\r\n`));
  };

  // Create the xterm instance exactly once.
  useEffect(() => {
    const term = new Xterm({
      fontFamily: '"SF Mono", SFMono-Regular, Menlo, monospace',
      fontSize: TERM_BASE_FONT + useStore.getState().fontZoom,
      lineHeight: 1.0,
      theme: currentTerminalTheme(),
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (innerRef.current) term.open(innerRef.current);
    // Canvas renderer: solid throughput without burning a WebGL context per tab.
    try {
      term.loadAddon(new CanvasAddon());
    } catch {
      /* fall back to the default DOM renderer */
    }
    const writeSeq = (data: string) =>
      void invoke("pty_write", { sessionId, data }).catch(() => {});

    term.onData((d) => writeSeq(d));

    // The open-path / clipboard modifier is Cmd on macOS, Ctrl on Windows & Linux (VS Code parity).
    // `navigator.platform` is deprecated and occasionally empty in webviews, so fall back to UA.
    const isMac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent);
    const openModHeld = (ev: { metaKey: boolean; ctrlKey: boolean }) =>
      isMac ? ev.metaKey : ev.ctrlKey;

    // --- Cmd/Ctrl+Click a file path -> open it in Conduit's editor (VS Code parity) ---
    // Track whether the modifier is held so path tokens only light up / activate with it;
    // a plain click keeps normal terminal selection.
    let cmdHeld = false;
    const onMod = (ev: KeyboardEvent) => {
      cmdHeld = openModHeld(ev);
    };
    const onBlur = () => {
      cmdHeld = false;
    };
    window.addEventListener("keydown", onMod, true);
    window.addEventListener("keyup", onMod, true);
    window.addEventListener("blur", onBlur);

    const openPath = async (raw: string) => {
      try {
        const r = await invoke<{ absPath: string; line: number | null; col: number | null } | null>(
          "resolve_terminal_path",
          { base: workingDirectory, token: raw },
        );
        if (!r || disposedRef.current) return;
        useStore.getState().openFile(
          projectId,
          r.absPath,
          r.line != null ? { reveal: { line: r.line, col: r.col ?? 1 } } : undefined,
        );
      } catch {
        /* a stale/mistyped path simply does nothing */
      }
    };

    // Absolute (/…), home (~/…), explicit-relative (./,../) or workspace-relative
    // (>=2 segments) path with an optional :line or :line:col suffix. Deliberately permissive —
    // the Rust resolver verifies existence, so a false match at worst underlines a dead token.
    const PATH_SOURCE =
      "(?:(?:~\\/|\\.\\.?\\/|\\/)[\\w.\\-@]+(?:\\/[\\w.\\-@]+)*|[\\w.\\-@]+(?:\\/[\\w.\\-@]+)+)(?::\\d+(?::\\d+)?)?";

    const linkDisposable = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        if (!cmdHeld) return callback(undefined);
        const buf = term.buffer.active;
        // Walk up to the first row of the (possibly wrapped) logical line.
        let start = bufferLineNumber - 1;
        while (start > 0 && buf.getLine(start)?.isWrapped) start--;
        // Concatenate the wrapped rows at FULL width so a string index -> cell math stays exact.
        // Caveat: a wide/CJK or combined (emoji/ZWJ) glyph earlier in the line emits a different
        // number of JS chars than terminal columns, so a token after it can be mis-ranged — a
        // benign missed/misplaced underline (the resolver still only opens files that exist).
        const cols = term.cols;
        let text = "";
        let row = start;
        for (;;) {
          const line = buf.getLine(row);
          if (!line) break;
          text += line.translateToString(false);
          const next = buf.getLine(row + 1);
          if (next?.isWrapped) row++;
          else break;
        }
        const re = new RegExp(PATH_SOURCE, "g");
        const links: ILink[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const raw = m[0];
          const s = m.index;
          const e = s + raw.length - 1;
          links.push({
            range: {
              start: { x: (s % cols) + 1, y: start + Math.floor(s / cols) + 1 },
              end: { x: (e % cols) + 1, y: start + Math.floor(e / cols) + 1 },
            },
            text: raw,
            activate: (ev: MouseEvent, matched: string) => {
              if (!openModHeld(ev)) return;
              void openPath(matched);
            },
          });
        }
        callback(links.length ? links : undefined);
      },
    });

    // VS Code-parity key chords. xterm sends a bare `\r` for Enter (Shift or not),
    // so `claude` can't tell Shift+Enter apart; and Cmd+Backspace isn't wired to a
    // delete sequence. Emit the right bytes and skip xterm's default for these two.
    // (Option+Backspace is left to xterm's native macOptionIsMeta handling, which
    // already produces delete-word.)
    // Clipboard: xterm's canvas isn't a text input, so copy/paste must be wired by hand.
    // macOS uses Cmd+C / Cmd+V; Windows & Linux use Ctrl+Shift+C / Ctrl+Shift+V, plus the
    // "smart" Ctrl+C that copies the current selection (then releases it so a second
    // Ctrl+C still sends SIGINT) and Ctrl+V to paste — matching Windows Terminal.
    const copySelection = () => {
      const sel = term.getSelection();
      if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
      term.clearSelection();
    };
    const pasteClipboard = () => {
      void navigator.clipboard
        .readText()
        .then((t) => {
          if (t && !disposedRef.current) term.paste(t);
        })
        .catch(() => {});
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const k = e.key.toLowerCase();
      // Copy
      if (k === "c" && !e.altKey) {
        const macCopy = isMac && e.metaKey && !e.ctrlKey;
        const winCopyShift = !isMac && e.ctrlKey && e.shiftKey;
        const winCopySmart = !isMac && e.ctrlKey && !e.shiftKey && term.hasSelection();
        if (macCopy || winCopyShift || winCopySmart) {
          if (term.hasSelection()) {
            copySelection();
            e.preventDefault();
            return false;
          }
          // No selection on Windows Ctrl+C → fall through so it sends SIGINT.
          if (winCopyShift) {
            e.preventDefault();
            return false;
          }
        }
      }
      // Paste (Ctrl+V and Ctrl+Shift+V both paste on Windows/Linux; Cmd+V on macOS)
      if (k === "v" && !e.altKey) {
        const macPaste = isMac && e.metaKey && !e.ctrlKey;
        const winPaste = !isMac && e.ctrlKey;
        if (macPaste || winPaste) {
          e.preventDefault();
          pasteClipboard();
          return false;
        }
      }
      const plain = !e.ctrlKey && !e.metaKey;
      // Shift+Enter → newline (same ESC CR that the working Option+Enter sends)
      if (e.key === "Enter" && e.shiftKey && !e.altKey && plain) {
        e.preventDefault();
        writeSeq("\x1b\r");
        return false;
      }
      // Cmd+Backspace → delete to start of line (Ctrl-U)
      if (e.key === "Backspace" && e.metaKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        writeSeq("\x15");
        return false;
      }
      // Cmd+Left / Cmd+Right → start / end of line (readline Ctrl-A / Ctrl-E). VS Code parity.
      if (e.key === "ArrowLeft" && e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        writeSeq("\x01");
        return false;
      }
      if (e.key === "ArrowRight" && e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        writeSeq("\x05");
        return false;
      }
      return true;
    });

    // Right-click: copy the selection if there is one, otherwise paste — the classic
    // terminal convention (and the discoverable path for users without the key chords).
    const onContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
      if (term.hasSelection()) copySelection();
      else pasteClipboard();
    };
    innerRef.current?.addEventListener("contextmenu", onContextMenu);

    termRef.current = term;
    const unregister = registerTerminal(term);
    fitRef.current = fit;

    // Re-fit when the host area changes size (window resize, panel toggles).
    const ro = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      scheduleFit();
    });
    if (innerRef.current) ro.observe(innerRef.current);

    // Web fonts can settle after first paint, changing cell metrics — refit then.
    void document.fonts?.ready.then(() => {
      if (visibleRef.current) scheduleFit();
    });

    const onWinResize = () => {
      if (visibleRef.current) scheduleFit();
    };
    window.addEventListener("resize", onWinResize);

    return () => {
      unregister();
      disposedRef.current = true;
      if (resizeTimer.current) window.clearTimeout(resizeTimer.current);
      window.removeEventListener("resize", onWinResize);
      ro.disconnect();
      linkDisposable.dispose();
      window.removeEventListener("keydown", onMod, true);
      window.removeEventListener("keyup", onMod, true);
      window.removeEventListener("blur", onBlur);
      innerRef.current?.removeEventListener("contextmenu", onContextMenu);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track latest `visible` for the ResizeObserver closure.
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;

    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* not measurable yet */
      }
      const cols = term.cols;
      const rows = term.rows;

      if (!spawnedRef.current) {
        spawnPty(cols, rows);
      } else {
        void invoke("pty_resize", { sessionId, cols, rows }).catch(() => {});
      }
      // Only the agent terminal pulls focus on reveal; the right-panel shell opts out
      // (focusOnReveal=false on a session switch) so it can't steal focus from Claude.
      // The effect re-subscribes on every `visible` change, so this captures the value
      // at the moment of reveal.
      if (focusOnReveal) term.focus();
      // Late fallback: catch layout/font settling after the first frame.
      window.setTimeout(() => scheduleFit(), 120);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Eager restore-on-open: bring every session of the ACTIVE project live without waiting for
  // a click (VSCode-style — the whole project comes back where you left off). Companion shells
  // (shellOnly) stay lazy. Spawns with fallback dims; the reveal-refit corrects the size when
  // the tab is actually shown. Gated by the restoreSessionsOnOpen setting (default on).
  useEffect(() => {
    if (spawnedRef.current || shellOnly) return;
    if (!restoreOnOpen || projectId !== selectedProjectId) return;
    const term = termRef.current;
    if (!term) return;
    spawnPty(term.cols || 80, term.rows || 24);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreOnOpen, selectedProjectId]);

  // App-wide font zoom (View menu). Setting options.fontSize changes cell metrics
  // WITHOUT firing the ResizeObserver (the host box is unchanged), so cols/rows must
  // be renegotiated with the PTY explicitly. Hidden keep-alive terminals skip the fit
  // (0×0 hazard) and pick the new size up through the reveal-refit path.
  const fontZoom = useStore((s) => s.fontZoom);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const size = TERM_BASE_FONT + fontZoom;
    if (term.options.fontSize === size) return;
    term.options.fontSize = size;
    if (visibleRef.current) scheduleFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontZoom]);

  function scheduleFit() {
    if (disposedRef.current) return;
    if (resizeTimer.current) window.clearTimeout(resizeTimer.current);
    resizeTimer.current = window.setTimeout(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit || disposedRef.current) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (spawnedRef.current) {
        void invoke("pty_resize", {
          sessionId,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {});
      }
    }, 80);
  }

  return (
    <div
      className={`term-host ${visible ? "visible" : "hidden"}`}
      style={style}
      onMouseDown={onFocusGroup}
    >
      <div ref={innerRef} className="term-inner" />
    </div>
  );
}
