import { describe, expect, it } from "vitest";
import {
  appendItem,
  canSend,
  greeting,
  isRenderable,
  relativeTime,
  type ChatItem,
} from "./rootChat";

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

describe("greeting", () => {
  it("maps hours to day parts", () => {
    expect(greeting(3)).toBe("Up late");
    expect(greeting(9)).toBe("Morning");
    expect(greeting(14)).toBe("Afternoon");
    expect(greeting(20)).toBe("Evening");
    expect(greeting(23)).toBe("Night owl");
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000; // ms
  const at = (secAgo: number) => now / 1000 - secAgo;
  it("buckets seconds, minutes, hours, days", () => {
    expect(relativeTime(at(10), now)).toBe("just now");
    expect(relativeTime(at(120), now)).toBe("2m ago");
    expect(relativeTime(at(7200), now)).toBe("2h ago");
    expect(relativeTime(at(172800), now)).toBe("2d ago");
  });
});
