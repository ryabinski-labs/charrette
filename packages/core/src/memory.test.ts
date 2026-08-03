import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkMemoryBanner, observe, observeChecks, recall } from "./memory.js";
import { Store } from "./store.js";

const DAY = 86_400_000;
/** A fixed clock, so "3 days ago" is a fact about the test and not about today. */
const NOW = 1_700_000_000_000;

function store(): Store {
  return new Store(":memory:");
}

function check(s: Store, subject: string, verdict: "passed" | "failed" | "flaky", opts: { runId?: string; detail?: string; at?: number } = {}) {
  observe(s, { kind: "check", subject, verdict, detail: opts.detail ?? "", runId: opts.runId ?? "run-1" }, opts.at ?? NOW);
}

describe("writing down what a run watched happen", () => {
  it("keeps an observation for the next run to read", () => {
    const s = store();
    check(s, "pnpm test", "passed");
    expect(recall(s, "check").map((o) => [o.subject, o.verdict])).toEqual([["pnpm test", "passed"]]);
  });

  it("counts a repeat sighting instead of adding a row, so the table stays the size of the suite", () => {
    const s = store();
    check(s, "pnpm test", "passed", { at: NOW - DAY });
    check(s, "pnpm test", "passed", { at: NOW });
    const rows = recall(s, "check");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.observations).toBe(2);
    expect(rows[0]!.observedAt).toBe(NOW);
  });

  it("holds a passing and a failing memory of the same command at once, because both happened", () => {
    const s = store();
    check(s, "pnpm test", "passed", { at: NOW - DAY });
    check(s, "pnpm test", "failed", { at: NOW });
    expect(recall(s, "check").map((o) => o.verdict)).toEqual(["failed", "passed"]);
  });

  it("returns the most recent observation first, since that is the one that is still true", () => {
    const s = store();
    check(s, "old", "passed", { at: NOW - 5 * DAY });
    check(s, "new", "passed", { at: NOW });
    expect(recall(s, "check").map((o) => o.subject)).toEqual(["new", "old"]);
  });

  it("does not answer with another kind's memories", () => {
    const s = store();
    check(s, "pnpm test", "passed");
    expect(recall(s, "something-else")).toEqual([]);
  });

  it("keeps one line of evidence, so a whole test suite's output cannot become the memory", () => {
    const s = store();
    check(s, "pnpm test", "failed", { detail: `first line\n${"x".repeat(5000)}` });
    expect(recall(s, "check")[0]!.detail).toBe("first line");
  });

  it("bounds a single very long line too", () => {
    const s = store();
    check(s, "pnpm test", "failed", { detail: "y".repeat(5000) });
    expect(recall(s, "check")[0]!.detail).toHaveLength(300);
  });

  it("outlives the run that wrote it — that is the whole point", () => {
    // Two Store instances over one file, which is what a later run in the same
    // repository actually is. An in-memory database would pass this test while
    // proving nothing about it.
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "harness-memory-")), "harness.db");
    const first = new Store(dbPath);
    observe(first, { kind: "check", subject: "pnpm test", verdict: "failed", detail: "", runId: "run-1" }, NOW);
    first.db.close();

    const next = new Store(dbPath);
    const carried = recall(next, "check");
    expect(carried).toHaveLength(1);
    expect(carried[0]!.runId).toBe("run-1");
    next.db.close();
  });
});

describe("what one task's check run is allowed to teach the repository", () => {
  const RUN = { runId: "run-1", configured: ["pnpm build", "pnpm test"], failed: [], inherited: [], flaky: [] } as Parameters<typeof observeChecks>[1];

  function verdicts(s: Store): Record<string, string> {
    return Object.fromEntries(recall(s, "check").map((o) => [`${o.subject}:${o.verdict}`, o.detail]));
  }

  it("remembers a green suite as green", () => {
    const s = store();
    observeChecks(s, RUN, NOW);
    expect(Object.keys(verdicts(s)).sort()).toEqual(["pnpm build:passed", "pnpm test:passed"]);
  });

  it("does NOT remember a failure this task caused — that is one worker's bug, not the repo's", () => {
    // The whole reason this rule is here. `pnpm test` went red in this worktree
    // and is fine on the base, so the repository learns nothing at all about it;
    // the check that did pass is still recorded.
    const s = store();
    observeChecks(s, { ...RUN, failed: ["pnpm test"] }, NOW);
    expect(Object.keys(verdicts(s))).toEqual(["pnpm build:passed"]);
  });

  it("remembers a failure the task inherited, because that one is the repo's", () => {
    const s = store();
    observeChecks(
      s,
      { ...RUN, failed: ["pnpm test"], inherited: [{ command: "pnpm test", signatures: ["auth.test.ts > expired token"] }] },
      NOW
    );
    expect(verdicts(s)["pnpm test:failed"]).toBe("auth.test.ts > expired token");
  });

  it("names each thing that was already failing, so the operator knows where to look", () => {
    const s = store();
    observeChecks(s, { ...RUN, failed: ["pnpm test"], inherited: [{ command: "pnpm test", signatures: ["a > one", "b > two"] }] }, NOW);
    expect(verdicts(s)["pnpm test:failed"]).toBe("a > one · b > two");
  });

  it("remembers a check that failed and then passed on a re-run as flaky", () => {
    const s = store();
    observeChecks(s, { ...RUN, failed: ["pnpm test"], flaky: ["pnpm test"] }, NOW);
    expect(verdicts(s)).toHaveProperty("pnpm test:flaky");
  });

  it("writes nothing at all for a run with no checks configured", () => {
    const s = store();
    observeChecks(s, { ...RUN, configured: [] }, NOW);
    expect(recall(s, "check")).toEqual([]);
  });
});

describe("telling the next run what this repo did to these checks", () => {
  it("says nothing when the repo has never been observed", () => {
    expect(checkMemoryBanner(store(), ["pnpm test"], NOW)).toEqual([]);
  });

  it("says nothing when there are no checks to say it about", () => {
    const s = store();
    check(s, "pnpm test", "failed");
    expect(checkMemoryBanner(s, [], NOW)).toEqual([]);
  });

  it("stays quiet about a check that was last seen passing", () => {
    const s = store();
    check(s, "pnpm test", "passed");
    expect(checkMemoryBanner(s, ["pnpm test"], NOW)).toEqual([]);
  });

  it("warns that a check was already red on an earlier run's base", () => {
    const s = store();
    check(s, "pnpm test", "failed", { runId: "40da9337" });
    const lines = checkMemoryBanner(s, ["pnpm test"], NOW).join("\n");
    expect(lines).toContain("pnpm test");
    expect(lines).toContain("40da9337");
    expect(lines).toContain("parks every task");
  });

  it("shows the evidence under the warning", () => {
    const s = store();
    check(s, "pnpm test", "failed", { detail: "auth.test.ts > rejects an expired token" });
    expect(checkMemoryBanner(s, ["pnpm test"], NOW).join("\n")).toContain("auth.test.ts > rejects an expired token");
  });

  it("omits the evidence line when there is no evidence, rather than printing a blank one", () => {
    const s = store();
    check(s, "pnpm test", "failed");
    expect(checkMemoryBanner(s, ["pnpm test"], NOW).some((l) => l.trim() === "")).toBe(false);
  });

  it("reports a flaky check as a flaky check, not as a failure", () => {
    const s = store();
    check(s, "pnpm e2e", "flaky");
    const lines = checkMemoryBanner(s, ["pnpm e2e"], NOW).join("\n");
    expect(lines).toContain("failed and then passed on a re-run");
    expect(lines).not.toContain("parks every task");
  });

  it("goes quiet once the check has been seen passing more recently than it failed", () => {
    const s = store();
    check(s, "pnpm test", "failed", { at: NOW - 3 * DAY });
    check(s, "pnpm test", "passed", { at: NOW });
    expect(checkMemoryBanner(s, ["pnpm test"], NOW)).toEqual([]);
  });

  it("still warns when the failure is the more recent of the two", () => {
    const s = store();
    check(s, "pnpm test", "passed", { at: NOW - 3 * DAY });
    check(s, "pnpm test", "failed", { at: NOW });
    expect(checkMemoryBanner(s, ["pnpm test"], NOW).join("\n")).toContain("parks every task");
  });

  it("ignores a command this run is not going to use", () => {
    const s = store();
    check(s, "cargo test", "failed");
    expect(checkMemoryBanner(s, ["pnpm test"], NOW)).toEqual([]);
  });

  it("passes over a check it has never seen and still reports the one it has", () => {
    // The ordinary case for a repo that just added a check: some of the suite is
    // remembered and some of it is brand new.
    const s = store();
    check(s, "pnpm test", "failed");
    const lines = checkMemoryBanner(s, ["pnpm lint", "pnpm test"], NOW).join("\n");
    expect(lines).toContain("pnpm test");
    expect(lines).not.toContain("pnpm lint");
  });

  it("dates the claim, because a repo has had commits since", () => {
    const s = store();
    check(s, "a", "failed", { at: NOW });
    check(s, "b", "failed", { at: NOW - DAY });
    check(s, "c", "failed", { at: NOW - 9 * DAY });
    const lines = checkMemoryBanner(s, ["a", "b", "c"], NOW).join("\n");
    expect(lines).toContain("(today)");
    expect(lines).toContain("(yesterday)");
    expect(lines).toContain("(9 days ago)");
  });

  it("reports the checks in the order the run will run them, not the order they were remembered", () => {
    const s = store();
    check(s, "second", "failed", { at: NOW });
    check(s, "first", "failed", { at: NOW - DAY });
    const body = checkMemoryBanner(s, ["first", "second"], NOW).join("\n");
    expect(body.indexOf("first")).toBeLessThan(body.indexOf("second"));
  });

  it("heads the block so the operator knows these are observations, not predictions", () => {
    const s = store();
    check(s, "pnpm test", "failed");
    expect(checkMemoryBanner(s, ["pnpm test"], NOW)[0]).toContain("watched happen");
  });
});
