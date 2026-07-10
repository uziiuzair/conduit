import { describe, expect, it } from "vitest";
import type { BridgeProject } from "../src/protocol.js";
import {
  indexSessions,
  parseCommand,
  PromptEcho,
  renderChatBatch,
  renderSessionList,
  resolveUseTarget,
} from "../src/render.js";

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
