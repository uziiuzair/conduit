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

export type ServerFrame =
  | { type: "projects"; projects: BridgeProject[] }
  | { type: "size"; cols: number; rows: number }
  | { type: "history"; items: ChatItem[] }
  | { type: "output"; data: string }
  | { type: "status"; event: string; body: unknown }
  | { type: "chat"; item: ChatItem }
  | { type: "error"; message: string };

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
    t === "error"
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
