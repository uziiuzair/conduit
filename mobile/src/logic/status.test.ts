import type { Agent } from "../data/types";
import {
  agentBadge,
  agentSubline,
  basename,
  eventKindFor,
  needsCount,
  statusDot,
  toolActivity,
} from "./status";

const mk = (over: Partial<Agent>): Agent => ({
  id: "a",
  name: "agent",
  branch: "main",
  kind: "claude",
  status: "idle",
  ...over,
});

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("src/auth/login.ts")).toBe("login.ts");
    expect(basename("file.ts")).toBe("file.ts");
  });
});

describe("toolActivity", () => {
  it("maps edit-family tools to 'Editing <file>'", () => {
    expect(toolActivity("Edit", { file_path: "src/store.ts" })).toBe("Editing store.ts");
    expect(toolActivity("Write", { file_path: "a/b.ts" })).toBe("Editing b.ts");
    expect(toolActivity("Edit")).toBe("Editing a file");
  });
  it("maps Read / Bash / search / Task / web", () => {
    expect(toolActivity("Read", { file_path: "x/y.ts" })).toBe("Reading y.ts");
    expect(toolActivity("Bash", { command: "ls" })).toBe("Running a command");
    expect(toolActivity("Grep")).toBe("Searching the code");
    expect(toolActivity("Task")).toBe("Running a subagent");
    expect(toolActivity("WebFetch")).toBe("Browsing the web");
  });
  it("falls back to the raw tool name", () => {
    expect(toolActivity("SomeMcpTool")).toBe("SomeMcpTool");
  });
});

describe("eventKindFor", () => {
  it("buckets tools into timeline kinds", () => {
    expect(eventKindFor("Read")).toBe("read");
    expect(eventKindFor("Bash")).toBe("bash");
    expect(eventKindFor("MultiEdit")).toBe("edit");
    expect(eventKindFor("Glob")).toBe("search");
    expect(eventKindFor("Task")).toBe("subagent");
    expect(eventKindFor("Mystery")).toBe("generic");
  });
});

describe("statusDot", () => {
  it("derives the dot kind from status", () => {
    expect(statusDot(mk({ status: "needsInput" }))).toBe("needs");
    expect(statusDot(mk({ status: "running" }))).toBe("running");
    expect(statusDot(mk({ status: "done" }))).toBe("done");
    expect(statusDot(mk({ status: "idle" }))).toBe("idle");
  });
});

describe("agentSubline", () => {
  it("prefers the attention line when needing input", () => {
    expect(agentSubline(mk({ status: "needsInput", attention: "approval · Bash" }))).toBe(
      "approval · Bash",
    );
  });
  it("shows compacting over running activity", () => {
    expect(agentSubline(mk({ status: "running", compacting: true, activity: "Editing x" }))).toBe(
      "compacting…",
    );
  });
  it("shows activity while running, done timing, and idle", () => {
    expect(agentSubline(mk({ status: "running", activity: "Editing store.ts" }))).toBe(
      "Editing store.ts",
    );
    expect(agentSubline(mk({ status: "done", doneAgo: "3m ago" }))).toBe("done · finished 3m ago");
    expect(agentSubline(mk({ status: "idle" }))).toBe("idle");
  });
});

describe("needsCount", () => {
  it("counts agents awaiting the human", () => {
    expect(
      needsCount([mk({ status: "needsInput" }), mk({ status: "running" }), mk({ status: "needsInput" })]),
    ).toBe(2);
  });
});

describe("agentBadge", () => {
  it("maps kind to a single letter", () => {
    expect(agentBadge("claude")).toBe("C");
    expect(agentBadge("codex")).toBe("X");
    expect(agentBadge("gemini")).toBe("G");
  });
});
