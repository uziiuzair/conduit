import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  useStore,
  activeGroup,
  findSession,
  workingDirOf,
  effectiveDirOf,
  prettyPath,
  openInVscode,
  baseName,
  type Project,
  type EditorGroup,
  type WsTab,
} from "../store";
import {
  hasSessionDrag,
  isMixedLayout,
  resolveProjectColor,
  readSessionDrag,
  tabProjectId,
} from "../layout";
import { TerminalView } from "./Terminal";
import { CodeEditorPane } from "./CodeEditorPane";
import { BoardView } from "./BoardView";
import { CanvasControls, CanvasUnderlay } from "./CanvasView";
import { CanvasRail } from "./CanvasRail";
import { ContextMeter } from "./ContextMeter";
import { FOOTER_H, HEADER_H, LIVE_ZOOM_MIN, nodeH, nodeW } from "../canvas";
import { useCanvas } from "../hooks/useCanvas";
import { TerminalIcon, FileIcon, CodeIcon, CloseIcon } from "./Icons";

/** Payload carried by a native tab drag (shared between WorkspaceCenter and GroupTabStrip). */
type TabDrag = { fromGroupId: string; tab: WsTab };
type PaneZone = "left" | "center" | "right";

const MIN_WEIGHT = 0.14;

/** How far outside the viewport a node still counts as live, in screen pixels. Generous, so
 *  scrolling a node into frame does not flash a card first. */
const CULL_MARGIN = 400;

/** Left/width percentages per group, derived from weights — no DOM measurement. */
function geometry(weights: number[]): { left: number; width: number }[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return weights.map((w) => {
    const width = (w / sum) * 100;
    const left = acc;
    acc += width;
    return { left, width };
  });
}

/** Path relative to the project root (or the longest-matching session worktree root);
 *  the absolute path when no root matches. */
function relativePathOf(project: Project, path: string): string {
  const roots = [project.path, ...project.sessions.map((s) => s.worktreePath ?? "")].filter(
    Boolean,
  );
  let best = "";
  for (const r of roots) {
    if (path.startsWith(r + "/") && r.length > best.length) best = r;
  }
  return best ? path.slice(best.length + 1) : path;
}

/** A right-clicked tab (menu rendered by WorkspaceCenter, fixed-position). */
type TabMenuState = { x: number; y: number; groupId: string; tab: WsTab };

export function WorkspaceCenter({
  projects,
  projectId,
  home,
}: {
  projects: Project[];
  projectId: string | null;
  home: string | null;
}) {
  const layout = useStore((s) => (projectId ? s.layouts[projectId] : undefined));
  const centerMode = useStore((s) => (projectId ? s.centerMode[projectId] ?? "terminals" : "terminals"));
  // The board is global now — not a per-project mode — so it reads its own store field
  // rather than `centerMode`, and stays open across a project switch.
  const canvasMode = useStore((s) => s.canvasOpen);
  // Read unconditionally (hooks cannot be conditional); it is inert while the board is closed.
  const { canvas } = useCanvas();
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const setGroupWeights = useStore((s) => s.setGroupWeights);
  const moveTab = useStore((s) => s.moveTab);
  const splitTab = useStore((s) => s.splitTab);
  const dropSessionIntoPane = useStore((s) => s.dropSessionIntoPane);
  const wsRef = useRef<HTMLDivElement>(null);

  // drag-to-split / move-between-groups
  const dragData = useRef<TabDrag | null>(null);
  const [dragging, setDragging] = useState(false);
  // A session dragged in from the SIDEBAR. Tracked separately from `dragging` because it
  // starts in another component tree and carries no TabDrag — without this the pane
  // overlay never appeared, so dragging a session out of the sidebar did nothing at all.
  const [sidebarDragging, setSidebarDragging] = useState(false);
  // directional pane overlay: which group + region the cursor is currently over
  const [dropZone, setDropZone] = useState<{ groupId: string; zone: PaneZone } | null>(null);

  const onTabDragStart = (fromGroupId: string, tab: WsTab) => {
    dragData.current = { fromGroupId, tab };
    setDragging(true);
  };
  const onTabDragEnd = () => {
    dragData.current = null;
    setDragging(false);
    setSidebarDragging(false);
    setDropZone(null);
  };
  // Any drop target that can take a session: a tab being rearranged, or a sidebar row
  // arriving. The overlay renders for both.
  const showDropZones = dragging || sidebarDragging;

  // A drag cancelled with Esc while still over the workspace fires no `dragleave`, and the
  // overlay sits at z-index 30 across the terminals — a stuck one would swallow every click
  // and read as a frozen app. `dragend` always fires on the source, so listen globally.
  useEffect(() => {
    if (!sidebarDragging) return;
    const clear = () => {
      setSidebarDragging(false);
      setDropZone(null);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [sidebarDragging]);

  const activeProject = projectId ? projects.find((p) => p.id === projectId) ?? null : null;
  const ag = activeGroup(layout);

  // Maximized group (⇧⌘M): ephemeral store state; a stale id (group since closed)
  // simply doesn't match and the normal geometry applies. The maximized group takes
  // the full width; the others KEEP their slots but are hidden via the same
  // visibility-only mechanism as inactive tabs — nothing unmounts or refits.
  const maxGroupId = useStore((s) => (projectId ? s.maximized[projectId] : undefined));
  const maxIdx = layout && maxGroupId ? layout.groups.findIndex((g) => g.id === maxGroupId) : -1;
  const isMax = maxIdx !== -1;
  const geomBase = layout ? geometry(layout.weights) : [];
  const geom = isMax ? geomBase.map((g, i) => (i === maxIdx ? { left: 0, width: 100 } : g)) : geomBase;

  // Right-clicked tab menu (fixed-position overlay, FileTree dismissal pattern).
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);
  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [tabMenu]);
  const onTabContext = (e: React.MouseEvent, groupId: string, tab: WsTab) => {
    e.preventDefault();
    e.stopPropagation();
    setTabMenu({ x: e.clientX, y: e.clientY, groupId, tab });
  };

  const groupIndexOfRef = (ref: string): number =>
    layout ? layout.groups.findIndex((g) => g.tabs.some((t) => t.ref === ref)) : -1;

  // True while a pinch/wheel-zoom is in flight. Terminals hide for its duration: a dozen
  // GPU-composited surfaces re-rasterizing every frame is the jank, and hiding them makes
  // the gesture a pure chrome transform. Set from CanvasUnderlay, which owns the wheel
  // listener, and cleared by it on settle.
  const [zooming, setZooming] = useState(false);

  // Placement for a session terminal of any project. Terminals are a permanent flat
  // stack (keep-alive); only CSS position/visibility changes. display:none when its
  // project isn't active or the session isn't open as a tab.
  //
  // DO NOT reorder the two branches below: canvas mode MUST be checked before the
  // pane-mode `!layout` bail, not after. The canvas is global, so it has to place a node
  // even when no project is selected at all -- and `layout` is then always undefined,
  // since it comes from the SELECTED project. Bailing on `!layout` first would hide every
  // terminal on the canvas the moment no project is selected, which defeats "global" in
  // exactly the case that proves it: a fresh install with no project chosen yet.
  const placeSession = (sessionId: string) => {
    // Pane mode deliberately does NOT check ownership: a layout may borrow another
    // project's session (WsTab.projectId), and `groupIndexOfRef` below already hides
    // anything the active layout does not hold. Canvas mode does not check either, and
    // that IS the global board: membership is the node list, which spans every project.
    //
    // Canvas mode positions the SAME mounted terminals by absolute coordinates instead of
    // group percentages. This is the whole trick behind live terminals in canvas nodes:
    // one mounted set, two CSS expressions of it.
    //
    // The coordinates are SCREEN pixels, not canvas units. The stack carries only
    // translate(pan) -- no scale() -- because scaling a terminal scales a rasterized glyph
    // atlas, which is the blur. Each host is therefore sized `logical x zoom` and its
    // glyphs are rasterized at `base x zoom` by TerminalView's canvasScale.
    //
    // `right`/`bottom` are cleared explicitly because .term-host is `inset: 0`, and
    // leaving them at 0 would fight the width/height set here.
    if (canvasMode) {
      const node = canvas.nodes.find((n) => n.ref === sessionId);
      if (!node) {
        return { visible: false, inActiveGroup: false, style: { display: "none" } as React.CSSProperties };
      }
      const z = canvas.zoom;
      // The stack carries translate(pan), so a node's screen position is its scaled
      // coordinate plus the pan. No viewport yet (first paint) counts as on-screen -- a
      // terminal that never went live would never spawn its PTY.
      const vp = canvasViewportRef.current;
      const sx = node.x * z + canvas.pan.x;
      const sy = node.y * z + canvas.pan.y;
      const onScreen =
        !vp ||
        (sx + nodeW(node) * z > -CULL_MARGIN &&
          sx < vp.clientWidth + CULL_MARGIN &&
          sy + nodeH(node) * z > -CULL_MARGIN &&
          sy < vp.clientHeight + CULL_MARGIN);
      return {
        // Hidden below the legibility threshold, during a zoom gesture, or far enough
        // off-screen to be culled -- the card renders instead in every case. Hidden is
        // CSS-only, so the PTY and the xterm are untouched.
        visible: z >= LIVE_ZOOM_MIN && !zooming && onScreen,
        inActiveGroup: false, // never steal the keyboard just because a node scrolled by
        style: {
          left: node.x * z,
          top: (node.y + HEADER_H) * z,
          width: nodeW(node) * z,
          // Stops above the footer strip so the resize grip stays reachable -- the
          // terminal paints above the card frame and would otherwise cover it.
          height: (nodeH(node) - HEADER_H - FOOTER_H) * z,
          right: "auto",
          bottom: "auto",
          padding: `${6 * z}px ${8 * z}px`,
        } as React.CSSProperties,
      };
    }
    // Pane-mode-only bail -- deliberately AFTER the canvas branch above, not before it. See
    // the comment at the top of this function.
    if (!layout) {
      return { visible: false, inActiveGroup: false, style: { display: "none" } as React.CSSProperties };
    }
    const gi = groupIndexOfRef(sessionId);
    if (gi === -1)
      return { visible: false, inActiveGroup: false, style: { display: "none" } as React.CSSProperties };
    const g = layout.groups[gi];
    // Each group always shows ITS OWN active tab — not gated on the focused group.
    // While a group is maximized, every other group's pane is hidden (kept mounted).
    const visible = g.activeRef === sessionId && (!isMax || gi === maxIdx);
    return {
      visible,
      // Only the active group's terminal may grab focus on reveal — restoring from
      // maximize reveals several panes at once and they must not steal the keyboard.
      inActiveGroup: ag?.id === g.id,
      style: { left: `${geom[gi].left}%`, width: `${geom[gi].width}%` } as React.CSSProperties,
    };
  };

  const nothingVisible =
    !canvasMode && (!layout || layout.groups.every((g) => g.tabs.length === 0));
  const soloGroup = (layout?.groups.length ?? 0) <= 1;
  // Computed for the LAYOUT, not per group: with project A in one pane and project B in
  // another, each group is internally uniform yet the panes still need telling apart.
  const mixed = !!layout && !!projectId && isMixedLayout(layout, projectId);

  const startDrag = (e: React.MouseEvent, boundary: number) => {
    if (!layout || !wsRef.current || !projectId) return;
    e.preventDefault();
    const rect = wsRef.current.getBoundingClientRect();
    const startX = e.clientX;
    const start = [...layout.weights];
    const total = start.reduce((a, b) => a + b, 0) || 1;
    const min = MIN_WEIGHT * total;
    const onMove = (ev: MouseEvent) => {
      const d = ((ev.clientX - startX) / rect.width) * total;
      let a = start[boundary] + d;
      let b = start[boundary + 1] - d;
      if (a < min) {
        b -= min - a;
        a = min;
      }
      if (b < min) {
        a -= min - b;
        b = min;
      }
      const w = [...start];
      w[boundary] = a;
      w[boundary + 1] = b;
      setGroupWeights(projectId, w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // Stable id order, deliberately decoupled from sidebar order: layout is pure CSS
  // (absolute positioning), so DOM order is visually irrelevant — but if it followed the
  // sidebar, a drag-reorder there would make React physically move every keep-alive
  // terminal node (detach + reattach), blurring the focused xterm and dropping selections.
  const allSessions = projects
    .flatMap((p) => p.sessions.map((s) => ({ project: p, session: s })))
    .sort((a, b) => a.session.id.localeCompare(b.session.id));

  return (
    <div className="center">
      <div
        className="workspace"
        ref={wsRef}
        // Watch for a sidebar session ENTERING the workspace so the pane overlay can show.
        // `dragenter` alone is not enough: it fires once, and a drag that starts over a
        // child (a tab strip) would never re-fire it — so dragover keeps the flag set.
        onDragEnter={(e) => {
          if (hasSessionDrag(e.dataTransfer)) setSidebarDragging(true);
        }}
        onDragOver={(e) => {
          if (hasSessionDrag(e.dataTransfer)) {
            e.preventDefault();
            setSidebarDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setSidebarDragging(false);
            setDropZone(null);
          }
        }}
        onDrop={() => {
          setSidebarDragging(false);
          setDropZone(null);
        }}
      >
        {/* This chrome strip hosts the canvas's own toggle + zoom/pan controls, and — only
            when a project happens to be selected — that project's active-group tabs, so a
            click can still jump into panes. Gated on `canvasMode` ALONE, matching the
            underlay below: a first-time user with no project yet still needs a way to see
            "live/overview", Fit, and the close button once the canvas is open, or the
            canvas can only ever be closed by the keyboard shortcut again. `layout` decides
            which of the two bodies to render, not whether the strip appears at all. */}
        {canvasMode && (
          <div className="group-chrome" style={{ left: 0, width: "100%" }}>
            {layout ? (
              <GroupTabStrip
                projectId={projectId!}
                projects={projects}
                mixed={mixed}
                group={activeGroup(layout) ?? layout.groups[0]}
                home={home}
                isActiveGroup
                soloGroup
                dragging={dragging}
                dragRef={dragData}
                onTabDragStart={onTabDragStart}
                onTabDragEnd={onTabDragEnd}
                onTabContext={onTabContext}
                canvasViewportRef={canvasViewportRef}
              />
            ) : (
              <div className="tab-strip">
                <div className="tab-strip-fill" data-tauri-drag-region />
                <CanvasToggleButton />
                <CanvasControls viewportRef={canvasViewportRef} />
              </div>
            )}
          </div>
        )}

        {layout &&
          activeProject &&
          !canvasMode &&
          layout.groups.map((g, i) =>
            g.tabs.length > 0 && (!isMax || i === maxIdx) ? (
              <div
                className="group-chrome"
                key={g.id}
                style={{ left: `${geom[i].left}%`, width: `${geom[i].width}%` }}
              >
                <GroupTabStrip
                  projectId={projectId!}
                  projects={projects}
                  mixed={mixed}
                  group={g}
                  home={home}
                  isActiveGroup={ag?.id === g.id}
                  soloGroup={soloGroup}
                  dragging={dragging}
                  dragRef={dragData}
                  onTabDragStart={onTabDragStart}
                  onTabDragEnd={onTabDragEnd}
                  onTabContext={onTabContext}
                />
              </div>
            ) : null,
          )}

        {layout &&
          !isMax &&
          !canvasMode &&
          layout.groups.slice(1).map((g, i) => (
            <div
              className="group-divider"
              key={"div-" + g.id}
              style={{ left: `${geom[i + 1].left}%` }}
              onMouseDown={(e) => startDrag(e, i)}
            />
          ))}

        {/* Underlay FIRST so the terminal stack paints above it — the card frames are
            chrome around live terminals, not a replacement for them. Gated on canvasMode
            ALONE — this is the actual global board, and it must render (and show every
            project's placed sessions) with no project selected at all. */}
        {canvasMode && (
          <CanvasUnderlay
            viewportRef={canvasViewportRef}
            onZoomActive={setZooming}
          />
        )}

        <div
          className={`term-stack ${canvasMode ? "canvas-mode" : ""}`}
          style={
            canvasMode
              ? {
                  // translate ONLY. The children are already sized and placed in screen
                  // pixels by placeSession; a scale() here is what resampled the glyph
                  // atlas and made zoomed text soft. The underlay keeps its scale(), being
                  // vector content that a transform renders crisply.
                  transform: `translate(${canvas.pan.x}px, ${canvas.pan.y}px)`,
                  transformOrigin: "0 0",
                }
              : undefined
          }
        >
          {allSessions.map(({ project, session }) => {
            const pl = placeSession(session.id);
            // By ref alone, not by ownership: a borrowed session sits in the active
            // layout's groups too, and clicking into its terminal must activate that group.
            const gi = groupIndexOfRef(session.id);
            const gid = gi !== -1 ? layout?.groups[gi]?.id : undefined;
            return (
              <TerminalView
                key={session.id}
                sessionId={session.id}
                projectId={project.id}
                workingDirectory={session.useWorktree ? project.path : workingDirOf(project, session)}
                // Re-extract the slug Claude was given at create time (last path segment).
                worktreeName={
                  session.useWorktree && session.worktreePath
                    ? baseName(session.worktreePath)
                    : undefined
                }
                role={session.role}
                stopped={session.stopped ?? false}
                canvasScale={canvasMode ? canvas.zoom : undefined}
                visible={pl.visible}
                focusOnReveal={pl.inActiveGroup}
                // Clicking into the terminal body activates its group, like the editor
                // — keeps ⌃Tab/⌘1-9/⇧⌘M/File▸Save targeting where the user works.
                onFocusGroup={
                  gid && projectId
                    ? () => {
                        const st = useStore.getState();
                        if (activeGroup(st.layouts[projectId])?.id !== gid) {
                          st.setActiveGroup(projectId, gid);
                        }
                      }
                    : undefined
                }
                style={pl.style}
              />
            );
          })}
          {layout &&
            projectId &&
            layout.groups.map((g, gi) => {
              const activeTab = g.tabs.find((t) => t.ref === g.activeRef);
              return (
                <CodeEditorPane
                  key={projectId + "::grp::" + g.id}
                  projectId={projectId}
                  groupId={g.id}
                  visible={
                    !!activeTab && activeTab.kind === "file" && (!isMax || gi === maxIdx)
                  }
                  style={{ left: `${geom[gi].left}%`, width: `${geom[gi].width}%` }}
                />
              );
            })}

          {/* Directional drop overlay — a separate absolutely-positioned sibling layer that
              only exists mid-drag. It NEVER wraps/reparents the panes above (keep-alive).
              left/right thirds split into a new column; the center moves into the group. */}
          {showDropZones &&
            layout &&
            projectId &&
            layout.groups.map((g, gi) =>
              isMax && gi !== maxIdx ? null : (
              <div
                className="pane-dropzones"
                key={"pdz-" + g.id}
                style={{ left: `${geom[gi].left}%`, width: `${geom[gi].width}%` }}
              >
                {(["left", "center", "right"] as PaneZone[]).map((zone) => (
                  <div
                    key={zone}
                    className={`pane-dropzone ${zone} ${
                      dropZone?.groupId === g.id && dropZone.zone === zone ? "active" : ""
                    }`}
                    onDragOver={(e) => {
                      if (!dragData.current && !hasSessionDrag(e.dataTransfer)) return;
                      e.preventDefault();
                      setDropZone({ groupId: g.id, zone });
                    }}
                    onDragLeave={() =>
                      setDropZone((cur) =>
                        cur && cur.groupId === g.id && cur.zone === zone ? null : cur,
                      )
                    }
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      // A sidebar session wins: it is the only payload that can carry a
                      // FOREIGN project, and a tab drag never sets that MIME type.
                      const ext = readSessionDrag(e.dataTransfer);
                      const d = dragData.current;
                      if (ext) {
                        dropSessionIntoPane(projectId, g.id, zone, ext.projectId, ext.sessionId);
                      } else if (d) {
                        if (zone === "center") {
                          moveTab(projectId, d.fromGroupId, d.tab.ref, g.id, g.tabs.length);
                        } else {
                          splitTab(projectId, d.tab.ref, g.id, zone);
                        }
                      }
                      onTabDragEnd();
                    }}
                  />
                ))}
              </div>
            ))}
        </div>

        {/* The rail and edge pips are siblings of .term-stack, mounted here rather than
            inside CanvasUnderlay — see CanvasRail's own doc comment for why nesting them
            in the underlay (a stacking context at z-index 1) would trap them behind every
            terminal (.term-stack.canvas-mode, z-index 2). Gated on canvasMode alone, like
            the underlay itself: the board is global, so this renders with no project
            selected too. */}
        {canvasMode && <CanvasRail viewportRef={canvasViewportRef} onZoomActive={setZooming} />}

        {nothingVisible && <EmptyState />}

        {projectId && centerMode === "board" && (
          <div className="board-overlay">
            <BoardView projectId={projectId} />
          </div>
        )}



        {tabMenu && activeProject && projectId && (
          <TabContextMenu
            projectId={projectId}
            project={activeProject}
            menu={tabMenu}
            onClose={() => setTabMenu(null)}
          />
        )}
      </div>
    </div>
  );
}

function GroupTabStrip({
  projectId,
  projects,
  mixed,
  group,
  home,
  isActiveGroup,
  soloGroup,
  dragging,
  dragRef,
  onTabDragStart,
  onTabDragEnd,
  onTabContext,
  canvasViewportRef,
}: {
  projectId: string;
  /** Every project: a session tab may belong to any of them, not just the host. */
  projects: Project[];
  /** This layout holds sessions from more than one project, so tabs carry a project badge. */
  mixed: boolean;
  group: EditorGroup;
  home: string | null;
  isActiveGroup: boolean;
  soloGroup: boolean;
  dragging: boolean;
  dragRef: React.RefObject<TabDrag | null>;
  onTabDragStart: (fromGroupId: string, tab: WsTab) => void;
  onTabDragEnd: () => void;
  onTabContext: (e: React.MouseEvent, groupId: string, tab: WsTab) => void;
  /** Present only for the canvas-mode strip, which hosts the canvas controls. */
  canvasViewportRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActiveGroup = useStore((s) => s.setActiveGroup);
  const setCenterMode = useStore((s) => s.setCenterMode);
  const centerMode = useStore((s) => s.centerMode[projectId] ?? "terminals");
  const canvasOpen = useStore((s) => s.canvasOpen);
  const setCanvasOpen = useStore((s) => s.setCanvasOpen);
  const requestCloseTab = useStore((s) => s.requestCloseTab);
  const pinTab = useStore((s) => s.pinTab);
  const dirty = useStore((s) => s.dirty);
  const moveTab = useStore((s) => s.moveTab);
  const dropSessionIntoPane = useStore((s) => s.dropSessionIntoPane);
  const sessionDirs = useStore((s) => s.sessionDirs);
  const sessionContext = useStore((s) => s.sessionContext);
  const richSessionView = useStore((s) => s.richSessionView);
  const richViewOpen = useStore((s) => s.richViewOpen);
  const toggleRichView = useStore((s) => s.toggleRichView);

  // Insertion caret for tab reorder / move-into-strip: index in [0, tabs.length].
  const [caretIndex, setCaretIndex] = useState<number | null>(null);
  // Drop into THIS strip at the caret position — an existing tab being rearranged, or a
  // session dragged in from the sidebar. The strip has to take the sidebar drop itself:
  // `.group-chrome` sits ABOVE `.term-stack`, so the pane overlay never receives a pointer
  // that is over a tab strip, and the strip is the most natural place to aim.
  const commitDrop = (dt?: DataTransfer) => {
    const ext = readSessionDrag(dt);
    const d = dragRef.current;
    if (ext) {
      dropSessionIntoPane(projectId, group.id, "center", ext.projectId, ext.sessionId);
    } else if (d) {
      moveTab(projectId, d.fromGroupId, d.tab.ref, group.id, caretIndex ?? group.tabs.length);
    }
    setCaretIndex(null);
    onTabDragEnd();
  };
  // Clear a stale caret once the drag ends anywhere.
  useEffect(() => {
    if (!dragging) setCaretIndex(null);
  }, [dragging]);

  const activeTab = group.tabs.find((t) => t.ref === group.activeRef) ?? null;
  // Resolved across ALL projects, not this one: the cwd readout and the VS Code button must
  // follow a borrowed session to ITS repo, or they would quietly point at the host project.
  const activeFound = activeTab?.kind === "session" ? findSession(projects, activeTab.ref) : null;
  const wd = activeFound
    ? effectiveDirOf(activeFound.project, activeFound.session, sessionDirs)
    : null;

  const label = (t: WsTab): string =>
    t.kind === "session"
      ? findSession(projects, t.ref)?.session.name ?? "Session"
      : baseName(t.ref);

  /** The project a tab belongs to, and its accent (chosen > derived > none — see
   *  resolveProjectColor). Files are always the host's. */
  const autoProjectColors = useStore((s) => s.autoProjectColors);
  const ownerOf = (t: WsTab): { id: string; name: string; accent: string | null } => {
    const id = t.kind === "session" ? tabProjectId(t, projectId) : projectId;
    const project = projects.find((p) => p.id === id);
    return {
      id,
      name: project?.name ?? "",
      accent: resolveProjectColor(id, project?.color, autoProjectColors),
    };
  };

  return (
    <div
      className={`tab-strip ${isActiveGroup ? "active-group" : ""}`}
      onMouseDown={() => setActiveGroup(projectId, group.id)}
      onDragOver={(e) => {
        // Allow drops anywhere on the strip (incl. padding); tabs/fill set the caret index.
        if (dragRef.current || hasSessionDrag(e.dataTransfer)) e.preventDefault();
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer truly leaves the strip (not on child→child moves).
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setCaretIndex(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        commitDrop(e.dataTransfer);
      }}
    >
      {group.tabs.map((t, i) => (
        <Fragment key={t.ref}>
          {caretIndex === i && <span className="tab-caret" />}
          <div
            className={`tab ${group.activeRef === t.ref ? "active" : ""} ${
              t.preview ? "preview" : ""
            } ${mixed ? "badged" : ""}`}
            style={
              mixed && ownerOf(t).accent
                ? ({ ["--proj-accent" as string]: ownerOf(t).accent } as React.CSSProperties)
                : undefined
            }
            title={mixed ? `${ownerOf(t).name} · ${label(t)}` : undefined}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", t.ref);
              onTabDragStart(group.id, t);
            }}
            onDragEnd={onTabDragEnd}
            onDragOver={(e) => {
              if (!dragRef.current && !hasSessionDrag(e.dataTransfer)) return;
              e.preventDefault();
              // Insert before this tab if the cursor is left of its horizontal midpoint.
              const rect = e.currentTarget.getBoundingClientRect();
              setCaretIndex(e.clientX < rect.left + rect.width / 2 ? i : i + 1);
            }}
            onClick={() => {
              setActiveTab(projectId, group.id, t.ref);
              setCenterMode(projectId, "terminals");
              // This strip also renders as the canvas's own chrome (canvasViewportRef set);
              // picking a tab there must leave the canvas, or the click has no visible
              // effect — setCenterMode alone no longer does, since the canvas is a global
              // flag independent of this project's centerMode.
              setCanvasOpen(false);
            }}
            onDoubleClick={() => {
              // Double-click pins a preview tab (VS Code semantics).
              if (t.kind === "file" && t.preview) pinTab(projectId, t.ref);
            }}
            onContextMenu={(e) => onTabContext(e, group.id, t)}
          >
            {t.kind === "session" ? (
              <TerminalIcon size={11} />
            ) : (
              <FileIcon size={11} />
            )}
            {/* Shown on EVERY tab once the layout is mixed, never on only the foreign ones:
                badging just the visitors would make a bare tab mean "the host project",
                which is knowledge the badge exists to remove. */}
            {mixed && <span className="tab-project">{ownerOf(t).name}</span>}
            <span className="tab-label">{label(t)}</span>
            {t.kind === "file" && dirty[t.ref] && (
              <span className="tab-dirty" title="Unsaved changes" />
            )}
            <button
              className="tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                void requestCloseTab(projectId, group.id, t.ref);
              }}
            >
              <CloseIcon size={10} />
            </button>
            {t.kind === "session" && <ContextMeter usage={sessionContext[t.ref]} />}
          </div>
        </Fragment>
      ))}
      {caretIndex === group.tabs.length && <span className="tab-caret" />}
      <div
        className="tab-strip-fill"
        data-tauri-drag-region
        onDragOver={(e) => {
          if (!dragRef.current && !hasSessionDrag(e.dataTransfer)) return;
          e.preventDefault();
          setCaretIndex(group.tabs.length);
        }}
      />
      {wd && soloGroup && <span className="cwd">{prettyPath(wd, home)}</span>}
      {/* Per-session view switch. Only exists when the preference is on, and only for a
          session tab -- an editor or a diff has no conversation to render. The terminal is
          never unmounted by this; the pane simply covers it (see SessionChat). */}
      {richSessionView && activeTab?.kind === "session" && (
        <button
          type="button"
          className={`header-btn board-tab ${richViewOpen[activeTab.ref] ? "active" : ""}`}
          title={
            richViewOpen[activeTab.ref]
              ? "Back to the terminal (it never stopped running)"
              : "Read this session as a conversation"
          }
          onClick={() => toggleRichView(activeTab.ref)}
        >
          <span className="board-tab-dot" />
          <span>{richViewOpen[activeTab.ref] ? "Terminal" : "Chat"}</span>
        </button>
      )}
      {isActiveGroup && (
        <button
          type="button"
          className={`header-btn board-tab ${centerMode === "board" ? "active" : ""}`}
          title="Task board (⇧⌘B)"
          onClick={() =>
            setCenterMode(projectId, centerMode === "board" ? "terminals" : "board")
          }
        >
          <span className="board-tab-dot" />
          <span>Board</span>
        </button>
      )}
      {isActiveGroup && <CanvasToggleButton />}
      {/* Canvas controls live in the persistent header rather than a floating bar of
          their own: one header, and nothing overlapping the top row of nodes. */}
      {canvasOpen && canvasViewportRef && <CanvasControls viewportRef={canvasViewportRef} />}
      {wd &&
        (soloGroup ? (
          <button className="header-btn" title="Open in VS Code" onClick={() => void openInVscode(wd)}>
            <CodeIcon size={12} />
            <span>VS Code</span>
          </button>
        ) : (
          <button
            className="icon-btn"
            title={`Open ${prettyPath(wd, home)} in VS Code`}
            onClick={() => void openInVscode(wd)}
          >
            <CodeIcon size={12} />
          </button>
        ))}
    </div>
  );
}

/**
 * The canvas's own open/close toggle, in the header. Shared between `GroupTabStrip` (used
 * both for a normal pane's header, where it is the discovery affordance, and for the
 * canvas-mode strip itself, where it is the close affordance) and the bare bar
 * `WorkspaceCenter` renders in canvas mode when no project is selected — one definition so
 * the two can never say different things or read different state.
 *
 * Named "Canvas" deliberately, not "Board": the adjacent per-project button already owns
 * that word for the task board (the Kanban backed by `.conduit/` files), a shipped feature
 * users already know by that name. This is the surface `CanvasView.tsx`/`canvas.ts` and the
 * `canvasOpen` store field are named for throughout the code.
 */
function CanvasToggleButton() {
  const canvasOpen = useStore((s) => s.canvasOpen);
  const setCanvasOpen = useStore((s) => s.setCanvasOpen);
  return (
    <button
      className={`header-btn board-tab ${canvasOpen ? "active" : ""}`}
      title={canvasOpen ? "Hide the canvas" : "Show the canvas (Cmd/Ctrl+Shift+C)"}
      onClick={() => setCanvasOpen(!canvasOpen)}
    >
      <span className="board-tab-dot" />
      <span>{canvasOpen ? "Hide canvas" : "Canvas"}</span>
    </button>
  );
}

function TabContextMenu({
  projectId,
  project,
  menu,
  onClose,
}: {
  projectId: string;
  project: Project;
  menu: TabMenuState;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const requestCloseTab = useStore((s) => s.requestCloseTab);
  const revealInTree = useStore((s) => s.revealInTree);
  const layout = useStore((s) => s.layouts[projectId]);
  const group = layout?.groups.find((g) => g.id === menu.groupId);
  const isFile = menu.tab.kind === "file";

  // Flip/clamp into the viewport before paint (FileTreeMenu pattern) — tab strips
  // can reach the right window edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    let left = menu.x;
    let top = menu.y;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, menu.x - r.width);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, menu.y - r.height);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [menu]);

  // Sequential so each tab's own dirty-confirm can appear (and abort just that tab).
  const closeMany = (refs: string[]) => {
    onClose();
    void (async () => {
      for (const r of refs) await requestCloseTab(projectId, menu.groupId, r);
    })();
  };
  const others = group ? group.tabs.filter((t) => t.ref !== menu.tab.ref).map((t) => t.ref) : [];
  const idx = group ? group.tabs.findIndex((t) => t.ref === menu.tab.ref) : -1;
  const toRight = group && idx !== -1 ? group.tabs.slice(idx + 1).map((t) => t.ref) : [];

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={() => {
          onClose();
          void requestCloseTab(projectId, menu.groupId, menu.tab.ref);
        }}
      >
        Close
      </button>
      <button disabled={others.length === 0} onClick={() => closeMany(others)}>
        Close Others
      </button>
      <button disabled={toRight.length === 0} onClick={() => closeMany(toRight)}>
        Close to the Right
      </button>
      {isFile && (
        <>
          <button
            onClick={() => {
              onClose();
              void navigator.clipboard.writeText(menu.tab.ref).catch(() => {});
            }}
          >
            Copy Path
          </button>
          <button
            onClick={() => {
              onClose();
              void navigator.clipboard
                .writeText(relativePathOf(project, menu.tab.ref))
                .catch(() => {});
            }}
          >
            Copy Relative Path
          </button>
          <button
            onClick={() => {
              onClose();
              revealInTree(menu.tab.ref);
            }}
          >
            Reveal in Tree
          </button>
          <button
            onClick={() => {
              onClose();
              void invoke("reveal_path", { path: menu.tab.ref }).catch((e) => {
                // e.g. the file was deleted on disk — surface it, don't look broken.
                void invoke("notify_user", { title: "Conduit", body: String(e) }).catch(() => {});
              });
            }}
          >
            Reveal in Finder
          </button>
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <TerminalIcon size={40} className="big-icon" />
      <div className="title">No session open</div>
      <div className="sub">
        Pick a session in the sidebar to open it here, or add a project and spin one up.
      </div>
    </div>
  );
}
