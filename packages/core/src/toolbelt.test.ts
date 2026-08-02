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

  it("tells an infra agent how to check its work and forbids applying it", () => {
    // Infrastructure is the case where the read-only rule matters most: an
    // `apply` cannot be reviewed after the fact, only undone. Every IaC tool
    // must arrive with both halves — the verification command it should run,
    // and the mutating one it must not.
    const infra = ["terraform", "kubectl", "helm", "pulumi", "cdk"];
    const block = toolbeltBlock(detectToolbelt(undefined, env(fakeBin(...infra))));
    for (const name of infra) expect(block).toContain(`\`${name}\``);

    expect(block).toMatch(/terraform validate.*plan|`plan`/);
    expect(block).toMatch(/NEVER `apply`, `destroy`/);
    expect(block).toMatch(/--dry-run=server/);
    expect(block).toMatch(/helm lint/);
    expect(block).toMatch(/pulumi preview/);
    expect(block).toMatch(/cdk synth/);
    expect(block).toMatch(/NEVER `pulumi up`/);
    expect(block).toMatch(/NEVER `cdk deploy`/);
  });

  it("still lets a repo withhold the cloud CLIs entirely", () => {
    // An operator who does not want agents near their account narrows the
    // allowlist; detection must not smuggle the new tools in behind that.
    const dir = fakeBin("terraform", "kubectl", "aws", "podman");
    expect(detectToolbelt(["podman"], env(dir)).map((t) => t.name)).toEqual(["podman"]);
  });
});
