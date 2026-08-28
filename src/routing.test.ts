import { describe, expect, it } from "vitest";
import { pickTarget, type AvailabilityMap, type Chain } from "./routing";

/** The threshold the usage bar defaults to (10% left). */
const T = 0.1;

const ok = (remaining: number | null = null) => ({ installed: true, remaining });
const missing = { installed: false, remaining: null };

const CHAIN: Chain = [
  { agent: "claude", model: "haiku" },
  { agent: "commandcode", model: "claude-haiku-4-5" },
  { agent: "opencode" },
];

describe("pickTarget", () => {
  it("takes the first choice when it is available", () => {
    const avail: AvailabilityMap = { claude: ok(0.8) };
    const d = pickTarget(CHAIN, avail, T);
    expect(d.target).toEqual({ agent: "claude", model: "haiku" });
    expect(d.fellBack).toBe(false);
    expect(d.exhausted).toBe(false);
  });

  it("skips an agent that is not installed, and says so", () => {
    const avail: AvailabilityMap = { claude: missing, commandcode: ok(0.9) };
    const d = pickTarget(CHAIN, avail, T);
    expect(d.target?.agent).toBe("commandcode");
    expect(d.fellBack).toBe(true);
    // The reason has to name the thing that was skipped — a fallback the user can't
    // explain reads as the router ignoring their settings.
    expect(d.reason).toContain("claude isn't installed");
    expect(d.exhausted).toBe(false);
  });

  it("falls back past an agent that is out of quota", () => {
    const avail: AvailabilityMap = { claude: ok(0.05), commandcode: ok(0.7) };
    const d = pickTarget(CHAIN, avail, T);
    expect(d.target?.agent).toBe("commandcode");
    expect(d.reason).toContain("claude is low on quota");
  });

  it("treats unknown quota as available, never as exhausted", () => {
    // The distinction that matters most here. agy and OpenCode have no usage API at all,
    // and Command Code's can fail to answer — routing away from a working agent because a
    // meter didn't load would be a silent, permanent misroute.
    const avail: AvailabilityMap = { claude: ok(null) };
    const d = pickTarget(CHAIN, avail, T);
    expect(d.target?.agent).toBe("claude");
    expect(d.exhausted).toBe(false);
  });

  it("treats an unprobed agent as present", () => {
    // An empty availability map is what the first render has before any probe returns.
    const d = pickTarget(CHAIN, {}, T);
    expect(d.target?.agent).toBe("claude");
    expect(d.fellBack).toBe(false);
  });

  it("still picks something when everything is low, and flags it", () => {
    // A low meter is not a reason to refuse to start work: extra credits, an imminent
    // reset, or a plan change all make it wrong in the user's favour.
    const avail: AvailabilityMap = {
      claude: ok(0.01),
      commandcode: ok(0),
      opencode: ok(0.02),
    };
    const d = pickTarget(CHAIN, avail, T);
    expect(d.target?.agent).toBe("claude");
    expect(d.exhausted).toBe(true);
    expect(d.reason).toContain("low on quota");
  });

  it("prefers an installed exhausted agent over an uninstalled one", () => {
    const avail: AvailabilityMap = { claude: missing, commandcode: ok(0), opencode: missing };
    const d = pickTarget(CHAIN, avail, T);
    expect(d.target?.agent).toBe("commandcode");
    expect(d.exhausted).toBe(true);
    expect(d.fellBack).toBe(true);
  });

  it("returns nothing when no agent in the chain is installed", () => {
    const avail: AvailabilityMap = {
      claude: missing,
      commandcode: missing,
      opencode: missing,
    };
    const d = pickTarget(CHAIN, avail, T);
    expect(d.target).toBeNull();
    expect(d.reason).toContain("installed");
  });

  it("handles an absent or empty chain without inventing a target", () => {
    const empty: Chain = [];
    for (const chain of [undefined, empty]) {
      const d = pickTarget(chain, {}, T);
      expect(d.target).toBeNull();
      expect(d.exhausted).toBe(false);
    }
  });

  it("uses the threshold it is given", () => {
    const avail: AvailabilityMap = { claude: ok(0.2), commandcode: ok(0.9) };
    // At a 10% threshold, 20% left is fine...
    expect(pickTarget(CHAIN, avail, 0.1).target?.agent).toBe("claude");
    // ...and at a 30% one it is not. One number drives both the meter warning and the
    // reroute, so they can never disagree about what "low" means.
    expect(pickTarget(CHAIN, avail, 0.3).target?.agent).toBe("commandcode");
  });

  it("treats exactly-at-threshold as low", () => {
    // `<=`, not `<`: a meter reading exactly the warning level is already the state the
    // user asked to be warned about.
    const avail: AvailabilityMap = { claude: ok(0.1), commandcode: ok(0.9) };
    expect(pickTarget(CHAIN, avail, 0.1).target?.agent).toBe("commandcode");
  });

  it("carries the model, not just the agent", () => {
    const avail: AvailabilityMap = { claude: ok(0.05), commandcode: ok(0.9) };
    const d = pickTarget(CHAIN, avail, T);
    expect(d.target?.model).toBe("claude-haiku-4-5");
    // A target with no model means "leave the agent's own choice alone", and must not
    // acquire one from the previous link in the chain.
    const last = pickTarget([{ agent: "opencode" }], {}, T);
    expect(last.target?.model).toBeUndefined();
  });
});
