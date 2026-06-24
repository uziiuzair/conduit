import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  useStore,
  findSession,
  globalSelectedSessionId,
  type TodoItem,
  type TodoStatus,
} from "./store";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceCenter } from "./components/WorkspaceCenter";
import { RightColumn } from "./components/RightColumn";

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

  useEffect(() => {
    void load();
  }, [load]);

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
          void maybeAutoName(session, body?.prompt);
          break;
        case "todos":
          applyTodos(body?.tool_input, session);
          break;
        case "tooluse":
          if (body?.tool_name === "TodoWrite") applyTodos(body?.tool_input, session);
          break;
        case "stop":
          st.setStatus(session, "done");
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

  return (
    <div className="app-root">
      <Sidebar />
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
function applyTodos(toolInput: any, sessionId: string) {
  const raw = toolInput?.todos;
  if (!Array.isArray(raw)) return;
  const todos: TodoItem[] = raw
    .filter((it) => typeof it?.content === "string")
    .map((it) => ({
      content: it.content as string,
      status: (it.status as TodoStatus) ?? "pending",
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
