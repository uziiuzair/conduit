import { describe, it, expect } from "vitest";
import { sanitizeHookPayload, sanitizeSession } from "./events";

describe("event sanitizers", () => {
  it("strips hook body to a safe lifecycle event (no transcript/body)", () => {
    const out = sanitizeHookPayload({ session: "s1", event: "stop", body: { prompt: "secret text" } });
    expect(out).toEqual({ event: "lifecycle.stop", session: "s1" });
    expect(JSON.stringify(out)).not.toContain("secret text");
  });

  it("prefix-maps hook verbs to lifecycle.<verb> and never forwards body", () => {
    expect(sanitizeHookPayload({ session: "s1", event: "sessionstart", body: {} }).event).toBe("lifecycle.sessionstart");
    const out = sanitizeHookPayload({ session: "s1", event: "tooluse", body: { secret: "x" } });
    expect(out).toEqual({ event: "lifecycle.tooluse", session: "s1" });
  });

  it("reduces a session to id + title only", () => {
    const out = sanitizeSession({ id: "s1", title: "My work", secretField: "x" } as any);
    expect(out).toEqual({ id: "s1", title: "My work" });
  });
});
