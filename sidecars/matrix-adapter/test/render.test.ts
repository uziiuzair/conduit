import { describe, expect, it } from "vitest";
import type { BridgeProject } from "../src/protocol.js";
import {
  estimateCostUsd,
  indexSessions,
  parseCommand,
  PromptEcho,
  renderChanges,
  renderChatBatch,
  renderSessionList,
  renderTodos,
  resolveUseTarget,
} from "../src/render.js";
import type { TodoItem } from "../src/protocol.js";

const PROJECTS: BridgeProject[] = [
  {
    id: "p1",
    name: "Conduit",
    path: "/repo",
    sessions: [
      { id: "s1", name: "auth", branch: "feat/x", running: true },
      { id: "s2", name: "docs", branch: null, running: false },
    ],
  },
  {
    id: "p2",
    name: "Badger",
    path: "/other",
    sessions: [{ id: "s3", name: "api", branch: "main", running: true }],
  },
];

describe("parseCommand", () => {
  it("parses the command set case-insensitively", () => {
    expect(parseCommand("/conduit list")).toEqual({ cmd: "list" });
    expect(parseCommand("/CONDUIT USE 3")).toEqual({ cmd: "use", target: "3" });
    expect(parseCommand("/conduit use sess-abc")).toEqual({ cmd: "use", target: "sess-abc" });
    expect(parseCommand("/conduit detach")).toEqual({ cmd: "detach" });
    expect(parseCommand("/conduit")).toEqual({ cmd: "help" });
    expect(parseCommand("/conduit bogus")).toEqual({ cmd: "help" });
  });

  it("parses the Phase-1 control verbs", () => {
    expect(parseCommand("/conduit stop")).toEqual({ cmd: "stop" });
    expect(parseCommand("/conduit key esc")).toEqual({ cmd: "key", key: "esc" });
    expect(parseCommand("/conduit send npm run build")).toEqual({
      cmd: "send",
      text: "npm run build",
    });
  });

  it("parses the Phase-2 awareness verbs", () => {
    expect(parseCommand("/conduit todos")).toEqual({ cmd: "todos" });
    expect(parseCommand("/conduit watch")).toEqual({ cmd: "watch", on: true });
    expect(parseCommand("/conduit watch on")).toEqual({ cmd: "watch", on: true });
    expect(parseCommand("/conduit watch off")).toEqual({ cmd: "watch", on: false });
  });

  it("parses the Phase-5 diff-review verbs", () => {
    expect(parseCommand("/conduit changes")).toEqual({ cmd: "changes" });
    expect(parseCommand("/conduit diff src/store.ts")).toEqual({
      cmd: "diff",
      path: "src/store.ts",
    });
  });

  it("parses the Phase-3 lifecycle verbs", () => {
    expect(parseCommand("/conduit kill")).toEqual({ cmd: "kill" });
    expect(parseCommand("/conduit new fix the checkout bug")).toEqual({
      cmd: "new",
      prompt: "fix the checkout bug",
    });
  });

  it("treats non-commands and /bot as not-ours", () => {
    expect(parseCommand("fix the tests")).toBeNull();
    expect(parseCommand("/bot list")).toBeNull();
  });
});

describe("session listing", () => {
  it("indexes sessions across projects with running flags", () => {
    const rows = indexSessions(PROJECTS);
    expect(rows.map((r) => r.sessionId)).toEqual(["s1", "s2", "s3"]);
    expect(rows[0].label).toContain("Conduit / auth (feat/x)");
    expect(rows[0].label).toContain("running");
    expect(rows[1].label).toContain("idle");
    expect(renderSessionList(PROJECTS)).toContain("1. Conduit / auth");
    expect(renderSessionList([])).toContain("No sessions");
  });

  it("resolves use-targets by index or raw id", () => {
    const rows = indexSessions(PROJECTS);
    expect(resolveUseTarget("3", rows)).toBe("s3");
    expect(resolveUseTarget("9", rows)).toBeNull();
    expect(resolveUseTarget("some-session-id", rows)).toBe("some-session-id");
  });
});

describe("renderChatBatch", () => {
  it("assistant bubbles are m.text, tool events coalesce into one notice", () => {
    const out = renderChatBatch(
      [
        { kind: "event", event: "bash", label: "ran", mono: "npm test" },
        { kind: "event", event: "edit", label: "edited", mono: "src/store.ts" },
        { kind: "bubble", role: "assistant", text: "Done — tests pass." },
      ],
      () => false,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      msgtype: "m.notice",
      body: "⚙ ran `npm test`\n⚙ edited `src/store.ts`",
    });
    expect(out[1]).toEqual({ msgtype: "m.text", body: "Done — tests pass." });
  });

  it("desktop-typed user bubbles become notices; own prompts are suppressed", () => {
    const out = renderChatBatch(
      [
        { kind: "bubble", role: "user", text: "from the phone" },
        { kind: "bubble", role: "user", text: "typed at the desk" },
      ],
      (t) => t === "from the phone",
    );
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain("typed at the desk");
    expect(out[0].msgtype).toBe("m.notice");
  });

  it("drops usage items", () => {
    const out = renderChatBatch(
      [
        {
          kind: "usage",
          model: "m",
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheCreationTokens: 4,
        },
      ],
      () => false,
    );
    expect(out).toHaveLength(0);
  });
});

describe("renderTodos", () => {
  it("renders a checklist with progress and in-progress activeForm", () => {
    const todos: TodoItem[] = [
      { content: "Write parser", status: "completed" },
      { content: "Wire relay", status: "in_progress", activeForm: "Wiring the relay" },
      { content: "Add tests", status: "pending" },
    ];
    const out = renderTodos(todos);
    expect(out).toContain("Plan (1/3 done):");
    expect(out).toContain("✅ Write parser");
    expect(out).toContain("🔄 Wiring the relay");
    expect(out).toContain("⬜ Add tests");
    expect(renderTodos([])).toContain("No plan yet");
  });
});

describe("renderChanges", () => {
  it("summarizes changed files with counts", () => {
    const out = renderChanges([
      { status: "M", path: "src/a.ts", added: 5, removed: 2 },
      { status: "A", path: "b.ts", added: 10, removed: 0 },
    ]);
    expect(out).toContain("Changed files (2):");
    expect(out).toContain("M  src/a.ts +5 -2");
    expect(out).toContain("A  b.ts +10");
    expect(renderChanges([])).toBe("No changes against HEAD.");
  });
});

describe("estimateCostUsd", () => {
  it("is zero for no usage and grows with output tokens", () => {
    expect(estimateCostUsd({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })).toBe(0);
    const a = estimateCostUsd({ input: 1000, output: 0, cacheRead: 0, cacheCreation: 0 });
    const b = estimateCostUsd({ input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 });
    expect(b).toBeGreaterThan(a);
  });
});

describe("PromptEcho", () => {
  it("matches each recorded prompt once, within the window", () => {
    const echo = new PromptEcho(1000);
    echo.record("hello", 0);
    expect(echo.matches("hello", 500)).toBe(true);
    expect(echo.matches("hello", 600)).toBe(false); // consumed
    echo.record("late", 0);
    expect(echo.matches("late", 5000)).toBe(false); // window expired
  });
});
