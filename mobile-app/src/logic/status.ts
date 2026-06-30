import type { Agent, EventKind } from "../data/types";

/** basename of a path, e.g. "src/auth/login.ts" -> "login.ts" */
export function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

/**
 * Tool name + input -> human activity phrase. Mirror of the desktop
 * `toolActivity` (src/App.tsx) so the phone says the same things the sidebar does.
 */
export function toolActivity(
  tool: string,
  input?: { file_path?: string; path?: string; command?: string },
): string {
  const file = input?.file_path ?? input?.path;
  switch (tool) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return file ? `Editing ${basename(file)}` : "Editing a file";
    case "Read":
      return file ? `Reading ${basename(file)}` : "Reading a file";
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
    default:
      return tool;
  }
}

/** Which timeline glyph/lane a tool maps to. */
export function eventKindFor(tool: string): EventKind {
  switch (tool) {
    case "Read":
      return "read";
    case "Bash":
      return "bash";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Grep":
    case "Glob":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "Task":
      return "subagent";
    default:
      return "generic";
  }
}

export type DotKind = "running" | "done" | "idle" | "needs";

export function statusDot(a: Agent): DotKind {
  switch (a.status) {
    case "needsInput":
      return "needs";
    case "running":
      return "running";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

/** Secondary line under an agent's name in the Projects list. */
export function agentSubline(a: Agent): string {
  if (a.status === "needsInput") return a.attention ?? "needs your input";
  if (a.compacting) return "compacting…";
  if (a.status === "running") return a.activity ?? "working…";
  if (a.status === "done") return a.doneAgo ? `done · finished ${a.doneAgo}` : "done";
  return "idle";
}

/** How many agents are waiting on the human (drives the header chip). */
export function needsCount(agents: Agent[]): number {
  return agents.filter((a) => a.status === "needsInput").length;
}

/** Single-letter avatar for an agent kind: Claude / codeX / Gemini. */
export function agentBadge(kind: Agent["kind"]): string {
  return kind === "codex" ? "X" : kind === "gemini" ? "G" : "C";
}
