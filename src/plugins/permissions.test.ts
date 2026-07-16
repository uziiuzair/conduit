import { describe, it, expect } from "vitest";
import { permissionForMethod, permissionForEvent, describe as describePerm } from "./permissions";

describe("permissions", () => {
  it("maps host methods to their required permission", () => {
    expect(permissionForMethod("notify")).toBe("notifications");
    expect(permissionForMethod("clipboard.write")).toBe("clipboard:write");
    expect(permissionForMethod("unknown.method")).toBeNull();
  });

  it("maps events to their required permission", () => {
    expect(permissionForEvent("session.start")).toBe("hooks:session");
    expect(permissionForEvent("fleet.spawn")).toBe("hooks:fleet");
    expect(permissionForEvent("lifecycle.stop")).toBe("hooks:lifecycle");
    expect(permissionForEvent("nope.nope")).toBeNull();
  });

  it("describes a permission with label + risk line", () => {
    const d = describePerm("notifications");
    expect(d.label.length).toBeGreaterThan(0);
    expect(d.riskLine.length).toBeGreaterThan(0);
  });
});
