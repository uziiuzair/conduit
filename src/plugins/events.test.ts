import { describe, it, expect } from "vitest";
import { sanitizeHookPayload, sanitizeSession } from "./events";

describe("event sanitizers", () => {
  it("strips hook body to a safe lifecycle event (no transcript/body)", () => {
    const out = sanitizeHookPayload({ session: "s1", event: "stop", body: { prompt: "secret text" } });
    expect(out).toEqual({ event: "lifecycle.stop", session: "s1" });
    expect(JSON.stringify(out)).not.toContain("secret text");
  });

  it("maps unknown hook verbs to lifecycle.notify", () => {
    expect(sanitizeHookPayload({ session: "s1", event: "weird", body: {} }).event).toBe("lifecycle.notify");
  });

  it("reduces a session to id + title only", () => {
    const out = sanitizeSession({ id: "s1", title: "My work", secretField: "x" } as any);
    expect(out).toEqual({ id: "s1", title: "My work" });
  });
});
