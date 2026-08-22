export type AgentId =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "antigravity"
  | "commandcode";

export interface AgentMeta {
  id: AgentId;
  label: string;
  /** Monogram letter shown in the glyph. */
  letter: string;
  /** CSS color token for the glyph tint. */
  tint: string;
  /** Whether Conduit's worktree isolation is offered for this agent (Phase 1: Claude only). */
  supportsWorktree: boolean;
  /** Whether the MCP matrix can manage servers for this agent (OpenCode: not yet — Tier 3). */
  supportsMcp: boolean;
}

export const AGENTS: AgentMeta[] = [
  { id: "claude",   label: "Claude Code", letter: "C", tint: "#ce8a6e", supportsWorktree: true,  supportsMcp: true  },
  { id: "codex",    label: "Codex CLI",   letter: "x", tint: "#9aa6b2", supportsWorktree: false, supportsMcp: true  },
  { id: "gemini",   label: "Gemini CLI",  letter: "G", tint: "#7e9cff", supportsWorktree: false, supportsMcp: true  },
  { id: "opencode", label: "OpenCode",    letter: "o", tint: "#6cc29a", supportsWorktree: false, supportsMcp: false },
  { id: "antigravity", label: "Antigravity", letter: "A", tint: "#a78bfa", supportsWorktree: false, supportsMcp: false },
  // Command Code's binary is `cmd` on Unix and `cmdc` on Windows -- the monogram stays a
  // plain "c" so it reads the same on both. `supportsMcp` because `cmd mcp add/remove`
  // takes the same flags Claude's does; `supportsWorktree` stays off because Command Code
  // manages its own worktrees (`-w`) and two managers over one directory is a decision
  // that has not been made yet.
  { id: "commandcode", label: "Command Code", letter: "c", tint: "#e0b341", supportsWorktree: false, supportsMcp: true },
];

export const DEFAULT_AGENT: AgentId = "claude";

export function agentMeta(id: AgentId): AgentMeta {
  return AGENTS.find((a) => a.id === id) ?? AGENTS[0];
}

/** Result of the Rust `detect_agents` PATH scan (mirrors AgentInfo in agent.rs). */
export interface AgentInfo {
  id: AgentId;
  label: string;
  binary: string;
  found: boolean;
  path?: string | null;
  /** One-click install command for this agent, or null when there's no known installer. */
  installCommand?: string | null;
}

/** MCP server definition — mirrors the Rust McpServer struct (serde rename_all = "camelCase"). */
export interface McpServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: [string, string][];
}
