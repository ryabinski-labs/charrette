import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url));

/**
 * Root test config — the one CI runs.
 *
 * The per-package `test` scripts still work for local iteration (`pnpm -r
 * test`), but they each start their own vitest with its own coverage view, so
 * none of them can answer "is the whole repo covered?". This config runs every
 * suite in one process against one coverage map, which is what the 100%
 * thresholds below are asserted on.
 */
export default defineConfig({
  resolve: {
    /**
     * Point cross-package imports at source, not `dist/`.
     *
     * Left alone, `@harness/shared` resolves through pnpm's workspace symlink
     * to `packages/shared/dist/index.js`. The tests still pass — but the
     * coverage map credits the build artifact, so `shared/src/config.ts` read
     * as 0% covered while `skillsInjection.test.ts` was exercising every
     * routing rule in it. Aliasing to `src` measures the file we actually
     * ship changes to, and drops the build step from the test job.
     */
    alias: {
      "@harness/shared": pkg("shared"),
      "@harness/core": pkg("core"),
      "@harness/dashboard": pkg("dashboard"),
      "@harness/skills-mcp": pkg("skills-mcp"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    // Several suites drive real git — worktrees, merges, pushes to a bare
    // remote — and a whole run can be a few dozen of those. The 5s default is
    // comfortable on a developer's laptop and a coin flip on a CI runner.
    //
    // 30s was itself a coin flip. The whole-run cases spend their wall clock
    // waiting on process spawns rather than on work — the pit-stop suite's
    // longest case measures 30s wall against 5.7s of CPU — so their duration
    // tracks how fast the machine can fork git, and four of that file's seven
    // cases already sit between 10s and 30s. It failed there on an unmodified
    // tree while passing in the same suite an hour earlier; a bound that a
    // green test lands inside by a second is not measuring anything.
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      // Every shipped source file counts, whether or not a test imports it —
      // without this an untested file is simply absent from the report and
      // 100% means "100% of what we remembered to test".
      all: true,
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/*.d.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
