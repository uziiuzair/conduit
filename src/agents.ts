export type AgentId = "claude" | "codex";

export interface AgentMeta {
  id: AgentId;
  label: string;
  /** Monogram letter shown in the glyph. */
  letter: string;
  /** CSS color token for the glyph tint. */
  tint: string;
  /** Whether Conduit's worktree isolation is offered for this agent (Phase 1: Claude only). */
  supportsWorktree: boolean;
}

export const AGENTS: AgentMeta[] = [
  { id: "claude", label: "Claude Code", letter: "C", tint: "#ce8a6e", supportsWorktree: true },
  { id: "codex", label: "Codex CLI", letter: "x", tint: "#9aa6b2", supportsWorktree: false },
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
}
