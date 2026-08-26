import { describe, expect, it } from "vitest";
import { appendItem, canSend, isRenderable, type ChatItem } from "./rootChat";

const bubble: ChatItem = { kind: "bubble", role: "user", text: "hi" };

describe("appendItem", () => {
  it("appends without mutating and tolerates undefined", () => {
    const first = appendItem(undefined, bubble);
    expect(first).toEqual([bubble]);
    const second = appendItem(first, { kind: "event", event: "read", label: "read" });
    expect(second).toHaveLength(2);
    expect(first).toHaveLength(1); // no mutation
  });
});

describe("isRenderable", () => {
  it("renders bubbles and events, hides usage records", () => {
    expect(isRenderable(bubble)).toBe(true);
    expect(isRenderable({ kind: "event", event: "read", label: "read" })).toBe(true);
    expect(isRenderable({ kind: "usage", inputTokens: 5 })).toBe(false);
  });
});

describe("canSend", () => {
  it("requires non-blank text and no running turn", () => {
    expect(canSend("hello", false)).toBe(true);
    expect(canSend("   ", false)).toBe(false);
    expect(canSend("hello", true)).toBe(false);
  });
});
