import { describe, expect, it } from "vitest";
import { blocksGlobalShortcut, isEditableTarget, isInTerminal } from "./keyboardGuards";

/** A fake DOM target: `closest` reports a match only for the selectors listed as hitting. */
const fakeTarget = (opts: { termHost?: boolean; editable?: boolean }): EventTarget =>
  ({
    closest: (selector: string) => {
      if (selector === ".term-host") return opts.termHost ? ({} as Element) : null;
      if (selector.startsWith("textarea")) return opts.editable ? ({} as Element) : null;
      return null;
    },
  }) as unknown as EventTarget;

describe("isInTerminal", () => {
  it("is true only when the target sits inside .term-host", () => {
    expect(isInTerminal(fakeTarget({ termHost: true }))).toBe(true);
    expect(isInTerminal(fakeTarget({}))).toBe(false);
  });

  it("is false for a null target", () => {
    expect(isInTerminal(null)).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("is true only when the target sits inside an editable field", () => {
    expect(isEditableTarget(fakeTarget({ editable: true }))).toBe(true);
    expect(isEditableTarget(fakeTarget({}))).toBe(false);
  });

  it("is false for a null target", () => {
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("blocksGlobalShortcut", () => {
  it("blocks for either a terminal or an editable target", () => {
    expect(blocksGlobalShortcut(fakeTarget({ termHost: true }))).toBe(true);
    expect(blocksGlobalShortcut(fakeTarget({ editable: true }))).toBe(true);
    expect(blocksGlobalShortcut(fakeTarget({}))).toBe(false);
  });

  it("does not block a target with no closest at all (e.g. window itself)", () => {
    expect(blocksGlobalShortcut({} as EventTarget)).toBe(false);
  });
});
