import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBash, runShell, type ShellLimits } from "./agentTools.js";

/**
 * Real processes, on purpose: what broke was the relationship between a shell,
 * the descendants it leaves behind and the pipes they inherit, and no fake of
 * `exec` has any of those.
 *
 * Run 614e06d5's demo agents started servers with
 * `cd x && nohup python server.py --port 8102 > log 2>&1 & sleep 6; cat log`,
 * and each such call took the full 30-minute timeout to come back.
 */

let dir: string;
const env = () => ({ PATH: process.env.PATH ?? "", HOME: dir });
const opts = (over: { timeoutMs?: number; signal?: AbortSignal } = {}) => ({
  cwd: dir,
  env: env(),
  timeoutMs: over.timeoutMs ?? 20_000,
  signal: over.signal ?? new AbortController().signal,
});
const limits = (over: Partial<ShellLimits>): ShellLimits => ({ maxBuffer: 1024 * 1024, quietMs: 50, drainMs: 1_000, ...over });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The pid a background process wrote down, once it has. */
async function pidFrom(file: string): Promise<number> {
  const path = join(dir, file);
  for (let i = 0; i < 200 && !(existsSync(path) && readFileSync(path, "utf8").trim()); i++) await wait(10);
  const pid = Number(readFileSync(path, "utf8").trim());
  spawned.push(pid);
  return pid;
}

const spawned: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "charrette-shell-"));
});

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("a command that leaves a server running", () => {
  it("returns when the shell exits, with `&`, and the server keeps running", async () => {
    const started = Date.now();
    const out = await runBash(`sh -c 'echo $$ > server.pid; exec sleep 30' & sleep 0.2; echo started`, {
      cwd: dir,
      env: env(),
      signal: new AbortController().signal,
    });

    expect(out).toContain("started");
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(alive(await pidFrom("server.pid"))).toBe(true);
  }, 15_000);

  it("returns for the exact `cd x && nohup ... > log 2>&1 &` shape that hung, and the server keeps running", async () => {
    const started = Date.now();
    const out = await runBash(
      `mkdir -p x; cd x && nohup sh -c 'echo $$ > ../server.pid; echo up; exec sleep 30' > log 2>&1 & sleep 0.4; cat x/log`,
      { cwd: dir, env: env(), signal: new AbortController().signal }
    );

    expect(out).toContain("up");
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(alive(await pidFrom("server.pid"))).toBe(true);
  }, 15_000);

  it("does not kill a server that writes to the inherited pipe after the call returned", async () => {
    // Closing our end would hand it a SIGPIPE on its next log line.
    await runShell(`sh -c 'echo $$ > server.pid; sleep 0.4; echo late; echo later; exec sleep 30' &`, opts());
    const pid = await pidFrom("server.pid");

    await wait(800);

    expect(alive(pid)).toBe(true);
  }, 15_000);

  it("keeps everything the shell wrote just before it exited", async () => {
    const out = await runShell(`sleep 30 & echo $! > bg.pid; head -c 200000 /dev/zero | tr '\\0' x`, opts());

    await pidFrom("bg.pid");
    expect(out.stdout).toHaveLength(200_000);
    expect(out.code).toBe(0);
  }, 15_000);

  it("stops draining at the bound when a background process never goes quiet", async () => {
    const started = Date.now();
    const out = await runShell(
      // No `sleep` in the loop: forking one per line can outlast the quiet window
      // on a loaded machine, and then this never reaches the bound it is about.
      `sh -c 'echo $$ > bg.pid; while :; do echo x; done' & sleep 0.1; echo done-here`,
      opts(),
      // A bound well past the quiet window: on a busy runner the first check can
      // land late, and one past the bound would end the drain before it looped.
      limits({ maxBuffer: 64 * 1024 * 1024, quietMs: 20, drainMs: 1_500 })
    );

    expect(out.stdout).toContain("done-here");
    expect(out.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(alive(await pidFrom("bg.pid"))).toBe(true);
  }, 15_000);

  it("does not kill a background process for overflowing the cap after the shell has gone", async () => {
    const out = await runShell(`sh -c 'echo $$ > bg.pid; sleep 0.2; exec yes' &`, opts(), limits({ maxBuffer: 1000, quietMs: 600, drainMs: 3_000 }));
    const pid = await pidFrom("bg.pid");

    expect(out.code).toBe(0);
    expect(out.stdout.length).toBeLessThanOrEqual(1000);
    await wait(100);
    expect(alive(pid)).toBe(true);
  }, 15_000);
});

describe("a foreground command behaves as it always did", () => {
  it("captures both streams and the exit code", async () => {
    expect(await runShell(`echo out; echo err >&2; exit 3`, opts())).toEqual({ stdout: "out\n", stderr: "err\n", code: 3 });
  });

  it("waits for a foreground command however long it is quiet", async () => {
    expect((await runShell(`sleep 0.5; echo finished`, opts(), limits({ quietMs: 10, drainMs: 20 }))).stdout).toBe("finished\n");
  });

  it("reports a command killed by a signal as a failure", async () => {
    expect((await runShell(`kill -TERM $$`, opts())).code).toBe(1);
  });

  it("kills a command at the timeout and keeps what it had said", async () => {
    const started = Date.now();
    const out = await runShell(`echo before; sleep 30; echo after`, opts({ timeoutMs: 300 }));

    expect(out.stdout).toBe("before\n");
    expect(out.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("still returns at the timeout from a shell that ignores the signal", async () => {
    const started = Date.now();
    const out = await runShell(
      `trap '' TERM; echo $$ > shell.pid; while :; do sleep 0.05; done`,
      opts({ timeoutMs: 200 }),
      limits({ drainMs: 150 })
    );
    await pidFrom("shell.pid");

    expect(out.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("cuts output at the cap and kills the command that overran it", async () => {
    const started = Date.now();
    const out = await runShell(`head -c 5000 /dev/zero | tr '\\0' x; sleep 30`, opts(), limits({ maxBuffer: 1000 }));

    expect(out.stdout).toHaveLength(1000);
    expect(out.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("stops when the session is aborted", async () => {
    const ctl = new AbortController();
    const running = runShell(`sleep 30`, opts({ signal: ctl.signal }));
    await wait(100);
    ctl.abort();

    expect((await running).code).toBe(1);
  }, 10_000);

  it("reports a shell that could not be started", async () => {
    expect((await runShell(`echo hi`, { ...opts(), cwd: join(dir, "no-such-directory") })).code).toBe(1);
  });
});
