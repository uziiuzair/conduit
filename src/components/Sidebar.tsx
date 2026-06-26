import { useEffect, useRef, useState } from "react";
import { NewSessionDialog } from "./NewSessionDialog";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  useStore,
  liveState,
  findSession,
  workingDirOf,
  openInVscode,
  worktreeIsDirty,
  worktreeRemove,
  globalSelectedSessionId,
  type Project,
  type Session,
} from "../store";
import {
  FolderIcon,
  FolderPlusIcon,
  TerminalIcon,
  PlusIcon,
  EllipsisIcon,
  CircleFilledIcon,
} from "./Icons";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { ClaudeStatusPill } from "./ClaudeStatusPill";
import { ClaudeUsagePanel } from "./ClaudeUsagePanel";

async function deleteSession(
  projects: Project[],
  projectId: string,
  sessionId: string,
  removeSession: (p: string, s: string) => Promise<void>,
) {
  // Resolve synchronously before any await: session path/branch are immutable for a
  // given id, so the projects snapshot can't go stale across the awaits below.
  const found = findSession(projects, sessionId);
  const session = found?.session;
  if (!session) return;
  if (!confirm(`Delete session "${session.name}"?`)) return;

  if (session.useWorktree && session.worktreePath) {
    const dirty = await worktreeIsDirty(session.worktreePath);
    const msg = dirty
      ? `Also remove its git worktree (${session.branch})?\n\nIt has uncommitted changes that will be permanently lost.`
      : `Also remove its git worktree (${session.branch})?\n\nThe branch is kept; only the working copy is removed.`;
    if (confirm(msg)) {
      // Kill the live process first so git can release the worktree lock.
      await invoke("pty_kill", { sessionId }).catch(() => {});
      await invoke("pty_kill", { sessionId: `${sessionId}::term` }).catch(() => {});
      try {
        await worktreeRemove(found.project.path, session.worktreePath, dirty);
      } catch (e) {
        console.error("Worktree removal failed:", e);
        void invoke("notify_user", {
          title: "Conduit",
          body: `Worktree not removed: ${e}`,
        }).catch((err) => console.error("notify_user failed:", err));
      }
    }
  }
  await removeSession(projectId, sessionId);
}

export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const addProject = useStore((s) => s.addProject);

  async function pickProject() {
    const dir = await open({
      directory: true,
      multiple: false,
      title: "Add Project",
    });
    if (typeof dir === "string") await addProject(dir);
  }

  return (
    <div className="sidebar">
      <div className="drag-region" data-tauri-drag-region />
      <div className="sidebar-scroll">
        <div className="section-label">Projects</div>
        {projects.map((p) => (
          <ProjectBlock key={p.id} project={p} />
        ))}
      </div>
      <ClaudeUsagePanel />
      <div className="add-bar">
        <button onClick={pickProject}>
          <FolderPlusIcon size={12} />
          <span>Add Project</span>
        </button>
        <ClaudeStatusPill />
        <ThemeSwitcher />
      </div>
      <SessionContextMenu />
    </div>
  );
}

function ProjectBlock({ project }: { project: Project }) {
  const addSession = useStore((s) => s.addSession);
  const openMenu = useStore((s) => s.openMenu);
  const [showNew, setShowNew] = useState(false);

  const openProjectMenu = (x: number, y: number) =>
    openMenu({ x, y, kind: "project", projectId: project.id });

  return (
    <div className="project-block">
      <div
        className="project-head"
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openProjectMenu(e.clientX, e.clientY);
        }}
      >
        <FolderIcon size={11} className="folder-icon" />
        <span className="name">{project.name}</span>
        <button
          className="menu-btn"
          title="Project actions"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            openProjectMenu(r.left, r.bottom + 2);
          }}
        >
          <EllipsisIcon size={14} />
        </button>
      </div>
      <div className="session-list">
        {project.sessions.map((s) => (
          <SessionRow key={s.id} project={project} session={s} />
        ))}
        <button
          className="new-session"
          onClick={() => setShowNew(true)}
        >
          <PlusIcon size={12} />
          <span>New session</span>
        </button>
      </div>
      {showNew && (
        <NewSessionDialog
          projectPath={project.path}
          onCancel={() => setShowNew(false)}
          onCreate={(opts) => {
            setShowNew(false);
            void addSession(project.id, opts);
          }}
        />
      )}
    </div>
  );
}

function SessionRow({
  project,
  session,
}: {
  project: Project;
  session: Session;
}) {
  const selected = useStore((s) => globalSelectedSessionId(s) === session.id);
  const status = useStore((s) => liveState(s.live, session.id).status);
  const activity = useStore((s) => liveState(s.live, session.id).activity);
  const compacting = useStore((s) => liveState(s.live, session.id).compacting);
  const editing = useStore((s) => s.editingSessionId === session.id);
  const selectSession = useStore((s) => s.selectSession);
  const openMenu = useStore((s) => s.openMenu);

  return (
    <div
      className={`session-row ${selected ? "selected" : ""}`}
      onClick={() => {
        if (!editing) selectSession(project.id, session.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu({
          x: e.clientX,
          y: e.clientY,
          kind: "session",
          projectId: project.id,
          sessionId: session.id,
        });
      }}
    >
      <TerminalIcon size={12} className="term-icon" />
      {editing ? (
        <RenameInput
          projectId={project.id}
          sessionId={session.id}
          initial={session.name}
        />
      ) : (
        <span className="name">{session.name}</span>
      )}
      {!editing && session.branch && (
        <span className="branch-chip" title={session.branch}>
          {session.branch}
        </span>
      )}
      <StatusAccessory status={status} activity={activity} compacting={compacting} />
    </div>
  );
}

function RenameInput({
  projectId,
  sessionId,
  initial,
}: {
  projectId: string;
  sessionId: string;
  initial: string;
}) {
  const renameSession = useStore((s) => s.renameSession);
  const cancelRename = useStore((s) => s.cancelRename);
  const done = useRef(false);

  const commit = (value: string) => {
    if (done.current) return;
    done.current = true;
    void renameSession(projectId, sessionId, value);
  };

  return (
    <input
      className="session-rename-input"
      defaultValue={initial}
      autoFocus
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(e.currentTarget.value);
        else if (e.key === "Escape") {
          done.current = true;
          cancelRename();
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  );
}

function StatusAccessory({
  status,
  activity,
  compacting,
}: {
  status: string;
  activity?: string;
  compacting?: boolean;
}) {
  if (status === "needsInput") return <span className="pill-needs">needs you</span>;
  if (compacting) return <span className="pill-compacting">compacting</span>;
  if (status === "running")
    return activity ? (
      <span className="pill-activity" title={activity}>
        {activity}
      </span>
    ) : (
      <span className="dot running" />
    );
  if (status === "done")
    return <CircleFilledIcon size={11} className="dot done" />;
  return null;
}

function SessionContextMenu() {
  const menu = useStore((s) => s.menu);
  const projects = useStore((s) => s.projects);
  const closeMenu = useStore((s) => s.closeMenu);
  const startRename = useStore((s) => s.startRename);
  const removeSession = useStore((s) => s.removeSession);
  const removeProject = useStore((s) => s.removeProject);
  const openToSide = useStore((s) => s.openToSide);

  useEffect(() => {
    if (!menu) return;
    const close = () => closeMenu();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, closeMenu]);

  if (!menu) return null;

  if (menu.kind === "project") {
    const project = projects.find((p) => p.id === menu.projectId);
    return (
      <div
        className="context-menu"
        style={{ left: menu.x, top: menu.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="danger"
          onClick={() => {
            if (
              project &&
              confirm(
                `Remove project "${project.name}" from Conduit?\n\nThis closes its sessions. Your files are not deleted.`,
              )
            )
              void removeProject(menu.projectId);
            closeMenu();
          }}
        >
          Remove Project
        </button>
      </div>
    );
  }

  if (!menu.sessionId) return null;
  const sid = menu.sessionId;
  return (
    <div
      className="context-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button onClick={() => startRename(sid)}>Rename</button>
      <button
        onClick={() => {
          openToSide(menu.projectId, { kind: "session", ref: sid });
          closeMenu();
        }}
      >
        Open to the Side
      </button>
      <button
        onClick={() => {
          const found = findSession(projects, sid);
          if (found) void openInVscode(workingDirOf(found.project, found.session));
          closeMenu();
        }}
      >
        Open in VS Code
      </button>
      <button
        className="danger"
        onClick={() => {
          void deleteSession(projects, menu.projectId, sid, removeSession);
          closeMenu();
        }}
      >
        Delete
      </button>
    </div>
  );
}
