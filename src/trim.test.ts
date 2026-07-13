// Pure node-env tests for the "Clean Whitespace on Save" edit computation. The store
// maps these results onto pushEditOperations; correctness here is what keeps the
// feature from corrupting buffers (columns are 1-based, Monaco-style).

import { describe, expect, it } from "vitest";
import { cleanupEdits } from "./trim";

describe("cleanupEdits — trailing whitespace", () => {
  it("emits one edit per line with trailing spaces or tabs", () => {
    const { trims } = cleanupEdits(["abc  ", "def", "ghi\t", ""], { trimTrailing: true });
    expect(trims).toEqual([
      { lineNumber: 1, fromColumn: 4, endColumn: 6 },
      { lineNumber: 3, fromColumn: 4, endColumn: 5 },
    ]);
  });
  it("trims a whitespace-only line to empty", () => {
    const { trims } = cleanupEdits(["   "], { trimTrailing: true });
    expect(trims).toEqual([{ lineNumber: 1, fromColumn: 1, endColumn: 4 }]);
  });
  it("leaves interior whitespace alone", () => {
    const { trims } = cleanupEdits(["a  b"], { trimTrailing: true });
    expect(trims).toEqual([]);
  });
  it("emits nothing when trimming is off (markdown hard breaks)", () => {
    const { trims } = cleanupEdits(["line  ", "break  "], { trimTrailing: false });
    expect(trims).toEqual([]);
  });
});

describe("cleanupEdits — final newline", () => {
  it("wants a newline when the last line is non-empty", () => {
    expect(cleanupEdits(["abc"], { trimTrailing: true }).appendFinalNewline).toBe(true);
  });
  it("is satisfied by an existing trailing newline (final empty line)", () => {
    expect(cleanupEdits(["abc", ""], { trimTrailing: true }).appendFinalNewline).toBe(false);
  });
  it("does not add a blank line when trimming empties the last line", () => {
    // "abc\n   " -> trim makes the final line empty -> the doc already ends in \n.
    expect(cleanupEdits(["abc", "   "], { trimTrailing: true }).appendFinalNewline).toBe(false);
    // ...but WITHOUT trimming, that whitespace last line still needs its newline.
    expect(cleanupEdits(["abc", "   "], { trimTrailing: false }).appendFinalNewline).toBe(true);
  });
  it("leaves an empty document alone", () => {
    const r = cleanupEdits([""], { trimTrailing: true });
    expect(r.trims).toEqual([]);
    expect(r.appendFinalNewline).toBe(false);
  });
});
