import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // CLI wiring is exercised end-to-end by scripts/cli-smoke.mjs and scripts/package-e2e.mjs,
      // which run the built artifact outside the vitest process, so it is not part of this gate.
      exclude: ["src/**/*.test.ts", "src/bin/**", "src/index.ts", "src/commands/**", "src/cli/**"],
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 70,
        functions: 80,
        statements: 70,
        branches: 50,
      },
    },
  },
});
