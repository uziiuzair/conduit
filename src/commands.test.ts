import { describe, expect, it } from "vitest";
import { type Command, corpus, rankCommands } from "./commands";

const cmd = (id: string, label: string, extra: Partial<Command> = {}): Command => ({
  id,
  label,
  run: () => {},
  ...extra,
});

const ids = (cs: Command[]) => cs.map((c) => c.id);

describe("corpus", () => {
  it("includes a searchable hint and never a note", () => {
    expect(corpus(cmd("a", "New Session", { hint: "conduit" }))).toBe("New Session conduit");
    expect(corpus(cmd("b", "New Worktree", { note: "not supported on SSH projects" }))).toBe(
      "New Worktree",
    );
  });
});

describe("rankCommands", () => {
  const list = [
    cmd("new", "New Session"),
    cmd("board", "Toggle Board"),
    cmd("canvas", "Toggle Canvas"),
    cmd("settings", "Open Settings"),
  ];

  it("leaves the curated order alone when there is no query", () => {
    expect(ids(rankCommands("", list, 10))).toEqual(["new", "board", "canvas", "settings"]);
    expect(ids(rankCommands("   ", list, 10))).toEqual(["new", "board", "canvas", "settings"]);
  });

  it("matches a subsequence, not just a prefix", () => {
    // "tgcv" → To(g)gle (C)an(v)as
    expect(ids(rankCommands("tgcv", list, 10))).toEqual(["canvas"]);
    expect(ids(rankCommands("nsess", list, 10))).toEqual(["new"]);
  });

  it("drops commands the query cannot match at all", () => {
    expect(rankCommands("zzzz", list, 10)).toEqual([]);
  });

  it("honors the limit", () => {
    expect(rankCommands("o", list, 2)).toHaveLength(2);
  });

  it("finds a command through its searchable hint", () => {
    const withHint = [cmd("s1", "Switch to Session", { hint: "api-refactor" })];
    expect(ids(rankCommands("refactor", withHint, 10))).toEqual(["s1"]);
  });

  it("never lets a note answer a query", () => {
    // The bug this guards: a disabled row explaining itself with "not supported on SSH
    // projects" started coming back for "ssh", which is not what the row does.
    const withNote = [
      cmd("wt", "New Worktree", { note: "not supported on SSH projects" }),
      cmd("ssh", "Open SSH Project"),
    ];
    expect(ids(rankCommands("ssh", withNote, 10))).toEqual(["ssh"]);
  });

  it("still surfaces a disabled command so its reason can be read", () => {
    const withDisabled = [cmd("wt", "New Worktree", { disabled: true, note: "no git repo" })];
    expect(ids(rankCommands("worktree", withDisabled, 10))).toEqual(["wt"]);
  });

  it("breaks score ties by the curated order", () => {
    const tied = [cmd("a", "Toggle Alpha"), cmd("b", "Toggle Bravo")];
    expect(ids(rankCommands("toggle", tied, 10))).toEqual(["a", "b"]);
    expect(ids(rankCommands("toggle", [tied[1], tied[0]], 10))).toEqual(["b", "a"]);
  });
});
