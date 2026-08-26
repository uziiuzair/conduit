import { describe, expect, it } from "vitest";
import { inProfile, normalizeProfileId } from "./profiles";

const known = new Set(["work", "stream"]);

describe("normalizeProfileId", () => {
  it("keeps a known id", () => {
    expect(normalizeProfileId("work", known)).toBe("work");
  });
  it("normalizes null/undefined/empty to Default", () => {
    expect(normalizeProfileId(null, known)).toBeNull();
    expect(normalizeProfileId(undefined, known)).toBeNull();
    expect(normalizeProfileId("", known)).toBeNull();
  });
  it("normalizes a dangling id to Default (nothing hidden forever)", () => {
    expect(normalizeProfileId("deleted-profile", known)).toBeNull();
  });
});

describe("inProfile", () => {
  it("Default profile shows untagged and dangling items only", () => {
    expect(inProfile(null, null, known)).toBe(true);
    expect(inProfile(undefined, null, known)).toBe(true);
    expect(inProfile("deleted-profile", null, known)).toBe(true);
    expect(inProfile("work", null, known)).toBe(false);
  });
  it("a named profile shows only its own items", () => {
    expect(inProfile("work", "work", known)).toBe(true);
    expect(inProfile("stream", "work", known)).toBe(false);
    expect(inProfile(null, "work", known)).toBe(false);
  });
  it("a dangling ACTIVE id behaves as Default", () => {
    expect(inProfile(null, "deleted-profile" as string, known)).toBe(true);
    expect(inProfile("work", "deleted-profile" as string, known)).toBe(false);
  });
});
