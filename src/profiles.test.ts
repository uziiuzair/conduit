import { describe, expect, it } from "vitest";
import {
  eventInThisWindow,
  eventInWindow,
  inProfile,
  mountedInWindow,
  normalizeProfileId,
} from "./profiles";

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

describe("mountedInWindow", () => {
  it("switch mode (windowed=false) mounts every project, regardless of profile", () => {
    expect(mountedInWindow({ profileId: "work" }, false, null, known)).toBe(true);
    expect(mountedInWindow({ profileId: "stream" }, false, "work", known)).toBe(true);
    expect(mountedInWindow({ profileId: null }, false, "work", known)).toBe(true);
    expect(mountedInWindow({}, false, "work", known)).toBe(true);
  });
  it("window mode (windowed=true) mounts only this window's own profile", () => {
    expect(mountedInWindow({ profileId: "work" }, true, "work", known)).toBe(true);
    expect(mountedInWindow({ profileId: "stream" }, true, "work", known)).toBe(false);
    expect(mountedInWindow({ profileId: null }, true, null, known)).toBe(true);
    expect(mountedInWindow({}, true, null, known)).toBe(true);
    expect(mountedInWindow({ profileId: "work" }, true, null, known)).toBe(false);
  });
  it("window mode normalizes a dangling project profile id to Default", () => {
    expect(mountedInWindow({ profileId: "deleted-profile" }, true, null, known)).toBe(true);
    expect(mountedInWindow({ profileId: "deleted-profile" }, true, "work", known)).toBe(false);
  });
  it("window mode normalizes a dangling window profile id to Default", () => {
    expect(
      mountedInWindow({ profileId: null }, true, "deleted-profile" as string, known),
    ).toBe(true);
    expect(
      mountedInWindow({ profileId: "work" }, true, "deleted-profile" as string, known),
    ).toBe(false);
  });
});

describe("eventInThisWindow", () => {
  it("switch mode (windowed=false) always returns true, regardless of ids", () => {
    expect(eventInThisWindow(false, "work", "stream", known)).toBe(true);
    expect(eventInThisWindow(false, null, "work", known)).toBe(true);
    expect(eventInThisWindow(false, "deleted-profile", "work", known)).toBe(true);
  });
  it("window mode (windowed=true) delegates to eventInWindow", () => {
    expect(eventInThisWindow(true, "work", "work", known)).toBe(true);
    expect(eventInThisWindow(true, "work", "stream", known)).toBe(false);
    expect(eventInThisWindow(true, null, "work", known)).toBe(false);
    expect(eventInThisWindow(true, null, null, known)).toBe(true);
  });
  it("window mode normalizes a dangling id (item or window) to Default", () => {
    expect(eventInThisWindow(true, "deleted-profile", null, known)).toBe(true);
    expect(eventInThisWindow(true, null, "deleted-profile" as string, known)).toBe(true);
    expect(eventInThisWindow(true, "work", "deleted-profile" as string, known)).toBe(false);
  });
});
