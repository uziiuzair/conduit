import { describe, expect, it } from "vitest";
import { matchProjectByPath } from "./cliOpen";

const projects = [
  { id: "a", path: "/Users/u/code/alpha" },
  { id: "b", path: "/Users/u/code/beta/" },
];

describe("matchProjectByPath", () => {
  it("finds an exact match", () => {
    expect(matchProjectByPath(projects, "/Users/u/code/alpha")).toBe("a");
  });

  it("ignores a trailing slash on either side", () => {
    expect(matchProjectByPath(projects, "/Users/u/code/alpha/")).toBe("a");
    expect(matchProjectByPath(projects, "/Users/u/code/beta")).toBe("b");
  });

  it("returns null when nothing matches, so the caller adds the project", () => {
    expect(matchProjectByPath(projects, "/Users/u/code/gamma")).toBeNull();
  });

  it("does not treat a prefix as a match", () => {
    expect(matchProjectByPath(projects, "/Users/u/code/alpha-2")).toBeNull();
    expect(matchProjectByPath(projects, "/Users/u/code")).toBeNull();
  });

  it("never matches an empty path", () => {
    expect(matchProjectByPath(projects, "")).toBeNull();
    expect(matchProjectByPath(projects, "/")).toBeNull();
  });

  it("compares Windows paths case-insensitively and normalizes separators", () => {
    const win = [{ id: "w", path: "C:\\Users\\u\\Code\\Alpha" }];
    expect(matchProjectByPath(win, "c:/users/u/code/alpha")).toBe("w");
  });
});
