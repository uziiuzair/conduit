import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore, type Session } from "../store";
import { TERM_BASE_FONT } from "./Terminal";
import { snapZoom } from "../terminalZoom";
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
import { resolveProjectColor } from "../layout";
import { useCanvas } from "../hooks/useCanvas";
import { AgentGlyph, glyphStateFor } from "./AgentGlyph";
import { deleteSession } from "./Sidebar";

/**
 * The spatial view of the board: one node per curated session, each showing that session's
 * REAL live terminal — from any project, since the board is global rather than per project.
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
  viewportRef,
  onZoomActive,
}: {
  /** Owned by WorkspaceCenter and shared with the toolbar, which needs the viewport's
   *  size for Fit but is a sibling of this element rather than a child. */
  viewportRef: React.RefObject<HTMLDivElement | null>;
  /** Raised true while a zoom gesture is in flight, false ~120ms after it settles.
   *  WorkspaceCenter hides the terminals for that window — see its `zooming`. */
  onZoomActive: (active: boolean) => void;
}) {
  const live = useStore((s) => s.live);
  const selectSession = useStore((s) => s.selectSession);
  const setCanvasOpen = useStore((s) => s.setCanvasOpen);
  const addSession = useStore((s) => s.addSession);
  const removeSession = useStore((s) => s.removeSession);
  const projects = useStore((s) => s.projects);
  // "New session here" has to land somewhere -- the board itself spans every project, so
  // this is the one place left that still means a single project: whichever one is
  // selected in the sidebar right now. Null (nothing selected) disables the menu item
  // rather than guessing a project for it.
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const sessionContext = useStore((s) => s.sessionContext);
  const autoProjectColors = useStore((s) => s.autoProjectColors);
  const { canvas, setCanvas } = useCanvas();

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

  // Fit once so the board never opens on empty space with the cards off-screen. Only when
  // there is no saved pan/zoom to respect -- there is now one board rather than one per
  // project, so "no saved pan/zoom" is read directly off the plane instead of off a
  // per-project record that no longer exists: pan/zoom still sitting at the untouched
  // default is what a board nobody has ever panned or zoomed looks like, whether that is
  // because it is brand new or because only its NOTES were migrated in (which carry their
  // own x/y but never a pan/zoom -- see migrateNotes in canvas.ts).
  const fittedRef = useRef(false);
  useLayoutEffect(() => {
    if (fittedRef.current) return;
    fittedRef.current = true;
    const untouched = canvas.pan.x === 0 && canvas.pan.y === 0 && canvas.zoom === 1;
    if (untouched) fitToContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally one-shot: see
    // fittedRef above. Re-running on every `canvas`/`fitToContent` change (both of which
    // change on virtually every interaction) would re-fit on the user's own panning.
  }, []);

  const settleRef = useRef<number | null>(null);
  // The wheel closure is rebuilt per render but its timeout is not; the ref is what the
  // settle reads so it snaps the LATEST zoom rather than the one the gesture started at.
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  useEffect(
    () => () => {
      // Unmounting mid-gesture (Escape / "Hide canvas" within the settle window) must still
      // clear WorkspaceCenter's `zooming` -- a bare clearTimeout would leave it stuck true
      // forever, since nothing else ever calls onZoomActive(false) again until another full
      // zoom gesture completes, and canvas terminals would render as cards on next entry.
      if (settleRef.current) {
        window.clearTimeout(settleRef.current);
        onZoomActive(false);
      }
    },
    [onZoomActive],
  );

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
        onZoomActive(true);
        setCanvas(
          zoomAt(canvas, Math.exp(-e.deltaY / 200), e.clientX - rect.left, e.clientY - rect.top),
        );
        if (settleRef.current) window.clearTimeout(settleRef.current);
        // Settle: snap to a rung so the glyphs rasterize at an integer size, then let the
        // terminals back. Read through the ref because this closure is one gesture old by
        // the time it fires.
        settleRef.current = window.setTimeout(() => {
          const cur = canvasRef.current;
          const snapped = snapZoom(cur.zoom, TERM_BASE_FONT + useStore.getState().fontZoom);
          if (snapped !== cur.zoom) {
            // Snap about the viewport centre, so settling does not slide the plane.
            const el2 = viewportRef.current;
            setCanvas(
              el2
                ? zoomAt(cur, snapped / cur.zoom, el2.clientWidth / 2, el2.clientHeight / 2)
                : { ...cur, zoom: snapped },
            );
          }
          onZoomActive(false);
        }, 120);
        return;
      }
      if ((e.target as Element | null)?.closest?.(".term-host")) return; // terminal scrollback
      e.preventDefault();
      setCanvas({ ...canvas, pan: { x: canvas.pan.x - e.deltaX, y: canvas.pan.y - e.deltaY } });
    };
    host.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => host.removeEventListener("wheel", onWheel, { capture: true });
  }, [canvas, setCanvas, onZoomActive]);

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
   * Create a session at the point the menu was opened, in the currently SELECTED project —
   * the board itself has no project of its own for a brand new session to belong to. The
   * menu item is disabled when nothing is selected (see CanvasMenu), so `menu` being open
   * here implies `selectedProjectId` is set; the null check is defensive only.
   *
   * TRANSIENT: this used to also drop the new session's card at the click point, writing
   * the node directly rather than letting `reconcile` auto-place it. `reconcile` (and its
   * auto-placement) is gone as of this change — membership is curated now — and explicit
   * placement has not landed yet, so a session created here gets no card until that lands.
   * Accepted rather than patched twice; do not add a workaround here.
   */
  const addSessionHere = () => {
    if (!menu || !selectedProjectId) return;
    setMenu(null);
    void addSession(selectedProjectId);
  };

  // Keyed across EVERY project, not one: a node's session may belong to any of them — the
  // whole point of the global board.
  const byId = useMemo(
    () => new Map(projects.flatMap((p) => p.sessions.map((s): [string, Session] => [s.id, s]))),
    [projects],
  );

  // Note/card pairs to draw a tether between. A link whose session is gone is cleared by
  // pruneCanvas, so anything unresolvable here is a card that has not been placed yet.
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

        {/* Keyed by session id, in `canvas.nodes` order, which pruneCanvas() and moveNode()
            both preserve. Never sort this list. */}
        {canvas.nodes.map((node) => {
          const session = byId.get(node.ref);
          if (!session) return null;
          const status = live[node.ref]?.status ?? "idle";
          const liveEntry = live[node.ref];
          const activity = liveEntry?.activity;
          // How long this session has been waiting on a human. Only meaningful while it IS
          // waiting -- `updatedAt` is when the status was last asserted, whatever it is.
          const waitedMs =
            status === "needsInput" && liveEntry?.updatedAt
              ? Date.now() - liveEntry.updatedAt
              : null;
          const ownerProject = projects.find((p) => p.id === node.projectId);
          // resolveProjectColor is the ONE place precedence is decided: a user-chosen colour
          // beats the derived accent, which is used only while autoProjectColors is on, and
          // null falls through to each consumer's neutral CSS fallback. Never call
          // projectAccent directly or the sidebar and the board disagree.
          const projColor = ownerProject
            ? resolveProjectColor(ownerProject.id, ownerProject.color, autoProjectColors)
            : null;
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
                  selectSession(node.projectId, node.ref);
                  setCanvasOpen(false);
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
              {/* The card IS the view below the legibility floor and during zoom gestures,
                  so it carries what the terminal would have told you. All DOM text, hence
                  crisp at any zoom -- which is the point of hiding the raster at all. */}
              {!showTerminals && (
                <div className="canvas-card-body rich">
                  <div className="canvas-card-row">
                    <span className={`canvas-card-status ${status}`}>{statusLabel(status)}</span>
                    {waitedMs !== null && (
                      <span className="canvas-card-waited" title="Waiting for you">
                        {formatWaited(waitedMs)}
                      </span>
                    )}
                  </div>
                  {activity && (
                    <div className="canvas-card-activity" title={activity}>
                      {activity}
                    </div>
                  )}
                  {/* Context % deliberately lives only in the footer (below), which is
                      present in both live and compact modes -- one location at every zoom,
                      rather than a number that appears and vanishes as you zoom. */}
                  <div className="canvas-card-row dim">
                    <span className="canvas-card-project" style={{ color: projColor ?? undefined }}>
                      {ownerProject?.name ?? "—"}
                    </span>
                  </div>
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
          Empty board — drag a session in from the sidebar, or right-click to add a section.
        </div>
      )}

      {menu && (
        <CanvasMenu
          menu={menu}
          // Link targets for a note: sessions already ON the board, not every session in
          // every project — a note ties to something you can see and drag a tether to.
          sessions={canvas.nodes
            .map((n) => byId.get(n.ref))
            .filter((s): s is Session => s !== undefined)
            .map((s) => ({ id: s.id, name: s.name }))}
          linkedRef={
            menu.noteId ? notesOf(canvas).find((n) => n.id === menu.noteId)?.linkedRef : undefined
          }
          canAddSession={selectedProjectId !== null}
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
            const node = menu.nodeRef ? canvas.nodes.find((n) => n.ref === menu.nodeRef) : undefined;
            setMenu(null);
            if (!node) return;
            selectSession(node.projectId, node.ref);
            setCanvasOpen(false);
          }}
          onNoteAbout={() => menu.nodeRef && addNoteAbout(menu.nodeRef)}
          onDeleteSession={() => {
            const ref = menu.nodeRef;
            const node = ref ? canvas.nodes.find((n) => n.ref === ref) : undefined;
            setMenu(null);
            // Reuses the sidebar's own delete, confirms and all — the confirms ARE the
            // safety here, and a thinner second path would drift away from them.
            if (ref && node) void deleteSession(projects, node.projectId, ref, removeSession);
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
  canAddSession,
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
  /** Whether a project is selected for "New session here" to create into. False disables
   *  the item instead of hiding it, so it stays a discoverable action. */
  canAddSession: boolean;
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
            <button
              onClick={onAddSession}
              disabled={!canAddSession}
              title={canAddSession ? undefined : "Select a project first"}
            >
              New session here
            </button>
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
  viewportRef,
}: {
  viewportRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { canvas, setCanvas } = useCanvas();
  const setCanvasOpen = useStore((s) => s.setCanvasOpen);
  const isLive = canvas.zoom >= LIVE_ZOOM_MIN;
  // The visible way out is the header's Board toggle, which flips to "Hide board" while
  // the board is open. This is only the keyboard route to the same action.
  const exitCanvas = useCallback(() => setCanvasOpen(false), [setCanvasOpen]);

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

/** Coarse "how long" for a card: minutes up to an hour, then hours. Never seconds — a
 *  card is read at a glance and a ticking number is noise. */
function formatWaited(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}
