import { describe, expect, it } from "vitest";
import { modeLabel, nextMode } from "./permissionMode";

describe("modeLabel", () => {
  it("maps the four hook spellings", () => {
    expect(modeLabel("default")).toBe("normal");
    expect(modeLabel("acceptEdits")).toBe("auto-accept");
    expect(modeLabel("plan")).toBe("plan");
    expect(modeLabel("bypassPermissions")).toBe("bypass");
  });
  it("returns null for unknown or absent — the chip must not invent a state", () => {
    expect(modeLabel(undefined)).toBeNull();
    expect(modeLabel("someFutureMode")).toBeNull();
  });
});

describe("nextMode", () => {
  it("follows Claude's Shift+Tab cycle", () => {
    expect(nextMode("default")).toBe("acceptEdits");
    expect(nextMode("acceptEdits")).toBe("plan");
    expect(nextMode("plan")).toBe("default");
  });
  it("drops bypass and unknowns back into the cycle", () => {
    expect(nextMode("bypassPermissions")).toBe("default");
    expect(nextMode("weird")).toBe("default");
  });
});
