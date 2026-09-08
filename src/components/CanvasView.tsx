import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore, type Session } from "../store";
import { TERM_BASE_FONT } from "./Terminal";
import { snapZoom } from "../terminalZoom";
import {
  type Box,
  type CanvasState,
  CARD_H,
  CARD_W,
  FOOTER_H,
  HEADER_H,
  LIVE_ZOOM_MIN,
  type Members,
  NOTE_H,
  NOTE_HEAD_H,
  NOTE_W,
  SECTION_PALETTE,
  addNodeAt,
  addNote,
  addSection,
  boxOfNode,
  boxOfNote,
  boxOfSection,
  containsBox,
  fit,
  linkEndpoints,
  linkNote,
  membersOf,
  moveNode,
  moveNote,
  nodeH,
  nodeW,
  notesOf,
  removeNode,
  removeNote,
  removeSection,
  resizeNode,
  resizeNote,
  resizeSection,
  sectionsByZ,
  sectionsOf,
  setNoteText,
  setSectionColor,
  setSectionTitle,
  toCanvasDelta,
  toCanvasPoint,
  translateMany,
  zoomAt,
} from "../canvas";
import { emptyHistory, pushHistory, redo, undo } from "../canvasHistory";
import { meterLevel, meterTitle } from "../contextMeter";
import { hasSessionDrag, readSessionDrag, resolveProjectColor } from "../layout";
import { useCanvas } from "../hooks/useCanvas";
import { AgentGlyph, glyphStateFor } from "./AgentGlyph";
import { CanvasSectionFrame } from "./CanvasSection";
import { deleteSession } from "./Sidebar";

/** How far a pointer has to move before a gesture counts as a drag rather than a click —
 *  shared by object-click-to-select and the marquee's own click/drag split. */
const CLICK_DRAG_THRESHOLD_PX = 3;

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

  // Undo/redo. A ref, not state — history churns on every edit and none of it is ever
  // rendered directly, only replayed back into `canvas` via setCanvas.
  const historyRef = useRef(emptyHistory<CanvasState>());
  /** Record the state as it was BEFORE a gesture or a discrete edit. Called at gesture
   *  START (pointer-down of a move/resize, or immediately before a menu action's
   *  setCanvas) and NEVER per pointer-move — that is what makes one drag one undo step.
   *  pushHistory itself dedupes a snapshot identical to the last one recorded, so calling
   *  this at the start of a gesture that turns out to be a no-op click costs nothing. */
  const snapshot = useCallback(() => {
    historyRef.current = pushHistory(historyRef.current, canvas);
  }, [canvas]);

  // ref === null means panning the plane; mode distinguishes moving from resizing, since
  // both are pointer drags over the same element tree; kind says which array the id
  // addresses — sessions, notes and sections are separate lists (see canvas.ts).
  const [drag, setDrag] = useState<{
    ref: string | null;
    kind: "node" | "note" | "section";
    mode: "pan" | "move" | "resize";
    lastX: number;
    lastY: number;
    /** Captured at gesture start for a section move — recomputing per frame would let
     *  items join and leave as the box swept over them, which reads as the section
     *  eating the board. */
    members?: Members;
  } | null>(null);

  /** Ephemeral and never persisted — a selection is a thing you are doing, not a thing the
   *  board is. Never written into CanvasState or localStorage. */
  const [selection, setSelection] = useState<
    Array<{ kind: "node" | "note" | "section"; id: string }>
  >([]);
  const isSelected = useCallback(
    (kind: "node" | "note" | "section", id: string) =>
      selection.some((s) => s.kind === kind && s.id === id),
    [selection],
  );
  /** Click on an object selects it alone; shift-click toggles it in or out of the set. */
  const selectObject = useCallback(
    (kind: "node" | "note" | "section", id: string, additive: boolean) => {
      setSelection((sel) => {
        if (!additive) return [{ kind, id }];
        const already = sel.some((s) => s.kind === kind && s.id === id);
        return already ? sel.filter((s) => !(s.kind === kind && s.id === id)) : [...sel, { kind, id }];
      });
    },
    [],
  );

  // Distinguishes a click from a drag: a move/resize/pan gesture that never crossed the
  // threshold above is a click, and a click on an object selects it (see endDrag) while a
  // drag does not also fire a spurious select of whatever it started on. Refs, not state —
  // read once at gesture end, never rendered.
  const movedRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  // Rubber-band selection. Screen-space, relative to the VIEWPORT element's own rect (never
  // the host's — see the marquee-tracking effect below for why). null when no marquee is in
  // progress. `additive` is captured at gesture start from the shift key, since a marquee
  // adds to the existing selection rather than replacing it while held.
  const [marquee, setMarquee] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    additive: boolean;
  } | null>(null);
  const marqueeRef = useRef(marquee);
  marqueeRef.current = marquee;

  // Space-drag pans, since plain-drag on empty plane now marquees (see the plane's own
  // pointerdown handler and the marquee-tracking effect below). Tracked in a ref rather
  // than state — it drives an imperative check inside a pointerdown handler, not a render.
  // Ignored while the keystroke lands in an editable element (a note, a section's title
  // editor) so ordinary typing of the space bar never arms panning.
  const spaceHeldRef = useRef(false);
  useEffect(() => {
    const isEditable = (t: EventTarget | null) =>
      !!(t as Element | null)?.closest?.("textarea, input, [contenteditable='true']");
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isEditable(e.target)) spaceHeldRef.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeldRef.current = false;
    };
    // Space held, then focus leaves the webview entirely (Cmd-Tab away, released outside
    // the window) — no keyup ever reaches us, and without this the ref would stick `true`
    // forever, silently panning every later plain drag instead of marqueeing.
    const onBlur = () => {
      spaceHeldRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Undo/redo/delete-selection. Bound to window, not the underlay element, so it fires
  // regardless of which piece of chrome has focus — but two guards keep it from stealing a
  // keystroke that belongs elsewhere, mirroring CanvasControls' own Escape handler above:
  // a keystroke inside a live agent terminal belongs to that agent, and one landing in an
  // editable field (a note's textarea, a section's rename input) is that field's own text,
  // not a board command. The section rename input additionally stops propagation on every
  // keydown itself (see CanvasSectionFrame), so it never reaches here at all; the check
  // below is what protects the note textarea, which has no such handler of its own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.(".term-host")) return;
      if (target?.closest?.("textarea, input, [contenteditable='true']")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const step = undo(historyRef.current, canvas);
        if (step) {
          historyRef.current = step.history;
          setCanvas(step.state);
        }
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const step = redo(historyRef.current, canvas);
        if (step) {
          historyRef.current = step.history;
          setCanvas(step.state);
        }
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && selection.length > 0) {
        e.preventDefault();
        // This removes objects from the BOARD only — removeNode/removeNote/removeSection
        // never touch a session's lifecycle. Ending a session stays behind the sidebar's
        // own confirming path (see onDeleteSession in the context menu below); a keystroke
        // must never reach it.
        snapshot();
        let next = canvas;
        for (const s of selection) {
          if (s.kind === "node") next = removeNode(next, s.id);
          else if (s.kind === "note") next = removeNote(next, s.id);
          else next = removeSection(next, s.id);
        }
        setCanvas(next);
        // Selection referred to objects that may no longer exist — clear it rather than
        // leave it pointing at deleted ids.
        setSelection([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvas, setCanvas, selection, snapshot]);

  // "Rename" in a section's context menu opens the SAME inline editor as a double-click on
  // its title chip, but that editor's state lives inside CanvasSectionFrame — a sibling of
  // this menu. window.prompt() is unreliable in WKWebView (see ProfileBar in Sidebar.tsx),
  // so this is a request, not the edit state itself: bumping the nonce for a target id is
  // what tells that one frame to open its own editor.
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameNonce, setRenameNonce] = useState(0);
  const showTerminals = canvas.zoom >= LIVE_ZOOM_MIN;

  // Drop-affordance for a session dragged in from the sidebar. Read during `dragover` off
  // the MIME type alone — `dataTransfer.getData` is blocked until drop, only `types` is
  // readable — so this is the earliest point the outline can render.
  const [dropActive, setDropActive] = useState(false);

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
    /** Set when the click landed on a section's title chip, which gets its own items. */
    sectionId?: string;
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

  // Dropping a session from the sidebar onto the board. Bound to the same PARENT as the
  // wheel handler above, in the same capture phase, for the identical reason: the
  // terminal stack is a SIBLING painted above the underlay, and a card's terminal takes
  // pointer events once visible (`.term-host.visible`), so a drag over the body of an
  // already-placed card never reaches a listener on the underlay itself — it would bubble
  // straight past it to `.workspace`'s own (unrelated) pane-drop handler. Capturing at the
  // common ancestor sees both the open canvas and every card's terminal.
  useEffect(() => {
    const el = viewportRef.current;
    const host = el?.parentElement ?? el;
    if (!el || !host) return;
    const onDragOver = (e: DragEvent) => {
      // Only claim drags we actually accept — an unrelated drag (a file, browser text
      // selection, another app's drop source) must fall through to default browser
      // behaviour rather than being swallowed by a preventDefault it never asked for.
      if (!hasSessionDrag(e.dataTransfer)) return;
      e.preventDefault();
      // MUST match the sidebar row's effectAllowed ("move", shared with the sidebar->pane
      // drag). The browser computes the drag operation as the intersection of the
      // source's effectAllowed and the target's dropEffect; "move" does not admit "copy",
      // so setting "copy" here would make WebKit resolve the operation to "none" and the
      // `drop` event would never fire — silently, no console warning. The session is not
      // literally leaving the sidebar (it stays listed there), but the sidebar is a
      // directory of every session, not a container this drag removes it from, so "move"
      // is also the honest read of what dropping onto the board does. Do not change this
      // back to "copy" — change the sidebar's effectAllowed instead if a future consumer
      // genuinely needs a copy semantic, and only after checking every existing drag it
      // is shared with.
      e.dataTransfer!.dropEffect = "move";
      setDropActive((prev) => (prev ? prev : true));
    };
    const onDragLeave = (e: DragEvent) => {
      // Against HOST, not `el` — a card's terminal lives in the sibling `.term-stack`, so
      // checking against the underlay alone would read every card as "outside the board"
      // and flicker the outline off on every pass over one. Checking against the common
      // ancestor is what keeps "still over the board" true while the cursor is over a
      // card's live terminal.
      if (!host.contains(e.relatedTarget as Node | null)) setDropActive(false);
    };
    const onDrop = (e: DragEvent) => {
      setDropActive(false);
      const payload = readSessionDrag(e.dataTransfer);
      if (!payload) return;
      e.preventDefault();
      // Against EL (the viewport/underlay element), not `host` — `host` is the wider
      // ancestor shared with the terminal stack, and its rect is offset from the
      // underlay's own origin that `toCanvasPoint` expects.
      const rect = el.getBoundingClientRect();
      // Drop where the cursor is, centred on it rather than corner-anchored — a card
      // whose top-left lands under the pointer appears to jump down and right.
      const p = toCanvasPoint(canvas, e.clientX - rect.left, e.clientY - rect.top);
      snapshot();
      setCanvas(
        addNodeAt(canvas, payload.sessionId, payload.projectId, p.x - CARD_W / 2, p.y - CARD_H / 2),
      );
    };
    host.addEventListener("dragover", onDragOver, { capture: true });
    host.addEventListener("dragleave", onDragLeave, { capture: true });
    host.addEventListener("drop", onDrop, { capture: true });
    return () => {
      host.removeEventListener("dragover", onDragOver, { capture: true });
      host.removeEventListener("dragleave", onDragLeave, { capture: true });
      host.removeEventListener("drop", onDrop, { capture: true });
    };
  }, [canvas, setCanvas, snapshot]);

  // Fallback for a drag that ends without ever firing `dragleave` on the board — e.g.
  // cancelled with Esc while still hovering it. This is NOT a theoretical gap: this
  // exact drag payload already needed this exact fallback once, in WorkspaceCenter's
  // sidebar-to-pane overlay, whose comment on `sidebarDragging` records that a
  // Esc-cancelled drag over that overlay fires no `dragleave` at all. `dragend` always
  // fires on the drag SOURCE regardless of how the drag ended, so listen globally rather
  // than trust a `dragleave` that may never come. Mirrors that effect exactly.
  useEffect(() => {
    if (!dropActive) return;
    const clear = () => setDropActive(false);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [dropActive]);

  // Marquee drag-tracking: bound to the ancestor in the capture phase, exactly like the
  // wheel and drag-and-drop handlers above and for the identical reason — `.term-stack` is
  // a sibling painted above this element, so a plain listener bound to the underlay would
  // lose the drag the instant it crossed a card's live terminal. A marquee that cannot be
  // drawn across a card cannot select the things people most want to select. Reads/writes
  // through refs (`marqueeRef`, `canvasRef`) rather than the closed-over `marquee`/`canvas`
  // so the effect can bind once and stay correct across the whole gesture.
  useEffect(() => {
    const el = viewportRef.current;
    const host = el?.parentElement ?? el;
    if (!el || !host) return;
    const onMove = (e: PointerEvent) => {
      if (!marqueeRef.current) return;
      const rect = el.getBoundingClientRect();
      setMarquee((m) => (m ? { ...m, x1: e.clientX - rect.left, y1: e.clientY - rect.top } : m));
    };
    const onUp = () => {
      const cur = marqueeRef.current;
      if (!cur) return;
      setMarquee(null);
      const x0 = Math.min(cur.x0, cur.x1);
      const y0 = Math.min(cur.y0, cur.y1);
      const x1 = Math.max(cur.x0, cur.x1);
      const y1 = Math.max(cur.y0, cur.y1);
      if (x1 - x0 < CLICK_DRAG_THRESHOLD_PX && y1 - y0 < CLICK_DRAG_THRESHOLD_PX) {
        // Never dragged far enough to be a marquee — a plain click on empty plane, which
        // clears the selection. A shift-click has nothing to add or remove, so it leaves
        // the existing selection alone rather than clearing it.
        if (!cur.additive) setSelection([]);
        return;
      }
      const c = canvasRef.current;
      const p0 = toCanvasPoint(c, x0, y0);
      const p1 = toCanvasPoint(c, x1, y1);
      const box: Box = { x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y };
      const hits: Array<{ kind: "node" | "note" | "section"; id: string }> = [
        ...c.nodes
          .filter((n) => containsBox(box, boxOfNode(n)))
          .map((n) => ({ kind: "node" as const, id: n.ref })),
        ...notesOf(c)
          .filter((n) => containsBox(box, boxOfNote(n)))
          .map((n) => ({ kind: "note" as const, id: n.id })),
        ...sectionsOf(c)
          .filter((s) => containsBox(box, boxOfSection(s)))
          .map((s) => ({ kind: "section" as const, id: s.id })),
      ];
      setSelection((sel) => {
        if (!cur.additive) return hits;
        const merged = [...sel];
        for (const h of hits) if (!merged.some((s) => s.kind === h.kind && s.id === h.id)) merged.push(h);
        return merged;
      });
    };
    host.addEventListener("pointermove", onMove, { capture: true });
    host.addEventListener("pointerup", onUp, { capture: true });
    host.addEventListener("pointercancel", onUp, { capture: true });
    return () => {
      host.removeEventListener("pointermove", onMove, { capture: true });
      host.removeEventListener("pointerup", onUp, { capture: true });
      host.removeEventListener("pointercancel", onUp, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount-once: every
    // value read inside comes through a ref (marqueeRef, canvasRef), so rebinding on canvas
    // or selection churn would only add pointless listener thrash mid-gesture.
  }, []);

  const onPointerDown = (
    e: React.PointerEvent,
    ref: string | null,
    mode: "pan" | "move" | "resize",
    kind: "node" | "note" | "section" = "node",
  ) => {
    // Middle-drag always pans, regardless of what the caller asked for — a middle click
    // must never start a move or a resize. This is the one case the button-0 guard below
    // is relaxed for.
    if (e.button === 1) {
      // Chromium (WebView2 on Windows, and Chrome-based dev tooling) fires its own
      // middle-click autoscroll on this same press; left alone it fights the pan with its
      // own scroll cursor.
      e.preventDefault();
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      movedRef.current = false;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      setDrag({ ref: null, kind: "node", mode: "pan", lastX: e.clientX, lastY: e.clientY });
      return;
    }
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    movedRef.current = false;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    // A move or resize is about to mutate the canvas; a pan only moves the camera and must
    // never create an undo step. Recorded once here, at gesture start, not per pointermove
    // in onPointerMove below — that is what makes one drag one undo step.
    if (mode !== "pan") snapshot();
    // Membership is captured ONCE, here, at gesture start — never recomputed on later
    // pointermoves. A resize is deliberately excluded: it changes what the section
    // contains rather than moving anything, so it has no members to capture.
    let members: Members | undefined;
    if (kind === "section" && mode === "move" && ref) {
      const m = membersOf(canvas, ref);
      members = { ...m, sections: [...m.sections, ref] };
    }
    setDrag({ ref, kind, mode, lastX: e.clientX, lastY: e.clientY, members });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    if (
      Math.abs(e.clientX - dragStartRef.current.x) > CLICK_DRAG_THRESHOLD_PX ||
      Math.abs(e.clientY - dragStartRef.current.y) > CLICK_DRAG_THRESHOLD_PX
    ) {
      movedRef.current = true;
    }
    const dxScreen = e.clientX - drag.lastX;
    const dyScreen = e.clientY - drag.lastY;
    if (drag.mode === "pan" || drag.ref === null) {
      // Pan is in SCREEN units — the plane moves with the cursor 1:1 at any zoom.
      setCanvas({ ...canvas, pan: { x: canvas.pan.x + dxScreen, y: canvas.pan.y + dyScreen } });
    } else {
      // Move and resize are in CANVAS units, so the thing tracks the cursor at any zoom.
      const { dx, dy } = toCanvasDelta(dxScreen, dyScreen, canvas.zoom);
      if (drag.kind === "section") {
        if (drag.mode === "resize") {
          const section = sectionsOf(canvas).find((s) => s.id === drag.ref);
          // Resize only changes what the section CONTAINS — contents are deliberately
          // left where they are, which is what makes "draw a box around those three" work.
          if (section) setCanvas(resizeSection(canvas, section.id, section.w + dx, section.h + dy));
        } else if (drag.members) {
          // The set captured at pointerdown, not a fresh membersOf() call — see the
          // `members` field's own comment on why recomputing here would be wrong.
          setCanvas(translateMany(canvas, drag.members, dx, dy));
        }
      } else if (drag.kind === "note") {
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

  // A plain click (no meaningful movement) selects the object the gesture started on;
  // shift-click toggles it in or out of the set. Pan gestures (drag.ref === null, both
  // space-drag and middle-drag) never select — see the plane's own pointerdown handler and
  // the middle-button branch above for why a pan is the only mode that can have a null ref.
  const endDrag = (e: React.PointerEvent) => {
    if (drag && drag.ref !== null && !movedRef.current) {
      selectObject(drag.kind, drag.ref, e.shiftKey);
    }
    setDrag(null);
  };
  // A cancelled gesture (pointercancel) is not a deliberate release — clear the drag
  // without treating it as a click.
  const cancelDrag = () => setDrag(null);

  /** Right-click on the plane, a note, a card, or a section's title chip — `on` says which. */
  const openMenu = (
    e: React.MouseEvent,
    on: { noteId?: string; nodeRef?: string; sectionId?: string } = {},
  ) => {
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
    snapshot();
    setCanvas(linkNote(addNote(canvas, id, node.x, node.y + nodeH(node) + 16), id, ref));
    setMenu(null);
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  const addNoteHere = () => {
    if (!menu) return;
    snapshot();
    setCanvas(addNote(canvas, crypto.randomUUID(), menu.x, menu.y));
    setMenu(null);
  };

  const addSectionHere = () => {
    if (!menu) return;
    snapshot();
    setCanvas(addSection(canvas, crypto.randomUUID(), menu.x, menu.y, 900, 640, "Section"));
    setMenu(null);
  };

  const setSectionColorHere = (color: number | null) => {
    if (menu?.sectionId) {
      snapshot();
      setCanvas(setSectionColor(canvas, menu.sectionId, color));
    }
    setMenu(null);
  };

  /** Requests CanvasSectionFrame open its own inline editor — see `renameTarget`/
   *  `renameNonce` above for why this is a request rather than the edit state itself. */
  const renameSectionHere = () => {
    if (menu?.sectionId) {
      setRenameTarget(menu.sectionId);
      setRenameNonce((n) => n + 1);
    }
    setMenu(null);
  };

  const deleteSectionHere = () => {
    // Removes the container only — see removeSection's own doc comment. What was inside
    // stays on the board, exactly like "Remove from board" does for a single card.
    if (menu?.sectionId) {
      snapshot();
      setCanvas(removeSection(canvas, menu.sectionId));
    }
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
      className={`canvas-underlay ${drag?.ref === null ? "panning" : ""} ${
        dropActive ? "drop-active" : ""
      }`}
      onPointerDown={(e) => {
        if (
          !(e.target === e.currentTarget || (e.target as Element).classList.contains("canvas-plane"))
        )
          return;
        // Middle-drag and space-drag pan; plain left-drag on empty plane marquees instead
        // (below) — see the brief's rationale for moving pan off plain-drag.
        if (e.button === 1 || (e.button === 0 && spaceHeldRef.current)) {
          onPointerDown(e, null, "pan");
          return;
        }
        if (e.button !== 0) return;
        const el = viewportRef.current;
        if (!el) return;
        e.preventDefault();
        // Every other gesture in this file captures the pointer at its start — the marquee
        // is Pointer Events too and needs the same guarantee: without it, a release outside
        // the window never reaches the capture-phase pointerup listener below, `marquee` is
        // never cleared, and the rectangle stays painted until another marquee starts.
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        const rect = el.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        setMarquee({ x0: x, y0: y, x1: x, y1: y, additive: e.shiftKey });
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={cancelDrag}
      onContextMenu={(e) => openMenu(e)}
      // Session-drop handling (dragover/dragleave/drop) is bound imperatively to the
      // common ancestor in an effect below — see that effect's comment for why a JSX
      // prop here would miss every drag over an already-placed card. Only the
      // drop-active class (above) stays driven from here.
    >
      <div
        className="canvas-plane"
        style={{ transform: `translate(${canvas.pan.x}px, ${canvas.pan.y}px) scale(${canvas.zoom})` }}
      >
        {/* Sections FIRST, so document order alone puts them behind everything else — no
            z-index, no stored z. sectionsByZ orders by descending area so a nested section
            paints over its parent; see that function's comment for why the order is
            derived rather than stored. */}
        {sectionsByZ(canvas).map((section) => (
          <CanvasSectionFrame
            key={section.id}
            section={section}
            selected={isSelected("section", section.id)}
            editRequest={renameTarget === section.id ? renameNonce : undefined}
            onMovePointerDown={(e) => {
              e.stopPropagation();
              onPointerDown(e, section.id, "move", "section");
            }}
            onResizePointerDown={(e) => {
              e.stopPropagation();
              onPointerDown(e, section.id, "resize", "section");
            }}
            onContextMenu={(e) => openMenu(e, { sectionId: section.id })}
            onRename={(title) => {
              snapshot();
              setCanvas(setSectionTitle(canvas, section.id, title));
            }}
          />
        ))}

        {/* Tethers, drawn under notes and cards (sections are further back still). Each
            runs centre to centre and is then clipped for free by the boxes painting over
            it, so what remains is exactly the gap between a note and the session it is
            about. */}
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
            className={`canvas-note ${isSelected("note", note.id) ? "selected" : ""}`}
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
              className={`canvas-card status-${status} ${showTerminals ? "live" : "compact"} ${
                isSelected("node", node.ref) ? "selected" : ""
              }`}
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

      {/* Screen-space, a sibling of `.canvas-plane` rather than a child of it — the plane
          carries the pan/zoom transform and the marquee must not scale or slide with it. */}
      {marquee && (
        <div
          className="canvas-marquee"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}

      {canvas.nodes.length === 0 && notesOf(canvas).length === 0 && sectionsOf(canvas).length === 0 && (
        <div className="canvas-empty">
          <div>Empty canvas — drag a session in from the sidebar, or right-click to add a section.</div>
          <div>Drag to select · Space-drag or middle-drag to pan</div>
        </div>
      )}

      {menu && (
        <CanvasMenu
          menu={menu}
          // Link targets for a note: sessions already ON the board, not every session in
          // every project. A link draws a tether to a NODE's position, and a session with
          // no node has no endpoint — offering it here would let a note point at a session
          // pruneCanvas would treat as dangling the moment anything re-pruned it (the same
          // state stripLink exists to clean up after the fact). Narrowing the picker makes
          // the invalid choice unofferable up front instead of merely unrepresentable later.
          sessions={canvas.nodes
            .map((n) => byId.get(n.ref))
            .filter((s): s is Session => s !== undefined)
            .map((s) => ({ id: s.id, name: s.name }))}
          linkedRef={
            menu.noteId ? notesOf(canvas).find((n) => n.id === menu.noteId)?.linkedRef : undefined
          }
          sectionColor={
            menu.sectionId
              ? (sectionsOf(canvas).find((s) => s.id === menu.sectionId)?.color ?? null)
              : null
          }
          canAddSession={selectedProjectId !== null}
          onClose={closeMenu}
          onAddSession={addSessionHere}
          onAddNote={addNoteHere}
          onAddSectionHere={addSectionHere}
          onSetSectionColor={setSectionColorHere}
          onRenameSection={renameSectionHere}
          onDeleteSection={deleteSectionHere}
          onLinkNote={(ref) => {
            if (menu.noteId) {
              snapshot();
              setCanvas(linkNote(canvas, menu.noteId, ref));
            }
            setMenu(null);
          }}
          onDeleteNote={() => {
            if (menu.noteId) {
              snapshot();
              setCanvas(removeNote(canvas, menu.noteId));
            }
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
          onRemoveFromBoard={() => {
            const ref = menu.nodeRef;
            setMenu(null);
            // Off the board only — the session itself is untouched and keeps running. See
            // removeNode's own doc comment; the destructive path below is the other thing.
            if (ref) {
              snapshot();
              setCanvas(removeNode(canvas, ref));
            }
          }}
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
  sectionColor,
  canAddSession,
  onClose,
  onAddSession,
  onAddNote,
  onAddSectionHere,
  onSetSectionColor,
  onRenameSection,
  onDeleteSection,
  onLinkNote,
  onDeleteNote,
  onOpenSession,
  onNoteAbout,
  onRemoveFromBoard,
  onDeleteSession,
}: {
  menu: { screenX: number; screenY: number; noteId?: string; nodeRef?: string; sectionId?: string };
  /** Link targets, when the menu is a note's. */
  sessions: Array<{ id: string; name: string }>;
  /** The note's current link, so the list can mark it. */
  linkedRef?: string;
  /** The section's current colour index, when the menu is a section's — null for neutral,
   *  so the swatch row can mark which one is active. */
  sectionColor: number | null;
  /** Whether a project is selected for "New session here" to create into. False disables
   *  the item instead of hiding it, so it stays a discoverable action. */
  canAddSession: boolean;
  onClose: () => void;
  onAddSession: () => void;
  onAddNote: () => void;
  onAddSectionHere: () => void;
  onSetSectionColor: (color: number | null) => void;
  onRenameSection: () => void;
  /** Removes the container only — everything inside stays on the board. */
  onDeleteSection: () => void;
  onLinkNote: (ref: string | null) => void;
  onDeleteNote: () => void;
  onOpenSession: () => void;
  onNoteAbout: () => void;
  /** Off the board only — the session keeps running. Distinct from onDeleteSession, which
   *  ends it; both live in this same menu, so the wording has to carry the difference. */
  onRemoveFromBoard: () => void;
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
            {/* Two ways off this card, and they must not be confusable: this one only
                takes the card off the board, the danger item below ends the session. */}
            <button
              onClick={onRemoveFromBoard}
              title="Takes the card off the board. The session keeps running."
            >
              Remove from board
            </button>
            <button
              className="danger"
              onClick={onDeleteSession}
              title="Ends the session behind a confirmation. The card and the sidebar entry are both gone."
            >
              Delete session…
            </button>
          </>
        ) : menu.sectionId ? (
          <>
            <div className="context-menu-label">Colour</div>
            {/* A row, not PROJECT_PALETTE's hover-and-wait flyout: a section's palette is
                six colours plus neutral, small enough to show at once. */}
            <div className="canvas-menu-swatches">
              <button
                className={`canvas-swatch neutral ${sectionColor === null ? "sel" : ""}`}
                title="Neutral"
                onClick={() => onSetSectionColor(null)}
              />
              {SECTION_PALETTE.map((c, i) => (
                <button
                  key={c}
                  className={`canvas-swatch ${sectionColor === i ? "sel" : ""}`}
                  style={{ background: c }}
                  title={`Colour ${i + 1}`}
                  onClick={() => onSetSectionColor(i)}
                />
              ))}
            </div>
            <div className="context-menu-sep" />
            <button onClick={onRenameSection}>Rename</button>
            <div className="context-menu-sep" />
            <button
              className="danger"
              onClick={onDeleteSection}
              title="Removes the container. Everything inside stays on the board."
            >
              Delete section
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
            <button onClick={onAddSectionHere}>New section here</button>
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
  // The visible way out is the header's Canvas toggle, which flips to "Hide canvas" while
  // the canvas is open. This is only the keyboard route to the same action.
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
