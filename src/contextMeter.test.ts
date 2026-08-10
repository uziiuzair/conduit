import { describe, expect, it } from "vitest";
import { DANGER_AT, WARN_AT, formatTokens, meterLevel, meterTitle } from "./contextMeter";

const usage = (used: number, window: number, model: string | null = null) => ({
  used,
  window,
  fraction: Math.min(1, used / window),
  model,
});

describe("meterLevel", () => {
  it("stays quiet until the window is genuinely tight", () => {
    expect(meterLevel(0)).toBe("ok");
    expect(meterLevel(0.5)).toBe("ok");
    expect(meterLevel(WARN_AT - 0.001)).toBe("ok");
  });

  it("escalates at each threshold, inclusive", () => {
    expect(meterLevel(WARN_AT)).toBe("warn");
    expect(meterLevel(0.85)).toBe("warn");
    expect(meterLevel(DANGER_AT)).toBe("danger");
    expect(meterLevel(1)).toBe("danger");
  });
});

describe("formatTokens", () => {
  it("keeps small counts exact and large ones short", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(847)).toBe("847");
    expect(formatTokens(46_000)).toBe("46.0k");
    expect(formatTokens(1_000)).toBe("1.0k");
  });

  it("drops the decimal once it stops carrying information", () => {
    expect(formatTokens(184_000)).toBe("184k");
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_240_000)).toBe("1.2M");
  });
});

describe("meterTitle", () => {
  it("says the percentage, the numbers, and the model", () => {
    expect(meterTitle(usage(460_000, 1_000_000, "claude-opus-4-8"))).toBe(
      "Context 46% — 460k / 1.0M (claude-opus-4-8)",
    );
  });

  it("omits the model when the transcript never named one", () => {
    expect(meterTitle(usage(50_000, 200_000))).toBe("Context 25% — 50.0k / 200k");
  });
});
