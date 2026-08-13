import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { liveState, useStore } from "../store";

/** Mirrors Rust `subagents::Subagent`. */
interface Subagent {
  id: string;
  toolUseId: string | null;
  lines: string[];
  updatedAt: number;
}

/** Only poll while the parent is working — an idle session's subagents cannot change. */
const POLL_MS = 2_000;

/**
 * What a session's Task subagents are doing.
 *
 * A fan-out used to be invisible: one busy dot for what might be five agents working in
 * parallel. Claude writes each subagent's transcript beside the parent's, so this is a read
 * — rendered as an activity log (prose, `$ Tool arg`, `↳ result`) rather than raw JSON.
 */
export function SubagentsView({ sessionId }: { sessionId: string }) {
  const [agents, setAgents] = useState<Subagent[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const status = useStore((s) => liveState(s.live, sessionId).status);

  useEffect(() => {
    let alive = true;
    const read = () => {
      void invoke<Subagent[]>("session_subagents", { sessionId })
        .then((v) => {
          if (alive) setAgents(v);
        })
        .catch(() => {});
    };
    read();
    // Keep polling only while the parent is running. A finished fan-out stays on screen —
    // the last thing each subagent did is often exactly what you came to read.
    if (status !== "running") return () => { alive = false; };
    const t = setInterval(read, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId, status]);

  if (agents.length === 0) {
    return <p className="placeholder">No subagents for this session.</p>;
  }

  return (
    <div className="subagents">
      {agents.map((a, i) => {
        // Newest first from the backend, so the first row is the one most likely being
        // watched; the rest start collapsed to keep the panel scannable.
        const open = expanded[a.id] ?? i === 0;
        const last = a.lines[a.lines.length - 1] ?? "";
        return (
          <div key={a.id} className={`subagent ${open ? "open" : ""}`}>
            <button
              className="subagent-head"
              onClick={() => setExpanded((e) => ({ ...e, [a.id]: !open }))}
            >
              <span className="subagent-caret">{open ? "▾" : "▸"}</span>
              <span className="subagent-id">agent {a.id.slice(0, 8)}</span>
              {!open && <span className="subagent-last">{last}</span>}
            </button>
            {open && (
              <div className="subagent-log">
                {a.lines.map((l, j) => (
                  <div
                    key={j}
                    className={`subagent-line ${
                      l.startsWith("$ ") ? "tool" : l.startsWith("  ↳") ? "result" : ""
                    }`}
                  >
                    {l}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
