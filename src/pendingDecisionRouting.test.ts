import { describe, expect, it } from "vitest";
import { decisionRoute } from "./pendingDecisionRouting";
import type { AvailabilityMap } from "./routing";
import type { RoutesView } from "./routing";

const T = 0.1;
const ok = (remaining: number | null = null) => ({ installed: true, remaining });
const missing = { installed: false, remaining: null };

const routesWith = (chain: RoutesView["effective"]["implementation"]): RoutesView => ({
  effective: { implementation: chain },
  defaults: {},
  global: {},
  project: {},
});

describe("decisionRoute — chat-named agent", () => {
  it("disables when the named agent is not installed", () => {
    // This is the bug the review caught: a free-text agent from the proposal must get
    // the same availability test as a routed target, not a bypass.
    const avail: AvailabilityMap = { commandcode: missing };
    const r = decisionRoute({ agent: "commandcode", model: null, kind: null }, null, avail, T);
    expect(r.agent).toBeNull();
    expect(r.unusableNamed).toEqual({ agent: "commandcode", why: "it isn't installed" });
  });

  it("disables when the named agent is installed but at/below the low-quota threshold", () => {
    const avail: AvailabilityMap = { claude: ok(0.05) };
    const r = decisionRoute({ agent: "claude", model: null, kind: null }, null, avail, T);
    expect(r.agent).toBeNull();
    expect(r.unusableNamed?.agent).toBe("claude");
    expect(r.unusableNamed?.why).toContain("quota");
  });

  it("enables when the named agent is installed with quota to spare", () => {
    const avail: AvailabilityMap = { claude: ok(0.8) };
    const r = decisionRoute({ agent: "claude", model: "haiku", kind: null }, null, avail, T);
    expect(r.agent).toBe("claude");
    expect(r.model).toBe("haiku");
    expect(r.source).toBe("chat");
    expect(r.unusableNamed).toBeUndefined();
  });

  it("treats unknown quota (no meter) as usable, same as pickTarget does", () => {
    const avail: AvailabilityMap = { claude: ok(null) };
    const r = decisionRoute({ agent: "claude", model: null, kind: null }, null, avail, T);
    expect(r.agent).toBe("claude");
  });

  it("names the specific agent the chat asked for, not a generic message", () => {
    const avail: AvailabilityMap = { opencode: missing };
    const r = decisionRoute({ agent: "opencode", model: null, kind: null }, null, avail, T);
    expect(r.unusableNamed?.agent).toBe("opencode");
  });
});

describe("decisionRoute — routing (no agent named)", () => {
  it("routes cleanly with no warning when the first choice is available", () => {
    const routes = routesWith([{ agent: "claude", model: "haiku" }]);
    const avail: AvailabilityMap = { claude: ok(0.8) };
    const r = decisionRoute({ agent: null, model: null, kind: "implementation" }, routes, avail, T);
    expect(r.agent).toBe("claude");
    expect(r.source).toBe("routing");
    expect(r.warning).toBeUndefined();
  });

  it("surfaces a warning on fallback, but still enables the button", () => {
    const routes = routesWith([{ agent: "claude" }, { agent: "commandcode" }]);
    const avail: AvailabilityMap = { claude: missing, commandcode: ok(0.9) };
    const r = decisionRoute({ agent: null, model: null, kind: "implementation" }, routes, avail, T);
    expect(r.agent).toBe("commandcode");
    expect(r.warning).toContain("claude isn't installed");
  });

  it("surfaces a warning when every target is exhausted, but still enables the button", () => {
    // pickTarget's own philosophy for a fallback CHAIN: a lesser choice beats no session
    // at all. Unlike the chat-named-agent case above, this must NOT disable.
    const routes = routesWith([{ agent: "claude" }]);
    const avail: AvailabilityMap = { claude: ok(0.02) };
    const r = decisionRoute({ agent: null, model: null, kind: "implementation" }, routes, avail, T);
    expect(r.agent).toBe("claude");
    expect(r.warning).toBeTruthy();
  });

  it("disables with no chat agent and no routes loaded yet", () => {
    const r = decisionRoute({ agent: null, model: null, kind: "implementation" }, null, {}, T);
    expect(r.agent).toBeNull();
    expect(r.unusableNamed).toBeUndefined();
  });

  it("disables when nothing in the routed chain is installed", () => {
    const routes = routesWith([{ agent: "claude" }, { agent: "commandcode" }]);
    const avail: AvailabilityMap = { claude: missing, commandcode: missing };
    const r = decisionRoute({ agent: null, model: null, kind: "implementation" }, routes, avail, T);
    expect(r.agent).toBeNull();
  });

  it("defaults an absent kind to implementation", () => {
    const routes = routesWith([{ agent: "claude" }]);
    const avail: AvailabilityMap = { claude: ok(0.9) };
    const r = decisionRoute({ agent: null, model: null, kind: undefined }, routes, avail, T);
    expect(r.agent).toBe("claude");
  });
});
