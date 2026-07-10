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

/**
 * A phone message -> raw PTY keystrokes. Single-line text is typed + Enter.
 * Multi-line text rides inside bracketed paste so the Claude CLI receives it as
 * one paste block (a bare "\n" mid-stream would submit the first line alone),
 * then Enter submits.
 */
export function promptToKeystrokes(text: string): string {
  const t = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!t.includes("\n")) return t + "\r";
  return `\x1b[200~${t}\x1b[201~\r`;
}

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
