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

  it("gives the demo agent a way to take the screenshot it is asked for", () => {
    // The demo prompt orders "screenshots for anything rendered". Before this
    // the toolbelt held nothing that could render a page, so the instruction
    // was unachievable and demos reported a listening port as evidence.
    const block = toolbeltBlock(detectToolbelt(undefined, env(fakeBin("playwright"))));
    expect(block).toMatch(/playwright screenshot/);
    expect(block).toMatch(/curl of the same URL is not a screenshot/);
    expect(block).toMatch(/Local URLs only/);
  });

  it("only advertises browser commands the installed engine can actually run", () => {
    // Every Apple device descriptor pins webkit, and `-b chromium` does not
    // override it. A machine that ran `playwright install chromium` — the one
    // recovery this block recommends — therefore fails an `--device 'iPhone 15'`
    // screenshot with "Executable doesn't exist at .../webkit-2336/pw_run.sh",
    // an error that never names the flag that caused it. Mobile evidence has to
    // come from a chromium-backed device or the advice sends the agent into a
    // wall the toolbelt itself built.
    const block = toolbeltBlock(detectToolbelt(undefined, env(fakeBin("playwright"))));
    expect(block).toMatch(/--device 'Pixel 7'/);
    expect(block).not.toMatch(/--device '(iPhone|iPad)/i);
    expect(block).toMatch(/Apple descriptor pins webkit/);
  });

  it("still lets a repo withhold the cloud CLIs entirely", () => {
    // An operator who does not want agents near their account narrows the
    // allowlist; detection must not smuggle the new tools in behind that.
    const dir = fakeBin("terraform", "kubectl", "aws", "podman");
    expect(detectToolbelt(["podman"], env(dir)).map((t) => t.name)).toEqual(["podman"]);
  });
});
