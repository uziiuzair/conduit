// Typed mirror of Conduit's bridge protocol (src-tauri/src/bridge.rs +
// transcript.rs) and pure frame parsing. No I/O — vitest exercises this directly.

// ---- server -> client frames -------------------------------------------------

export interface BridgeSession {
  id: string;
  name: string;
  branch?: string | null;
  agent?: string;
  running: boolean;
}

export interface BridgeProject {
  id: string;
  name: string;
  path: string;
  sessions: BridgeSession[];
}

/** Chat items produced by transcript.rs `parse_line`. */
export type ChatItem =
  | { kind: "bubble"; role: "user" | "assistant"; text: string }
  | { kind: "event"; event: string; label: string; mono: string | null }
  | {
      kind: "usage";
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    };

export interface GitChange {
  status: string;
  path: string;
  added: number;
  removed: number;
}

export interface GitResult {
  type: "gitresult";
  action: string;
  changes?: GitChange[];
  path?: string;
  diff?: string;
  error?: string;
}

export type ServerFrame =
  | { type: "projects"; projects: BridgeProject[] }
  | { type: "size"; cols: number; rows: number }
  | { type: "history"; items: ChatItem[] }
  | { type: "output"; data: string }
  | { type: "status"; event: string; body: unknown }
  | { type: "chat"; item: ChatItem }
  | { type: "error"; message: string }
  | { type: "killed"; sessionId: string }
  | { type: "spawned"; sessionId: string; name: string; projectId: string }
  | GitResult;

/** Parse one bridge text frame; null on garbage or unknown type. */
export function parseServerFrame(text: string): ServerFrame | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const t = (v as { type?: unknown }).type;
  if (
    t === "projects" ||
    t === "size" ||
    t === "history" ||
    t === "output" ||
    t === "status" ||
    t === "chat" ||
    t === "error" ||
    t === "gitresult" ||
    t === "killed" ||
    t === "spawned"
  ) {
    return v as ServerFrame;
  }
  return null;
}

// ---- client -> server frames ---------------------------------------------------

export const listFrame = (): string => JSON.stringify({ type: "list" });
export const attachFrame = (sessionId: string): string =>
  JSON.stringify({ type: "attach", session_id: sessionId });
export const inputFrame = (sessionId: string, data: string): string =>
  JSON.stringify({ type: "input", session_id: sessionId, data });
export const gitFrame = (sessionId: string, action: string, path?: string): string =>
  JSON.stringify({ type: "git", session_id: sessionId, action, ...(path ? { path } : {}) });
export const killFrame = (sessionId: string): string =>
  JSON.stringify({ type: "kill", session_id: sessionId });
export const spawnFrame = (
  projectId: string,
  prompt: string,
  agent?: string,
  worktree = false,
): string =>
  JSON.stringify({ type: "spawn", project_id: projectId, prompt, worktree, ...(agent ? { agent } : {}) });

/** The Enter keystroke that submits the prompt. Sent as its OWN pty write, a beat
 *  after the text — see promptToInsert. */
export const SUBMIT_KEY = "\r";

/**
 * A phone message -> the "insert into the input field" keystrokes, WITHOUT the
 * submitting Enter. Multi-line text rides inside bracketed paste so the Claude CLI
 * receives it as one block (a bare "\n" mid-stream would submit the first line
 * alone). The Enter is deliberately NOT appended: an Ink-based TUI like Claude
 * Code treats a text burst that ends in "\r" as pasted content and drops the
 * newline into the field instead of submitting, so the caller sends SUBMIT_KEY as
 * a separate keystroke once the field has rendered the text.
 */
export function promptToInsert(text: string): string {
  const t = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!t.includes("\n")) return t;
  return `\x1b[200~${t}\x1b[201~`;
}

/** Interrupt a running agent (Ctrl-C). */
export const INTERRUPT_KEY = "\x03";

/** Friendly control-key names -> the bytes to write to the PTY. Lets the phone
 *  drive Claude Code's interactive prompts/menus (y/n approvals, selection lists).
 *  `y`/`n` include the submitting Enter so a one-tap answer works. */
const CONTROL_KEYS: Record<string, string> = {
  esc: "\x1b",
  escape: "\x1b",
  enter: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  tab: "\t",
  "ctrl-c": "\x03",
  ctrlc: "\x03",
  space: " ",
  y: "y\r",
  yes: "y\r",
  n: "n\r",
  no: "n\r",
};

/** Bytes for a named control key, or null if the name is unknown. Pure. */
export function controlKeyBytes(name: string): string | null {
  return CONTROL_KEYS[name.trim().toLowerCase()] ?? null;
}

/** Names accepted by `/conduit key`, for help text. */
export const CONTROL_KEY_NAMES = "esc, enter, up, down, left, right, tab, ctrl-c, space, y, n";

// ---- hook status events -> presence -------------------------------------------

// ---- awareness: activity labels, todos, usage (Phase 2) -----------------------

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

/** Base filename of a path, forward-slash aware. */
function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Short "what it's doing now" label from a `pretool`/`tooluse` hook body, or null
 *  when there's nothing worth showing. Mirrors App.tsx's toolActivity (claude names).
 *  Pure. */
export function activityLabel(body: unknown): string | null {
  const b = body as { tool_name?: string; tool_input?: Record<string, unknown> } | null;
  const name = b?.tool_name;
  if (typeof name !== "string" || !name) return null;
  const inp = b?.tool_input ?? {};
  const file = () => {
    const p = inp.file_path ?? inp.path ?? inp.notebook_path;
    return typeof p === "string" && p ? baseName(p) : undefined;
  };
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const f = file();
      return f ? `✏️ editing ${f}` : "✏️ editing files";
    }
    case "Read": {
      const f = file();
      return f ? `📖 reading ${f}` : "📖 reading files";
    }
    case "Bash": {
      const c = inp.command;
      return typeof c === "string" ? `⚙️ running ${c.slice(0, 60)}` : "⚙️ running a command";
    }
    case "Grep":
    case "Glob":
      return "🔎 searching";
    case "Task":
      return "🤖 running a subagent";
    case "WebFetch":
    case "WebSearch":
      return "🌐 browsing the web";
    case "TodoWrite":
      return null; // shown in the todo mirror instead
    default:
      return name;
  }
}

/** Extract a todo list from a `todos`/TodoWrite hook body (several shapes). Pure. */
export function parseHookTodos(body: unknown): TodoItem[] | null {
  const b = body as { tool_input?: unknown; todos?: unknown; todo_list?: unknown } | null;
  const ti = b?.tool_input as { todos?: unknown } | undefined;
  const raw = ti?.todos ?? b?.todos ?? b?.todo_list;
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((t) => t && typeof (t as { content?: unknown }).content === "string")
    .map((t) => {
      const it = t as { content: string; status?: string; activeForm?: string };
      return {
        content: it.content,
        status:
          it.status === "in_progress" || it.status === "completed" ? it.status : "pending",
        activeForm: typeof it.activeForm === "string" ? it.activeForm : undefined,
      };
    });
}

/** What a hook event means for the Matrix typing indicator. */
export function typingForStatus(event: string): boolean | null {
  switch (event) {
    case "prompt":
    case "pretool":
    case "tooluse":
      return true;
    case "stop":
    case "sessionend":
    case "notification":
      return false;
    default:
      return null; // no presence change (todos, precompact, sessionstart, …)
  }
}
