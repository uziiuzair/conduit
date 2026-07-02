import type { ChatItem } from "../data/types";
import {
  appendAssistantReply,
  appendPrompt,
  groupFeed,
  pendingApproval,
  resolveApproval,
} from "./feed";

describe("appendPrompt", () => {
  it("appends a trimmed user bubble", () => {
    const out = appendPrompt([], "  hello  ", "u-1");
    expect(out).toEqual([{ kind: "bubble", id: "u-1", role: "user", text: "hello" }]);
  });
  it("ignores empty/whitespace prompts", () => {
    expect(appendPrompt([], "   ", "u-9")).toEqual([]);
  });
  it("does not mutate the input array", () => {
    const input: ChatItem[] = [];
    appendPrompt(input, "x", "u-2");
    expect(input).toEqual([]);
  });
});

describe("appendAssistantReply", () => {
  it("appends an assistant bubble", () => {
    expect(appendAssistantReply([], "on it", "a-1")).toEqual([
      { kind: "bubble", id: "a-1", role: "assistant", text: "on it" },
    ]);
  });
});

describe("resolveApproval", () => {
  const feed: ChatItem[] = [
    { kind: "bubble", id: "u", role: "user", text: "hi" },
    { kind: "approval", id: "ap-1", tool: "Bash", input: "rm -rf x" },
  ];
  it("marks the matching approval allowed/denied", () => {
    expect(resolveApproval(feed, "ap-1", "allow")[1]).toMatchObject({ resolved: "allow" });
    expect(resolveApproval(feed, "ap-1", "deny")[1]).toMatchObject({ resolved: "deny" });
  });
  it("leaves other items untouched", () => {
    expect(resolveApproval(feed, "ap-1", "allow")[0]).toEqual(feed[0]);
  });
  it("is a no-op for unknown ids", () => {
    expect(resolveApproval(feed, "nope", "allow")).toEqual(feed);
  });
});

describe("pendingApproval", () => {
  it("finds the first unresolved approval", () => {
    const feed: ChatItem[] = [
      { kind: "approval", id: "ap-1", tool: "Bash", input: "a", resolved: "allow" },
      { kind: "approval", id: "ap-2", tool: "Bash", input: "b" },
    ];
    expect(pendingApproval(feed)?.id).toBe("ap-2");
  });
  it("returns null when all are resolved", () => {
    const feed: ChatItem[] = [{ kind: "approval", id: "ap-1", tool: "Bash", input: "a", resolved: "deny" }];
    expect(pendingApproval(feed)).toBeNull();
  });
});

describe("groupFeed", () => {
  it("collapses consecutive events onto one rail and keeps others standalone", () => {
    const feed: ChatItem[] = [
      { kind: "bubble", id: "u", role: "user", text: "go" },
      { kind: "event", id: "e1", event: "read", label: "read", mono: "a.ts" },
      { kind: "event", id: "e2", event: "bash", label: "ran", mono: "npm test" },
      { kind: "approval", id: "ap", tool: "Bash", input: "rm" },
    ];
    const rows = groupFeed(feed);
    expect(rows.map((r) => r.type)).toEqual(["item", "events", "item"]);
    const eventsRow = rows[1];
    if (eventsRow.type !== "events") throw new Error("expected events row");
    expect(eventsRow.events).toHaveLength(2);
  });
});
