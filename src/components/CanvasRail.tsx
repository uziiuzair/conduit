import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { TERM_BASE_FONT } from "./Terminal";
import { snapZoom } from "../terminalZoom";
import { CARD_H, CARD_W, LIVE_ZOOM_MIN, addNodeAt, nodeH, nodeW, type CanvasNode } from "../canvas";
import { useCanvas } from "../hooks/useCanvas";
import { resolveProjectColor } from "../layout";
import { AgentGlyph, glyphStateFor } from "./AgentGlyph";
import { formatWaited } from "./CanvasView";
import {
  attentionQueue,
  cameraFor,
  easeInOutCubic,
  edgePips,
  interpolateCamera,
  type AttentionItem,
  type AttentionSource,
  type Camera,
  type PipBox,
  type Viewport,
} from "../canvasAttention";

/** How often the queue re-reads the clock, so a wait time keeps climbing without a
 *  render every second — a status change (via `live`) still updates the rail instantly. */
const NOW_TICK_MS = 15_000;

/** Fly-to duration. Long enough to read as motion, short enough not to feel sluggish. */
const FLY_MS = 300;

/**
 * The attention rail + edge pips + fly-to camera — the part of the board that answers
 * "as load increases, how do I find the thing waiting on me" rather than "where did I put
 * it". See `src/canvasAttention.ts` for the pure geometry this renders.
 *
 * MUST be mounted by `WorkspaceCenter` as a sibling AFTER `.term-stack`, never as a child
 * of `CanvasUnderlay`. `.canvas-underlay` is a stacking context (`position: absolute;
 * z-index: 1`), and `.term-stack.canvas-mode` is a SIBLING of it at `z-index: 2` — a pip
 * nested inside the underlay could never paint above a terminal no matter what z-index it
 * declared, which is exactly the failure this feature exists to prevent (the card hiding
 * the very thing pointing at it). This is the fifth time that hazard has bitten this
 * feature; do not move this back inside the underlay.
 */
export function CanvasRail({
  viewportRef,
  onZoomActive,
}: {
  /** The canvas viewport element, owned by WorkspaceCenter and shared with
   *  CanvasControls/CanvasUnderlay — pips and fly-to both need its screen rect. */
  viewportRef: React.RefObject<HTMLDivElement | null>;
  /** Same flag CanvasUnderlay raises for a wheel-zoom gesture (see its own prop of the
   *  same name) — WorkspaceCenter hides the terminals while it is true. A fly-to crosses
   *  several font-ladder rungs continuously over its whole flight, which is exactly the
   *  per-frame glyph-atlas-rebuild cost that flag exists to hide, and clicking a rail row
   *  from an overview is the single most common way a user changes zoom on this board. */
  onZoomActive: (active: boolean) => void;
}) {
  const projects = useStore((s) => s.projects);
  const live = useStore((s) => s.live);
  const autoProjectColors = useStore((s) => s.autoProjectColors);
  const fontZoom = useStore((s) => s.fontZoom);
  const { canvas, setCanvas, snapshot } = useCanvas();

  // Sources span EVERY project's sessions, on the board or not — the queue is a triage
  // surface, not a board index (see attentionQueue's own doc comment for the two arms:
  // needsInput, and running stuck past the 20-minute watchdog).
  const sources = useMemo<AttentionSource[]>(
    () =>
      projects.flatMap((p) =>
        p.sessions.map((s) => ({
          ref: s.id,
          projectId: p.id,
          status: live[s.id]?.status ?? "idle",
          updatedAt: live[s.id]?.updatedAt,
        })),
      ),
    [projects, live],
  );

  // Re-read the clock on a coarse tick so wait times age without a render per second — a
  // status flip still updates the rail immediately via `live` above.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(t);
  }, []);
  const queue = useMemo(() => attentionQueue(sources, now), [sources, now]);
  const queueByRef = useMemo(() => new Map(queue.map((q) => [q.ref, q] as const)), [queue]);

  const byId = useMemo(
    () => new Map(projects.flatMap((p) => p.sessions.map((s) => [s.id, s] as const))),
    [projects],
  );
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p] as const)), [projects]);
  const nodeProjectId = useMemo(
    () => new Map(canvas.nodes.map((n) => [n.ref, n.projectId] as const)),
    [canvas.nodes],
  );
  const colorOf = useCallback(
    (projectId: string) =>
      resolveProjectColor(projectId, projectById.get(projectId)?.color, autoProjectColors),
    [projectById, autoProjectColors],
  );

  // ---- The board's own VISIBLE region: the viewport's rect minus the rail's own
  // footprint. Both are measured off the real DOM (ResizeObserver), never a hardcoded
  // number duplicated between here and theme.css's `.canvas-rail` rule — so the two can
  // never drift apart. This is the fix for a real bug: a card sitting behind the opaque
  // rail counts as "on screen" against the raw viewport rect, so it got no edge pip even
  // though the user cannot see it — exactly the failure pips exist to prevent, reintroduced
  // by the rail itself. Feeding this narrowed rect to BOTH edgePips (so a hidden card is
  // correctly treated as off-screen and gets a pip pinned at the rail's left edge,
  // pointing at it) and cameraFor (so a fly-to centres the target in the space the user can
  // actually see, not the raw DOM rect half of which the rail covers) is the whole fix —
  // deliberately NOT insetting `.canvas-underlay` itself, which would drag `.term-stack`
  // and every absolutely-positioned terminal into a coordinate change they do not need. ----
  const railRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  const [railWidth, setRailWidth] = useState(0);
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => setViewportSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewportRef]);
  useLayoutEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const update = () => setRailWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const boardViewport = useMemo<Viewport>(
    () => ({ w: Math.max(0, viewportSize.w - railWidth), h: viewportSize.h }),
    [viewportSize, railWidth],
  );
  // Read at animation-frame / click time rather than closed over — flyToBox is memoized
  // independent of viewport size, exactly like canvasRef below is independent of canvas
  // content, so a resize mid-flight doesn't recreate the in-flight callback.
  const boardViewportRef = useRef(boardViewport);
  boardViewportRef.current = boardViewport;

  // ---- Fly-to camera: pan+zoom animated over FLY_MS, cancelled by a second call or by
  // unmount. `canvasRef` mirrors the latest canvas on every render, mirroring the same
  // pattern CanvasUnderlay uses for its own zoom-settle timeout — read at animation-frame
  // time rather than closed over, since a frame is one render stale otherwise. ----
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  const flyRef = useRef<number | null>(null);

  const flyToBox = useCallback(
    (box: { x: number; y: number; w: number; h: number }) => {
      const el = viewportRef.current;
      if (!el) return;
      if (flyRef.current) cancelAnimationFrame(flyRef.current);
      const from: Camera = { pan: canvasRef.current.pan, zoom: canvasRef.current.zoom };
      const to = cameraFor(
        { ref: "", ...box },
        // Narrowed by the rail's own width (see boardViewport above) — centring against
        // the raw DOM rect would land the target half under the rail instead of in the
        // middle of the space the user can actually see.
        boardViewportRef.current,
        // Land on a font-size rung so the terminal is crisp the instant the flight ends —
        // arriving between rungs would land the user on a soft terminal.
        snapZoom(Math.max(canvasRef.current.zoom, LIVE_ZOOM_MIN), TERM_BASE_FONT + fontZoom),
      );
      // The flight interpolates zoom continuously, crossing several font-ladder rungs —
      // raised for its whole duration and lowered when it ends OR is cancelled by a second
      // call below (never left stuck true: cancellation immediately re-raises it for the
      // new flight, and the unmount cleanup effect lowers it if one was still in flight).
      onZoomActive(true);
      const start = performance.now();
      const step = () => {
        const t = Math.min(1, (performance.now() - start) / FLY_MS);
        const cam = interpolateCamera(from, to, easeInOutCubic(t));
        setCanvas({ ...canvasRef.current, pan: cam.pan, zoom: cam.zoom });
        if (t < 1) {
          flyRef.current = requestAnimationFrame(step);
        } else {
          flyRef.current = null;
          onZoomActive(false);
        }
      };
      flyRef.current = requestAnimationFrame(step);
    },
    [fontZoom, onZoomActive, setCanvas, viewportRef],
  );

  const flyTo = useCallback(
    (ref: string) => {
      const node = canvasRef.current.nodes.find((n) => n.ref === ref);
      if (!node) return;
      flyToBox({ x: node.x, y: node.y, w: nodeW(node), h: nodeH(node) });
    },
    [flyToBox],
  );

  useEffect(
    () => () => {
      // Unmounting mid-flight (leaving the canvas while a fly-to is running) must still
      // clear WorkspaceCenter's zooming flag -- a bare cancelAnimationFrame would leave it
      // stuck true forever, mirroring CanvasUnderlay's own settle-timeout cleanup above it.
      if (flyRef.current) {
        cancelAnimationFrame(flyRef.current);
        onZoomActive(false);
      }
    },
    [onZoomActive],
  );

  /**
   * Click a queue entry: fly to its card if it already has one, else place it near the
   * viewport centre and fly there. Curation as a side effect of triage is the low-effort
   * way onto an empty board, and it happens exactly when the user cares about the session.
   */
  const goTo = useCallback(
    (ref: string, projectId: string) => {
      const cur = canvasRef.current;
      if (cur.nodes.some((n) => n.ref === ref)) {
        flyTo(ref);
        return;
      }
      const el = viewportRef.current;
      const z = cur.zoom || 1;
      const cx = el ? el.clientWidth / 2 : 400;
      const cy = el ? el.clientHeight / 2 : 300;
      const x = (cx - cur.pan.x) / z - CARD_W / 2;
      const y = (cy - cur.pan.y) / z - CARD_H / 2;
      // One undo step for the placement, exactly like any other board edit — see
      // useCanvas' own doc comment on `snapshot`.
      snapshot();
      const next = addNodeAt(cur, ref, projectId, x, y);
      // DELIBERATE, not a stray leftover: `setCanvas` below writes the store
      // SYNCHRONOUSLY, but this component's own re-render — the thing that would
      // otherwise refresh `canvasRef.current` from the new `canvas` prop of `useCanvas()`
      // — has not happened yet. `flyTo` immediately below reads `canvasRef.current` to
      // find the node it should fly to; without this line it would still see the PREVIOUS
      // render's canvas and silently no-op (no node found yet), racing this component's
      // own render instead of waiting for it. Writing the ref by hand here closes that gap.
      canvasRef.current = next;
      setCanvas(next);
      flyTo(ref);
    },
    [flyTo, setCanvas, snapshot, viewportRef],
  );

  // ---- Edge pips: markers on the viewport border for queued sessions that ARE on the
  // board but currently off screen (against `boardViewport`, not the raw DOM rect — see
  // that constant's own comment for why). ----
  const pipBoxes = useMemo<PipBox[]>(
    () =>
      queue
        .map((q) => canvas.nodes.find((n) => n.ref === q.ref))
        .filter((n): n is CanvasNode => Boolean(n))
        .map((n) => ({ ref: n.ref, x: n.x, y: n.y, w: nodeW(n), h: nodeH(n) })),
    [queue, canvas.nodes],
  );
  const pips = useMemo(() => {
    if (boardViewport.w === 0 && boardViewport.h === 0) return [];
    return edgePips(pipBoxes, { pan: canvas.pan, zoom: canvas.zoom }, boardViewport);
  }, [pipBoxes, canvas.pan, canvas.zoom, boardViewport]);

  const rowTitle = (session: { name: string } | undefined, item: AttentionItem): string =>
    `${session?.name ?? "Session"} — waiting ${formatWaited(item.waitedMs)}`;

  /** A pip has no text of its own — the arrow is purely graphical — so its accessible name
   *  has to say both what it is pointing at AND that the thing is off screen, which a
   *  sighted user infers from the marker sitting on the viewport border but a screen
   *  reader user cannot. */
  const pipLabel = (session: { name: string } | undefined, item: AttentionItem | undefined): string =>
    `${session?.name ?? "Session"} is off screen — waiting ${formatWaited(item?.waitedMs ?? 0)}`;

  /** Rail rows and pips are both semantically buttons (activating one flies the camera),
   *  not text — a `<div onClick>` with no role/tabIndex/key handling is an incomplete
   *  button, unreachable and unactivatable from the keyboard. Shared by both so Enter/Space
   *  behave identically everywhere in this file. */
  const onKeyActivate = (handler: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handler();
    } else if (e.key === " " || e.key === "Spacebar") {
      // Space's default is scrolling the page; a button activating with Space must not
      // also scroll out from under the user.
      e.preventDefault();
      handler();
    }
  };

  return (
    <>
      <div ref={railRef} className="canvas-rail" aria-label="Sessions waiting on you">
        <div className="canvas-rail-head">Needs you</div>
        {queue.length === 0 ? (
          <div className="canvas-rail-empty">Nothing is waiting on you.</div>
        ) : (
          queue.map((q) => {
            const session = byId.get(q.ref);
            const project = projectById.get(q.projectId);
            const color = colorOf(q.projectId);
            return (
              <div
                key={q.ref}
                className="canvas-rail-row"
                title={rowTitle(session, q)}
                role="button"
                tabIndex={0}
                onClick={() => goTo(q.ref, q.projectId)}
                onKeyDown={onKeyActivate(() => goTo(q.ref, q.projectId))}
              >
                {session && (
                  <AgentGlyph
                    id={session.agent}
                    state={glyphStateFor(
                      live[q.ref]?.status,
                      live[q.ref] !== undefined,
                      live[q.ref]?.compacting,
                    )}
                  />
                )}
                <span className="canvas-rail-name">{session?.name ?? q.ref}</span>
                <span className="canvas-rail-project" style={{ color: color ?? undefined }}>
                  {project?.name ?? ""}
                </span>
                <span className="canvas-rail-waited">{formatWaited(q.waitedMs)}</span>
              </div>
            );
          })
        )}
      </div>

      {/* Screen-space overlay, positioned to match .canvas-underlay's own box exactly (see
          theme.css) so a pip's (x, y) — computed against `boardViewport`, itself measured
          off the SAME element's clientWidth/clientHeight — lands at the same place on
          screen that geometry describes. Sits ABOVE .term-stack.canvas-mode (z-index 2),
          the one thing on the board that must outrank a terminal, since a pip's whole job
          is being seen. */}
      <div className="canvas-pip-layer">
        {pips.map((pip) => {
          const item = queueByRef.get(pip.ref);
          const session = byId.get(pip.ref);
          const projectId = nodeProjectId.get(pip.ref);
          const color = projectId ? colorOf(projectId) : null;
          return (
            <div
              key={pip.ref}
              className="canvas-pip"
              style={{
                left: pip.x,
                top: pip.y,
                transform: `translate(-50%, -50%) rotate(${pip.angle}rad)`,
              }}
              title={item ? rowTitle(session, item) : session?.name}
              role="button"
              tabIndex={0}
              aria-label={pipLabel(session, item)}
              onClick={() => flyTo(pip.ref)}
              onKeyDown={onKeyActivate(() => flyTo(pip.ref))}
            >
              <span
                className="canvas-pip-arrow"
                style={color ? ({ ["--pip-tint" as string]: color } as React.CSSProperties) : undefined}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}
