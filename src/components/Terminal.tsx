import { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
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

    // VS Code-parity key chords. xterm sends a bare `\r` for Enter (Shift or not),
    // so `claude` can't tell Shift+Enter apart; and Cmd+Backspace isn't wired to a
    // delete sequence. Emit the right bytes and skip xterm's default for these two.
    // (Option+Backspace is left to xterm's native macOptionIsMeta handling, which
    // already produces delete-word.)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
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
      return true;
    });

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
        spawnedRef.current = true;
        const channel = new Channel<string>();
        channel.onmessage = (msg) => {
          if (disposedRef.current) return;
          term.write(b64ToBytes(msg));
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
        }).catch((e) => term.write(`\r\n[spawn error: ${e}]\r\n`));
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
