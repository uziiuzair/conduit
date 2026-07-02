/**
 * Wire protocol for the Conduit mobile bridge (the Rust `bridge.rs` WebSocket).
 * These types mirror the server→client / client→server JSON exactly. A mapping
 * layer (live.ts) turns them into the UI types in src/data/types.ts.
 */

// ---- server → client ----

export interface WireSession {
  id: string;
  name: string;
  branch?: string | null;
  agent: "claude" | "codex" | "gemini";
  running: boolean;
  useWorktree?: boolean;
  worktreePath?: string | null;
}

export interface WireProject {
  id: string;
  name: string;
  path: string;
  sessions: WireSession[];
}

/** A transcript-derived chat item (subset the parser emits — no id on the wire). */
export type WireChatItem =
  | { kind: "bubble"; role: "user" | "assistant"; text: string }
  | { kind: "event"; event: string; label: string; mono?: string | null; ok?: string | null };

export type ServerMsg =
  | { type: "projects"; projects: WireProject[] }
  | { type: "size"; cols: number; rows: number }
  | { type: "history"; items: WireChatItem[] }
  | { type: "chat"; item: WireChatItem }
  | { type: "status"; event: string; body: unknown }
  | { type: "output"; data: string } // base64 PTY bytes — chat UI ignores
  | { type: "error"; message: string };

// ---- client → server ----

export type ClientMsg =
  | { type: "list" }
  | { type: "attach"; session_id: string }
  | { type: "input"; session_id: string; data: string }
  | { type: "resize"; session_id: string; cols: number; rows: number };

/** Default dev endpoint: the desktop bridge on loopback (Simulator reaches this). */
export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8456";
