import { describe, expect, test } from "vitest";

import { cloneNameFromUrl, validateProjectName } from "./projectNew";

describe("cloneNameFromUrl", () => {
  test("https URL with .git suffix", () => {
    expect(cloneNameFromUrl("https://github.com/user/repo.git")).toBe("repo");
  });

  test("https URL without .git", () => {
    expect(cloneNameFromUrl("https://github.com/user/repo")).toBe("repo");
  });

  test("trailing slash", () => {
    expect(cloneNameFromUrl("https://github.com/user/repo/")).toBe("repo");
  });

  test("scp-like git@ URL", () => {
    expect(cloneNameFromUrl("git@github.com:user/repo.git")).toBe("repo");
  });

  test("local filesystem path (hermetic clones)", () => {
    expect(cloneNameFromUrl("/tmp/fixtures/upstream.git")).toBe("upstream");
  });

  test("surrounding whitespace is trimmed", () => {
    expect(cloneNameFromUrl("  https://github.com/user/repo.git  ")).toBe("repo");
  });

  test("bare host yields empty", () => {
    expect(cloneNameFromUrl("https://github.com/")).toBe("");
  });

  test("empty input yields empty", () => {
    expect(cloneNameFromUrl("")).toBe("");
  });
});

describe("validateProjectName", () => {
  test("plain name passes", () => {
    expect(validateProjectName("my-app")).toBeNull();
  });

  test("empty is rejected", () => {
    expect(validateProjectName("")).toMatch(/name/i);
  });

  test("whitespace-only is rejected", () => {
    expect(validateProjectName("   ")).toMatch(/name/i);
  });

  test("dot and dot-dot are rejected", () => {
    expect(validateProjectName(".")).not.toBeNull();
    expect(validateProjectName("..")).not.toBeNull();
  });

  test("path separators are rejected on every platform", () => {
    expect(validateProjectName("a/b")).not.toBeNull();
    expect(validateProjectName("a\\b")).not.toBeNull();
  });
});
