import { describe, expect, it } from "vitest";
import { supersededMap, timeAgo, truncateLine, type FeedDecision } from "./continuityFeed";

const decision = (over: Partial<FeedDecision>): FeedDecision => ({
  id: "d1",
  decisionKey: "k",
  content: "c",
  decisionType: "other",
  status: "active",
  supersedes: null,
  createdAt: "2026-08-14T01:00:00Z",
  authorLabel: null,
  ...over,
});

describe("truncateLine", () => {
  it("collapses newlines so a multi-line decision stays one row", () => {
    expect(truncateLine("first\nsecond\nthird", 80)).toBe("first second third");
  });

  it("leaves text at the limit untouched", () => {
    expect(truncateLine("abcde", 5)).toBe("abcde");
  });

  it("ellipsizes past the limit without exceeding it", () => {
    const out = truncateLine("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect(out.length).toBe(5);
  });

  it("collapses runs of whitespace", () => {
    expect(truncateLine("a    b", 80)).toBe("a b");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-08-14T12:00:00Z");

  it("reads seconds as now", () => {
    expect(timeAgo("2026-08-14T11:59:30Z", now)).toBe("now");
  });

  it("reads minutes", () => {
    expect(timeAgo("2026-08-14T11:30:00Z", now)).toBe("30m");
  });

  it("reads hours", () => {
    expect(timeAgo("2026-08-14T09:00:00Z", now)).toBe("3h");
  });

  it("reads days", () => {
    expect(timeAgo("2026-08-12T12:00:00Z", now)).toBe("2d");
  });

  it("degrades to an empty string on an unparseable timestamp", () => {
    expect(timeAgo("not a date", now)).toBe("");
  });

  it("clamps a clock-skewed future timestamp to now rather than going negative", () => {
    expect(timeAgo("2026-08-14T12:05:00Z", now)).toBe("now");
  });
});

describe("supersededMap", () => {
  it("maps a superseded decision to the one that replaced it", () => {
    const old = decision({ id: "d1", status: "superseded" });
    const next = decision({ id: "d2", supersedes: "d1" });

    const map = supersededMap([next, old]);

    expect(map.d1?.id).toBe("d2");
    expect(map.d2).toBeUndefined();
  });

  it("ignores a supersedes pointer to a decision outside the loaded page", () => {
    const next = decision({ id: "d2", supersedes: "not-loaded" });

    expect(supersededMap([next])).toEqual({});
  });
});
