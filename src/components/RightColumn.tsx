import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  useStore,
  liveState,
  findSession,
  workingDirOf,
  activeSessionIdOf,
  activeGroup,
  type Project,
  type TodoStatus,
} from "../store";
import { GitGraph, type GraphCommit } from "./GitGraph";
import { FileTree } from "./FileTree";
import { TerminalView } from "./Terminal";
import {
  RefreshIcon,
  CircleIcon,
  CircleDashedIcon,
  CircleFilledIcon,
} from "./Icons";

interface Change {
  status: string;
  path: string;
  added: number;
  removed: number;
}

// How often to re-read git state so the panel reflects branch switches / commits
// made in the terminal. Fast local reads (rev-parse/status/log); the terminal and
// this panel are visible together, so we can't lean on window focus to refresh.
const GIT_POLL_MS = 2500;

export function RightColumn({
  projects,
  projectId,
}: {
  projects: Project[];
  projectId: string | null;
}) {
  const topTab = useStore((s) => s.topTab);
  const setTopTab = useStore((s) => s.setTopTab);
  const bottomTab = useStore((s) => s.bottomTab);
  const setBottomTab = useStore((s) => s.setBottomTab);

  const layout = useStore((s) => (projectId ? s.layouts[projectId] : undefined));
  const project = projectId ? projects.find((p) => p.id === projectId) ?? null : null;

  // The right column follows the active group's session *context*. If the active
  // tab is a file (or the group holds only files), fall back to the group's session,
  // then the project's first session — so Files/Git stay visible while viewing a file.
  const ag = activeGroup(layout);
  let activeSessionId = activeSessionIdOf(layout);
  if (!activeSessionId && ag) {
    activeSessionId = ag.tabs.find((t) => t.kind === "session")?.ref ?? null;
  }
  if (!activeSessionId && project) {
    activeSessionId = project.sessions[0]?.id ?? null;
  }
  const selected = activeSessionId ? findSession(projects, activeSessionId) : null;
  const workingDirectory = selected
    ? workingDirOf(selected.project, selected.session)
    : project?.path ?? "";

  const [changes, setChanges] = useState<Change[]>([]);
  const [graph, setGraph] = useState<GraphCommit[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Last branch we observed, so a checkout made in the terminal can be detected
  // and the file tree reloaded once — without remounting it on every poll tick.
  const lastBranch = useRef<string | null | undefined>(undefined);

  // Re-read git state (branch, changes, graph) WITHOUT remounting the file tree.
  // Safe to call on a timer — unlike `refresh`, it never bumps `refreshKey`, so
  // expanded folders survive. The file tree is reloaded only when the branch
  // actually changes (see below), since that's when the file set can differ.
  const refreshGit = useCallback(() => {
    if (!workingDirectory) {
      setChanges([]);
      setGraph([]);
      setBranch(null);
      lastBranch.current = undefined;
      return;
    }
    void invoke<Change[]>("git_changes", { dir: workingDirectory })
      .then(setChanges)
      .catch(() => setChanges([]));
    void invoke<GraphCommit[]>("git_graph", { dir: workingDirectory })
      .then(setGraph)
      .catch(() => setGraph([]));
    void invoke<string | null>("git_branch", { dir: workingDirectory })
      .then((b) => {
        // Branch changed underfoot (e.g. `git checkout` in the terminal): reload
        // the tree once so it reflects the new branch. Skip the first read
        // (undefined sentinel) and dir switches — those remount the tree anyway.
        if (lastBranch.current !== undefined && lastBranch.current !== b) {
          setRefreshKey((k) => k + 1);
        }
        lastBranch.current = b;
        setBranch(b);
      })
      .catch(() => setBranch(null));
  }, [workingDirectory]);

  // Manual refresh button: full reload, including a file-tree remount.
  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    refreshGit();
  }, [refreshGit]);

  // Keep git state in sync with branch switches / commits made in the terminal.
  // The terminal and this panel are on screen at once, so focus-based refresh
  // never fires — we poll while the window is visible (mirrors useClaudeAmbient).
  useEffect(() => {
    lastBranch.current = undefined; // new working dir: don't treat first read as a switch
    refreshGit();
    if (!workingDirectory) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer == null) timer = setInterval(refreshGit, GIT_POLL_MS);
    };
    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        refreshGit();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [refreshGit, workingDirectory]);

  // vertical split (top panel height), persisted
  const [topH, setTopH] = useState<number>(() => {
    const saved = Number(localStorage.getItem("conduit.topH"));
    return saved >= 120 ? saved : 340;
  });
  const hRef = useRef(topH);
  const topRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const startVResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const top = topRef.current?.getBoundingClientRect().top ?? 0;
    setDragging(true);
    const onMove = (ev: MouseEvent) => {
      const h = Math.max(120, Math.min(window.innerHeight - 180, ev.clientY - top));
      hRef.current = h;
      setTopH(h);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false);
      localStorage.setItem("conduit.topH", String(hRef.current));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  const branchLabel = selected?.session.worktreePath
    ? `worktree · ${selected.session.branch ?? "session"}`
    : branch ?? "no branch";

  // All sessions' plain shells stay mounted (keep-alive).
  const allSessions = projects.flatMap((p) =>
    p.sessions.map((s) => ({ session: s, project: p })),
  );

  return (
    <div className="right-col">
      {/* TOP PANEL */}
      <div className="panel top-panel" ref={topRef} style={{ height: topH }}>
        <div className="panel-tabs">
          <PanelTab label="Files" active={topTab === "files"} onClick={() => setTopTab("files")} />
          <PanelTab
            label={`Changes${changes.length ? ` ${changes.length}` : ""}`}
            active={topTab === "changes"}
            onClick={() => setTopTab("changes")}
          />
          <PanelTab label="To-dos" active={topTab === "todos"} onClick={() => setTopTab("todos")} />
          <div className="tab-strip-fill" data-tauri-drag-region />
          <button className="panel-action" title="Refresh" onClick={refresh}>
            <RefreshIcon size={12} />
          </button>
        </div>
        <div className="panel-content">
          {!projectId ? (
            <p className="placeholder">No project selected.</p>
          ) : topTab === "files" ? (
            <>
              <div className="branch-bar">⎇ {branchLabel}</div>
              <FileTree
                key={`${workingDirectory}:${refreshKey}`}
                projectId={projectId}
                rootDir={workingDirectory}
              />
            </>
          ) : topTab === "changes" ? (
            <ChangesView changes={changes} />
          ) : activeSessionId ? (
            <TodosView sessionId={activeSessionId} />
          ) : (
            <p className="placeholder">No session in this group.</p>
          )}
        </div>
      </div>

      <div
        className={`v-resizer ${dragging ? "dragging" : ""}`}
        onMouseDown={startVResize}
      />

      {/* BOTTOM PANEL */}
      <div className="panel bottom-panel">
        <div className="panel-tabs">
          <PanelTab label="Terminal" active={bottomTab === "terminal"} onClick={() => setBottomTab("terminal")} />
          <PanelTab label="Git" active={bottomTab === "git"} onClick={() => setBottomTab("git")} />
        </div>
        <div className="panel-content bottom-content">
          {allSessions.map(({ session, project }) => (
            <TerminalView
              key={`${session.id}::term`}
              sessionId={`${session.id}::term`}
              workingDirectory={workingDirOf(project, session)}
              visible={activeSessionId === session.id && bottomTab === "terminal"}
              shellOnly
            />
          ))}
          {bottomTab === "git" && (
            <div className="git-host">
              <GitGraph commits={graph} />
            </div>
          )}
          {bottomTab === "terminal" && !selected && (
            <p className="placeholder" style={{ padding: 12 }}>
              No session selected.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function PanelTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`panel-tab ${active ? "active" : ""}`} onClick={onClick}>
      {label}
    </button>
  );
}

function ChangesView({ changes }: { changes: Change[] }) {
  if (changes.length === 0)
    return <p className="placeholder">No changes against HEAD.</p>;
  return (
    <div className="panel-scroll">
      {changes.map((c, i) => (
        <div className="mono-row" key={i}>
          <span className="st">{c.status}</span>
          <span className="path">{c.path}</span>
          <span className="spacer" />
          {c.added > 0 && <span className="add">+{c.added}</span>}
          {c.removed > 0 && <span className="rem">-{c.removed}</span>}
        </div>
      ))}
    </div>
  );
}

function TodosView({ sessionId }: { sessionId: string }) {
  const todos = useStore((s) => liveState(s.live, sessionId).todos);
  if (todos.length === 0)
    return (
      <p className="placeholder">No to-dos yet. They appear as claude plans its work.</p>
    );
  return (
    <div className="panel-scroll">
      {todos.map((t, i) => (
        <div className={`todo ${t.status}`} key={i}>
          <TodoIcon status={t.status} />
          <span className={`content ${t.status}`}>
            {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
          </span>
        </div>
      ))}
      <div className="live-note">
        <span className="dot" />
        <span>live · via TodoWrite hook</span>
      </div>
    </div>
  );
}

function TodoIcon({ status }: { status: TodoStatus }) {
  if (status === "completed")
    return <CircleFilledIcon size={13} className="ic completed" />;
  if (status === "in_progress")
    return <CircleDashedIcon size={13} className="ic in_progress" />;
  return <CircleIcon size={13} className="ic pending" />;
}
