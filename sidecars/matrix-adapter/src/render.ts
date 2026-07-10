// Pure rendering + command parsing: chat items -> Matrix message content, and
// owner messages -> /conduit commands. No Matrix SDK imports (unit-testable).

import type { BridgeProject, ChatItem, TodoItem } from "./protocol.js";

// ---- /conduit command parsing ---------------------------------------------------

export type Command =
  | { cmd: "help" }
  | { cmd: "list" }
  | { cmd: "use"; target: string }
  | { cmd: "detach" }
  | { cmd: "status" }
  | { cmd: "stop" }
  | { cmd: "key"; key: string }
  | { cmd: "send"; text: string }
  | { cmd: "todos" }
  | { cmd: "watch"; on: boolean };

/** Parse "/conduit …" (null = not a command; the text is a prompt). "/bot …" is
 *  BadgerClaw's own namespace and is treated as not-ours (also null). */
export function parseCommand(body: string): Command | null {
  const m = /^\/conduit\b\s*([\s\S]*)$/i.exec(body.trim());
  if (!m) return null;
  const rest = m[1].trim();
  if (rest === "" || /^help$/i.test(rest)) return { cmd: "help" };
  if (/^list$/i.test(rest)) return { cmd: "list" };
  if (/^detach$/i.test(rest)) return { cmd: "detach" };
  if (/^status$/i.test(rest)) return { cmd: "status" };
  if (/^stop$/i.test(rest)) return { cmd: "stop" };
  if (/^todos$/i.test(rest)) return { cmd: "todos" };
  const watch = /^watch(?:\s+(on|off))?$/i.exec(rest);
  if (watch) return { cmd: "watch", on: (watch[1] ?? "on").toLowerCase() === "on" };
  const use = /^use\s+(.+)$/i.exec(rest);
  if (use) return { cmd: "use", target: use[1].trim() };
  const key = /^key\s+(.+)$/i.exec(rest);
  if (key) return { cmd: "key", key: key[1].trim() };
  const send = /^send\s+([\s\S]+)$/i.exec(rest);
  if (send) return { cmd: "send", text: send[1] };
  return { cmd: "help" };
}

export const HELP_TEXT = [
  "Conduit adapter commands:",
  "/conduit list — projects & sessions on the desktop",
  "/conduit use <n | session-id> — bind this room to a session",
  "/conduit detach — unbind this room",
  "/conduit status — binding + bridge connectivity",
  "/conduit stop — interrupt the running agent (Ctrl-C)",
  "/conduit key <name> — send a control key (esc, enter, up, down, y, n, …)",
  "/conduit send <text> — type text into the session WITHOUT running it",
  "/conduit todos — the bound session's current plan/checklist",
  "/conduit watch on|off — ping this room when a turn finishes (for when you're away)",
  "Anything else you type here is sent to the bound session as a prompt.",
  "Tip: Claude's y/n approval prompts stream here — just reply y or n.",
].join("\n");

// ---- awareness rendering (Phase 2) ----------------------------------------------

const TODO_MARK: Record<TodoItem["status"], string> = {
  completed: "✅",
  in_progress: "🔄",
  pending: "⬜",
};

/** Render a todo list as a checklist. Empty list -> a friendly placeholder. */
export function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "No plan yet — the agent hasn't written todos.";
  const done = todos.filter((t) => t.status === "completed").length;
  const lines = todos.map((t) => {
    const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
    return `${TODO_MARK[t.status]} ${label}`;
  });
  return [`Plan (${done}/${todos.length} done):`, ...lines].join("\n");
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });

/** Rough cost estimate — Opus-class blended rate, deliberately conservative. Cache
 *  reads are ~10% of fresh input. Only a ballpark for "am I burning money" awareness. */
export function estimateCostUsd(u: Usage): number {
  const inputPerM = 15,
    outputPerM = 75,
    cacheReadPerM = 1.5;
  return (
    (u.input * inputPerM +
      u.cacheCreation * inputPerM +
      u.cacheRead * cacheReadPerM +
      u.output * outputPerM) /
    1_000_000
  );
}

export function renderUsage(u: Usage): string {
  const tok = u.input + u.output + u.cacheCreation; // fresh tokens (cache reads are cheap/repeated)
  return `~${tok.toLocaleString()} tokens this session (≈$${estimateCostUsd(u).toFixed(2)})`;
}

// ---- session listing --------------------------------------------------------------

export interface IndexedSession {
  index: number;
  sessionId: string;
  label: string;
}

/** Flatten the projects tree into stable 1-based indices for `/conduit use <n>`. */
export function indexSessions(projects: BridgeProject[]): IndexedSession[] {
  const out: IndexedSession[] = [];
  let i = 1;
  for (const p of projects) {
    for (const s of p.sessions ?? []) {
      const branch = s.branch ? ` (${s.branch})` : "";
      const state = s.running ? "● running" : "○ idle";
      out.push({
        index: i,
        sessionId: s.id,
        label: `${p.name} / ${s.name}${branch} — ${state}`,
      });
      i += 1;
    }
  }
  return out;
}

export function renderSessionList(projects: BridgeProject[]): string {
  const rows = indexSessions(projects);
  if (rows.length === 0) return "No sessions on the desktop right now.";
  return ["Sessions:", ...rows.map((r) => `${r.index}. ${r.label}`)].join("\n");
}

/** Resolve a `/conduit use` target: an index into the last listing, or a raw id. */
export function resolveUseTarget(
  target: string,
  listing: IndexedSession[],
): string | null {
  if (/^\d+$/.test(target)) {
    return listing.find((r) => r.index === Number(target))?.sessionId ?? null;
  }
  return target.length > 0 ? target : null;
}

// ---- chat items -> Matrix content ---------------------------------------------------

export interface OutboundMessage {
  /** m.text = a chat bubble (pushes); m.notice = ambient bot chatter. */
  msgtype: "m.text" | "m.notice";
  body: string;
}

/** One tool event -> a compact activity line. */
export function renderEvent(item: Extract<ChatItem, { kind: "event" }>): string {
  const mono = item.mono ? ` \`${truncate(item.mono, 120)}\`` : "";
  return `⚙ ${item.label}${mono}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * A drained batch of chat items -> outbound Matrix messages. Assistant bubbles are
 * standalone m.text; consecutive tool events coalesce into one m.notice; desktop-
 * typed user bubbles become notices UNLESS they echo a prompt this adapter sent
 * (`wasOwnPrompt` — dedup so the phone doesn't see its own message twice).
 */
export function renderChatBatch(
  items: ChatItem[],
  wasOwnPrompt: (text: string) => boolean,
): OutboundMessage[] {
  const out: OutboundMessage[] = [];
  let events: string[] = [];
  const flushEvents = () => {
    if (events.length > 0) {
      out.push({ msgtype: "m.notice", body: events.join("\n") });
      events = [];
    }
  };
  for (const item of items) {
    if (item.kind === "event") {
      events.push(renderEvent(item));
      continue;
    }
    flushEvents();
    if (item.kind === "usage") continue; // dropped in v1
    if (item.role === "assistant") {
      out.push({ msgtype: "m.text", body: item.text });
    } else if (!wasOwnPrompt(item.text)) {
      out.push({ msgtype: "m.notice", body: `💻 typed on desktop: ${item.text}` });
    }
  }
  flushEvents();
  return out;
}

/** Remembers prompts the adapter sent so their transcript echoes can be skipped. */
export class PromptEcho {
  private sent: { text: string; at: number }[] = [];
  constructor(private windowMs = 60_000) {}

  record(text: string, now = Date.now()): void {
    this.sent.push({ text, at: now });
    if (this.sent.length > 50) this.sent.shift();
  }

  /** True once per recorded prompt (consumed on match). */
  matches(text: string, now = Date.now()): boolean {
    const i = this.sent.findIndex(
      (s) => s.text === text && now - s.at <= this.windowMs,
    );
    if (i === -1) return false;
    this.sent.splice(i, 1);
    return true;
  }
}
