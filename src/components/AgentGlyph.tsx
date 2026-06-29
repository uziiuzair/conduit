import { agentMeta, type AgentId } from "../agents";

/** Rounded-square monogram identifying an agent. Accessible: shape + letter + color,
 *  with the agent name as the title (not color alone). */
export function AgentGlyph({ id, size = 14 }: { id: AgentId; size?: number }) {
  const m = agentMeta(id);
  return (
    <span
      className="agent-glyph"
      title={m.label}
      aria-label={m.label}
      style={{ width: size, height: size, background: m.tint, fontSize: Math.round(size * 0.6) }}
    >
      {m.letter}
    </span>
  );
}
