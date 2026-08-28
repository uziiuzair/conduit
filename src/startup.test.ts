import { describe, expect, it } from "vitest";
import { initialProjectSelection } from "./startup";

const IDS = ["p-alpha", "p-beta", "p-gamma"];

describe("initialProjectSelection", () => {
  it("reopens the project you were last on, not the topmost one", () => {
    expect(initialProjectSelection(IDS, "last", "p-gamma")).toBe("p-gamma");
  });

  it("opens nothing when the remembered project is gone", () => {
    // Deleted, or removed from Conduit on another machine. Silently opening a DIFFERENT
    // project (and spawning its sessions) is the failure mode being fixed, so this is a
    // deliberate null rather than a fallback to projects[0].
    expect(initialProjectSelection(IDS, "last", "p-deleted")).toBeNull();
  });

  it("opens nothing on a first launch with no memory", () => {
    expect(initialProjectSelection(IDS, "last", null)).toBeNull();
    expect(initialProjectSelection(IDS, "last", "")).toBeNull();
  });

  it("opens nothing when asked to, even with a valid memory", () => {
    expect(initialProjectSelection(IDS, "none", "p-beta")).toBeNull();
  });

  it("survives an empty project list", () => {
    expect(initialProjectSelection([], "last", "p-alpha")).toBeNull();
    expect(initialProjectSelection([], "none", null)).toBeNull();
  });
});
