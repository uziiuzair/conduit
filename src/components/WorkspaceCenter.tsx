import { Fragment, useEffect, useRef, useState } from "react";
import {
  useStore,
  activeGroup,
  workingDirOf,
  prettyPath,
  openInVscode,
  baseName,
  type Project,
  type EditorGroup,
  type WsTab,
} from "../store";
import { TerminalView } from "./Terminal";
import { CodeEditorPane } from "./CodeEditorPane";
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
  const geom = layout ? geometry(layout.weights) : [];
  const ag = activeGroup(layout);

  const groupIndexOfRef = (ref: string): number =>
    layout ? layout.groups.findIndex((g) => g.tabs.some((t) => t.ref === ref)) : -1;

  // Placement for a session terminal of any project. Terminals are a permanent flat
  // stack (keep-alive); only CSS position/visibility changes. display:none when its
  // project isn't active or the session isn't open as a tab.
  const placeSession = (ownerProjectId: string, sessionId: string) => {
    if (ownerProjectId !== projectId || !layout) {
      return { visible: false, style: { display: "none" } as React.CSSProperties };
    }
    const gi = groupIndexOfRef(sessionId);
    if (gi === -1) return { visible: false, style: { display: "none" } as React.CSSProperties };
    const g = layout.groups[gi];
    // Each group always shows ITS OWN active tab — not gated on the focused group.
    const visible = g.activeRef === sessionId;
    return {
      visible,
      style: { left: `${geom[gi].left}%`, width: `${geom[gi].width}%` } as React.CSSProperties,
    };
  };

  const nothingVisible = !layout || layout.groups.every((g) => g.tabs.length === 0);
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

  const allSessions = projects.flatMap((p) =>
    p.sessions.map((s) => ({ project: p, session: s })),
  );

  return (
    <div className="center">
      <div className="workspace" ref={wsRef}>
        {layout &&
          activeProject &&
          layout.groups.map((g, i) =>
            g.tabs.length > 0 ? (
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
                />
              </div>
            ) : null,
          )}

        {layout &&
          layout.groups.slice(1).map((g, i) => (
            <div
              className="group-divider"
              key={"div-" + g.id}
              style={{ left: `${geom[i + 1].left}%` }}
              onMouseDown={(e) => startDrag(e, i)}
            />
          ))}

        <div className="term-stack">
          {allSessions.map(({ project, session }) => {
            const pl = placeSession(project.id, session.id);
            return (
              <TerminalView
                key={session.id}
                sessionId={session.id}
                workingDirectory={session.useWorktree ? project.path : workingDirOf(project, session)}
                // Re-extract the slug Claude was given at create time (last path segment).
                worktreeName={
                  session.useWorktree && session.worktreePath
                    ? baseName(session.worktreePath)
                    : undefined
                }
                role={session.role}
                visible={pl.visible}
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
                  visible={!!activeTab && activeTab.kind === "file"}
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
            layout.groups.map((g, gi) => (
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
}) {
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActiveGroup = useStore((s) => s.setActiveGroup);
  const requestCloseTab = useStore((s) => s.requestCloseTab);
  const dirty = useStore((s) => s.dirty);
  const moveTab = useStore((s) => s.moveTab);

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
  const wd = activeSession ? workingDirOf(project, activeSession) : null;

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
            className={`tab ${group.activeRef === t.ref ? "active" : ""}`}
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
            onClick={() => setActiveTab(projectId, group.id, t.ref)}
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
