import { mapChatItem, mapProjects, statusPatch } from "./live";
import type { WireChatItem, WireProject } from "./protocol";

describe("mapChatItem", () => {
  it("maps a user bubble", () => {
    const w: WireChatItem = { kind: "bubble", role: "user", text: "hi" };
    expect(mapChatItem(w)).toMatchObject({ kind: "bubble", role: "user", text: "hi" });
  });
  it("maps a tool event, defaulting unknown kinds to generic", () => {
    expect(mapChatItem({ kind: "event", event: "bash", label: "ran", mono: "npm test" })).toMatchObject({
      kind: "event",
      event: "bash",
      label: "ran",
      mono: "npm test",
    });
    expect(mapChatItem({ kind: "event", event: "weird", label: "did" })).toMatchObject({ event: "generic" });
  });
  it("assigns an id", () => {
    expect(mapChatItem({ kind: "bubble", role: "assistant", text: "yo" }).id).toBeTruthy();
  });
});

describe("mapProjects", () => {
  it("maps wire projects to UI projects with running→status", () => {
    const wire: WireProject[] = [
      {
        id: "p1",
        name: "Conduit",
        path: "/repo",
        sessions: [
          { id: "s1", name: "auth", branch: "feat/x", agent: "claude", running: true },
          { id: "s2", name: "idle-one", branch: null, agent: "codex", running: false },
        ],
      },
    ];
    const out = mapProjects(wire);
    expect(out[0]).toMatchObject({ id: "p1", name: "Conduit", path: "/repo" });
    expect(out[0].agents[0]).toMatchObject({ id: "s1", name: "auth", branch: "feat/x", kind: "claude", status: "running" });
    expect(out[0].agents[1]).toMatchObject({ id: "s2", branch: "", kind: "codex", status: "idle" });
  });
});

describe("statusPatch", () => {
  it("prompt → running and clears activity", () => {
    expect(statusPatch("prompt", {})).toMatchObject({ status: "running", clearActivity: true });
  });
  it("pretool → running with activity label", () => {
    expect(statusPatch("pretool", { tool_name: "Edit", tool_input: { file_path: "src/x.ts" } })).toMatchObject({
      status: "running",
      activity: "Editing x.ts",
    });
  });
  it("todos → progress, running when any in_progress", () => {
    const body = { tool_input: { todos: [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }] } };
    expect(statusPatch("todos", body)).toMatchObject({ todos: { done: 1, total: 3 }, status: "running" });
  });
  it("stop → done, notification → needsInput, sessionend → idle", () => {
    expect(statusPatch("stop", {})).toMatchObject({ status: "done" });
    expect(statusPatch("notification", { message: "needs you" })).toMatchObject({ status: "needsInput" });
    expect(statusPatch("sessionend", {})).toMatchObject({ status: "idle" });
  });
  it("unknown verb → empty patch", () => {
    expect(statusPatch("mystery", {})).toEqual({});
  });
});
