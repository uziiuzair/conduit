import { describe, expect, it } from "vitest";
import {
  decisionRoute,
  projectsNeedingRoutes,
  type RoutesByProject,
} from "./pendingDecisionRouting";
import type { AvailabilityMap } from "./routing";
import type { RoutesView } from "./routing";

const T = 0.1;
const ok = (remaining: number | null = null) => ({ installed: true, remaining });
const missing = { installed: false, remaining: null };

/** The default project every single-project case below uses. */
const P = "proj-1";

/** A card. `projectId` matters now: a card is routed by ITS OWN project's chains. */
const card = (
  d: Partial<{ agent: string | null; model: string | null; kind: string | null }> = {},
  projectId = P,
) => ({ agent: null, model: null, kind: null, ...d, projectId });

const routesWith = (chain: RoutesView["effective"]["implementation"]): RoutesView => ({
  effective: { implementation: chain },
  defaults: {},
  global: {},
  project: {},
});

/** One project's table, keyed the way the store keys them. */
const forProject = (
  chain: RoutesView["effective"]["implementation"],
  projectId = P,
): RoutesByProject => ({ [projectId]: routesWith(chain) });

describe("decisionRoute — chat-named agent", () => {
  it("disables when the named agent is not installed", () => {
    // This is the bug the review caught: a free-text agent from the proposal must get
    // the same availability test as a routed target, not a bypass.
    const avail: AvailabilityMap = { commandcode: missing };
    const r = decisionRoute(card({ agent: "commandcode" }), {}, avail, T);
    expect(r.agent).toBeNull();
    expect(r.unusableNamed).toEqual({ agent: "commandcode", why: "it isn't installed" });
  });

  it("disables when the named agent is installed but at/below the low-quota threshold", () => {
    const avail: AvailabilityMap = { claude: ok(0.05) };
    const r = decisionRoute(card({ agent: "claude" }), {}, avail, T);
    expect(r.agent).toBeNull();
    expect(r.unusableNamed?.agent).toBe("claude");
    expect(r.unusableNamed?.why).toContain("quota");
  });

  it("enables when the named agent is installed with quota to spare", () => {
    const avail: AvailabilityMap = { claude: ok(0.8) };
    const r = decisionRoute(card({ agent: "claude", model: "haiku" }), {}, avail, T);
    expect(r.agent).toBe("claude");
    expect(r.model).toBe("haiku");
    expect(r.source).toBe("chat");
    expect(r.unusableNamed).toBeUndefined();
  });

  it("treats unknown quota (no meter) as usable, same as pickTarget does", () => {
    const avail: AvailabilityMap = { claude: ok(null) };
    const r = decisionRoute(card({ agent: "claude" }), {}, avail, T);
    expect(r.agent).toBe("claude");
  });

  it("names the specific agent the chat asked for, not a generic message", () => {
    const avail: AvailabilityMap = { opencode: missing };
    const r = decisionRoute(card({ agent: "opencode" }), {}, avail, T);
    expect(r.unusableNamed?.agent).toBe("opencode");
  });

  // `d.agent` is free text a MODEL wrote. `pickTarget`'s `blocker` treats an agent absent
  // from the availability map as USABLE (an unprobed agent is assumed present), so an
  // invented id used to produce an ENABLED button labelled "as gpt5-turbo (chosen by the
  // chat)" — and Rust's lenient `AgentId` then spawned Claude under it.
  it("disables an agent id that does not exist, however healthy the map looks", () => {
    const r = decisionRoute(card({ agent: "gpt5-turbo" }), {}, {}, T);
    expect(r.agent).toBeNull();
    expect(r.unusableNamed).toEqual({ agent: "gpt5-turbo", why: "there is no such agent" });
  });

  it("still disables an invented agent when the availability map claims it is healthy", () => {
    // The map is keyed by AgentId, so a fabricated key can only arrive as a cast — but a
    // future availability source could supply one, and "unknown means usable" would then
    // enable the button. The identity check must not depend on the map at all.
    const avail = { "gpt5-turbo": ok(0.9) } as unknown as AvailabilityMap;
    const r = decisionRoute(card({ agent: "gpt5-turbo" }), {}, avail, T);
    expect(r.agent).toBeNull();
  });

  it("does not fall through to routing when the named agent is bogus", () => {
    // Silently routing past a bad name would spawn something the card never showed.
    const avail: AvailabilityMap = { claude: ok(0.9) };
    const r = decisionRoute(
      card({ agent: "gpt5-turbo", kind: "implementation" }),
      forProject([{ agent: "claude" }]),
      avail,
      T,
    );
    expect(r.agent).toBeNull();
    expect(r.source).toBeUndefined();
  });
});

describe("decisionRoute — routing (no agent named)", () => {
  it("routes cleanly with no warning when the first choice is available", () => {
    const routes = forProject([{ agent: "claude", model: "haiku" }]);
    const avail: AvailabilityMap = { claude: ok(0.8) };
    const r = decisionRoute(card({ kind: "implementation" }), routes, avail, T);
    expect(r.agent).toBe("claude");
    expect(r.source).toBe("routing");
    expect(r.warning).toBeUndefined();
  });

  it("surfaces a warning on fallback, but still enables the button", () => {
    const routes = forProject([{ agent: "claude" }, { agent: "commandcode" }]);
    const avail: AvailabilityMap = { claude: missing, commandcode: ok(0.9) };
    const r = decisionRoute(card({ kind: "implementation" }), routes, avail, T);
    expect(r.agent).toBe("commandcode");
    expect(r.warning).toContain("claude isn't installed");
  });

  it("surfaces a warning when every target is exhausted, but still enables the button", () => {
    // pickTarget's own philosophy for a fallback CHAIN: a lesser choice beats no session
    // at all. Unlike the chat-named-agent case above, this must NOT disable.
    const routes = forProject([{ agent: "claude" }]);
    const avail: AvailabilityMap = { claude: ok(0.02) };
    const r = decisionRoute(card({ kind: "implementation" }), routes, avail, T);
    expect(r.agent).toBe("claude");
    expect(r.warning).toBeTruthy();
  });

  it("says routing is still resolving — not 'no agent' — before the table arrives", () => {
    // The two are both disabled, but only one of them is a verdict. Rendering "no agent
    // available for this kind of work" off an empty map tells the user something false
    // about their configuration.
    const r = decisionRoute(card({ kind: "implementation" }), {}, {}, T);
    expect(r.agent).toBeNull();
    expect(r.routesPending).toBe(true);
    expect(r.unusableNamed).toBeUndefined();
  });

  it("disables when nothing in the routed chain is installed", () => {
    const routes = forProject([{ agent: "claude" }, { agent: "commandcode" }]);
    const avail: AvailabilityMap = { claude: missing, commandcode: missing };
    const r = decisionRoute(card({ kind: "implementation" }), routes, avail, T);
    expect(r.agent).toBeNull();
    // A loaded-but-empty answer IS a verdict, so this must not read as "still resolving".
    expect(r.routesPending).toBeUndefined();
  });

  it("defaults an absent kind to implementation", () => {
    const routes = forProject([{ agent: "claude" }]);
    const avail: AvailabilityMap = { claude: ok(0.9) };
    const r = decisionRoute(card({ kind: undefined }), routes, avail, T);
    expect(r.agent).toBe("claude");
  });
});

describe("decisionRoute — routing is scoped to the card's own project", () => {
  const avail: AvailabilityMap = { claude: ok(0.9), commandcode: ok(0.9), codex: ok(0.9) };

  it("routes a card by its own project's chain, not another project's", () => {
    // The bug: `routes` was ONE shared store slot, written by the new-session dialog and
    // the routing panel too. Open the dialog for X, approve a card for Y, and Y was
    // routed by X's chains.
    const byProject: RoutesByProject = {
      "proj-x": routesWith([{ agent: "claude" }]),
      "proj-y": routesWith([{ agent: "commandcode" }]),
    };
    expect(
      decisionRoute(card({ kind: "implementation" }, "proj-y"), byProject, avail, T).agent,
    ).toBe("commandcode");
    expect(
      decisionRoute(card({ kind: "implementation" }, "proj-x"), byProject, avail, T).agent,
    ).toBe("claude");
  });

  it("does not borrow a table from the only project that happens to be loaded", () => {
    // A globals-only load (`loadRouting(null)`) or a single other project's table must
    // not be applied to a card whose own project is unknown.
    const byProject: RoutesByProject = { "proj-x": routesWith([{ agent: "claude" }]) };
    const r = decisionRoute(card({ kind: "implementation" }, "proj-y"), byProject, avail, T);
    expect(r.agent).toBeNull();
    expect(r.routesPending).toBe(true);
  });

  it("honours a project-level override, which globals-only loading dropped", () => {
    const byProject: RoutesByProject = {
      "proj-y": {
        effective: { implementation: [{ agent: "codex" }] },
        defaults: { implementation: [{ agent: "claude" }] },
        global: {},
        project: { implementation: [{ agent: "codex" }] },
      },
    };
    expect(
      decisionRoute(card({ kind: "implementation" }, "proj-y"), byProject, avail, T).agent,
    ).toBe("codex");
  });
});

describe("projectsNeedingRoutes", () => {
  it("names each unloaded project once, and skips the loaded ones", () => {
    const loaded: RoutesByProject = { "proj-x": routesWith([{ agent: "claude" }]) };
    const want = projectsNeedingRoutes(
      [
        { projectId: "proj-x" },
        { projectId: "proj-y" },
        { projectId: "proj-y" },
        { projectId: "proj-z" },
      ],
      loaded,
    );
    expect(want.sort()).toEqual(["proj-y", "proj-z"]);
  });

  it("asks for nothing when every card's project is already loaded", () => {
    const loaded: RoutesByProject = { "proj-x": routesWith([]) };
    expect(projectsNeedingRoutes([{ projectId: "proj-x" }], loaded)).toEqual([]);
  });
});
