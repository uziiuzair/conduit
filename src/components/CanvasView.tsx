import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { CARD_H, CARD_W, HEADER_H, LIVE_ZOOM_MIN, fit, moveNode, toCanvasDelta, zoomAt } from "../canvas";
import { useProjectCanvas } from "../hooks/useProjectCanvas";
import { AgentGlyph } from "./AgentGlyph";

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
  const { canvas, setCanvas } = useProjectCanvas(projectId);

  const [drag, setDrag] = useState<{ ref: string | null; lastX: number; lastY: number } | null>(
    null,
  );
  const showTerminals = canvas.zoom >= LIVE_ZOOM_MIN;

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
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        setCanvas(
          zoomAt(canvas, Math.exp(-e.deltaY / 200), e.clientX - rect.left, e.clientY - rect.top),
        );
      } else {
        setCanvas({ ...canvas, pan: { x: canvas.pan.x - e.deltaX, y: canvas.pan.y - e.deltaY } });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [canvas, setCanvas]);

  const onPointerDown = (e: React.PointerEvent, ref: string | null) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ ref, lastX: e.clientX, lastY: e.clientY });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dxScreen = e.clientX - drag.lastX;
    const dyScreen = e.clientY - drag.lastY;
    if (drag.ref === null) {
      setCanvas({ ...canvas, pan: { x: canvas.pan.x + dxScreen, y: canvas.pan.y + dyScreen } });
    } else {
      const node = canvas.nodes.find((n) => n.ref === drag.ref);
      if (node) {
        const { dx, dy } = toCanvasDelta(dxScreen, dyScreen, canvas.zoom);
        setCanvas(moveNode(canvas, drag.ref, node.x + dx, node.y + dy));
      }
    }
    setDrag({ ...drag, lastX: e.clientX, lastY: e.clientY });
  };

  const endDrag = () => setDrag(null);

  const byId = useMemo(() => new Map((project?.sessions ?? []).map((s) => [s.id, s])), [project]);

  return (
    <div
      ref={viewportRef}
      className={`canvas-underlay ${drag?.ref === null ? "panning" : ""}`}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget || (e.target as Element).classList.contains("canvas-plane"))
          onPointerDown(e, null);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        className="canvas-plane"
        style={{ transform: `translate(${canvas.pan.x}px, ${canvas.pan.y}px) scale(${canvas.zoom})` }}
      >
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
              style={{ left: node.x, top: node.y, width: CARD_W, height: CARD_H }}
            >
              <div
                className="canvas-card-head"
                style={{ height: HEADER_H }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onPointerDown(e, node.ref);
                }}
                onDoubleClick={() => {
                  selectSession(projectId, node.ref);
                  setCenterMode(projectId, "terminals");
                }}
                title="Drag to move · double-click to open in the pane view"
              >
                <AgentGlyph id={session.agent} />
                <span className="canvas-card-name">{session.name}</span>
                <span className={`canvas-dot status-${status}`} title={status} />
              </div>

              {/* The live terminal is painted here by .term-stack, which sits above this
                  underlay. When zoomed out past the threshold there is no terminal, so the
                  body shows the summary instead of an empty hole. */}
              {!showTerminals && (
                <div className="canvas-card-body">
                  <span className="canvas-card-status">{statusLabel(status)}</span>
                  {session.useWorktree && session.branch ? (
                    <span className="canvas-branch">{session.branch}</span>
                  ) : (
                    <span className="canvas-branch dim">project root</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {canvas.nodes.length === 0 && (
        <div className="canvas-empty">This project has no sessions yet.</div>
      )}
    </div>
  );
}

/**
 * The canvas toolbar. A SIBLING of the underlay rather than a child, because the underlay
 * sits below the terminal stack in the stacking order and a child cannot escape its
 * parent's stacking context — the toolbar has to be able to paint above the terminals.
 */
export function CanvasToolbar({
  projectId,
  viewportRef,
}: {
  projectId: string;
  viewportRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { canvas, setCanvas } = useProjectCanvas(projectId);
  const live = canvas.zoom >= LIVE_ZOOM_MIN;
  const fitToContent = () => {
    const el = viewportRef.current;
    if (el) setCanvas(fit(canvas, el.clientWidth, el.clientHeight));
  };
  return (
    <div className="canvas-toolbar">
      <span className="canvas-title">Canvas</span>
      <span className="canvas-count">
        {canvas.nodes.length} session{canvas.nodes.length === 1 ? "" : "s"}
      </span>
      <span className="canvas-toolbar-spacer" />
      <span className="canvas-lod" title={
        live
          ? "Terminals are live at this zoom"
          : `Zoom past ${Math.round(LIVE_ZOOM_MIN * 100)}% to show live terminals`
      }>
        {live ? "live" : "overview"}
      </span>
      <button className="canvas-btn" onClick={fitToContent} title="Fit all sessions in view">
        Fit
      </button>
      <button
        className="canvas-btn"
        onClick={() => setCanvas({ ...canvas, zoom: 1 })}
        title="Reset zoom to 100%"
      >
        {Math.round(canvas.zoom * 100)}%
      </button>
    </div>
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
