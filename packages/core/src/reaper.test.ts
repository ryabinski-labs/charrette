import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processesUnder, reapUnder, toolingMarkers } from "./reaper.js";

function dir(name: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), `charrette-${name}-`)));
}

const started: number[] = [];

/**
 * An orphan of exactly the shape the run left behind: detached from its parent,
 * no controlling terminal, still sitting in the worktree it was started in.
 */
function orphan(cwd: string): number {
  const child = spawn("sleep", ["120"], { cwd, detached: true, stdio: "ignore" });
  child.unref();
  started.push(child.pid!);
  return child.pid!;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already reaped, which is the point of most of these tests.
    }
  }
});

describe("orphan reaper", () => {
  it("finds a process still running in the worktree after its session is gone", async () => {
    const wt = dir("wt");
    const pid = orphan(wt);
    await new Promise((r) => setTimeout(r, 300));
    expect((await processesUnder(wt)).map((p) => p.pid)).toContain(pid);
  });

  it("kills it, and says what it killed", async () => {
    const wt = dir("wt");
    const pid = orphan(wt);
    await new Promise((r) => setTimeout(r, 300));
    const reaped = await reapUnder(wt, { graceMs: 500 });
    expect(reaped.map((r) => r.pid)).toContain(pid);
    expect(reaped.find((r) => r.pid === pid)!.command).toMatch(/sleep/);
    expect(alive(pid)).toBe(false);
  });

  /**
   * SIGTERM first so a test runner can drop its database connections; SIGKILL
   * for whatever ignores it. A wedged test process — the exact thing that held
   * a worktree open for 13 hours — is under no obligation to take the hint.
   */
  it("escalates to SIGKILL for a process that ignores SIGTERM, and says which signal killed it", async () => {
    const wt = dir("wt");
    const child = spawn("sh", ["-c", 'trap "" TERM; sleep 120'], { cwd: wt, detached: true, stdio: "ignore" });
    child.unref();
    started.push(child.pid!);
    await new Promise((r) => setTimeout(r, 300));

    const reaped = await reapUnder(wt, { graceMs: 500 });

    const mine = reaped.find((r) => r.pid === child.pid);
    expect(mine?.signal).toBe("SIGKILL");
    // Waited for rather than probed: a just-killed child stays a zombie, and so
    // still answers signal 0, until this process reaps it.
    await expect(new Promise((r) => child.on("exit", (_c, s) => r(s)))).resolves.toBe("SIGKILL");
  });

  it("reaches a process in a subdirectory of the worktree", async () => {
    const wt = dir("wt");
    const sub = realpathSync(mkdtempSync(path.join(wt, "backend-")));
    const pid = orphan(sub);
    await new Promise((r) => setTimeout(r, 300));
    await reapUnder(wt, { graceMs: 500 });
    expect(alive(pid)).toBe(false);
  });

  /**
   * The sweep runs against one task's worktree while other tasks are working in
   * theirs. Killing past the boundary would be worse than the leak it fixes.
   */
  it("leaves processes outside the worktree alone", async () => {
    const mine = dir("mine");
    const theirs = dir("theirs");
    const pid = orphan(theirs);
    await new Promise((r) => setTimeout(r, 300));
    expect(await reapUnder(mine, { graceMs: 100 })).toEqual([]);
    expect(alive(pid)).toBe(true);
  });

  it("does not match a sibling directory that shares a name prefix", async () => {
    const base = dir("base");
    const a = realpathSync(mkdtempSync(path.join(base, "task-")));
    const sibling = `${a}-2`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(sibling);
    const pid = orphan(sibling);
    await new Promise((r) => setTimeout(r, 300));
    expect(await reapUnder(a, { graceMs: 100 })).toEqual([]);
    expect(alive(pid)).toBe(true);
  });

  it("never reports this process or its ancestors as reapable", async () => {
    const found = await processesUnder(process.cwd());
    expect(found.map((p) => p.pid)).not.toContain(process.pid);
    expect(found.map((p) => p.pid)).not.toContain(process.ppid);
  });

  it("returns nothing for a directory nobody is working in", async () => {
    expect(await reapUnder(dir("empty"), { graceMs: 50 })).toEqual([]);
  });

  it("does not throw on a path that does not exist", async () => {
    expect(await reapUnder(path.join(tmpdir(), "charrette-does-not-exist-9d3f"), { graceMs: 50 })).toEqual([]);
  });
});

describe("telling the session's own tooling apart from its work", () => {
  const operatorConfig = {
    "chrome-devtools": { type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
    "skills-discovery": { type: "stdio", command: "python3", args: ["/Users/dev/.claude/skills/skills_discovery_mcp.py"] },
  };

  it("recognises an npx-launched MCP server by the package it runs, not by the runtime", () => {
    // What `ps` shows for `npx -y chrome-devtools-mcp@latest`: the runtime is
    // node and the version is gone, so the package name is the only thing left
    // that both strings share.
    const markers = toolingMarkers(operatorConfig);
    const listing = "/opt/homebrew/Cellar/node/25.2.1/bin/node /Users/dev/.npm/_npx/15c6/node_modules/.bin/chrome-devtools-mcp";
    expect(markers.some((m) => listing.includes(m))).toBe(true);
    expect(markers).not.toContain("npx");
    expect(markers).not.toContain("node");
  });

  it("recognises a script-launched MCP server by its path", () => {
    const markers = toolingMarkers(operatorConfig);
    expect(markers.some((m) => "python3 /Users/dev/.claude/skills/skills_discovery_mcp.py".includes(m))).toBe(true);
  });

  it("keeps no marker that would match work as well as tooling", () => {
    const markers = toolingMarkers({
      generic: { command: "python3", args: ["-u", "server.py"] },
      docker: { command: "docker", args: ["run", "-i", "some/image:1"] },
    });
    for (const command of ["python3 train.py", "docker compose up", "cargo build --release", "bash bench/scripts/m1-live-smoke.sh"]) {
      expect(markers.some((m) => command.includes(m))).toBe(false);
    }
  });

  it("throws away an absolute runtime path, which is long enough to look distinctive and is not", () => {
    // `/usr/bin/python3` clears the length and punctuation bars that `python3`
    // alone does not, and would then mark every python an agent ever ran.
    expect(toolingMarkers({ a: { command: "/usr/bin/python3", args: ["/opt/homebrew/bin/node"] } })).toEqual([]);
  });

  it("survives declarations it cannot read", () => {
    expect(toolingMarkers(undefined, null, "not an object", { broken: null }, { noCommand: {} })).toEqual([]);
  });

  it("flags a marked process as tooling and still kills it", async () => {
    const wt = dir("wt");
    const pid = orphan(wt);
    await new Promise((r) => setTimeout(r, 300));

    // `sleep` stands in for the MCP server: a marker changes what the kill is
    // reported as, never whether it happens — tooling must not outlive the
    // session either.
    const reaped = await reapUnder(wt, { graceMs: 500, tooling: ["sleep"] });
    expect(reaped.find((r) => r.pid === pid)!.tooling).toBe(true);
    expect(alive(pid)).toBe(false);
  });

  it("leaves an unmarked process reported as work", async () => {
    const wt = dir("wt");
    const pid = orphan(wt);
    await new Promise((r) => setTimeout(r, 300));

    const reaped = await reapUnder(wt, { graceMs: 500, tooling: ["chrome-devtools-mcp"] });
    expect(reaped.find((r) => r.pid === pid)!.tooling).toBe(false);
  });
});
