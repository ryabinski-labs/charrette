import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import type { Reporter } from "vitest/reporters";
import { partitionUnhandled, starvationNote, type UnhandledError } from "./packages/shared/src/runnerLoad.js";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url));

/**
 * Put back the exit code that `dangerouslyIgnoreUnhandledErrors` takes away,
 * for every unhandled error except a starved runner's RPC timeout.
 *
 * The flag is all-or-nothing and vitest offers nothing narrower, so the policy
 * is expressed here instead: `runnerLoad.ts` decides which errors are
 * statements about the machine, anything else sets the exit code back to 1,
 * and the ones let through are printed rather than dropped. Nothing in vitest
 * resets `exitCode` to 0 after reporters run, so setting it here holds.
 *
 * The hook is `onTestRunEnd`, not vitest 3's `onFinished`. Vitest 4 removed
 * `onFinished` from the reporter interface outright rather than deprecating
 * it, and a reporter object is a plain bag of optional methods — an unknown
 * key is not an error, it is simply never called. Left unrenamed this would
 * have gone on typechecking and gone on passing, while CI silently ran with
 * `dangerouslyIgnoreUnhandledErrors` on and nothing putting the exit code
 * back: every unhandled error swallowed, which is the exact failure this file
 * exists to prevent. `satisfies Reporter` is what makes that loud: the
 * interface is all-optional methods, so an object literal checked against it
 * fails on an excess property — a hook vitest no longer calls is a build
 * error rather than silence. No test can cover this file (the coverage
 * `include` is package sources), so the typecheck is the guard.
 */
const unhandledErrorPolicy = {
  onTestRunEnd(_testModules: unknown, errors: readonly UnhandledError[] = []) {
    if (!errors.length) return;
    const { fatal, starvation } = partitionUnhandled(errors);
    if (starvation.length) process.stderr.write(starvationNote(starvation.length, starvation));
    if (fatal.length) process.exitCode = 1;
  },
} satisfies Reporter;

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
     * Left alone, `@charrette/shared` resolves through pnpm's workspace symlink
     * to `packages/shared/dist/index.js`. The tests still pass — but the
     * coverage map credits the build artifact, so `shared/src/config.ts` read
     * as 0% covered while `skillsInjection.test.ts` was exercising every
     * routing rule in it. Aliasing to `src` measures the file we actually
     * ship changes to, and drops the build step from the test job.
     */
    alias: {
      "@charrette/shared": pkg("shared"),
      "@charrette/core": pkg("core"),
      "@charrette/dashboard": pkg("dashboard"),
      "@charrette/skills-mcp": pkg("skills-mcp"),
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
    /**
     * Leave the machine half its cores.
     *
     * CI runs on whichever self-hosted runner is free, and that can be a host
     * with other work on it. Uncapped, the fork pool takes a worker per core;
     * the parent process — which serves every worker's transforms and answers
     * their RPC — then competes with its own children for the CPU. birpc's
     * call timeout is a fixed 60s with no knob on it, so once the parent stalls
     * past that, a worker throws `Timeout calling "onTaskUpdate"`. Vitest
     * counts that as an unhandled error and exits 1 — which is how PR #63
     * failed with `2275 passed (2275)` and 100% coverage in the same log.
     *
     * Halving the pool leaves the parent cores to be responsive on. It is a
     * mitigation, not a proof: a host loaded enough will still starve it —
     * which run 31970423870 then demonstrated, failing this same way on mx1
     * with this cap already in force, so see `dangerouslyIgnoreUnhandledErrors`
     * below for the part that is a fix. Local runs stay uncapped: the flake
     * needs a contended machine, and the cap would cost every local run for it.
     */
    maxWorkers: process.env.CI ? "50%" : undefined,
    /**
     * A green suite is not failed by the machine it ran on.
     *
     * Run 31970423870: `120 passed`, `2298 passed`, `100 | 100 | 100 | 100`,
     * and exit 1 — on `Timeout calling "onTaskUpdate"`, at 498s on mx1 against
     * a dedicated runner's 104s. birpc's 60s is hardcoded, and the operator's
     * rule is that every self-hosted runner takes every workflow, so the suite
     * has to survive the slowest host that will accept it rather than the host
     * being narrowed to suit the suite.
     *
     * Blanket-ignoring would hide the next real unhandled rejection, so
     * `unhandledErrorPolicy` above hands the exit code straight back for
     * anything that is not a starved parent, and prints what it lets through.
     * CI only: locally an unhandled error is something to look at now, and a
     * developer's laptop is not the machine that starves.
     */
    dangerouslyIgnoreUnhandledErrors: Boolean(process.env.CI),
    /**
     * `dot` under CI, not the default's line per test.
     *
     * Failures still print in full; what goes away is 2298 formatted lines of
     * success written to a pipe by the one process every worker is waiting on
     * to answer its RPC. It is the parent's own workload and the only part of
     * it that grows with the suite, so it is the cheapest thing to give back.
     *
     * Both entries matter and they travel together: `--reporter` on the
     * command line REPLACES this list, and would take the policy above with it
     * — silently, leaving `dangerouslyIgnoreUnhandledErrors` on with nothing
     * putting the exit code back. CI runs `pnpm test:coverage`, which passes no
     * reporter flag; keep it that way.
     */
    reporters: process.env.CI ? ["dot", unhandledErrorPolicy] : ["default", unhandledErrorPolicy],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      // Every shipped source file counts, whether or not a test imports it.
      // Without that an untested file is simply absent from the report and
      // 100% means "100% of what we remembered to test".
      //
      // This used to say `all: true`. Vitest 4 deleted the option and folded
      // its meaning into `include`: with no `include` only files a test loaded
      // are measured, and with one, everything matching it is measured whether
      // a test touched it or not. So the line below now carries both jobs, and
      // deleting it would not narrow the report — it would silently stop
      // reporting the files nothing tests, with the thresholds still green.
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/*.d.ts"],
      /**
       * Four hundreds, and they are real ones.
       *
       * They were not always. Vitest 4 made AST-aware remapping unconditional
       * for the V8 provider: the old range-based mapping credited a
       * `.catch(() => fallback)` that never ran, because the line it sits on
       * did, and the new one counts the arrow itself. So the repository read
       * 100% for a long time while its git and GitHub failure paths had never
       * been exercised. Closing that was issue #5, over which these thresholds
       * spent four pull requests as negative counts — a maximum number of
       * uncovered entities — walking down to zero.
       *
       * What that exercise actually found, and the reason to keep the bar
       * here: of the forty-odd gaps, eight were handlers nothing could reach —
       * guards against contracts the suite already enforced — and they were
       * deleted rather than tested. The rest were paths nobody had ever run:
       * six roles that could be briefed and never were, three parsers, a
       * dozen guards with only one side taken. None of that was visible at
       * 99%.
       *
       * A percentage floor absorbs new debt as the repository grows. This one
       * does not: every uncovered line, branch, function and statement anyone
       * adds, anywhere, fails the build.
       */
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
