import { describe, expect, it } from "vitest";
import { eventInWindow, inProfile, normalizeProfileId } from "./profiles";

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

describe("eventInWindow", () => {
  it("same profile matches", () => {
    expect(eventInWindow("work", "work", known)).toBe(true);
  });
  it("cross profile does not match", () => {
    expect(eventInWindow("work", "stream", known)).toBe(false);
  });
  it("a dangling item id matches the Default window", () => {
    expect(eventInWindow("deleted-profile", null, known)).toBe(true);
  });
  it("a dangling window id matches Default items", () => {
    expect(eventInWindow(null, "deleted-profile" as string, known)).toBe(true);
  });
});
