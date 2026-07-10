import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyMatch("stots", "src/store.ts")).not.toBeNull();
    expect(fuzzyMatch("STOTS", "src/store.ts")).not.toBeNull();
    expect(fuzzyMatch("xyz", "src/store.ts")).toBeNull();
  });

  it("returns matched indices usable for highlighting", () => {
    const m = fuzzyMatch("st", "src/store.ts");
    expect(m).not.toBeNull();
    const chars = m!.indices.map((i) => "src/store.ts"[i].toLowerCase()).join("");
    expect(chars).toBe("st");
  });

  it("empty query matches everything with zero score", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ path: "anything", score: 0, indices: [] });
  });

  it("query longer than candidate never matches", () => {
    expect(fuzzyMatch("abcdef", "abc")).toBeNull();
  });
});

describe("fuzzyFilter ranking", () => {
  it("basename hits beat directory hits", () => {
    const ranked = fuzzyFilter("store", ["src/store.ts", "store/index.html"], 10);
    expect(ranked[0].path).toBe("src/store.ts");
  });

  it("boundary-aligned matches beat buried ones", () => {
    const ranked = fuzzyFilter("ftree", ["src/components/FileTree.tsx", "src/leftree-data.ts"], 10);
    expect(ranked[0].path).toBe("src/components/FileTree.tsx");
  });

  it("shorter paths win ties", () => {
    const ranked = fuzzyFilter("app", ["src/App.tsx", "src/components/AppShellWrapper.tsx"], 10);
    expect(ranked[0].path).toBe("src/App.tsx");
  });

  it("respects the limit and drops non-matches", () => {
    const ranked = fuzzyFilter("a", ["a1", "a2", "a3", "zzz"], 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.every((r) => r.path.startsWith("a"))).toBe(true);
  });
});
