import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectToolbelt, toolbeltBlock } from "./toolbelt.js";

/** A PATH directory holding fake executables with the given names. */
function fakeBin(...names: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-bin-"));
  for (const name of names) {
    const file = path.join(dir, name);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

const env = (dir: string) => ({ PATH: dir }) as NodeJS.ProcessEnv;

describe("toolbelt detection", () => {
  it("finds the tools that are actually on PATH", () => {
    const found = detectToolbelt(undefined, env(fakeBin("gh", "podman", "adb")));
    expect(found.map((t) => t.name).sort()).toEqual(["adb", "gh", "podman"]);
  });

  it("does not advertise a tool the machine does not have", () => {
    const found = detectToolbelt(undefined, env(fakeBin("gh")));
    expect(found.map((t) => t.name)).toEqual(["gh"]);
  });

  it("ignores a non-executable file of the right name", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-bin-"));
    writeFileSync(path.join(dir, "aws"), "not executable");
    expect(detectToolbelt(undefined, env(dir))).toEqual([]);
  });

  it("honours an allowlist so a repo can withhold aws", () => {
    const dir = fakeBin("gh", "aws", "podman");
    const found = detectToolbelt(["gh", "podman"], env(dir));
    expect(found.map((t) => t.name)).toEqual(["gh", "podman"]);
  });

  it("treats an empty allowlist as 'tell agents about nothing'", () => {
    expect(detectToolbelt([], env(fakeBin("gh", "aws")))).toEqual([]);
  });
});

describe("toolbelt prompt block", () => {
  it("is empty when nothing was found, so no prompt bytes are spent", () => {
    expect(toolbeltBlock([])).toBe("");
  });

  it("carries the guardrail with the tool, not just its name", () => {
    const block = toolbeltBlock(detectToolbelt(undefined, env(fakeBin("gh", "aws"))));
    // The whole point: an agent that reads this must not open PRs or mutate AWS.
    expect(block).toMatch(/Never `gh pr create`/);
    expect(block).toMatch(/READ ONLY/);
    expect(block).toMatch(/Never delete, terminate, scale, or modify/);
  });
});
