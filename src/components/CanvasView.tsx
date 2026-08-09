import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import {
  CARD_H,
  CARD_W,
  type CanvasState,
  emptyCanvas,
  fit,
  moveNode,
  reconcile,
  toCanvasDelta,
  zoomAt,
} from "../canvas";
import { AgentGlyph } from "./AgentGlyph";

/**
 * The spatial view of a project: one card per session, placed on a pan/zoom plane.
 *
 * Stage 1 is CARDS ONLY — no live terminals on the canvas. That is a deliberate scope
 * line, not a shortcut: a terminal is a rasterized bitmap, so a CSS-transformed one is
 * blurry at every zoom other than 1.0, and making it crisp means either re-rasterizing
 * per zoom level or writing a glyph renderer (nodeterm needed ~11,900 lines for theirs).
 * Cards give the whole spatial-map payoff — see everything, place it meaningfully, know
 * at a glance what is running — at none of that cost.
 *
 * The terminals stay mounted underneath this overlay the entire time, exactly as they do
 * under the board view. Nothing here mounts, unmounts, or reparents a TerminalView.
 *
 * Viewport handling is hand-rolled rather than React Flow: React Flow owns node DOM and
 * reorders/virtualizes it, and every one of those is an unmount.
 *
 * Design: docs/superpowers/specs/2026-08-10-project-canvas-view-viability.md
 */
export function CanvasView({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const live = useStore((s) => s.live);
  const stored = useStore((s) => s.canvases[projectId]);
  const setCanvas = useStore((s) => s.setCanvas);
  const setCenterMode = useStore((s) => s.setCenterMode);
  const selectSession = useStore((s) => s.selectSession);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ ref: string | null; lastX: number; lastY: number } | null>(
    null,
  );

  const sessionIds = useMemo(() => (project?.sessions ?? []).map((s) => s.id), [project]);

  // The canvas as rendered: stored state reconciled against the sessions that exist now.
  // Derived rather than stored so a session added or removed while this view was closed
  // is handled on the next render instead of needing a migration.
  const canvas: CanvasState = useMemo(
    () => reconcile(stored ?? emptyCanvas(), sessionIds),
    [stored, sessionIds],
  );

  // Persist the reconciliation itself (placements for new sessions, pruning for gone
  // ones) so positions survive a reload. Only when it actually changed — writing on
  // every render would loop.
  useEffect(() => {
    if (!stored || stored.nodes.length !== canvas.nodes.length) setCanvas(projectId, canvas);
  }, [canvas, stored, projectId, setCanvas]);

  const fitToContent = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    setCanvas(projectId, fit(canvas, el.clientWidth, el.clientHeight));
  }, [canvas, projectId, setCanvas]);

  // Fit once on first open of a project that has no saved pan/zoom, so the canvas never
  // opens showing empty space with the cards off-screen.
  const fittedRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (fittedRef.current === projectId || stored) return;
    fittedRef.current = projectId;
    fitToContent();
  }, [projectId, stored, fitToContent]);

  // Wheel: pan by default, zoom with ctrl/cmd (which is also what a trackpad pinch sends).
  // Registered non-passively so preventDefault actually stops the page rubber-banding.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        setCanvas(
          projectId,
          zoomAt(canvas, Math.exp(-e.deltaY / 200), e.clientX - rect.left, e.clientY - rect.top),
        );
      } else {
        setCanvas(projectId, {
          ...canvas,
          pan: { x: canvas.pan.x - e.deltaX, y: canvas.pan.y - e.deltaY },
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [canvas, projectId, setCanvas]);

  const onPointerDown = (e: React.PointerEvent, ref: string | null) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ ref, lastX: e.clientX, lastY: e.clientY });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dxScreen = e.clientX - drag.lastX;
    const dyScreen = e.clientY - drag.lastY;
    if (drag.ref === null) {
      setCanvas(projectId, {
        ...canvas,
        pan: { x: canvas.pan.x + dxScreen, y: canvas.pan.y + dyScreen },
      });
    } else {
      const node = canvas.nodes.find((n) => n.ref === drag.ref);
      if (node) {
        const { dx, dy } = toCanvasDelta(dxScreen, dyScreen, canvas.zoom);
        setCanvas(projectId, moveNode(canvas, drag.ref, node.x + dx, node.y + dy));
      }
    }
    setDrag({ ...drag, lastX: e.clientX, lastY: e.clientY });
  };

  const endDrag = () => setDrag(null);

  /** Open a session in the pane view — the canvas is for finding, panes are for working. */
  const open = (sessionId: string) => {
    selectSession(projectId, sessionId);
    setCenterMode(projectId, "terminals");
  };

  const byId = useMemo(
    () => new Map((project?.sessions ?? []).map((s) => [s.id, s])),
    [project],
  );

  return (
    <div className="canvas-view">
      <div className="canvas-toolbar">
        <span className="canvas-title">Canvas</span>
        <span className="canvas-count">
          {canvas.nodes.length} session{canvas.nodes.length === 1 ? "" : "s"}
        </span>
        <div className="canvas-toolbar-spacer" />
        <button className="canvas-btn" onClick={fitToContent} title="Fit all cards in view">
          Fit
        </button>
        <button
          className="canvas-btn"
          onClick={() => setCanvas(projectId, { ...canvas, zoom: 1 })}
          title="Reset zoom to 100%"
        >
          {Math.round(canvas.zoom * 100)}%
        </button>
      </div>

      <div
        ref={viewportRef}
        className={`canvas-viewport ${drag?.ref === null ? "panning" : ""}`}
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
          style={{
            transform: `translate(${canvas.pan.x}px, ${canvas.pan.y}px) scale(${canvas.zoom})`,
          }}
        >
          {/* Keyed by session id and rendered in `canvas.nodes` order, which `reconcile`
              and `moveNode` both preserve. Never sort this list. */}
          {canvas.nodes.map((node) => {
            const session = byId.get(node.ref);
            if (!session) return null;
            const status = live[node.ref]?.status ?? "idle";
            return (
              <div
                key={node.ref}
                className={`canvas-card status-${status}`}
                style={{ left: node.x, top: node.y, width: CARD_W, height: CARD_H }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onPointerDown(e, node.ref);
                }}
                onDoubleClick={() => open(node.ref)}
                title="Double-click to open this session"
              >
                <div className="canvas-card-head">
                  <AgentGlyph id={session.agent} />
                  <span className="canvas-card-name">{session.name}</span>
                  <span className={`canvas-dot status-${status}`} title={status} />
                </div>
                <div className="canvas-card-meta">
                  {session.useWorktree && session.branch ? (
                    <span className="canvas-branch" title={session.branch}>
                      {session.branch}
                    </span>
                  ) : (
                    <span className="canvas-branch dim">project root</span>
                  )}
                </div>
                <div className="canvas-card-status">{statusLabel(status)}</div>
              </div>
            );
          })}
        </div>

        {canvas.nodes.length === 0 && (
          <div className="canvas-empty">This project has no sessions yet.</div>
        )}
      </div>
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
