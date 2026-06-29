import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  useStore,
  findSession,
  globalSelectedSessionId,
  baseName,
  type TodoItem,
  type TodoStatus,
} from "./store";
import { type AgentId } from "./agents";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceCenter } from "./components/WorkspaceCenter";
import { RightColumn } from "./components/RightColumn";
import { Onboarding } from "./components/Onboarding";

interface HookPayload {
  session: string;
  event: string;
  body: any;
}

export default function App() {
  const projects = useStore((s) => s.projects);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const home = useStore((s) => s.homeDir);
  const load = useStore((s) => s.load);
  const loadAgents = useStore((s) => s.loadAgents);
  const agentSetupComplete = useStore((s) => s.agentSetupComplete);

  useEffect(() => {
    void load();
    void loadAgents();
  }, [load, loadAgents]);

  // Suppress the webview's default context menu (Reload / Inspect Element).
  // Our own row menus call preventDefault + stopPropagation, so they're unaffected.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  // Claude Code hook events relayed by the Rust HTTP listener.
  useEffect(() => {
    const unlisten = listen<HookPayload>("hook", ({ payload }) => {
      const { session, event, body } = payload;
      const st = useStore.getState();
      switch (event) {
        case "prompt":
          st.setStatus(session, "running");
          st.setCompacting(session, false);
          st.setActivity(session, undefined);
          void maybeAutoName(session, body?.prompt);
          break;
        case "todos":
          applyTodos(body?.tool_input, session);
          break;
        case "tooluse":
          if (body?.tool_name === "TodoWrite") applyTodos(body?.tool_input, session);
          break;
        case "pretool": {
          // Fires before each tool runs: a more responsive "running" plus a
          // live label of what it's doing. TodoWrite is shown in the To-dos panel.
          st.setStatus(session, "running");
          st.setCompacting(session, false);
          st.setActivity(session, toolActivity(agentOf(session), body?.tool_name, body?.tool_input));
          break;
        }
        case "precompact":
          st.setCompacting(session, true);
          break;
        case "sessionstart":
          // New or resumed session: clear any stale transient state.
          st.setCompacting(session, false);
          st.setActivity(session, undefined);
          break;
        case "sessionend":
          st.setStatus(session, "idle");
          st.setCompacting(session, false);
          st.setActivity(session, undefined);
          break;
        case "stop":
          st.setStatus(session, "done");
          st.setActivity(session, undefined);
          st.setCompacting(session, false);
          notifyIfAway(session, "finished");
          break;
        case "notification": {
          const active =
            globalSelectedSessionId(st) === session && document.hasFocus();
          if (!active) {
            st.setStatus(session, "needsInput");
            doNotify(session, body?.message ?? "needs your input");
          }
          break;
        }
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Returning to the app clears "needs you" on whatever session you're viewing.
  useEffect(() => {
    const onFocus = () => {
      const st = useStore.getState();
      const id = globalSelectedSessionId(st);
      if (id && st.live[id]?.status === "needsInput") st.setStatus(id, "idle");
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Resizable right column (persisted).
  const MIN_W = 260;
  const MAX_W = 720;
  const [rightWidth, setRightWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("conduit.rightWidth"));
    return saved >= MIN_W && saved <= MAX_W ? saved : 340;
  });
  const widthRef = useRef(rightWidth);
  const [dragging, setDragging] = useState(false);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - ev.clientX));
      widthRef.current = w;
      setRightWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false);
      localStorage.setItem("conduit.rightWidth", String(widthRef.current));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // Resizable sidebar (persisted). Mirrors the right-column resizer above.
  const SB_MIN = 200;
  const SB_MAX = 420;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("conduit.sidebarWidth"));
    return saved >= SB_MIN && saved <= SB_MAX ? saved : 232;
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  const [sidebarDragging, setSidebarDragging] = useState(false);

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setSidebarDragging(true);
    const onMove = (ev: MouseEvent) => {
      // clientX is the distance from the viewport's left edge = sidebar width.
      const w = Math.min(SB_MAX, Math.max(SB_MIN, ev.clientX));
      sidebarWidthRef.current = w;
      setSidebarWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setSidebarDragging(false);
      localStorage.setItem("conduit.sidebarWidth", String(sidebarWidthRef.current));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      className="app-root"
      style={{ ["--sidebar-w" as string]: `${sidebarWidth}px` }}
    >
      <Sidebar />
      {!agentSetupComplete && <Onboarding />}
      <div
        className={`sidebar-resizer ${sidebarDragging ? "dragging" : ""}`}
        onMouseDown={startSidebarResize}
      />
      <div
        className="detail"
        style={{ ["--right-w" as string]: `${rightWidth}px` }}
      >
        <WorkspaceCenter
          projects={projects}
          projectId={selectedProjectId}
          home={home}
        />
        <div
          className={`resizer ${dragging ? "dragging" : ""}`}
          onMouseDown={startResize}
        />
        <RightColumn projects={projects} projectId={selectedProjectId} />
      </div>
    </div>
  );
}

// ---- auto-rename ----
const autoNamed = new Set<string>();

async function maybeAutoName(sessionId: string, prompt: unknown) {
  if (typeof prompt !== "string" || !prompt.trim()) return;
  if (autoNamed.has(sessionId)) return;

  const found = findSession(useStore.getState().projects, sessionId);
  if (!found || !/^Session \d+$/.test(found.session.name)) return;

  autoNamed.add(sessionId);
  try {
    const name = await invoke<string>("suggest_session_name", { prompt });
    const clean = (name ?? "").trim();
    const now = findSession(useStore.getState().projects, sessionId);
    if (clean && now && /^Session \d+$/.test(now.session.name)) {
      await useStore.getState().renameSession(found.project.id, sessionId, clean);
    }
  } catch {
    autoNamed.delete(sessionId);
  }
}

// ---- hook helpers ----

/** Look up which agent is running a given session (defaults to "claude" for back-compat). */
function agentOf(sessionId: string): AgentId {
  return findSession(useStore.getState().projects, sessionId)?.session.agent ?? "claude";
}

/** Map a tool name + input to a short, human "what it's doing now" label for the
 *  sidebar. Agent-aware: each adapter has its own tool vocabulary. Returns undefined
 *  when there's nothing worth showing (e.g. the tool is surfaced elsewhere). */
function toolActivity(agent: AgentId, toolName?: string, toolInput?: any): string | undefined {
  if (typeof toolName !== "string" || !toolName) return undefined;

  if (agent === "codex") {
    switch (toolName) {
      case "Bash":
        return "Running a command";
      case "apply_patch": {
        const p = toolInput?.path ?? toolInput?.file_path;
        const f = typeof p === "string" && p ? baseName(p) : undefined;
        return f ? `Editing ${f}` : "Editing files";
      }
      default:
        return toolName;
    }
  }

  if (agent === "gemini") {
    switch (toolName) {
      case "run_shell_command":
        return "Running a command";
      case "write_file":
      case "replace": {
        const p = toolInput?.absolute_path ?? toolInput?.path ?? toolInput?.file_path;
        const f = typeof p === "string" && p ? baseName(p) : undefined;
        return f ? `Editing ${f}` : "Editing files";
      }
      case "read_file":
      case "read_many_files":
        return "Reading files";
      case "google_web_search":
      case "web_fetch":
        return "Browsing the web";
      case "write_todos":
        return undefined; // surfaced in the To-dos panel instead
      default:
        return toolName;
    }
  }

  // claude (and any unknown agent): keep the existing PascalCase switch body unchanged.
  const file = (): string | undefined => {
    const p = toolInput?.file_path ?? toolInput?.path ?? toolInput?.notebook_path;
    return typeof p === "string" && p ? baseName(p) : undefined;
  };
  switch (toolName) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const f = file();
      return f ? `Editing ${f}` : "Editing files";
    }
    case "Read": {
      const f = file();
      return f ? `Reading ${f}` : "Reading files";
    }
    case "Bash":
      return "Running a command";
    case "Grep":
    case "Glob":
      return "Searching the code";
    case "Task":
      return "Running a subagent";
    case "WebFetch":
    case "WebSearch":
      return "Browsing the web";
    case "TodoWrite":
      return undefined; // surfaced in the To-dos panel instead
    default:
      return toolName;
  }
}

function applyTodos(toolInput: any, sessionId: string) {
  // Claude sends { todos: [...] }; Gemini may send { todo_list: [...] } or a bare array.
  const raw =
    toolInput?.todos ?? toolInput?.todo_list ?? (Array.isArray(toolInput) ? toolInput : undefined);
  if (!Array.isArray(raw)) return;
  const todos: TodoItem[] = raw
    .filter((it) => typeof it?.content === "string")
    .map((it) => ({
      content: it.content as string,
      status: (it.status as TodoStatus) ?? "pending",
      activeForm: typeof it.activeForm === "string" ? (it.activeForm as string) : undefined,
    }));
  const st = useStore.getState();
  st.setTodos(sessionId, todos);
  if (todos.some((t) => t.status === "in_progress"))
    st.setStatus(sessionId, "running");
}

function sessionName(sessionId: string): string {
  const found = findSession(useStore.getState().projects, sessionId);
  return found?.session.name ?? "Session";
}

function notifyIfAway(sessionId: string, body: string) {
  const st = useStore.getState();
  if (!document.hasFocus() || globalSelectedSessionId(st) !== sessionId)
    doNotify(sessionId, body);
}

function doNotify(sessionId: string, body: string) {
  void invoke("notify_user", {
    title: "Conduit",
    subtitle: sessionName(sessionId),
    body,
  }).catch(() => {});
}
