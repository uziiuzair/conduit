import { useEffect, useRef } from "react";
import { Terminal as Xterm, type ILink, type IDisposable } from "@xterm/xterm";
import {
  cellFromPoint,
  decPrivateSeq,
  partitionMouseModes,
  sgrWheelReport,
  wheelLines,
} from "../terminalMouse";
import { FitAddon } from "@xterm/addon-fit";
import { attachRenderer, disposePane, type RendererHandle } from "../terminalRenderer";
import { REAL_ADDONS } from "../terminalRendererAddons";
import { invoke, Channel } from "@tauri-apps/api/core";
import { currentTerminalTheme, registerTerminal } from "../themes";
import { useStore, type SessionRole } from "../store";
import { SessionChat } from "./SessionChat";

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
  /**
   * The workingDirectory has been confirmed by the session-dir resolver
   * (useSessionDirs). The PTY is not spawned until this is true, so a worktree
   * shell never spawns into a not-yet-created directory (the old "shell lands in
   * ~" bug). Agent terminals omit it (default true) — pty_spawn resolves their
   * worktree race natively via worktree::spawn_target.
   */
  dirReady?: boolean;
  /** "conductor" attaches the fleet MCP server + persona at spawn; default "worker". */
  role?: SessionRole;
  /**
   * The user stopped this session (hibernate). Its PTYs are killed and NOT respawned
   * until this goes false again. The xterm instance stays mounted throughout — the
   * keep-alive rule is untouched — so scrollback survives a whole stop/start cycle.
   */
  stopped?: boolean;
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
  dirReady = true,
  role,
  stopped = false,
  focusOnReveal = true,
  onFocusGroup,
  style,
}: Props) {
  // Feature switch AND per-session state: the toggle only exists when the preference is
  // on, and only covers the sessions the user actually opened it for.
  const chatOpen = useStore((s) => s.richSessionView && !!s.richViewOpen[sessionId]);
  const toggleRichView = useStore((s) => s.toggleRichView);
  /** Read at reveal time by the fit/spawn effect. A REF, not a dep: adding chatOpen to
   *  that effect's deps would re-run a fit (and its spawn branch) on every toggle, which
   *  is a lot of machinery to move for a question it only needs to ask once. */
  const chatOpenRef = useRef(chatOpen);
  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);
  const innerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const resizeTimer = useRef<number | null>(null);
  const disposedRef = useRef(false);
  /** The live renderer addon. Declared up here, not next to its effect, because the
   *  create effect's cleanup has to dispose it BEFORE it disposes the xterm. */
  const rendererRef = useRef<RendererHandle | null>(null);
  /** Dir the live PTY was spawned in — respawn trigger compares against the prop. */
  const spawnedDirRef = useRef<string | null>(null);
  /** Latest workingDirectory for closures created in the mount-once effect (openPath). */
  const wdRef = useRef(workingDirectory);
  useEffect(() => {
    wdRef.current = workingDirectory;
  }, [workingDirectory]);
  /** Monotonic PTY generation. Bumped when a shell PTY is killed for respawn; each
   *  Channel closes over its generation so a doomed PTY's late output (including the
   *  "[process exited]" notice) can't paint into the reset terminal. */
  const spawnGenRef = useRef(0);
  /** Set when this session is hibernated; consumed by the next spawn, which clears the
   *  pane so Rust's cold-spawn scrollback replay isn't printed on top of the same screen.
   *  A ref (not the stop effect doing the reset directly) because the resume can arrive
   *  through either the stop transition or the reveal path, depending on whether the pane
   *  was on screen when the flag cleared. */
  const resetOnSpawnRef = useRef(false);

  const restoreOnOpen = useStore((s) => s.restoreSessionsOnOpen);
  const rendererPref = useStore((s) => s.terminalRenderer);
  const selectedProjectId = useStore((s) => s.selectedProjectId);

  // Spawn the PTY exactly once (guarded by spawnedRef). Shared by the reveal path and the
  // eager restore-on-open path, so a restored session can come back live (and resume — Claude
  // via --resume, agy via --conversation) without the user clicking its tab first.
  const spawnPty = (cols: number, rows: number) => {
    if (spawnedRef.current) return;
    spawnedRef.current = true;
    // Resuming a hibernated session: clear the pane first. Its tmux session is gone, so the
    // spawn below is COLD, and a cold spawn's first frame is the scrollback snapshot Rust
    // replays (`take_cold_scrollback`). That snapshot is the same screen this terminal is
    // still showing — without the reset the user would see it twice, the exact duplication
    // `warm_spawns` exists to prevent on the reattach path. The snapshot is the better copy
    // anyway: it also survives quitting the app, which the live buffer does not.
    if (resetOnSpawnRef.current) {
      resetOnSpawnRef.current = false;
      termRef.current?.reset();
    }
    // Read the dir from the ref, not the render closure: a deferred respawn (below)
    // may run after newer renders, and must spawn into the LATEST resolved dir.
    const wd = wdRef.current;
    spawnedDirRef.current = wd;
    // The MCP registry lives in localStorage, so Rust can't turn a session's allowlisted
    // NAMES into launchable commands — send the definitions with the spawn. Looked up fresh
    // every time, so editing a server in the matrix takes effect on the next start without
    // rewriting any session record. Rust still decides WHICH names apply (the persisted
    // allowlist wins); this is only the dictionary it resolves them against.
    const st = useStore.getState();
    const session = st.projects.flatMap((p) => p.sessions).find((s) => s.id === sessionId);
    const allowed = session?.mcpServers;
    const mcpAllowlist =
      allowed == null ? null : st.mcpServers.filter((s) => allowed.includes(s.name));
    const gen = spawnGenRef.current;
    const channel = new Channel<string>();
    channel.onmessage = (msg) => {
      if (disposedRef.current || gen !== spawnGenRef.current) return;
      termRef.current?.write(b64ToBytes(msg));
    };
    void invoke("pty_spawn", {
      sessionId,
      workingDirectory: wd,
      cols,
      rows,
      shellOnly,
      worktreeName: worktreeName ?? null,
      role: role ?? "worker",
      // A backend-spawned worker carries a first prompt; consumed once here.
      initialPrompt: useStore.getState().takePendingPrompt(sessionId) ?? null,
      mcpAllowlist,
      onEvent: channel,
    })
      .then(() => {
        // Cold-spawn repaint. When the agent resumes (`claude --resume <id>`, agy
        // `--conversation=<id>`) it replays into the alternate screen and nothing repaints
        // it, so the pane can come back blank or half-drawn — the long-standing "resume
        // looks broken" symptom. pty_spawn's RE-ATTACH fast path already nudges the winsize
        // for exactly this reason; the cold path never did. Harmless for a fresh session
        // (a resize to rows+1 and straight back).
        window.setTimeout(() => {
          if (disposedRef.current || gen !== spawnGenRef.current || !spawnedRef.current) return;
          const t = termRef.current;
          if (!t || !visibleRef.current) return;
          void invoke("pty_resize", { sessionId, cols: t.cols, rows: t.rows + 1 })
            .then(() => invoke("pty_resize", { sessionId, cols: t.cols, rows: t.rows }))
            .catch(() => {});
        }, 400);
      })
      .catch((e) => termRef.current?.write(`\r\n[spawn error: ${e}]\r\n`));
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
    // The renderer addon is attached by its own effect below, not here: it has to be able
    // to swap when the preference changes, and this effect must stay one-shot because
    // re-running it would recreate the xterm and kill the PTY under it.
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
          { base: wdRef.current, token: raw },
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
    // Read the clipboard on the Rust side, not via `navigator.clipboard.readText()`:
    // WKWebView gates browser clipboard reads behind a native "Paste" consent popup
    // (macOS 26+) and the canvas terminal has no editable target for it, so the browser
    // path silently fails. Rust reads the OS clipboard directly. A clipboard image comes
    // back as a temp-PNG path, which Claude Code's TUI attaches as a file.
    const pasteClipboard = () => {
      void invoke<{ kind: "text" | "image" | "empty"; text?: string; path?: string }>(
        "clipboard_read_for_paste",
      )
        .then((r) => {
          if (disposedRef.current) return;
          if (r.kind === "text" && r.text) term.paste(r.text);
          else if (r.kind === "image" && r.path) term.paste(r.path);
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

    // --- Mouse ownership for a bare shell pane (the WHY is in terminalMouse.ts) ---
    // tmux runs with `mouse on`, which the wheel needs and the buttons must not have: in a
    // pane whose program wants no mouse, tmux answers a drag with `copy-mode -M` (the
    // `[0/27]` badge and a stray second cursor) and a right-click with its own
    // Split/Kill `display-menu`. Refusing to enter mouse REPORTING hands selection,
    // word/line click and the context menu below back to xterm — the behaviour a native
    // terminal has whenever the foreground program is not asking for the mouse.
    // Agent panes are left alone: Claude Code turns tracking on itself, so tmux already
    // forwards their events to the program, which is the correct native answer there.
    // Trade: a mouse-aware TUI run INSIDE this shell (vim `set mouse=a`) loses the mouse.
    //
    // ALL OF IT is a workaround for tmux, so none of it may apply to a pane that has no
    // tmux under it — Windows above all, where tmux does not exist and the shell is a bare
    // cmd.exe. There, nothing consumes the re-encoded wheel report and xterm's own buffer
    // IS the real history, so swallowing the gesture just made shell panes unscrollable.
    // Read lazily, inside the handlers: `tmuxAvailable` is probed asynchronously at boot
    // and this effect never re-runs, so deciding at mount would let a pane that beat the
    // probe pin the wrong answer for its whole life.
    const underTmux = () => {
      const st = useStore.getState();
      return st.persistSessions && st.tmuxAvailable !== false;
    };
    const mouseDisposables: IDisposable[] = [];
    if (shellOnly) {
      for (const final of ["h", "l"] as const) {
        mouseDisposables.push(
          term.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
            if (!underTmux()) return false; // no tmux to fight — xterm owns the mouse
            const { mouse, other } = partitionMouseModes(params);
            if (mouse.length === 0) return false; // not ours — xterm's own handler runs
            // A combined `CSI ? 1002;1006 h` still owes its other half; replay it.
            if (other.length > 0) term.write(decPrivateSeq(other, final));
            return true;
          }),
        );
      }
      // The wheel is the half tmux keeps. Re-encode the gesture as the report xterm would
      // have sent and never scroll xterm's own buffer, which under tmux holds repaint
      // fragments rather than history.
      let wheelCarry = 0;
      term.attachCustomWheelEventHandler((ev) => {
        // No tmux under this pane: xterm's buffer holds the real history, so let it scroll.
        if (!underTmux()) return true;
        // Defensive: if the swallow above ever stops taking (an xterm upgrade moving the
        // parser registry), hand the wheel back instead of leaving the pane unscrollable.
        if (term.modes.mouseTrackingMode !== "none") return true;
        // Alternate screen has no history behind it, and xterm's arrow-key fallback is
        // what a native terminal does there.
        if (term.buffer.active.type === "alternate") return true;
        const host = innerRef.current;
        if (!host) return true;
        const rect = host.getBoundingClientRect();
        const moved = wheelLines(
          wheelCarry,
          ev.deltaY,
          ev.deltaMode,
          rect.height / term.rows,
          term.rows,
        );
        wheelCarry = moved.acc;
        if (moved.lines !== 0) {
          const { col, row } = cellFromPoint(
            ev.clientX - rect.left,
            ev.clientY - rect.top,
            rect.width,
            rect.height,
            term.cols,
            term.rows,
          );
          writeSeq(sgrWheelReport(moved.lines < 0 ? "up" : "down", col, row));
        }
        return false;
      });
    }

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
      mouseDisposables.forEach((d) => d.dispose());
      // Renderer addon first, xterm second — see disposePane. React runs this cleanup
      // before the renderer effect's own, so a bare term.dispose() here would be the one
      // that disposes the addon, and its throw would take the whole UI down with it.
      disposePane(rendererRef.current, term);
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Renderer addon, swapped in place when Settings → Terminal changes. Swapping the addon
  // is the whole point of keeping this separate from the effect above: the xterm instance
  // and its PTY survive untouched, so a renderer change costs a repaint and nothing else.
  // Placed after the create effect, so `termRef.current` is already populated on mount.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    rendererRef.current = attachRenderer(term, rendererPref, REAL_ADDONS);
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [rendererPref]);

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
        if (dirReady && !stopped) spawnPty(cols, rows);
      } else {
        void invoke("pty_resize", { sessionId, cols, rows }).catch(() => {});
      }
      // Only the agent terminal pulls focus on reveal; the right-panel shell opts out
      // (focusOnReveal=false on a session switch) so it can't steal focus from Claude.
      // The effect re-subscribes on every `visible` change, so this captures the value
      // at the moment of reveal.
      //
      // A session revealed with the rich view open must NOT pull focus either: the
      // terminal is behind the chat pane, so focusing it would put the caret somewhere
      // invisible and swallow the next thing typed.
      if (focusOnReveal && !chatOpenRef.current) term.focus();
      // Late fallback: catch layout/font settling after the first frame.
      window.setTimeout(() => scheduleFit(), 120);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, dirReady, stopped]);

  // Eager restore-on-open: bring every session of the ACTIVE project live without waiting for
  // a click (VSCode-style — the whole project comes back where you left off). Companion shells
  // (shellOnly) stay lazy. Spawns with fallback dims; the reveal-refit corrects the size when
  // the tab is actually shown. Gated by the restoreSessionsOnOpen setting (default on).
  // A session the user deliberately stopped is skipped here: without that, restoring the
  // project on the next open would relaunch it and silently undo the decision — which is
  // exactly why `stopped` is persisted rather than kept in component state.
  useEffect(() => {
    if (spawnedRef.current || shellOnly || stopped) return;
    if (!restoreOnOpen || projectId !== selectedProjectId) return;
    const term = termRef.current;
    if (!term) return;
    spawnPty(term.cols || 80, term.rows || 24);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreOnOpen, selectedProjectId, stopped]);

  // Shell-only: the resolved directory changed after spawn — a confirmed worktree was
  // deleted (fall back to the project root) or a deleted one came back. Kill + respawn
  // the shell there; scrollback for this pane is intentionally sacrificed. NEVER applied
  // to agent terminals — the keep-alive rule stands.
  useEffect(() => {
    if (!shellOnly || !spawnedRef.current) return;
    if (spawnedDirRef.current === workingDirectory) return;
    // Bump the generation FIRST so the doomed PTY's channel goes silent, then reset.
    const gen = ++spawnGenRef.current;
    spawnedRef.current = false;
    spawnedDirRef.current = null;
    termRef.current?.reset();
    // Await the kill before respawning: if pty_spawn could land first, it would
    // re-attach to the doomed PTY and the kill would leave a dead pane.
    void invoke("pty_kill", { sessionId })
      .catch(() => {})
      .then(() => {
        if (disposedRef.current || gen !== spawnGenRef.current) return;
        const term = termRef.current;
        if (term && visibleRef.current && dirReady) {
          spawnPty(term.cols || 80, term.rows || 24);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDirectory]);

  // Session hibernate: the user stopped or restarted this session.
  //
  // This is the ONLY path that may kill an AGENT PTY without deleting the session, and it
  // fires exclusively on an explicit user gesture (tab close, sidebar Stop, bulk stop-idle).
  // The keep-alive rule is otherwise untouched: tab switches, layout changes, group moves
  // and directory changes must still never reach an agent terminal.
  const prevStoppedRef = useRef(stopped);
  useEffect(() => {
    const was = prevStoppedRef.current;
    prevStoppedRef.current = stopped;
    if (was === stopped) return; // first run, or a re-render with no transition

    if (stopped) {
      if (!spawnedRef.current) return; // never spawned — nothing to do
      // Bump the generation FIRST so the doomed PTY's trailing frames (including its
      // "[process exited]" notice) can't paint over the stop marker below.
      spawnGenRef.current++;
      spawnedRef.current = false;
      spawnedDirRef.current = null;
      resetOnSpawnRef.current = true;
      // Deliberately NO reset() here: a stopped tab keeps showing where the session got to.
      // The clear happens at the NEXT spawn, just before Rust replays the snapshot.
      termRef.current?.write(
        "\r\n\x1b[2m── session stopped — click this tab to resume ──\x1b[0m\r\n",
      );
      // No pty_kill here. Tearing down the processes belongs to the `stop_session` /
      // `stop_idle_sessions` command that set this flag, and it uses RETIRE. `pty_kill` is
      // DESTROY — it would delete the scrollback snapshot the resume depends on, so a
      // second teardown from this side would quietly undo the feature.
      return;
    }

    // Restarting. Only spawn if this pane is actually on screen; a hidden one picks it up
    // through the reveal path above (which now also gates on `stopped`).
    // The repaint nudge lives in spawnPty, so it covers this path and the reveal path
    // equally — a stopped session can resume through either, depending on whether its pane
    // was already on screen when the flag cleared.
    const term = termRef.current;
    if (!term || !visibleRef.current || !dirReady) return;
    spawnPty(term.cols || 80, term.rows || 24);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopped]);

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
      {/* The rich view COVERS the terminal, it does not replace it. `.term-inner` above
          stays mounted and attached the whole time this is on screen -- unmounting or
          reparenting an xterm kills its PTY, which is the one rule this file exists to
          protect. Closing the pane reveals the terminal exactly as it was, mid-run.

          Companion shells are excluded: they have no transcript, so there would be
          nothing to render but an empty pane over a working shell. */}
      {chatOpen && !shellOnly && (
        <SessionChat sessionId={sessionId} onClose={() => toggleRichView(sessionId)} />
      )}
    </div>
  );
}
