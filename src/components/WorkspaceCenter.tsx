import { useRef, useState } from "react";
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
import { FileViewer } from "./FileViewer";
import { TerminalIcon, FileIcon, CodeIcon, CloseIcon, SplitIcon } from "./Icons";

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
  const moveTabToGroup = useStore((s) => s.moveTabToGroup);
  const openToSide = useStore((s) => s.openToSide);
  const wsRef = useRef<HTMLDivElement>(null);

  // drag-to-split / move-between-groups
  const dragData = useRef<{ fromGroupId: string; tab: WsTab } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  const [dropSplit, setDropSplit] = useState(false);

  const onTabDragStart = (fromGroupId: string, tab: WsTab) => {
    dragData.current = { fromGroupId, tab };
    setDragging(true);
  };
  const onTabDragEnd = () => {
    dragData.current = null;
    setDragging(false);
    setDropGroupId(null);
    setDropSplit(false);
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

  // File tabs of the active project, with group placement.
  const activeFiles: { ref: string; gi: number; visible: boolean }[] = [];
  if (layout) {
    layout.groups.forEach((g, gi) => {
      g.tabs.forEach((t) => {
        if (t.kind === "file") {
          activeFiles.push({ ref: t.ref, gi, visible: g.activeRef === t.ref });
        }
      });
    });
  }

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
                className={`group-chrome ${dropGroupId === g.id ? "drop-target" : ""}`}
                key={g.id}
                style={{ left: `${geom[i].left}%`, width: `${geom[i].width}%` }}
                onDragOver={(e) => {
                  if (dragData.current) {
                    e.preventDefault();
                    setDropGroupId(g.id);
                  }
                }}
                onDragLeave={() => setDropGroupId((cur) => (cur === g.id ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault();
                  const d = dragData.current;
                  if (d && d.fromGroupId !== g.id) {
                    moveTabToGroup(projectId!, d.fromGroupId, d.tab.ref, g.id);
                  }
                  onTabDragEnd();
                }}
              >
                <GroupTabStrip
                  projectId={projectId!}
                  project={activeProject}
                  group={g}
                  home={home}
                  isActiveGroup={ag?.id === g.id}
                  soloGroup={soloGroup}
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
                visible={pl.visible}
                style={pl.style}
              />
            );
          })}
          {activeFiles.map((f) => (
            <FileViewer
              key={projectId + "::" + f.ref}
              path={f.ref}
              visible={f.visible}
              style={{ left: `${geom[f.gi].left}%`, width: `${geom[f.gi].width}%` }}
            />
          ))}
        </div>

        {/* Right-edge drop zone: drag a tab here to split it into a new group. */}
        {dragging && (
          <div
            className={`split-dropzone ${dropSplit ? "active" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDropSplit(true);
            }}
            onDragLeave={() => setDropSplit(false)}
            onDrop={(e) => {
              e.preventDefault();
              const d = dragData.current;
              if (d && projectId) openToSide(projectId, d.tab);
              onTabDragEnd();
            }}
          >
            <span>Split</span>
          </div>
        )}

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
  onTabDragStart,
  onTabDragEnd,
}: {
  projectId: string;
  project: Project;
  group: EditorGroup;
  home: string | null;
  isActiveGroup: boolean;
  soloGroup: boolean;
  onTabDragStart: (fromGroupId: string, tab: WsTab) => void;
  onTabDragEnd: () => void;
}) {
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActiveGroup = useStore((s) => s.setActiveGroup);
  const closeTab = useStore((s) => s.closeTab);
  const openToSide = useStore((s) => s.openToSide);

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
    >
      {group.tabs.map((t) => (
        <div
          key={t.ref}
          className={`tab ${group.activeRef === t.ref ? "active" : ""}`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", t.ref);
            onTabDragStart(group.id, t);
          }}
          onDragEnd={onTabDragEnd}
          onClick={() => setActiveTab(projectId, group.id, t.ref)}
        >
          {t.kind === "session" ? (
            <TerminalIcon size={11} />
          ) : (
            <FileIcon size={11} />
          )}
          <span className="tab-label">{label(t)}</span>
          <button
            className="tab-split"
            title="Open to the side"
            onClick={(e) => {
              e.stopPropagation();
              openToSide(projectId, t);
            }}
          >
            <SplitIcon size={10} />
          </button>
          <button
            className="tab-close"
            title="Close tab"
            onClick={(e) => {
              e.stopPropagation();
              closeTab(projectId, group.id, t.ref);
            }}
          >
            <CloseIcon size={10} />
          </button>
        </div>
      ))}
      <div className="tab-strip-fill" data-tauri-drag-region />
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
