import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { taskIsolation } from "./isolation.js";
import { runDeterministicChecks } from "./qa.js";
import { conflictPrompt } from "./prompts.js";
import { detectToolbelt } from "./toolbelt.js";

/**
 * The arms of these functions that only a strange input reaches — an id made
 * entirely of punctuation, a check that fails without writing to stderr, a
 * merge that came out clean. Each is a real state the harness reaches; none is
 * the state a test naturally constructs.
 */

describe("naming a task's compose project", () => {
  it("falls back to a usable name when the id has nothing left after slugging", () => {
    // A generated id can be punctuation-only; an empty compose project name is
    // rejected by both docker and podman, which would fail the task at startup.
    const iso = taskIsolation("run1", "!!! ***");

    expect(iso.composeProject).toMatch(/task/);
    expect(iso.composeProject).not.toMatch(/^-|-$/);
  });

  it("keeps a long id inside what compose will accept", () => {
    const iso = taskIsolation("run1", "a".repeat(200));

    for (const part of iso.composeProject.split("-")) expect(part.length).toBeLessThanOrEqual(40);
  });
});

describe("running the repo's own checks", () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), "harness-checks-"));

  it("reports the output of a check that failed", async () => {
    const result = await runDeterministicChecks(dir(), ["echo 'to stdout'; echo 'to stderr' >&2; exit 1"]);

    expect(result.ok).toBe(false);
    expect(result.failures[0]!.output).toContain("to stdout");
    expect(result.failures[0]!.output).toContain("to stderr");
  });

  /**
   * A command that cannot be started at all — a missing binary, a bad
   * interpreter — produces no stdout and no stderr, only an error message. QA
   * being told the check failed with an empty explanation is the worst of both.
   */
  it("falls back to the error itself when the check wrote nothing", async () => {
    const result = await runDeterministicChecks(dir(), ["exit 3"]);

    expect(result.ok).toBe(false);
    expect(result.failures[0]!.output).not.toBe("");
    expect(result.failures[0]!.command).toBe("exit 3");
  });

  it("says nothing failed when everything passed", async () => {
    const result = await runDeterministicChecks(dir(), ["true", "echo fine"]);

    expect(result).toEqual({ ok: true, failures: [] });
  });

  it("caps how much of a very noisy failure is kept", async () => {
    const result = await runDeterministicChecks(dir(), ["for i in $(seq 1 2000); do echo 'a very long line of test output'; done; exit 1"]);

    expect(result.failures[0]!.output.length).toBeLessThanOrEqual(4000);
  });
});

describe("asking a worker to resolve its own conflicts", () => {
  it("names the conflicted files when there is something to resolve by hand", () => {
    const prompt = conflictPrompt("harness/run1/main", ["src/app.ts", "src/routes.ts"], false);

    expect(prompt).toContain("left conflicted on purpose");
    expect(prompt).toContain("src/app.ts");
    expect(prompt).toContain("src/routes.ts");
  });

  /**
   * A textually clean merge is not the same as a correct one — two tasks can
   * touch different files and still disagree — so the worker is asked to check
   * the combination rather than told there is nothing to do.
   */
  it("asks for a check of the combination when the merge came out clean", () => {
    const prompt = conflictPrompt("harness/run1/main", [], true);

    expect(prompt).toContain("nothing to resolve by hand");
    expect(prompt).toContain("not the same as correct");
    expect(prompt).not.toContain("Conflict markers are in");
  });
});

describe("what the agents are offered on PATH", () => {
  it("offers everything it finds when the operator named nothing", () => {
    const bin = mkdtempSync(path.join(tmpdir(), "harness-bin-"));
    writeFileSync(path.join(bin, "gh"), "#!/bin/sh\n", { mode: 0o755 });

    const found = detectToolbelt(undefined, { PATH: bin });

    expect(found.map((t) => t.name)).toContain("gh");
  });

  it("offers only what the operator named", () => {
    const bin = mkdtempSync(path.join(tmpdir(), "harness-bin-"));
    for (const name of ["gh", "aws"]) writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });

    expect(detectToolbelt(["aws"], { PATH: bin }).map((t) => t.name)).toEqual(["aws"]);
  });

  it("offers nothing at all for an empty allow list", () => {
    expect(detectToolbelt([], { PATH: "/usr/bin" })).toEqual([]);
  });

  it("copes with an environment carrying no PATH", () => {
    expect(detectToolbelt(undefined, {})).toEqual([]);
  });
});
