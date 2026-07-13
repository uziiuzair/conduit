import { useEffect, useMemo, useRef, useState } from "react";
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
  resolvedAccountKey,
  type Project,
  type Session,
} from "../store";
import {
  FolderIcon,
  FolderPlusIcon,
  PlusIcon,
  EllipsisIcon,
  CircleFilledIcon,
  ChevronRightIcon,
} from "./Icons";
import { AgentGlyph } from "./AgentGlyph";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { ClaudeStatusPill } from "./ClaudeStatusPill";
import { UsagePanel } from "./UsagePanel";
import { ClaudeStatusWarning } from "./ClaudeStatusWarning";

// Collapsed projects persist as a list of project ids in localStorage — a pure
// sidebar UI preference, mirroring conduit.sidebarWidth / conduit.topH (no backend
// state.json schema change). Default for any project not listed is expanded.
const COLLAPSED_KEY = "conduit.collapsedProjects";

function loadCollapsed(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function persistCollapsed(projectId: string, collapsed: boolean): void {
  const ids = loadCollapsed();
  if (collapsed) ids.add(projectId);
  else ids.delete(projectId);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    /* quota — non-fatal */
  }
}

// ---- Sidebar drag-reorder ----
// The active drag payload lives here (module scope) because dataTransfer contents are
// unreadable during dragover — only on drop — and the indicator needs it on hover.
type SidebarDrag =
  | { kind: "project"; projectId: string }
  | { kind: "session"; projectId: string; sessionId: string };
let sidebarDrag: SidebarDrag | null = null;

/** Insertion index (in the post-removal list) for dropping before/after `targetIdx`. */
function dropIndex(fromIdx: number, targetIdx: number, after: boolean): number {
  const to = after ? targetIdx + 1 : targetIdx;
  return fromIdx < to ? to - 1 : to;
}

/** "before" (top half) or "after" (bottom half) from the pointer position over a row. */
function dropHalf(e: React.DragEvent<HTMLDivElement>): "before" | "after" {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? "before" : "after";
}

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
  // Warn louder when the agent is mid-task (deleting hard-kills it; history is still kept).
  const running = useStore.getState().live[sessionId]?.status === "running";
  const prompt = running
    ? `Session "${session.name}" is still working. Delete and stop it?\n\nIts conversation history is kept.`
    : `Delete session "${session.name}"?`;
  if (!confirm(prompt)) return;

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
  const setShowSettings = useStore((s) => s.setShowSettings);
  const selectedAgent = useStore((s) => {
    const id = globalSelectedSessionId(s);
    if (!id) return "claude" as const;
    return findSession(s.projects, id)?.session.agent ?? "claude";
  });
  const showClaudeAmbient = selectedAgent === "claude";

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
      {showClaudeAmbient && <ClaudeStatusWarning />}
      <div className="sidebar-scroll">
        <div className="section-label">Projects</div>
        {projects.map((p) => (
          <ProjectBlock key={p.id} project={p} />
        ))}
      </div>
      <UsagePanel />
      <div className="add-bar">
        <button onClick={pickProject}>
          <FolderPlusIcon size={12} />
          <span>Add Project</span>
        </button>
        {showClaudeAmbient && <ClaudeStatusPill />}
        <button className="settings-btn" title="Settings" onClick={() => setShowSettings(true)}>⚙</button>
        <ThemeSwitcher />
      </div>
      <SessionContextMenu />
    </div>
  );
}

function ProjectBlock({ project }: { project: Project }) {
  const addSession = useStore((s) => s.addSession);
  const openMenu = useStore((s) => s.openMenu);
  const reorderProject = useStore((s) => s.reorderProject);
  const [showNew, setShowNew] = useState(false);
  const [collapsed, setCollapsed] = useState(() => loadCollapsed().has(project.id));
  const [dragSelf, setDragSelf] = useState(false);
  const [drop, setDrop] = useState<null | "before" | "after">(null);

  const openProjectMenu = (x: number, y: number) =>
    openMenu({ x, y, kind: "project", projectId: project.id });

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      persistCollapsed(project.id, next);
      return next;
    });

  return (
    <div
      className={`project-block ${collapsed ? "collapsed" : ""} ${dragSelf ? "dragging" : ""} ${
        drop ? `drop-${drop}` : ""
      }`}
      onDragOver={(e) => {
        if (sidebarDrag?.kind !== "project" || sidebarDrag.projectId === project.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDrop(dropHalf(e));
      }}
      onDragLeave={(e) => {
        // Ignore moves into our own children — only clear when truly leaving the block.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
      }}
      onDrop={(e) => {
        const src = sidebarDrag;
        // Recompute the half from the event: on WKWebView, dragleave's relatedTarget is
        // always null (WebKit bug 66547), so the `drop` indicator state may have been
        // spuriously cleared by a child-boundary crossing right before the drop.
        const pos = dropHalf(e);
        setDrop(null);
        if (src?.kind !== "project" || src.projectId === project.id) return;
        e.preventDefault();
        sidebarDrag = null;
        const list = useStore.getState().projects;
        const fromIdx = list.findIndex((p) => p.id === src.projectId);
        const targetIdx = list.findIndex((p) => p.id === project.id);
        if (fromIdx < 0 || targetIdx < 0) return;
        void reorderProject(src.projectId, dropIndex(fromIdx, targetIdx, pos === "after"));
      }}
    >
      <div
        className="project-head"
        role="button"
        aria-expanded={!collapsed}
        title={collapsed ? "Expand project" : "Collapse project"}
        draggable
        onDragStart={(e) => {
          sidebarDrag = { kind: "project", projectId: project.id };
          // Some engines (WebKit/Gecko) won't start a drag with an empty data store.
          e.dataTransfer.setData("text/plain", project.id);
          e.dataTransfer.effectAllowed = "move";
          setDragSelf(true);
        }}
        onDragEnd={() => {
          sidebarDrag = null;
          setDragSelf(false);
        }}
        onClick={toggleCollapsed}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openProjectMenu(e.clientX, e.clientY);
        }}
      >
        <ChevronRightIcon
          size={12}
          className={`project-chevron ${collapsed ? "" : "expanded"}`}
        />
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
          <SessionRow key={s.id} project={project} session={s} collapsed={collapsed} />
        ))}
        <button
          className={`new-session ${collapsed ? "collapsed-hidden" : ""}`}
          onClick={() => setShowNew(true)}
        >
          <PlusIcon size={12} />
          <span>New session</span>
        </button>
      </div>
      {showNew && (
        <NewSessionDialog
          projectPath={project.path}
          hasConductor={project.sessions.some((s) => s.role === "conductor")}
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
  collapsed,
}: {
  project: Project;
  session: Session;
  collapsed: boolean;
}) {
  const selected = useStore((s) => globalSelectedSessionId(s) === session.id);
  const status = useStore((s) => liveState(s.live, session.id).status);
  const activity = useStore((s) => liveState(s.live, session.id).activity);
  const compacting = useStore((s) => liveState(s.live, session.id).compacting);
  const editing = useStore((s) => s.editingSessionId === session.id);
  const selectSession = useStore((s) => s.selectSession);
  const openMenu = useStore((s) => s.openMenu);
  const reorderSession = useStore((s) => s.reorderSession);
  const [dragSelf, setDragSelf] = useState(false);
  const [drop, setDrop] = useState<null | "before" | "after">(null);
  const accounts = useStore((s) => s.accounts);
  const defaultAccounts = useStore((s) => s.defaultAccounts);
  // Which registered account this session resolves to (null = the env default / unconfigured).
  // Only shown once the user actually has accounts, so single-account users see no clutter.
  const accountLabel = useMemo(() => {
    if (accounts.length === 0) return null;
    const key = resolvedAccountKey(defaultAccounts, project, session);
    if (key === "default") return null;
    return accounts.find((a) => a.id === key)?.label ?? null;
  }, [accounts, defaultAccounts, project, session]);

  // When the project is collapsed, keep "active work" in view: the selected session
  // and any row that shows a live status accessory (running / needs-you / compacting /
  // done). Idle, unselected rows fold away. Same predicate StatusAccessory renders on.
  const hasAccessory =
    status === "needsInput" || compacting || status === "running" || status === "done";
  const hidden = collapsed && !selected && !hasAccessory;

  return (
    <div
      className={`session-row ${selected ? "selected" : ""} ${hidden ? "collapsed-hidden" : ""} ${
        dragSelf ? "dragging" : ""
      } ${drop ? `drop-${drop}` : ""}`}
      draggable={!editing}
      onDragStart={(e) => {
        e.stopPropagation();
        sidebarDrag = { kind: "session", projectId: project.id, sessionId: session.id };
        e.dataTransfer.setData("text/plain", session.id);
        e.dataTransfer.effectAllowed = "move";
        setDragSelf(true);
      }}
      onDragEnd={() => {
        sidebarDrag = null;
        setDragSelf(false);
      }}
      onDragOver={(e) => {
        // Sessions reorder within their own project only (a session's cwd/worktree/
        // transcript are rooted there); a foreign-project drag gets no drop target.
        if (
          sidebarDrag?.kind !== "session" ||
          sidebarDrag.projectId !== project.id ||
          sidebarDrag.sessionId === session.id
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setDrop(dropHalf(e));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
      }}
      onDrop={(e) => {
        const src = sidebarDrag;
        // From the event, not `drop` state — see the project-block onDrop note.
        const pos = dropHalf(e);
        setDrop(null);
        if (src?.kind !== "session" || src.projectId !== project.id) return;
        e.preventDefault();
        e.stopPropagation();
        sidebarDrag = null;
        const proj = useStore.getState().projects.find((p) => p.id === project.id);
        if (!proj) return;
        const fromIdx = proj.sessions.findIndex((s) => s.id === src.sessionId);
        const targetIdx = proj.sessions.findIndex((s) => s.id === session.id);
        if (fromIdx < 0 || targetIdx < 0 || fromIdx === targetIdx) return;
        void reorderSession(project.id, src.sessionId, dropIndex(fromIdx, targetIdx, pos === "after"));
      }}
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
      <AgentGlyph id={session.agent} size={14} />
      {session.role === "conductor" && (
        <span className="conductor-chip" title="Conductor — orchestrates this project">
          ◆
        </span>
      )}
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
      {!editing && accountLabel && (
        <span className="account-chip" title={`Account: ${accountLabel}`}>
          {accountLabel}
        </span>
      )}
      {!editing && <TrustChip session={session} />}
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

/** Trust-boundary badge (Feature 4). Only shown while private mode is on, since the marking is
 *  inert otherwise: a lock for a siloed (confidential, unreadable-by-others) session, or a small
 *  clearance tag. */
function TrustChip({ session }: { session: Session }) {
  const privateMode = useStore((s) => s.privateMode);
  if (!privateMode) return null;
  if (session.silo)
    return (
      <span
        className="trust-chip silo"
        title="Siloed — confidential; other agents cannot read this session and it is not streamed to a paired phone"
      >
        🔒
      </span>
    );
  if (session.clearance === "confidential")
    return (
      <span className="trust-chip conf" title="Confidential clearance">
        conf
      </span>
    );
  if (session.clearance === "internal")
    return (
      <span className="trust-chip internal" title="Internal clearance">
        int
      </span>
    );
  return null;
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
  const setSessionTrust = useStore((s) => s.setSessionTrust);
  const privateMode = useStore((s) => s.privateMode);
  const accounts = useStore((s) => s.accounts);
  const setSessionAccount = useStore((s) => s.setSessionAccount);
  const [accountOpen, setAccountOpen] = useState(false);

  // Reset the inline account expander whenever the menu target changes.
  useEffect(() => {
    setAccountOpen(false);
  }, [menu?.sessionId]);

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
  const menuSession = findSession(projects, sid)?.session;
  // Accounts eligible for this session's agent (empty = don't show the Account entry, so
  // single-account users' menu is unchanged).
  const eligibleAccounts = menuSession
    ? accounts.filter((a) => a.agents.includes(menuSession.agent))
    : [];
  const accountLabel = menuSession?.accountId
    ? accounts.find((a) => a.id === menuSession.accountId)?.label ?? null
    : null;
  const siloed = !!menuSession?.silo;
  const toggleSensitive = () => {
    if (menuSession) {
      void setSessionTrust(
        sid,
        siloed
          ? {
              clearance: "public",
              silo: false,
              localOnly: false,
              channels: [],
              modelTier: null,
              seedMemory: null,
              effort: null,
            }
          : {
              clearance: "confidential",
              silo: true,
              localOnly: true,
              channels: menuSession.channels ?? [],
              modelTier: menuSession.modelTier ?? null,
              seedMemory: menuSession.seedMemory ?? null,
              effort: menuSession.effort ?? null,
            },
      );
      if (!privateMode && !siloed) {
        void invoke("notify_user", {
          title: "Conduit",
          body: "Marked sensitive. Enable Private mode (Settings → Security) for the silo to take effect.",
        }).catch(() => {});
      }
    }
    closeMenu();
  };
  // SPEC-F: a custom/manual session is isolated by default (no fleet MCP, no board access
  // at all) -- this is the one opt-in toggle that joins it to the project's mailbox, still
  // scoped to that one project. Full-overwrite semantics on set_session_trust mean every
  // other trust field must be resent unchanged, same as toggleSensitive above.
  const sharedInProject = !!menuSession?.channels?.includes("project");
  const toggleShareInProject = () => {
    if (menuSession) {
      const channels = sharedInProject
        ? (menuSession.channels ?? []).filter((c) => c !== "project")
        : [...(menuSession.channels ?? []), "project"];
      void setSessionTrust(sid, {
        clearance: menuSession.clearance ?? "public",
        silo: menuSession.silo ?? false,
        localOnly: menuSession.localOnly ?? false,
        channels,
        modelTier: menuSession.modelTier ?? null,
        seedMemory: menuSession.seedMemory ?? null,
        effort: menuSession.effort ?? null,
      });
    }
    closeMenu();
  };
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
      <button onClick={toggleSensitive} title="Silo this session: no other agent can read it">
        {siloed ? "Clear sensitive mark" : "Mark sensitive (silo)"}
      </button>
      <button
        onClick={toggleShareInProject}
        title="Join this project's horizontal mailbox: post/read short data-only notes with other opted-in sessions via fleet_note/fleet_inbox"
      >
        {sharedInProject ? "Stop sharing in project" : "Share in project"}
      </button>
      {eligibleAccounts.length > 0 && (
        <>
          <button
            onClick={() => setAccountOpen((v) => !v)}
            title="Run this session under a specific account (applies on next launch)"
          >
            Account{accountLabel ? `: ${accountLabel}` : ""} {accountOpen ? "▾" : "▸"}
          </button>
          {accountOpen && (
            <div className="context-submenu">
              <button
                className={!menuSession?.accountId ? "sel" : ""}
                onClick={() => {
                  void setSessionAccount(sid, null);
                  closeMenu();
                }}
              >
                {!menuSession?.accountId ? "✓ " : ""}Use project / global default
              </button>
              {eligibleAccounts.map((a) => (
                <button
                  key={a.id}
                  className={menuSession?.accountId === a.id ? "sel" : ""}
                  onClick={() => {
                    void setSessionAccount(sid, a.id);
                    closeMenu();
                  }}
                >
                  {menuSession?.accountId === a.id ? "✓ " : ""}
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
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
