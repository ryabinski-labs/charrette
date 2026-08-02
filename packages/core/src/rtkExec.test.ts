import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashHooks } from "./pool.js";
import { rtkHooks } from "./rtk.js";

/**
 * The rtk path with a real `rtk` on PATH — a shell script standing in for the
 * binary, so this behaves the same on a developer's machine (where rtk is
 * usually installed) and in CI (where it never is). Without it, whether
 * `bashHooks()` returned one hook group or two came down to what happened to be
 * installed on the machine running the suite.
 */
function fakeRtkOnPath(script: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-rtk-"));
  const bin = path.join(dir, "rtk");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  // Prepended, not replacing: the stand-in is a shell script, and a PATH
  // holding only this directory leaves it unable to find `cat`.
  return `${dir}${path.delimiter}${saved.path ?? ""}`;
}

/** A directory with no rtk in it, ahead of everything else. */
function noRtkOnPath(): string {
  return `${mkdtempSync(path.join(tmpdir(), "harness-empty-"))}${path.delimiter}/nonexistent-bin`;
}

const saved = { path: process.env.PATH, off: process.env.HARNESS_RTK };

const bashInput = (command: string) =>
  ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "list files" },
  }) as never;

const fire = async (hook: (i: never, t: undefined, o: { signal: AbortSignal }) => Promise<unknown>, command: string) =>
  (await hook(bashInput(command), undefined, { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { updatedInput?: Record<string, unknown>; permissionDecisionReason?: string };
  };

describe("driving the real rtk binary", () => {
  beforeEach(() => {
    delete process.env.HARNESS_RTK;
  });

  afterEach(() => {
    process.env.PATH = saved.path;
    if (saved.off === undefined) delete process.env.HARNESS_RTK;
    else process.env.HARNESS_RTK = saved.off;
  });

  it("applies the rewrite an rtk on PATH answers with", async () => {
    process.env.PATH = fakeRtkOnPath(
      `#!/bin/sh\ncat > /dev/null\ncat <<'JSON'\n{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"rtk git status"}}}\nJSON\n`
    );
    const hook = rtkHooks()!.PreToolUse![0]!.hooks[0]!;

    const out = await fire(hook, "git status");

    expect(out.hookSpecificOutput?.updatedInput).toEqual({ command: "rtk git status", description: "list files" });
    expect(out.hookSpecificOutput?.permissionDecisionReason).toBe("rtk rewrite");
  });

  it("runs the command as written when rtk exits non-zero", async () => {
    process.env.PATH = fakeRtkOnPath(`#!/bin/sh\ncat > /dev/null\necho "rtk: panicked" >&2\nexit 2\n`);
    const hook = rtkHooks()!.PreToolUse![0]!.hooks[0]!;

    expect(await fire(hook, "git status")).toEqual({});
  });

  it("runs the command as written when rtk answers with nonsense", async () => {
    process.env.PATH = fakeRtkOnPath(`#!/bin/sh\ncat > /dev/null\necho 'not json at all'\n`);
    const hook = rtkHooks()!.PreToolUse![0]!.hooks[0]!;

    expect(await fire(hook, "git status")).toEqual({});
  });

  it("adds rtk's hook group after the guard when rtk is installed", () => {
    process.env.PATH = fakeRtkOnPath(`#!/bin/sh\ncat > /dev/null\necho '{}'\n`);

    const pre = bashHooks()!.PreToolUse!;

    expect(pre).toHaveLength(2);
    // The guard decides on the command the agent wrote, before rtk rewrites it.
    expect(pre[0]!.hooks).toHaveLength(2);
    expect(pre[1]!.matcher).toBe("Bash");
  });

  it("is the guard alone when rtk is not installed", () => {
    process.env.PATH = noRtkOnPath();

    expect(bashHooks()!.PreToolUse!).toHaveLength(1);
  });

  it("is off in an environment with no PATH at all", () => {
    expect(rtkHooks({})).toBeUndefined();
  });

  it("is the guard alone when the operator switched rtk off", () => {
    process.env.PATH = fakeRtkOnPath(`#!/bin/sh\necho '{}'\n`);
    process.env.HARNESS_RTK = "off";

    expect(bashHooks()!.PreToolUse!).toHaveLength(1);
  });
});
