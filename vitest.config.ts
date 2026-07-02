import { defineConfig } from "vitest/config";

// Node env only — the registry is framework-agnostic and never imports monaco,
// so its ref-count / dirty logic is exercised with a fake model (no DOM).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
