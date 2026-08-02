import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { buildProgramMock, parseAsyncMock, installCrashLogMock, recordFatalMock } = vi.hoisted(() => {
  const parseAsyncMock = vi.fn();
  return {
    parseAsyncMock,
    buildProgramMock: vi.fn(() => ({ parseAsync: parseAsyncMock })),
    installCrashLogMock: vi.fn(),
    recordFatalMock: vi.fn(),
  };
});

vi.mock("./cli.js", () => ({ buildProgram: buildProgramMock }));
vi.mock("./crashlog.js", () => ({ installCrashLog: installCrashLogMock, recordFatal: recordFatalMock }));

/** The binary runs its work at import, so each case needs its own module instance. */
async function runMain(): Promise<void> {
  vi.resetModules();
  await import("./main.js");
  // The `.catch()` is attached to a promise, so its handler runs a microtask
  // later than the import that started it.
  await new Promise((resolve) => setImmediate(resolve));
}

describe("the harness binary", () => {
  beforeEach(() => {
    buildProgramMock.mockClear();
    parseAsyncMock.mockReset();
    installCrashLogMock.mockClear();
    recordFatalMock.mockClear();
    vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("installs the crash handlers before parsing anything", async () => {
    parseAsyncMock.mockResolvedValue(undefined);

    await runMain();

    expect(installCrashLogMock).toHaveBeenCalledOnce();
    // Ordering matters: a failure while resolving the repo happens during parse,
    // and is only recorded if the handlers are already on.
    expect(installCrashLogMock.mock.invocationCallOrder[0]!).toBeLessThan(
      buildProgramMock.mock.invocationCallOrder[0]!
    );
    expect(parseAsyncMock).toHaveBeenCalledOnce();
    expect(recordFatalMock).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("records the reason and exits 1 when a command throws", async () => {
    const boom = new Error("no git repository at /tmp/nowhere");
    parseAsyncMock.mockRejectedValue(boom);

    await runMain();

    expect(recordFatalMock).toHaveBeenCalledWith(boom);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
