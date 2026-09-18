import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two paths the host operating system decides for you.
 *
 * `workingDirs` prefers lsof and falls back to reading /proc; a macOS box never
 * executes the fallback and a Linux box without lsof never executes the
 * preferred path, so on any single machine half of this file's subject is
 * unreachable. Both are driven here from a stubbed process table.
 */
const h = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  readdirMock: vi.fn(),
  readlinkMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: h.execFileMock };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: h.readdirMock, readlink: h.readlinkMock };
});

import { processesUnder, reapUnder } from "./reaper.js";

/**
 * Stands in for execFile, so each command answers with the stdout it would
 * really produce. The value handed to the callback is the `{stdout, stderr}`
 * pair `promisify(execFile)` resolves with — a bare string would leave the
 * destructuring in reaper.ts reading undefined, and every table would come out
 * empty for the wrong reason.
 */
function commandsAnswer(answers: { ps?: string; lsof?: string }): void {
  h.execFileMock.mockImplementation(
    (cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out?: { stdout: string; stderr: string }) => void) => {
      const stdout = cmd === "ps" ? answers.ps : answers.lsof;
      if (stdout === undefined) cb(new Error(`${cmd}: not found`));
      else cb(null, { stdout, stderr: "" });
      return undefined as never;
    }
  );
}

/** A `ps -Ao pid=,ppid=,tty=,command=` table. */
const psTable = (rows: [number, number, string, string][]) =>
  `${rows.map(([pid, ppid, tty, command]) => `  ${pid}  ${ppid} ${tty} ${command}`).join("\n")}\n`;

beforeEach(() => {
  h.execFileMock.mockReset();
  h.readdirMock.mockReset().mockResolvedValue([]);
  h.readlinkMock.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finding working directories without lsof", () => {
  it("reads them out of /proc instead", async () => {
    commandsAnswer({ ps: psTable([[4123, 1, "??", "node vitest --watch"]]) });
    h.readdirMock.mockResolvedValue(["4123", "self", "cpuinfo", "1"]);
    h.readlinkMock.mockImplementation(async (p: string) =>
      p === "/proc/4123/cwd" ? "/tmp/worktree/sub" : null
    );

    const found = await processesUnder("/tmp/worktree");

    expect(found).toEqual([{ pid: 4123, ppid: 1, tty: "??", command: "node vitest --watch" }]);
    // Only the numeric entries are process directories.
    expect(h.readlinkMock).toHaveBeenCalledTimes(2);
  });

  it("skips a /proc entry whose cwd link cannot be read", async () => {
    commandsAnswer({ ps: psTable([[4123, 1, "??", "node"]]) });
    h.readdirMock.mockResolvedValue(["4123"]);
    h.readlinkMock.mockImplementation(async () => {
      throw new Error("EACCES");
    });

    await expect(processesUnder("/tmp/worktree")).resolves.toEqual([]);
  });

  /**
   * On macOS there is no /proc, so this is the honest answer: the sweep finds no
   * orphans rather than guessing and killing the wrong thing.
   */
  it("finds nothing when there is no lsof and no /proc either", async () => {
    commandsAnswer({ ps: psTable([[4123, 1, "??", "node"]]) });
    h.readdirMock.mockImplementation(async () => {
      throw new Error("ENOENT");
    });

    await expect(processesUnder("/tmp/worktree")).resolves.toEqual([]);
  });

  it("prefers lsof and never looks at /proc when it answers", async () => {
    commandsAnswer({
      ps: psTable([[4123, 1, "??", "node"]]),
      lsof: "p4123\nn/tmp/worktree\n",
    });

    await expect(processesUnder("/tmp/worktree")).resolves.toHaveLength(1);
    expect(h.readdirMock).not.toHaveBeenCalled();
  });

  it("ignores an lsof name line that arrives before any pid", async () => {
    commandsAnswer({ ps: psTable([[4123, 1, "??", "node"]]), lsof: "n/tmp/worktree\np4123\nn/tmp/worktree\n" });

    await expect(processesUnder("/tmp/worktree")).resolves.toHaveLength(1);
  });

  it("ignores a pid lsof reported a cwd for that is not in the process table", async () => {
    commandsAnswer({ ps: psTable([]), lsof: "p4123\nn/tmp/worktree\n" });

    await expect(processesUnder("/tmp/worktree")).resolves.toEqual([]);
  });

  it("leaves alone a process someone is sitting in front of", async () => {
    // A controlling terminal is the operator's own shell in the worktree the
    // gate just told them to go and look at.
    commandsAnswer({ ps: psTable([[4123, 1, "ttys004", "zsh"]]), lsof: "p4123\nn/tmp/worktree\n" });

    await expect(processesUnder("/tmp/worktree")).resolves.toEqual([]);
  });

  it.each(["??", "?", "-"])("treats %s as no controlling terminal", async (tty) => {
    commandsAnswer({ ps: psTable([[4123, 1, tty, "node"]]), lsof: "p4123\nn/tmp/worktree\n" });

    await expect(processesUnder("/tmp/worktree")).resolves.toHaveLength(1);
  });

  it("never reports init, whatever it says its cwd is", async () => {
    commandsAnswer({ ps: psTable([[1, 0, "??", "launchd"]]), lsof: "p1\nn/tmp/worktree\n" });

    await expect(processesUnder("/tmp/worktree")).resolves.toEqual([]);
  });

  it("walks up the parent chain so a sweep can never kill its own ancestry", async () => {
    const parent = 999_001;
    const grandparent = 999_002;
    commandsAnswer({
      ps: psTable([
        [process.pid, parent, "??", "node charrette"],
        [parent, grandparent, "??", "sh"],
        [grandparent, 1, "??", "login"],
      ]),
      lsof: `p${parent}\nn/tmp/worktree\np${grandparent}\nn/tmp/worktree\n`,
    });

    await expect(processesUnder("/tmp/worktree")).resolves.toEqual([]);
  });

  it("stops walking a parent chain that loops back on itself", async () => {
    commandsAnswer({
      ps: psTable([
        [process.pid, 555, "??", "node"],
        [555, process.pid, "??", "sh"],
      ]),
      lsof: "p777\nn/tmp/worktree\n",
    });

    // 777 is not in the table, so nothing is returned — but the walk terminated.
    await expect(processesUnder("/tmp/worktree")).resolves.toEqual([]);
  });
});

describe("a sweep that cannot run at all", () => {
  it("finds nothing when neither ps nor lsof can be run", async () => {
    commandsAnswer({});

    await expect(reapUnder("/tmp/worktree")).resolves.toEqual([]);
  });

  /**
   * The last guard. A sweep is a tidy-up that runs after a task's code is
   * already committed, so nothing it can fail at — including being handed a
   * root that is not a path — may turn a finished session into a failed one.
   */
  it("reports nothing killed rather than throwing, whatever it is given", async () => {
    commandsAnswer({ ps: psTable([]), lsof: "" });

    await expect(reapUnder(undefined as unknown as string)).resolves.toEqual([]);
  });

  /**
   * A process that outlives both signals is not ours to kill — a container
   * runtime's daemon-owned helper, say. Reporting it as reaped would be a lie
   * the operator then acts on.
   */
  it("leaves alone what survives both signals and cannot be signalled", async () => {
    const stubborn = 4123;
    commandsAnswer({ ps: psTable([[stubborn, 1, "??", "root-owned helper"]]), lsof: `p${stubborn}\nn/tmp/worktree\n` });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === stubborn && signal === "SIGKILL") throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return true;
    }) as typeof process.kill);

    await expect(reapUnder("/tmp/worktree", { graceMs: 1 })).resolves.toEqual([]);
  });

  it("shrugs off a pid that vanished between listing and signalling", async () => {
    // pid 2^31-1 is not a running process, so SIGTERM throws ESRCH.
    const gone = 2_147_483_646;
    commandsAnswer({ ps: psTable([[gone, 1, "??", "npm test"]]), lsof: `p${gone}\nn/tmp/worktree\n` });

    // No graceMs: the default is what every caller in the charrette actually
    // gets, and it is the one number here nobody passes explicitly.
    const started = Date.now();
    await expect(reapUnder("/tmp/worktree")).resolves.toEqual([
      { pid: gone, command: "npm test", signal: "SIGTERM", tooling: false },
    ]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  });
});
