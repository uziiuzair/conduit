import { describe, it, expect } from "vitest";
import {
  parserSpecFor,
  mergeFormatOptions,
  hasFormatter,
  DEFAULT_FORMAT_CONFIG,
} from "./options";

describe("parserSpecFor", () => {
  it("maps ts/tsx to typescript + estree", () => {
    expect(parserSpecFor("/p/a.tsx")).toEqual({ parser: "typescript", plugins: ["typescript", "estree"] });
    expect(parserSpecFor("/p/a.ts")?.parser).toBe("typescript");
  });
  it("maps js family to babel", () => {
    expect(parserSpecFor("/p/a.mjs")).toEqual({ parser: "babel", plugins: ["babel", "estree"] });
  });
  it("maps css/scss/less to postcss with matching parser", () => {
    expect(parserSpecFor("/p/a.scss")).toEqual({ parser: "scss", plugins: ["postcss"] });
  });
  it("returns null for unsupported extensions", () => {
    expect(parserSpecFor("/p/a.rs")).toBeNull();
    expect(parserSpecFor("/p/Makefile")).toBeNull();
  });
});

describe("mergeFormatOptions", () => {
  it("project overrides global; unset project fields fall to global", () => {
    const merged = mergeFormatOptions({ printWidth: 120 }, DEFAULT_FORMAT_CONFIG);
    expect(merged.printWidth).toBe(120);
    expect(merged.tabWidth).toBe(DEFAULT_FORMAT_CONFIG.tabWidth);
  });
  it("null project config yields global", () => {
    expect(mergeFormatOptions(null, DEFAULT_FORMAT_CONFIG)).toEqual(DEFAULT_FORMAT_CONFIG);
  });
});

describe("hasFormatter", () => {
  it("true for prettier + rust + go files, false otherwise", () => {
    expect(hasFormatter("/p/a.ts")).toBe(true);
    expect(hasFormatter("/p/a.rs")).toBe(true);
    expect(hasFormatter("/p/a.go")).toBe(true);
    expect(hasFormatter("/p/a.txt")).toBe(false);
  });
});
