import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every test re-imports the module. `logPath` and `done` are module-level
 * state, and `done` is a one-way latch by design — a second test sharing the
 * first one's module instance would find the latch already thrown and record
 * nothing, passing for the wrong reason.
 */
async function freshCrashLog(): Promise<typeof import("./crashlog.js")> {
  vi.resetModules();
  return import("./crashlog.js");
}

/**
 * Captures what `installCrashLog` registers instead of emitting real process
 * events. Emitting them for real would hand the error to vitest's own
 * `uncaughtException` handling and fail the run; the point here is to execute
 * the handler bodies, which this does directly.
 */
function captureHandlers(): Map<string, (arg: never) => void> {
  const handlers = new Map<string, (arg: never) => void>();
  vi.spyOn(process, "on").mockImplementation((event: string | symbol, listener: (...a: never[]) => void) => {
    handlers.set(String(event), listener);
    return process;
  });
  return handlers;
}

describe("crashlog", () => {
  let stateDir: string;
  let stderr: string[];
  let exitCodes: number[];

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "harness-crashlog-"));
    stderr = [];
    exitCodes = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const logFile = () => path.join(stateDir, "harness.log");

  it("writes the reason to harness.log once the state dir is known", async () => {
    const { armCrashLog, recordFatal } = await freshCrashLog();
    armCrashLog(stateDir);

    recordFatal(new Error("the pool died"));

    const written = readFileSync(logFile(), "utf8");
    expect(written).toContain("fatal");
    expect(written).toContain("the pool died");
    expect(written).toContain(`pid=${process.pid}`);
    expect(written.endsWith("\n")).toBe(true);
    // The operator watching the terminal gets the first line, without the stack.
    expect(stderr.join("")).toBe("\nharness: fatal — the pool died\n");
  });

  it("still says why on stderr when it crashed before the repo was resolved", async () => {
    const { recordFatal } = await freshCrashLog();

    recordFatal(new Error("no git repo here"));

    expect(stderr.join("")).toContain("no git repo here");
    expect(existsSync(logFile())).toBe(false);
  });

  it("records something thrown that is not an Error", async () => {
    const { armCrashLog, recordFatal } = await freshCrashLog();
    armCrashLog(stateDir);

    recordFatal("a bare string rejection");

    expect(readFileSync(logFile(), "utf8")).toContain("a bare string rejection");
  });

  it("records an Error carrying no stack", async () => {
    const { armCrashLog, recordFatal } = await freshCrashLog();
    armCrashLog(stateDir);
    const e = new Error("stackless");
    e.stack = undefined;

    recordFatal(e);

    expect(readFileSync(logFile(), "utf8")).toContain("stackless");
  });

  it("logs the first reason only — a throw inside an exit handler must not overwrite the cause", async () => {
    const { armCrashLog, recordFatal } = await freshCrashLog();
    armCrashLog(stateDir);

    recordFatal(new Error("the real cause"));
    recordFatal(new Error("the consequence"));

    const written = readFileSync(logFile(), "utf8");
    expect(written).toContain("the real cause");
    expect(written).not.toContain("the consequence");
  });

  it("does not throw when the log itself cannot be written", async () => {
    const { armCrashLog, recordFatal } = await freshCrashLog();
    // A directory that does not exist: appendFileSync throws ENOENT, and a
    // process on its way out has nothing better to try.
    armCrashLog(path.join(stateDir, "gone", "deeper"));

    expect(() => recordFatal(new Error("boom"))).not.toThrow();
    expect(stderr.join("")).toContain("boom");
  });

  it("logs and exits 1 on an uncaught exception", async () => {
    const { armCrashLog, installCrashLog } = await freshCrashLog();
    const handlers = captureHandlers();
    armCrashLog(stateDir);
    installCrashLog();

    handlers.get("uncaughtException")!(new Error("unhandled throw") as never);

    expect(readFileSync(logFile(), "utf8")).toContain("unhandled throw");
    expect(exitCodes).toEqual([1]);
  });

  it("logs and exits 1 on an unhandled rejection", async () => {
    const { armCrashLog, installCrashLog } = await freshCrashLog();
    const handlers = captureHandlers();
    armCrashLog(stateDir);
    installCrashLog();

    handlers.get("unhandledRejection")!(new Error("nobody caught this") as never);

    const written = readFileSync(logFile(), "utf8");
    expect(written).toContain("unhandledRejection");
    expect(written).toContain("nobody caught this");
    expect(exitCodes).toEqual([1]);
  });

  it("still exits 1 on a rejection that arrives after the reason was already recorded", async () => {
    const { armCrashLog, installCrashLog, recordFatal } = await freshCrashLog();
    const handlers = captureHandlers();
    armCrashLog(stateDir);
    installCrashLog();
    recordFatal(new Error("the first cause"));

    handlers.get("unhandledRejection")!(new Error("the follow-on") as never);

    expect(readFileSync(logFile(), "utf8")).not.toContain("the follow-on");
    expect(exitCodes).toEqual([1]);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ])("records %s as an operator stop, not a crash, and exits %i", async (signal, code) => {
    const { armCrashLog, installCrashLog } = await freshCrashLog();
    const handlers = captureHandlers();
    armCrashLog(stateDir);
    installCrashLog();

    handlers.get(signal)!(undefined as never);

    const written = readFileSync(logFile(), "utf8");
    expect(written).toContain(`signal ${signal}`);
    expect(written).toContain("not a crash");
    expect(written).toContain("harness resume");
    // 128+n, so a supervisor can tell a Ctrl-C'd run from a clean exit.
    expect(exitCodes).toEqual([code]);
  });

  it("exits on a signal that arrives after a crash was already recorded, without relabelling it", async () => {
    const { armCrashLog, installCrashLog, recordFatal } = await freshCrashLog();
    const handlers = captureHandlers();
    armCrashLog(stateDir);
    installCrashLog();
    recordFatal(new Error("crashed first"));

    handlers.get("SIGTERM")!(undefined as never);

    const written = readFileSync(logFile(), "utf8");
    expect(written).toContain("crashed first");
    expect(written).not.toContain("signal SIGTERM");
    expect(exitCodes).toEqual([143]);
  });

  it("is safe to arm more than once — the last state dir wins", async () => {
    const { armCrashLog, recordFatal } = await freshCrashLog();
    const second = mkdtempSync(path.join(tmpdir(), "harness-crashlog-2-"));
    armCrashLog(stateDir);
    armCrashLog(second);

    recordFatal(new Error("late"));

    expect(existsSync(logFile())).toBe(false);
    expect(readFileSync(path.join(second, "harness.log"), "utf8")).toContain("late");
  });
});
