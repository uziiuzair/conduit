import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  useStore,
  activeGroup,
  workingDirOf,
  effectiveDirOf,
  prettyPath,
  openInVscode,
  baseName,
  type Project,
  type EditorGroup,
  type WsTab,
} from "../store";
import { TerminalView } from "./Terminal";
import { CodeEditorPane } from "./CodeEditorPane";
import { BoardView } from "./BoardView";
import { CanvasControls, CanvasUnderlay } from "./CanvasView";
import { FOOTER_H, HEADER_H, LIVE_ZOOM_MIN, nodeH, nodeW } from "../canvas";
import { useProjectCanvas } from "../hooks/useProjectCanvas";
import { TerminalIcon, FileIcon, CodeIcon, CloseIcon } from "./Icons";

/** Payload carried by a native tab drag (shared between WorkspaceCenter and GroupTabStrip). */
type TabDrag = { fromGroupId: string; tab: WsTab };
type PaneZone = "left" | "center" | "right";

const MIN_WEIGHT = 0.14;

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
  const canvasMode = centerMode === "canvas";
  // Read unconditionally (hooks cannot be conditional); it is inert outside canvas mode.
  const { canvas } = useProjectCanvas(projectId ?? null);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const setGroupWeights = useStore((s) => s.setGroupWeights);
  const moveTab = useStore((s) => s.moveTab);
  const splitTab = useStore((s) => s.splitTab);
  const wsRef = useRef<HTMLDivElement>(null);

  // drag-to-split / move-between-groups
  const dragData = useRef<TabDrag | null>(null);
  const [dragging, setDragging] = useState(false);
  // directional pane overlay: which group + region the cursor is currently over
  const [dropZone, setDropZone] = useState<{ groupId: string; zone: PaneZone } | null>(null);

  const onTabDragStart = (fromGroupId: string, tab: WsTab) => {
    dragData.current = { fromGroupId, tab };
    setDragging(true);
  };
  const onTabDragEnd = () => {
    dragData.current = null;
    setDragging(false);
    setDropZone(null);
  };

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

  // Placement for a session terminal of any project. Terminals are a permanent flat
  // stack (keep-alive); only CSS position/visibility changes. display:none when its
  // project isn't active or the session isn't open as a tab.
  const placeSession = (ownerProjectId: string, sessionId: string) => {
    if (ownerProjectId !== projectId || !layout) {
      return { visible: false, inActiveGroup: false, style: { display: "none" } as React.CSSProperties };
    }
    // Canvas mode positions the SAME mounted terminals by absolute canvas coordinates
    // instead of group percentages. This is the whole trick behind live terminals in
    // canvas nodes: one mounted set, two CSS expressions of it. The pan/zoom transform
    // is applied to .term-stack as a whole, so these coordinates stay in canvas units.
    //
    // `right`/`bottom` are cleared explicitly because .term-host is `inset: 0`, and
    // leaving them at 0 would fight the width/height set here.
    if (canvasMode) {
      const node = canvas.nodes.find((n) => n.ref === sessionId);
      if (!node) {
        return { visible: false, inActiveGroup: false, style: { display: "none" } as React.CSSProperties };
      }
      return {
        // Hidden below the legibility threshold — the card renders a summary instead.
        // Hidden is CSS-only, so the PTY and the xterm are untouched either way.
        visible: canvas.zoom >= LIVE_ZOOM_MIN,
        inActiveGroup: false, // never steal the keyboard just because a node scrolled by
        style: {
          left: node.x,
          top: node.y + HEADER_H,
          width: nodeW(node),
          // Stops above the footer strip so the resize grip stays reachable — the
          // terminal paints above the card frame and would otherwise cover it.
          height: nodeH(node) - HEADER_H - FOOTER_H,
          right: "auto",
          bottom: "auto",
          padding: "6px 8px",
        } as React.CSSProperties,
      };
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
      <div className="workspace" ref={wsRef}>
        {layout && activeProject && canvasMode && (
          <div className="group-chrome" style={{ left: 0, width: "100%" }}>
            <GroupTabStrip
              projectId={projectId!}
              project={activeProject}
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
                  project={activeProject}
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
            chrome around live terminals, not a replacement for them. */}
        {projectId && canvasMode && (
          <CanvasUnderlay projectId={projectId} viewportRef={canvasViewportRef} />
        )}

        <div
          className={`term-stack ${canvasMode ? "canvas-mode" : ""}`}
          style={
            canvasMode
              ? {
                  transform: `translate(${canvas.pan.x}px, ${canvas.pan.y}px) scale(${canvas.zoom})`,
                  transformOrigin: "0 0",
                }
              : undefined
          }
        >
          {allSessions.map(({ project, session }) => {
            const pl = placeSession(project.id, session.id);
            const gi = project.id === projectId ? groupIndexOfRef(session.id) : -1;
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
          {dragging &&
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
                      if (!dragData.current) return;
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
                      const d = dragData.current;
                      if (d) {
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
  project,
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
  project: Project;
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
  const requestCloseTab = useStore((s) => s.requestCloseTab);
  const pinTab = useStore((s) => s.pinTab);
  const dirty = useStore((s) => s.dirty);
  const moveTab = useStore((s) => s.moveTab);
  const sessionDirs = useStore((s) => s.sessionDirs);

  // Insertion caret for tab reorder / move-into-strip: index in [0, tabs.length].
  const [caretIndex, setCaretIndex] = useState<number | null>(null);
  // Drop of the dragged tab into THIS strip at the caret position.
  const commitDrop = () => {
    const d = dragRef.current;
    if (d) moveTab(projectId, d.fromGroupId, d.tab.ref, group.id, caretIndex ?? group.tabs.length);
    setCaretIndex(null);
    onTabDragEnd();
  };
  // Clear a stale caret once the drag ends anywhere.
  useEffect(() => {
    if (!dragging) setCaretIndex(null);
  }, [dragging]);

  const activeTab = group.tabs.find((t) => t.ref === group.activeRef) ?? null;
  const activeSession =
    activeTab?.kind === "session"
      ? project.sessions.find((s) => s.id === activeTab.ref) ?? null
      : null;
  const wd = activeSession ? effectiveDirOf(project, activeSession, sessionDirs) : null;

  const label = (t: WsTab): string =>
    t.kind === "session"
      ? project.sessions.find((s) => s.id === t.ref)?.name ?? "Session"
      : baseName(t.ref);

  return (
    <div
      className={`tab-strip ${isActiveGroup ? "active-group" : ""}`}
      onMouseDown={() => setActiveGroup(projectId, group.id)}
      onDragOver={(e) => {
        // Allow drops anywhere on the strip (incl. padding); tabs/fill set the caret index.
        if (dragRef.current) e.preventDefault();
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer truly leaves the strip (not on child→child moves).
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setCaretIndex(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        commitDrop();
      }}
    >
      {group.tabs.map((t, i) => (
        <Fragment key={t.ref}>
          {caretIndex === i && <span className="tab-caret" />}
          <div
            className={`tab ${group.activeRef === t.ref ? "active" : ""} ${
              t.preview ? "preview" : ""
            }`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", t.ref);
              onTabDragStart(group.id, t);
            }}
            onDragEnd={onTabDragEnd}
            onDragOver={(e) => {
              if (!dragRef.current) return;
              e.preventDefault();
              // Insert before this tab if the cursor is left of its horizontal midpoint.
              const rect = e.currentTarget.getBoundingClientRect();
              setCaretIndex(e.clientX < rect.left + rect.width / 2 ? i : i + 1);
            }}
            onClick={() => {
              setActiveTab(projectId, group.id, t.ref);
              setCenterMode(projectId, "terminals");
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
          </div>
        </Fragment>
      ))}
      {caretIndex === group.tabs.length && <span className="tab-caret" />}
      <div
        className="tab-strip-fill"
        data-tauri-drag-region
        onDragOver={(e) => {
          if (!dragRef.current) return;
          e.preventDefault();
          setCaretIndex(group.tabs.length);
        }}
      />
      {wd && soloGroup && <span className="cwd">{prettyPath(wd, home)}</span>}
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
      {isActiveGroup && (
        <button
          type="button"
          className={`header-btn board-tab ${centerMode === "canvas" ? "active" : ""}`}
          title="Canvas — every session as a card on a pan/zoom plane"
          onClick={() =>
            setCenterMode(projectId, centerMode === "canvas" ? "terminals" : "canvas")
          }
        >
          <span className="board-tab-dot" />
          <span>Canvas</span>
        </button>
      )}
      {/* Canvas controls live in the persistent header rather than a floating bar of
          their own: one header, and nothing overlapping the top row of nodes. */}
      {centerMode === "canvas" && canvasViewportRef && (
        <CanvasControls projectId={projectId} viewportRef={canvasViewportRef} />
      )}
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
