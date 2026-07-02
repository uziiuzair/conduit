/**
 * Map bridge wire messages to the app's UI types, and reduce live hook `status`
 * frames into a per-session status patch. The reducer is a port of the desktop
 * verb→status switch in `src/App.tsx`.
 */
import type { Agent, ChatItem, EventKind, Project, SessionStatus, TodoProgress } from "../data/types";
import { toolActivity } from "../logic/status";
import type { WireChatItem, WireProject, WireSession } from "./protocol";

let idSeq = 0;
function nextId(prefix = "w"): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

function eventKind(e: string): EventKind {
  switch (e) {
    case "read":
      return "read";
    case "bash":
      return "bash";
    case "edit":
      return "edit";
    case "search":
      return "search";
    case "web":
      return "web";
    case "subagent":
      return "subagent";
    default:
      return "generic";
  }
}

/** Transcript-derived wire item → UI ChatItem (assigns a render id). */
export function mapChatItem(w: WireChatItem): ChatItem {
  if (w.kind === "bubble") {
    return { kind: "bubble", id: nextId("b"), role: w.role, text: w.text };
  }
  return {
    kind: "event",
    id: nextId("e"),
    event: eventKind(w.event),
    label: w.label,
    mono: w.mono ?? undefined,
    ok: w.ok ?? undefined,
  };
}

export function mapSession(s: WireSession): Agent {
  return {
    id: s.id,
    name: s.name,
    branch: s.branch ?? "",
    kind: s.agent,
    // Baseline from the PTY-alive flag; live `status` frames refine it once attached.
    status: s.running ? "running" : "idle",
  };
}

export function mapProjects(ps: WireProject[]): Project[] {
  return ps.map((p) => ({
    id: p.id,
    name: p.name,
    path: p.path,
    agents: p.sessions.map(mapSession),
  }));
}

// ---- live status reducer (subset of desktop src/App.tsx hook switch) ----

export interface LivePatch {
  status?: SessionStatus;
  activity?: string;
  compacting?: boolean;
  todos?: TodoProgress;
  /** clear the transient activity label */
  clearActivity?: boolean;
}

interface HookBody {
  tool_name?: string;
  tool_input?: { todos?: unknown[]; todo_list?: unknown[]; file_path?: string; path?: string; command?: string };
  message?: string;
  prompt?: string;
}

function todoProgress(items: unknown[]): { progress: TodoProgress; anyRunning: boolean } {
  const arr = items as { status?: string }[];
  const done = arr.filter((t) => t.status === "completed").length;
  const anyRunning = arr.some((t) => t.status === "in_progress");
  return { progress: { done, total: arr.length }, anyRunning };
}

/** One hook `status` frame → a patch to apply to the session's live state. */
export function statusPatch(event: string, body: HookBody | null | undefined): LivePatch {
  const b = body ?? {};
  switch (event) {
    case "prompt":
      return { status: "running", compacting: false, clearActivity: true };
    case "pretool":
      return { status: "running", compacting: false, activity: toolActivity(b.tool_name ?? "", b.tool_input) };
    case "todos":
    case "tooluse": {
      const items = b.tool_input?.todos ?? b.tool_input?.todo_list;
      if (Array.isArray(items)) {
        const { progress, anyRunning } = todoProgress(items);
        return anyRunning ? { todos: progress, status: "running" } : { todos: progress };
      }
      return {};
    }
    case "precompact":
      return { compacting: true };
    case "sessionstart":
      return { compacting: false, clearActivity: true };
    case "sessionend":
      return { status: "idle", compacting: false, clearActivity: true };
    case "stop":
      return { status: "done", compacting: false, clearActivity: true };
    case "notification":
      return { status: "needsInput" };
    default:
      return {};
  }
}
