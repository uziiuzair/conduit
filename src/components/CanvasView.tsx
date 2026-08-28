import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import {
  FOOTER_H,
  HEADER_H,
  LIVE_ZOOM_MIN,
  NOTE_H,
  NOTE_HEAD_H,
  NOTE_W,
  addNote,
  fit,
  linkEndpoints,
  linkNote,
  moveNode,
  moveNote,
  nodeH,
  nodeW,
  notesOf,
  removeNote,
  resizeNode,
  resizeNote,
  setNoteText,
  toCanvasDelta,
  toCanvasPoint,
  zoomAt,
} from "../canvas";
import { meterLevel, meterTitle } from "../contextMeter";
import { useProjectCanvas } from "../hooks/useProjectCanvas";
import { AgentGlyph, glyphStateFor } from "./AgentGlyph";
import { deleteSession } from "./Sidebar";

/**
 * The spatial view of a project: one node per session, each showing that session's REAL
 * live terminal.
 *
 * The terminal is not cloned, mirrored, or re-attached. Every session's `TerminalView` is
 * already mounted for its whole life inside `.term-stack` and positioned purely by a
 * `style` prop — the canvas simply supplies different coordinates for those same elements
 * (see `placeSession` in WorkspaceCenter). That is what makes this safe: no xterm is
 * mounted, unmounted, reparented, or given a second PTY reader.
 *
 * Which means this component draws only the CHROME — the frame, header, and status — as an
 * UNDERLAY beneath the terminals, with the terminal occupying the card body below the
 * header strip. The header staying uncovered is what keeps a node draggable while its body
 * takes keystrokes.
 *
 * Below `LIVE_ZOOM_MIN` the terminals hide and the frames render as compact summaries;
 * see that constant for why the threshold exists rather than a glyph renderer.
 *
 * Design: docs/superpowers/specs/2026-08-10-project-canvas-view-viability.md
 */
export function CanvasUnderlay({
  projectId,
  viewportRef,
}: {
  projectId: string;
  /** Owned by WorkspaceCenter and shared with the toolbar, which needs the viewport's
   *  size for Fit but is a sibling of this element rather than a child. */
  viewportRef: React.RefObject<HTMLDivElement | null>;
}) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const live = useStore((s) => s.live);
  const selectSession = useStore((s) => s.selectSession);
  const setCenterMode = useStore((s) => s.setCenterMode);
  const addSession = useStore((s) => s.addSession);
  const removeSession = useStore((s) => s.removeSession);
  const projects = useStore((s) => s.projects);
  const sessionContext = useStore((s) => s.sessionContext);
  const { canvas, setCanvas } = useProjectCanvas(projectId);

  // ref === null means panning the plane; mode distinguishes moving from resizing, since
  // both are pointer drags over the same element tree; kind says which array the id
  // addresses — sessions and notes are separate lists (see canvas.ts).
  const [drag, setDrag] = useState<{
    ref: string | null;
    kind: "node" | "note";
    mode: "pan" | "move" | "resize";
    lastX: number;
    lastY: number;
  } | null>(null);
  const showTerminals = canvas.zoom >= LIVE_ZOOM_MIN;

  // Right-click menu. Holds the click in BOTH coordinate systems: screen for placing the
  // menu itself, canvas for placing whatever it creates.
  const [menu, setMenu] = useState<{
    screenX: number;
    screenY: number;
    x: number;
    y: number;
    /** Set when the click landed on a note, which gets its own items. */
    noteId?: string;
    /** Set when the click landed on a session card, which gets its own items. */
    nodeRef?: string;
  } | null>(null);

  const fitToContent = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    setCanvas(fit(canvas, el.clientWidth, el.clientHeight));
  }, [canvas, setCanvas]);

  // Fit once per project so the canvas never opens on empty space with the cards
  // off-screen. Only when there is no saved pan/zoom to respect.
  const fittedRef = useRef<string | null>(null);
  const hasStored = useStore((s) => Boolean(s.canvases[projectId]));
  useLayoutEffect(() => {
    if (fittedRef.current === projectId || hasStored) return;
    fittedRef.current = projectId;
    fitToContent();
  }, [projectId, hasStored, fitToContent]);

  // Wheel: pan by default, zoom with ctrl/cmd — which is also what a trackpad pinch
  // sends. Non-passive so preventDefault actually stops the page rubber-banding.
  //
  // Bound to the PARENT in the capture phase, not to the viewport. The terminal stack is a
  // sibling painted above the underlay, so a wheel event over a terminal never reaches the
  // underlay at all — and zoom has to work with the cursor over a node, which is most of
  // the canvas. Capturing at the common ancestor sees both.
  //
  // Plain scroll is then routed by target: inside a terminal it belongs to that terminal's
  // scrollback and we leave it alone; anywhere else it pans.
  useEffect(() => {
    const el = viewportRef.current;
    const host = el?.parentElement ?? el;
    if (!el || !host) return;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setCanvas(
          zoomAt(canvas, Math.exp(-e.deltaY / 200), e.clientX - rect.left, e.clientY - rect.top),
        );
        return;
      }
      if ((e.target as Element | null)?.closest?.(".term-host")) return; // terminal scrollback
      e.preventDefault();
      setCanvas({ ...canvas, pan: { x: canvas.pan.x - e.deltaX, y: canvas.pan.y - e.deltaY } });
    };
    host.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => host.removeEventListener("wheel", onWheel, { capture: true });
  }, [canvas, setCanvas]);

  const onPointerDown = (
    e: React.PointerEvent,
    ref: string | null,
    mode: "pan" | "move" | "resize",
    kind: "node" | "note" = "node",
  ) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ ref, kind, mode, lastX: e.clientX, lastY: e.clientY });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dxScreen = e.clientX - drag.lastX;
    const dyScreen = e.clientY - drag.lastY;
    if (drag.mode === "pan" || drag.ref === null) {
      // Pan is in SCREEN units — the plane moves with the cursor 1:1 at any zoom.
      setCanvas({ ...canvas, pan: { x: canvas.pan.x + dxScreen, y: canvas.pan.y + dyScreen } });
    } else {
      // Move and resize are in CANVAS units, so the thing tracks the cursor at any zoom.
      const { dx, dy } = toCanvasDelta(dxScreen, dyScreen, canvas.zoom);
      if (drag.kind === "note") {
        const note = notesOf(canvas).find((n) => n.id === drag.ref);
        if (note) {
          setCanvas(
            drag.mode === "resize"
              ? resizeNote(canvas, note.id, note.w + dx, note.h + dy)
              : moveNote(canvas, note.id, note.x + dx, note.y + dy),
          );
        }
      } else {
        const node = canvas.nodes.find((n) => n.ref === drag.ref);
        if (node) {
          setCanvas(
            drag.mode === "resize"
              ? resizeNode(canvas, drag.ref, nodeW(node) + dx, nodeH(node) + dy)
              : moveNode(canvas, drag.ref, node.x + dx, node.y + dy),
          );
        }
      }
    }
    setDrag({ ...drag, lastX: e.clientX, lastY: e.clientY });
  };

  const endDrag = () => setDrag(null);

  /** Right-click on the plane, a note, or a card — `on` says which. */
  const openMenu = (e: React.MouseEvent, on: { noteId?: string; nodeRef?: string } = {}) => {
    const el = viewportRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    const p = toCanvasPoint(canvas, e.clientX - rect.left, e.clientY - rect.top);
    setMenu({ screenX: e.clientX, screenY: e.clientY, x: p.x, y: p.y, ...on });
  };

  /** A note about a specific session, dropped just below its card and already linked. */
  const addNoteAbout = (ref: string) => {
    const node = canvas.nodes.find((n) => n.ref === ref);
    if (!node) return;
    const id = crypto.randomUUID();
    setCanvas(linkNote(addNote(canvas, id, node.x, node.y + nodeH(node) + 16), id, ref));
    setMenu(null);
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  const addNoteHere = () => {
    if (!menu) return;
    setCanvas(addNote(canvas, crypto.randomUUID(), menu.x, menu.y));
    setMenu(null);
  };

  /**
   * Create a session and put its card where the click was.
   *
   * The card is written into the canvas directly rather than letting `reconcile`
   * auto-place it: auto-placement fills the first free grid slot, which is the right
   * answer for a session that arrived from somewhere else and the wrong one for a session
   * the user asked for at a specific spot. `reconcile` then sees the node already exists
   * and leaves it alone.
   */
  const addSessionHere = () => {
    if (!menu) return;
    const { x, y } = menu;
    setMenu(null);
    const before = new Set((project?.sessions ?? []).map((s) => s.id));
    void (async () => {
      await addSession(projectId);
      const st = useStore.getState();
      const fresh = (st.projects.find((p) => p.id === projectId)?.sessions ?? []).find(
        (s) => !before.has(s.id),
      );
      if (!fresh) return;
      // Re-read rather than closing over `canvas`: the await let the store move on, and
      // the session that was just created is itself one of the changes.
      const cur = st.canvases[projectId];
      if (!cur || cur.nodes.some((n) => n.ref === fresh.id)) return;
      setCanvas({ ...cur, nodes: [...cur.nodes, { ref: fresh.id, x, y }] });
    })();
  };

  const byId = useMemo(() => new Map((project?.sessions ?? []).map((s) => [s.id, s])), [project]);

  // Note/card pairs to draw a tether between. A link whose session is gone is cleared by
  // reconcile, so anything unresolvable here is a card that has not been placed yet.
  const tethers = useMemo(
    () =>
      notesOf(canvas)
        .filter((n) => n.linkedRef)
        .map((note) => ({ note, node: canvas.nodes.find((n) => n.ref === note.linkedRef) }))
        .filter((p): p is { note: (typeof p)["note"]; node: NonNullable<(typeof p)["node"]> } =>
          Boolean(p.node),
        ),
    [canvas],
  );

  return (
    <div
      ref={viewportRef}
      className={`canvas-underlay ${drag?.ref === null ? "panning" : ""}`}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget || (e.target as Element).classList.contains("canvas-plane"))
          onPointerDown(e, null, "pan");
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onContextMenu={(e) => openMenu(e)}
    >
      <div
        className="canvas-plane"
        style={{ transform: `translate(${canvas.pan.x}px, ${canvas.pan.y}px) scale(${canvas.zoom})` }}
      >
        {/* Tethers, drawn UNDER everything. Each runs centre to centre and is then clipped
            for free by the boxes painting over it, so what remains is exactly the gap
            between a note and the session it is about. */}
        {tethers.length > 0 && (
          <svg className="canvas-links" aria-hidden>
            {tethers.map(({ note, node }) => {
              const { x1, y1, x2, y2 } = linkEndpoints(note, node);
              return <line key={note.id} x1={x1} y1={y1} x2={x2} y2={y2} />;
            })}
          </svg>
        )}

        {/* Notes first, so a note never paints over a session card. They are a separate
            list from `nodes` — see canvas.ts for why. */}
        {notesOf(canvas).map((note) => (
          <div
            key={note.id}
            className="canvas-note"
            style={{ left: note.x, top: note.y, width: note.w, height: note.h }}
            onContextMenu={(e) => openMenu(e, { noteId: note.id })}
          >
            <div
              className="canvas-note-head"
              style={{ height: NOTE_HEAD_H }}
              onPointerDown={(e) => {
                e.stopPropagation();
                onPointerDown(e, note.id, "move", "note");
              }}
              title="Drag to move · right-click to link or delete"
            >
              {/* Names the session even when its card is off-screen or the tether is too
                  long to follow by eye — which is most of why a link is worth having. */}
              {note.linkedRef && byId.has(note.linkedRef) && (
                <span className="canvas-note-link" title={`About ${byId.get(note.linkedRef)!.name}`}>
                  {byId.get(note.linkedRef)!.name}
                </span>
              )}
            </div>
            {/* An always-editable textarea rather than a click-to-edit mode: a sticky note
                that needs to be unlocked before it can be written on is a worse sticky
                note, and there is nothing here to protect from a stray keystroke. */}
            <textarea
              className="canvas-note-text"
              value={note.text}
              placeholder="Note…"
              spellCheck={false}
              onChange={(e) => setCanvas(setNoteText(canvas, note.id, e.target.value))}
              // The plane pans on pointerdown; without this, clicking into a note to type
              // would drag the whole canvas instead of placing a cursor. Stopping here
              // also stops the menu's own dismiss-on-outside-click listener from ever
              // seeing the event, so close it explicitly.
              onPointerDown={(e) => {
                e.stopPropagation();
                setMenu(null);
              }}
            />
            <span
              className="canvas-note-resize"
              title="Drag to resize"
              onPointerDown={(e) => {
                e.stopPropagation();
                onPointerDown(e, note.id, "resize", "note");
              }}
            />
          </div>
        ))}

        {/* Keyed by session id, in `canvas.nodes` order, which reconcile() and moveNode()
            both preserve. Never sort this list. */}
        {canvas.nodes.map((node) => {
          const session = byId.get(node.ref);
          if (!session) return null;
          const status = live[node.ref]?.status ?? "idle";
          return (
            <div
              key={node.ref}
              className={`canvas-card status-${status} ${showTerminals ? "live" : "compact"}`}
              style={{ left: node.x, top: node.y, width: nodeW(node), height: nodeH(node) }}
              onContextMenu={(e) => openMenu(e, { nodeRef: node.ref })}
            >
              <div
                className="canvas-card-head"
                style={{ height: HEADER_H }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onPointerDown(e, node.ref, "move");
                }}
                onDoubleClick={() => {
                  selectSession(projectId, node.ref);
                  setCenterMode(projectId, "terminals");
                }}
                title="Drag to move · double-click to open in the pane view"
              >
                <AgentGlyph
                  id={session.agent}
                  state={glyphStateFor(status, live[node.ref] !== undefined, live[node.ref]?.compacting)}
                />
                <span className="canvas-card-name">{session.name}</span>
                <span className={`canvas-dot status-${status}`} title={status} />
              </div>

              {/* The live terminal is painted here by .term-stack, which sits above this
                  underlay. When zoomed out past the threshold there is no terminal, so the
                  body shows the summary instead of an empty hole. */}
              {!showTerminals && (
                <div className="canvas-card-body">
                  <span className="canvas-card-status">{statusLabel(status)}</span>
                </div>
              )}

              {/* Footer strip. The terminal stops above it, so everything here stays
                  clickable even while the node is live. */}
              <div className="canvas-card-foot" style={{ height: FOOTER_H }}>
                {session.useWorktree && session.branch ? (
                  <span className="canvas-branch" title={session.branch}>
                    {session.branch}
                  </span>
                ) : (
                  <span className="canvas-branch dim">project root</span>
                )}
                {/* Context fill, same reading as the session's tab. On a card it is a
                    number rather than a hairline: a card is big enough to read one, and at
                    canvas distances a 2px bar says nothing. */}
                {sessionContext[node.ref] && (
                  <span
                    className={`canvas-ctx ${meterLevel(sessionContext[node.ref].fraction)}`}
                    title={meterTitle(sessionContext[node.ref])}
                  >
                    {Math.round(sessionContext[node.ref].fraction * 100)}%
                  </span>
                )}
                <span
                  className="canvas-resize"
                  title="Drag to resize"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onPointerDown(e, node.ref, "resize");
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {canvas.nodes.length === 0 && notesOf(canvas).length === 0 && (
        <div className="canvas-empty">
          Nothing here yet — right-click to add a session or a note.
        </div>
      )}

      {menu && (
        <CanvasMenu
          menu={menu}
          sessions={project?.sessions ?? []}
          linkedRef={
            menu.noteId ? notesOf(canvas).find((n) => n.id === menu.noteId)?.linkedRef : undefined
          }
          onClose={closeMenu}
          onAddSession={addSessionHere}
          onAddNote={addNoteHere}
          onLinkNote={(ref) => {
            if (menu.noteId) setCanvas(linkNote(canvas, menu.noteId, ref));
            setMenu(null);
          }}
          onDeleteNote={() => {
            if (menu.noteId) setCanvas(removeNote(canvas, menu.noteId));
            setMenu(null);
          }}
          onOpenSession={() => {
            if (!menu.nodeRef) return;
            setMenu(null);
            selectSession(projectId, menu.nodeRef);
            setCenterMode(projectId, "terminals");
          }}
          onNoteAbout={() => menu.nodeRef && addNoteAbout(menu.nodeRef)}
          onDeleteSession={() => {
            const ref = menu.nodeRef;
            setMenu(null);
            // Reuses the sidebar's own delete, confirms and all — the confirms ARE the
            // safety here, and a thinner second path would drift away from them.
            if (ref) void deleteSession(projects, projectId, ref, removeSession);
          }}
        />
      )}
    </div>
  );
}

/** The canvas right-click menu. Flips into the viewport the same way the tab menu does. */
function CanvasMenu({
  menu,
  sessions,
  linkedRef,
  onClose,
  onAddSession,
  onAddNote,
  onLinkNote,
  onDeleteNote,
  onOpenSession,
  onNoteAbout,
  onDeleteSession,
}: {
  menu: { screenX: number; screenY: number; noteId?: string; nodeRef?: string };
  /** Link targets, when the menu is a note's. */
  sessions: Array<{ id: string; name: string }>;
  /** The note's current link, so the list can mark it. */
  linkedRef?: string;
  onClose: () => void;
  onAddSession: () => void;
  onAddNote: () => void;
  onLinkNote: (ref: string | null) => void;
  onDeleteNote: () => void;
  onOpenSession: () => void;
  onNoteAbout: () => void;
  onDeleteSession: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    let left = menu.screenX;
    let top = menu.screenY;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, menu.screenX - r.width);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, menu.screenY - r.height);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [menu]);

  // Escape closes the MENU, and must not reach the canvas's own Escape handler — otherwise
  // dismissing a menu would also leave the canvas. Capture phase on window, which runs
  // before that handler's bubble-phase listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <>
      {/* A real backdrop rather than a window listener. Anything can swallow a pointer
          event before it reaches window — xterm does, for selection — and a menu that
          sometimes cannot be dismissed is worse than one with no click-away at all. An
          element that covers the screen cannot be bypassed. */}
      <div
        className="canvas-menu-backdrop"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          // A second right-click closes rather than opening a menu on the backdrop.
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        className="context-menu canvas-menu"
        style={{ left: menu.screenX, top: menu.screenY }}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {menu.noteId ? (
          <>
            {/* A flat list rather than a submenu: a project has a handful of sessions, and
                a submenu would put a hover-and-wait between the user and the only thing
                this menu is for. */}
            <div className="context-menu-label">This note is about…</div>
            {sessions.length === 0 && <div className="context-menu-empty">No sessions yet</div>}
            {sessions.map((s) => (
              <button
                key={s.id}
                className={linkedRef === s.id ? "checked" : ""}
                onClick={() => onLinkNote(linkedRef === s.id ? null : s.id)}
                title={linkedRef === s.id ? "Click to unlink" : `Link this note to ${s.name}`}
              >
                {s.name}
              </button>
            ))}
            {linkedRef && <button onClick={() => onLinkNote(null)}>Unlink</button>}
            <div className="context-menu-sep" />
            <button className="danger" onClick={onDeleteNote}>
              Delete note
            </button>
          </>
        ) : menu.nodeRef ? (
          <>
            <button onClick={onOpenSession}>Open in panes</button>
            <button onClick={onNoteAbout}>Add a note about this</button>
            <div className="context-menu-sep" />
            <button className="danger" onClick={onDeleteSession}>
              Delete session…
            </button>
          </>
        ) : (
          <>
            <button onClick={onAddSession}>New session here</button>
            <button onClick={onAddNote}>Add sticky note</button>
          </>
        )}
      </div>
    </>
  );
}

/**
 * Canvas controls, mounted INSIDE the persistent tab-strip header rather than in a bar of
 * their own. A floating toolbar meant two stacked headers and a strip of chrome sitting on
 * top of the first row of nodes; the header was already always-visible, so it hosts these.
 */
export function CanvasControls({
  projectId,
  viewportRef,
}: {
  projectId: string;
  viewportRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { canvas, setCanvas } = useProjectCanvas(projectId);
  const setCenterMode = useStore((s) => s.setCenterMode);
  const isLive = canvas.zoom >= LIVE_ZOOM_MIN;
  // The visible way out is the header's Canvas toggle, which flips to "Hide canvas" while
  // the canvas is open. This is only the keyboard route to the same action.
  const exitCanvas = useCallback(
    () => setCenterMode(projectId, "terminals"),
    [projectId, setCenterMode],
  );

  // Escape leaves the canvas — but ONLY when the keystroke did not land somewhere that
  // owns it. Escape inside a live agent session is how you interrupt it, and stealing that
  // to change views would be far worse than having no shortcut at all; Escape while typing
  // in a sticky note is a way to stop typing, not a way to lose the view you are typing in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as Element | null;
      if (target?.closest?.(".term-host")) return;
      if (target?.closest?.("textarea, input, [contenteditable='true']")) {
        (target as HTMLElement).blur?.();
        return;
      }
      exitCanvas();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exitCanvas]);

  return (
    <span className="canvas-controls">
      <span
        className="canvas-lod"
        title={
          isLive
            ? "Terminals are live at this zoom"
            : `Zoom past ${Math.round(LIVE_ZOOM_MIN * 100)}% to show live terminals`
        }
      >
        {isLive ? "live" : "overview"}
      </span>
      {/* The right-click menu is the fuller route; this exists so "you can put notes here"
          is discoverable without knowing to right-click first. Drops the note in the middle
          of what is currently on screen. */}
      <button
        className="canvas-btn"
        onClick={() => {
          const el = viewportRef.current;
          if (!el) return;
          const c = toCanvasPoint(canvas, el.clientWidth / 2, el.clientHeight / 2);
          setCanvas(addNote(canvas, crypto.randomUUID(), c.x - NOTE_W / 2, c.y - NOTE_H / 2));
        }}
        title="Add a sticky note in the middle of the view"
      >
        + Note
      </button>
      <button
        className="canvas-btn"
        onClick={() => {
          const el = viewportRef.current;
          if (el) setCanvas(fit(canvas, el.clientWidth, el.clientHeight));
        }}
        title="Fit everything in view"
      >
        Fit
      </button>
      <button
        className="canvas-btn"
        onClick={() => setCanvas({ ...canvas, zoom: 1 })}
        title="Reset zoom to 100%"
      >
        {Math.round(canvas.zoom * 100)}%
      </button>
    </span>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Working";
    case "needsInput":
      return "Needs you";
    case "done":
      return "Done";
    default:
      return "Idle";
  }
}
