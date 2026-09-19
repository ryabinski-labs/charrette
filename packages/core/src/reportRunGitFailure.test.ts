import { describe, expect, it, vi } from "vitest";

/**
 * What the scan does when git answers one question and not the next.
 *
 * `changedFiles` asks git up to four times, and every call after the first is
 * written to degrade rather than throw. That is not defensive habit: this runs
 * while a report is being assembled at the end of a run, and an exception here
 * would take the whole report with it — the one artefact produced after the
 * work is already done and merged. A git that goes away mid-scan must cost the
 * dark-switch section, not the report.
 *
 * Driven against a stubbed git because the failures are the ones a real
 * repository will not produce on demand: the branch verifies, and then the very
 * next command on the same branch fails.
 */
const failAfter = vi.hoisted(() => ({ calls: 0, failFrom: 99 }));
vi.mock("./git.js", () => ({
  git: async (_cwd: string, args: string[]) => {
    failAfter.calls++;
    if (failAfter.calls >= failAfter.failFrom) throw new Error(`git ${args[0]}: fatal`);
    // Call 1 verifies the ref; anything non-empty means "it exists".
    if (args[0] === "rev-parse") return "abc123\n";
    if (args[0] === "rev-list") return "def456\n";
    return "";
  },
}));

const { changedFiles } = await import("./reportRun.js");

describe("a git that stops answering mid-scan", () => {
  it("reports that it could not read rather than throwing, wherever git gives out", async () => {
    for (const failFrom of [2, 3, 4]) {
      failAfter.calls = 0;
      failAfter.failFrom = failFrom;

      const diff = await changedFiles("/repo", "main", "charrette/run-1/main", 1_700_000_000_000);

      // Whichever call died, the caller gets a described result and no throw.
      expect(diff.files).toEqual([]);
      expect(diff.basis).toBeTruthy();
    }
  });
});
