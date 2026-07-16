import { describe, it, expect } from "vitest";
import { checkGrant, checkEventGrant } from "./gate";

describe("permission gate", () => {
  it("allows a method only when its permission is granted", () => {
    expect(checkGrant(["notifications"], "notify")).toBe(true);
    expect(checkGrant([], "notify")).toBe(false);
    expect(checkGrant(["hooks:session"], "notify")).toBe(false);
  });

  it("rejects unknown methods regardless of grants", () => {
    expect(checkGrant(["notifications", "net"], "delete.everything")).toBe(false);
  });

  it("filters event delivery by grant", () => {
    expect(checkEventGrant(["hooks:session"], "session.stop")).toBe(true);
    expect(checkEventGrant(["hooks:fleet"], "session.stop")).toBe(false);
  });
});
