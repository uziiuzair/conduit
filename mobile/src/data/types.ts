/** Data model for the mobile companion. Mirrors the desktop's session/status
 * vocabulary (src/store.ts LiveState + src/themes.ts) so the two stay legible
 * to each other. Backed by mock data in this shell; by the bridge later. */

export type AgentKind = "claude" | "codex" | "gemini";

/** Same four states as the desktop `SessionStatus` (src/store.ts). */
export type SessionStatus = "idle" | "running" | "needsInput" | "done";

export interface TodoProgress {
  done: number;
  total: number;
}

export interface ApprovalRequest {
  id: string;
  /** tool name, e.g. "Bash" */
  tool: string;
  /** the thing being approved, e.g. "rm -rf node_modules && npm i" */
  input: string;
}

export interface Agent {
  id: string;
  name: string;
  branch: string;
  kind: AgentKind;
  status: SessionStatus;
  /** running: "Editing src/store.ts" (mirror of desktop `activity`) */
  activity?: string;
  todos?: TodoProgress;
  compacting?: boolean;
  /** needsInput sub-line: "approval · Bash: rm -rf…" | "waiting · your reply" */
  attention?: string;
  /** done: "3m ago" */
  doneAgo?: string;
  /** present when this agent is blocked on an approval */
  pendingApproval?: ApprovalRequest;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  agents: Agent[];
}

// ---- chat feed items ----

export type ChatRole = "user" | "assistant";
export type EventKind = "read" | "bash" | "edit" | "search" | "web" | "subagent" | "generic";
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface BubbleItem {
  kind: "bubble";
  id: string;
  role: ChatRole;
  text: string;
}

export interface EventItem {
  kind: "event";
  id: string;
  event: EventKind;
  /** verb, e.g. "read" / "ran" / "edited" */
  label: string;
  /** monospace detail, e.g. "src/auth/login.ts" or "npm test" */
  mono?: string;
  /** trailing ok marker, e.g. "✓ 12" */
  ok?: string;
}

export interface TodosItem {
  kind: "todos";
  id: string;
  done: number;
  total: number;
  items: { text: string; status: TodoStatus }[];
}

export interface ApprovalItem {
  kind: "approval";
  id: string;
  tool: string;
  input: string;
  /** undefined while pending; set once answered */
  resolved?: "allow" | "deny";
}

export type ChatItem = BubbleItem | EventItem | TodosItem | ApprovalItem;
