import { describe, it, expect } from "vitest";
import {
  agyRow,
  claudeRow,
  commandCodeRow,
  meterView,
  summaryRemaining,
  type UWindow,
} from "./usageRows";
import type { AgyUsage, ClaudeAccountUsage, CommandCodeAccountUsage } from "./store";

const win = (over: Partial<UWindow> = {}): UWindow => ({
  key: "k",
  label: "5-hour window",
  kind: "fiveHour",
  group: "plan",
  used: 0,
  quota: true,
  resetsAt: null,
  disabled: false,
  ...over,
});

describe("meterView", () => {
  // The bug this whole normalization exists to prevent: the label said "62% left" while
  // the bar filled to 38%. One call now produces both, so they cannot come apart.
  it("makes the number and the bar say the same thing, in both directions", () => {
    const w = win({ used: 0.62 });

    const used = meterView(w, "used");
    expect(used.pct).toBe(62);
    expect(used.word).toBe("used");
    expect(Math.round(used.fraction * 100)).toBe(used.pct);

    const left = meterView(w, "remaining");
    expect(left.pct).toBe(38);
    expect(left.word).toBe("left");
    expect(Math.round(left.fraction * 100)).toBe(left.pct);
  });

  it("reports severity as consumption whichever way the meter reads", () => {
    // A meter showing "8% left" is in danger, and a colour ramp keyed on the drawn
    // fraction would paint it as if it were nearly empty of trouble.
    const w = win({ used: 0.92 });
    expect(meterView(w, "used").severity).toBeCloseTo(0.92);
    expect(meterView(w, "remaining").severity).toBeCloseTo(0.92);
  });

  it("clamps nonsense from an endpoint instead of drawing past the bar", () => {
    expect(meterView(win({ used: 1.4 }), "used").pct).toBe(100);
    expect(meterView(win({ used: -0.2 }), "used").pct).toBe(0);
    expect(meterView(win({ used: NaN }), "remaining").pct).toBe(100);
  });
});

describe("row builders normalize every agent to consumption", () => {
  it("takes Claude's pctUsed through unchanged", () => {
    const entry: ClaudeAccountUsage = {
      accountId: null,
      label: "Personal",
      usage: {
        local: { totalTokens: 0 } as ClaudeAccountUsage["usage"]["local"],
        plan: [
          { label: "Current session", pctUsed: 0.18, resetsAt: null },
          { label: "Current week (all)", pctUsed: 0.03, resetsAt: null },
        ],
        planSource: "live",
      },
    };
    const row = claudeRow(entry);
    expect(row.windows.map((w) => w.used)).toEqual([0.18, 0.03]);
    expect(row.windows.every((w) => w.quota)).toBe(true);
    // Worst window drives health: 18% used = 82% left.
    expect(row.minRemaining).toBeCloseTo(0.82);
  });

  it("flips agy's remainingFraction, which is the only agent reporting headroom", () => {
    const u: AgyUsage = {
      accountId: null,
      planTier: "pro",
      email: "someone@example.com",
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "b1", label: "5-hour", remainingFraction: 0.25, resetsAt: null, disabled: false },
          ],
        },
      ],
      context: null,
      agentState: null,
      updatedAt: 0,
    };
    const row = agyRow(u);
    expect(row.windows[0].used).toBeCloseTo(0.75);
    expect(meterView(row.windows[0], "used").pct).toBe(75);
    expect(row.minRemaining).toBeCloseTo(0.25);
  });

  it("keeps Command Code's cap flag as an override on health, not on the windows", () => {
    const entry: CommandCodeAccountUsage = {
      accountId: null,
      label: "Default",
      usage: {
        windows: [{ label: "5-hour window", pctUsed: 0.006, resetsAt: null }],
        source: "live",
        limited: true,
      },
    };
    const row = commandCodeRow(entry);
    // The window still draws its true (tiny) consumption...
    expect(row.windows[0].used).toBeCloseTo(0.006);
    expect(row.windows[0].disabled).toBe(false);
    // ...while the account reads as spent, because it is capped right now.
    expect(row.minRemaining).toBe(0);
  });
});

describe("window labels", () => {
  it("names the same window the same way whoever reported it", () => {
    // Claude, Command Code and agy each name their own windows; stacked in one panel those
    // names read as three different kinds of limit instead of one limit, three vendors.
    const claude = claudeRow({
      accountId: null,
      label: "Personal",
      usage: {
        local: { totalTokens: 0 } as ClaudeAccountUsage["usage"]["local"],
        plan: [
          { label: "Current session", pctUsed: 0.1, resetsAt: null },
          { label: "Current week (all)", pctUsed: 0.1, resetsAt: null },
          { label: "Current week (Opus)", pctUsed: 0.1, resetsAt: null },
        ],
        planSource: "live",
      },
    });
    const cc = commandCodeRow({
      accountId: null,
      label: "Default",
      usage: {
        windows: [
          { label: "5-hour window", pctUsed: 0.1, resetsAt: null },
          { label: "Weekly", pctUsed: 0.1, resetsAt: null },
        ],
        source: "live",
        limited: false,
      },
    });
    expect(claude.windows.map((w) => w.label)).toEqual(["5-hour", "Weekly", "Weekly · Opus"]);
    expect(cc.windows.map((w) => w.label)).toEqual(["5-hour", "Weekly"]);
  });

  it("keeps agy's pool prefix, because those really are separate quotas", () => {
    const row = agyRow({
      accountId: null,
      planTier: "pro",
      email: null,
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "a", label: "5-hour", remainingFraction: 1, resetsAt: null, disabled: false },
          ],
        },
        {
          displayName: "Claude & GPT Models",
          buckets: [
            { bucketId: "b", label: "Weekly", remainingFraction: 1, resetsAt: null, disabled: false },
          ],
        },
      ],
      context: { usedPercentage: 12, contextWindowSize: 1_000_000, totalInputTokens: 0, totalOutputTokens: 0 },
      agentState: null,
      updatedAt: 0,
    });
    expect(row.windows.map((w) => w.label)).toEqual([
      "Gemini · 5-hour",
      "Claude/GPT · Weekly",
      "Context",
    ]);
  });
});

describe("summaryRemaining", () => {
  it("ignores the context window, which is not a quota", () => {
    // A conversation 95% through its context has consumed no plan at all. Counting it
    // would make a fresh account look nearly spent and steer the router away from it.
    const windows = [win({ used: 0.1 }), win({ key: "ctx", group: "context", quota: false, used: 0.95 })];
    expect(summaryRemaining(windows)).toBeCloseTo(0.9);
  });

  it("ignores a pool that is entirely disabled or entirely spent", () => {
    const gemini = win({ key: "g", group: "Gemini Models", used: 0.2 });
    const claudePool = win({ key: "c", group: "Claude & GPT Models", used: 1 });
    expect(summaryRemaining([gemini, claudePool])).toBeCloseTo(0.8);

    const disabled = win({ key: "d", group: "Claude & GPT Models", used: 0.5, disabled: true });
    expect(summaryRemaining([gemini, disabled])).toBeCloseTo(0.8);
  });

  it("treats an account with no quota windows as healthy, not as spent", () => {
    // No meter is not an empty meter — the router would otherwise stop using every agent
    // that exposes no usage API.
    expect(summaryRemaining([])).toBe(1);
  });
});
