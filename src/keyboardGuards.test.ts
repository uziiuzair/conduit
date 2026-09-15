import { describe, expect, it } from "vitest";
import {
  blocksGlobalShortcut,
  isEditableTarget,
  isInTerminal,
  isMacPlatform,
  tabSwitchDigit,
  type ModifierKeys,
} from "./keyboardGuards";

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

/** A keydown reduced to what `tabSwitchDigit` reads. Defaults: no modifier held. */
const key = (code: string, mods: Partial<ModifierKeys> = {}): ModifierKeys => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("isMacPlatform", () => {
  it("detects the Apple platform strings", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("iPhone")).toBe(true);
    expect(isMacPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(true);
  });

  it("is false for Windows and Linux", () => {
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
    expect(isMacPlatform("")).toBe(false);
  });
});

describe("tabSwitchDigit", () => {
  it("takes Cmd+digit on macOS and Alt+digit off it", () => {
    expect(tabSwitchDigit(key("Digit1", { metaKey: true }), true)).toBe(1);
    expect(tabSwitchDigit(key("Digit9", { altKey: true }), false)).toBe(9);
  });

  it("does NOT take the other platform's modifier", () => {
    // Alt+digit on a Mac is a meta-prefixed escape the terminal wants.
    expect(tabSwitchDigit(key("Digit1", { altKey: true }), true)).toBeNull();
    // Meta on Windows is the OS-reserved Windows key; it never reaches us as a shortcut.
    expect(tabSwitchDigit(key("Digit1", { metaKey: true }), false)).toBeNull();
  });

  it("never takes ctrl+digit on either platform", () => {
    // Ctrl+3 is ESC. Claiming it here would interrupt the running agent.
    for (const isMac of [true, false]) {
      expect(tabSwitchDigit(key("Digit3", { ctrlKey: true }), isMac)).toBeNull();
      expect(tabSwitchDigit(key("Digit3", { ctrlKey: true, metaKey: true }), isMac)).toBeNull();
      expect(tabSwitchDigit(key("Digit3", { ctrlKey: true, altKey: true }), isMac)).toBeNull();
    }
  });

  it("ignores shift, so ⇧-modified bindings stay free", () => {
    expect(tabSwitchDigit(key("Digit1", { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(tabSwitchDigit(key("Digit1", { altKey: true, shiftKey: true }), false)).toBeNull();
  });

  it("ignores Digit0 -- CmdOrCtrl+0 is the menu's zoom reset", () => {
    expect(tabSwitchDigit(key("Digit0", { metaKey: true }), true)).toBeNull();
    expect(tabSwitchDigit(key("Digit0", { altKey: true }), false)).toBeNull();
  });

  it("ignores non-digit and numpad codes", () => {
    expect(tabSwitchDigit(key("KeyA", { metaKey: true }), true)).toBeNull();
    expect(tabSwitchDigit(key("Numpad1", { altKey: true }), false)).toBeNull();
  });

  it("requires a modifier -- a bare digit is typing", () => {
    expect(tabSwitchDigit(key("Digit1"), true)).toBeNull();
    expect(tabSwitchDigit(key("Digit1"), false)).toBeNull();
  });
});
