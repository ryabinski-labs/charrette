import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The command tree, driven the way the operator drives it.
 *
 * Everything the CLI touches that leaves this process — the store, the agent
 * pool, GitHub, the dashboard, the terminal — is replaced here. What is under
 * test is the layer that had never been executed by anything but a human: which
 * settings win, what the banner claims, which run `resume` picks, and what the
 * closing report says happened.
 */

const h = vi.hoisted(() => {
  const storeMethods = {
    listRuns: vi.fn(() => [] as { id: string; state: string; assignment: string }[]),
    getRun: vi.fn(() => undefined as unknown),
    listTasks: vi.fn(() => [] as unknown[]),
    patchRunConfig: vi.fn(),
    spentUsd: vi.fn(() => 0),
    deployStatus: vi.fn(() => null as unknown),
    prodVerdict: vi.fn(() => null as unknown),
  };
  const controllerMethods = {
    startRun: vi.fn(async () => "run-1"),
    resume: vi.fn(async () => undefined),
    outcome: vi.fn(() => ({
      prs: [] as { number: number; title: string }[],
      parked: [] as unknown[],
      merged: 0,
      cancelled: 0,
      total: 0,
      intent: null as unknown,
      ci: null as unknown,
      deploy: null as unknown,
      prod: null as unknown,
      line: "nothing to do",
    })),
    regroupPrs: vi.fn(async () => null as unknown),
    hasRecoverableWork: vi.fn(() => false),
    awaitingVerification: vi.fn(() => false),
  };
  const dashboardMethods = {
    start: vi.fn(async () => "http://localhost:4777/#tok"),
    stop: vi.fn(async () => undefined),
    attach: vi.fn(),
  };
  return {
    storeMethods,
    controllerMethods,
    dashboardMethods,
    subscribers: [] as ((e: { event: Record<string, unknown> }) => void)[],
    controllerArgs: [] as unknown[][],
    dashboardArgs: [] as unknown[][],
    StoreMock: vi.fn(() => storeMethods),
    BusMock: vi.fn(),
    AgentPoolMock: vi.fn(),
    GitHubAdapterMock: vi.fn(),
    RunControllerMock: vi.fn(),
    DashboardMock: vi.fn(),
    detectToolbeltMock: vi.fn(() => [] as { name: string }[]),
    missingKeysMock: vi.fn(() => [] as string[]),
    ensureIgnoredMock: vi.fn(() => false),
    repoUnusableMock: vi.fn(async () => null as string | null),
    checkMemoryBannerMock: vi.fn(() => [] as string[]),
    originSlugMock: vi.fn(async () => "acme/widgets" as string | null),
    detectChecksMock: vi.fn(() => ({ checks: ["npm test"], source: "package.json" })),
    loadFileConfigMock: vi.fn(() => ({ config: {} as Record<string, unknown>, path: null as string | null })),
    resolveGitHubMock: vi.fn(
      (): { token?: string; slug?: string; source: string } => ({
        token: "gh-tok",
        slug: "acme/widgets",
        source: "git remote",
      })
    ),
    resolveRepoRootMock: vi.fn((p: string) => p),
    existsSyncMock: vi.fn(() => false),
    mkdirSyncMock: vi.fn(),
    writeFileSyncMock: vi.fn(),
    createInterfaceMock: vi.fn(),
    notifyDoneMock: vi.fn(),
    armCrashLogMock: vi.fn(),
    promptSeedMock: vi.fn(async () => "seed from the conversation"),
    chatCloseMock: vi.fn(),
    TerminalChatMock: vi.fn(),
    // The report's content is settled in postmortem.test.ts; what the CLI owes
    // is picking the right run and saying so when there is none.
    postmortemMock: vi.fn((_store: unknown, runId: string) => ({ runId })),
    renderPostmortemMock: vi.fn((p: { runId: string }) => `Run ${p.runId} [state] — assignment`),
  };
});

vi.mock("@harness/core", () => ({
  Store: h.StoreMock,
  Bus: h.BusMock,
  AgentPool: h.AgentPoolMock,
  GitHubAdapter: h.GitHubAdapterMock,
  RunController: h.RunControllerMock,
  detectToolbelt: h.detectToolbeltMock,
  ensureIgnored: h.ensureIgnoredMock,
  // The rule itself is unit-tested against real repositories in core; here it
  // stands in so a test can prove `run` and `resume` actually stop.
  repoUnusable: h.repoUnusableMock,
  // What the lines say is settled in memory.test.ts against a real database.
  // What the CLI owes is asking about the checks this run will actually use,
  // and putting the answer where the operator reads before approving a plan.
  checkMemoryBanner: h.checkMemoryBannerMock,
  // Pinned, so the banner assertion is about the line existing rather than
  // about whatever commit this checkout happens to be on.
  harnessBuild: () => "0.0.1@7453d60",
  // The rule this stands in for is unit-tested against the real implementation
  // in core; here it exists so a test can prove `harness run` actually refuses
  // when a routed provider has no key.
  missingKeys: h.missingKeysMock,
  originSlug: h.originSlugMock,
  postmortem: h.postmortemMock,
  renderPostmortem: h.renderPostmortemMock,
}));
vi.mock("@harness/dashboard", () => ({ Dashboard: h.DashboardMock }));
vi.mock("./defaults.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./defaults.js")>();
  return {
    ...actual,
    detectChecks: h.detectChecksMock,
    loadFileConfig: h.loadFileConfigMock,
    resolveGitHub: h.resolveGitHubMock,
    resolveRepoRoot: h.resolveRepoRootMock,
  };
});
vi.mock("./chat.js", () => ({ TerminalChat: h.TerminalChatMock }));
vi.mock("./crashlog.js", () => ({ armCrashLog: h.armCrashLogMock }));
vi.mock("./notify.js", () => ({ notifyDone: h.notifyDoneMock }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: h.existsSyncMock, mkdirSync: h.mkdirSyncMock, writeFileSync: h.writeFileSyncMock };
});
vi.mock("node:readline/promises", () => ({ createInterface: h.createInterfaceMock }));

import type { GateHandler } from "@harness/core";
import { buildProgram, modelOverrides } from "./cli.js";

let out: string[];

/** Everything the CLI printed, as one string. */
const printed = () => out.join("");

/** Drives the command tree exactly as the shell would, minus the argv preamble. */
async function cli(...argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv, { from: "user" });
}

/** The gates the CLI handed the controller — the terminal ones unless a dashboard took over. */
function gatesGiven(): GateHandler {
  return h.controllerArgs.at(-1)![4] as GateHandler;
}

/** The bus listener the CLI installed, for feeding it events. */
function busListener(): (e: { event: Record<string, unknown> }) => void {
  return h.subscribers.at(-1)!;
}

/** Scripts one readline answer, exposing the prompt it was asked with and whether it closed. */
function answerOnce(answer: string): { close: ReturnType<typeof vi.fn>; question: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const question = vi.fn(async () => answer);
  h.createInterfaceMock.mockReturnValue({ question, close });
  return { close, question };
}

/** A task escalation with nothing filled in — each case overrides what it is about. */
const GATE = {
  runId: "run-1",
  taskId: "t",
  title: "T",
  why: "why",
  recommendation: "",
  iterations: 3,
  branch: null,
  worktreePath: null,
};

const RUN_OUTCOME = {
  prs: [],
  parked: [],
  merged: 0,
  cancelled: 0,
  total: 0,
  intent: null,
  ci: null,
  deploy: null,
  prod: null,
  line: "nothing to do",
};

beforeEach(() => {
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });

  h.subscribers.length = 0;
  h.controllerArgs.length = 0;
  h.dashboardArgs.length = 0;

  for (const fn of [
    ...Object.values(h.storeMethods),
    ...Object.values(h.controllerMethods),
    ...Object.values(h.dashboardMethods),
  ]) {
    fn.mockReset();
  }
  h.storeMethods.listRuns.mockReturnValue([]);
  h.storeMethods.getRun.mockReturnValue(undefined);
  h.storeMethods.listTasks.mockReturnValue([]);
  h.storeMethods.spentUsd.mockReturnValue(0);
  h.storeMethods.deployStatus.mockReturnValue(null);
  h.storeMethods.prodVerdict.mockReturnValue(null);
  h.controllerMethods.startRun.mockResolvedValue("run-1");
  h.controllerMethods.resume.mockResolvedValue(undefined);
  h.controllerMethods.outcome.mockReturnValue({ ...RUN_OUTCOME });
  h.controllerMethods.regroupPrs.mockResolvedValue(null);
  h.controllerMethods.hasRecoverableWork.mockReturnValue(false);
  h.controllerMethods.awaitingVerification.mockReturnValue(false);
  h.dashboardMethods.start.mockResolvedValue("http://localhost:4777/#tok");
  h.dashboardMethods.stop.mockResolvedValue(undefined);

  h.StoreMock.mockReset().mockImplementation(() => h.storeMethods);
  h.BusMock.mockReset().mockImplementation(() => ({
    subscribe: (fn: (e: { event: Record<string, unknown> }) => void) => void h.subscribers.push(fn),
  }));
  h.AgentPoolMock.mockReset();
  h.GitHubAdapterMock.mockReset();
  h.RunControllerMock.mockReset().mockImplementation((...args: unknown[]) => {
    h.controllerArgs.push(args);
    return h.controllerMethods;
  });
  h.DashboardMock.mockReset().mockImplementation((...args: unknown[]) => {
    h.dashboardArgs.push(args);
    return h.dashboardMethods;
  });

  h.detectToolbeltMock.mockReset().mockReturnValue([]);
  h.missingKeysMock.mockReset().mockReturnValue([]);
  h.ensureIgnoredMock.mockReset().mockReturnValue(false);
  h.repoUnusableMock.mockReset().mockResolvedValue(null);
  h.checkMemoryBannerMock.mockReset().mockReturnValue([]);
  h.originSlugMock.mockReset().mockResolvedValue("acme/widgets");
  h.detectChecksMock.mockReset().mockReturnValue({ checks: ["npm test"], source: "package.json" });
  h.loadFileConfigMock.mockReset().mockReturnValue({ config: {}, path: null });
  h.resolveGitHubMock.mockReset().mockReturnValue({ token: "gh-tok", slug: "acme/widgets", source: "git remote" });
  h.resolveRepoRootMock.mockReset().mockImplementation((p: string) => p);
  h.existsSyncMock.mockReset().mockReturnValue(false);
  h.mkdirSyncMock.mockReset();
  h.writeFileSyncMock.mockReset();
  h.createInterfaceMock.mockReset();
  h.notifyDoneMock.mockReset();
  h.armCrashLogMock.mockReset();
  h.promptSeedMock.mockReset().mockResolvedValue("seed from the conversation");
  h.chatCloseMock.mockReset();
  h.TerminalChatMock.mockReset().mockImplementation(() => ({
    promptSeed: h.promptSeedMock,
    close: h.chatCloseMock,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("harness run — resolving what the run will actually do", () => {
  it("auto-detects checks and reports where each setting came from", async () => {
    await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard");

    const banner = printed();
    expect(banner).toContain("repo       /repo");
    // Which harness this is, before anything is spent — the same string every
    // session it spawns is stamped with.
    expect(banner).toContain("build      0.0.1@7453d60");
    expect(banner).toContain("checks     npm test   (auto-detected from package.json)");
    expect(banner).toContain("budget     run $30 · task $10   (defaults)");
    expect(banner).toContain("github     acme/widgets   (git remote)");
    expect(banner).toContain("prs        one rollup PR for the whole run   (default)");
    expect(banner).toContain("tools      none detected on PATH");
  });

  it("says nothing about models when every role is on the Anthropic default", async () => {
    // A line that never changes is a line nobody reads.
    await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard");
    expect(printed()).not.toContain("models     ");
  });

  it("names each role that was moved to another vendor", async () => {
    h.loadFileConfigMock.mockReturnValue({
      config: { models: { worker: "gpt-5.6-terra", demo: "gemini-3.5-flash-lite" } },
      path: "/repo/harness.config.json",
    });
    await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard");

    const banner = printed();
    expect(banner).toContain("worker→gpt-5.6-terra");
    expect(banner).toContain("demo→gemini-3.5-flash-lite");
    expect(banner).toContain("judging roles stay on Anthropic");
  });

  it("refuses the run when a routed provider has no key, before anything is spent", async () => {
    // `integrator` runs after every worker in the epic has been paid for.
    // Finding out there that the key was never exported wastes the epic.
    h.missingKeysMock.mockReturnValue(["OPENAI_API_KEY is not set, but worker (gpt-5.6-terra) is routed to openai."]);
    await expect(cli("run", "build a thing", "--repo", "/repo", "--no-dashboard")).rejects.toThrow(/OPENAI_API_KEY is not set/);
    expect(h.RunControllerMock).not.toHaveBeenCalled();
  });

  it("refuses a config that points a judging role off Anthropic", async () => {
    // Enforced by the config schema itself, so it cannot be reached by any
    // other entry point either.
    h.loadFileConfigMock.mockReturnValue({ config: { models: { qa: "gpt-5.6-terra" } }, path: "/repo/harness.config.json" });
    await expect(cli("run", "build a thing", "--repo", "/repo", "--no-dashboard")).rejects.toThrow(/pinned to Anthropic/);
  });

  it("takes a routing change from the command line, over the config file", async () => {
    h.loadFileConfigMock.mockReturnValue({ config: { models: { worker: "claude-sonnet-5" } }, path: "/repo/harness.config.json" });
    await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard", "--model", "worker=gpt-5.6-terra", "--model", "demo=gemini-3.5-flash-lite");

    const banner = printed();
    expect(banner).toContain("worker→gpt-5.6-terra");
    expect(banner).toContain("demo→gemini-3.5-flash-lite");
  });

  it("says when the run will stop to show you what it built, and how often", async () => {
    await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("pit stops  after every epic   (default)");
  });

  it.each([
    [{ tasks: 5 }, "every 5 merged tasks"],
    [{ usd: 100 }, "every $100 spent"],
    [{ minutes: 90 }, "every 90 minutes"],
    ["epic", "after every epic"],
  ])("reports the configured interval %j as %s", async (every, expected) => {
    h.loadFileConfigMock.mockReturnValue({ config: { pitStop: { every } }, path: "/repo/harness.config.json" });

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain(`pit stops  ${expected}   (harness.config.json)`);
  });

  it("says plainly what turning them off costs", async () => {
    h.loadFileConfigMock.mockReturnValue({ config: { pitStop: { every: "never" } }, path: "/repo/harness.config.json" });

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("pit stops  off — nothing between the plan gate and the diff");
  });

  it("prefers --check over anything the repo suggests", async () => {
    h.loadFileConfigMock.mockReturnValue({ config: { deterministicChecks: ["make ci"] }, path: "/repo/harness.config.json" });

    await cli("run", "x", "--repo", "/repo", "--no-dashboard", "--check", "go test ./...", "go vet ./...");

    expect(printed()).toContain("checks     go test ./... · go vet ./...   (--check)");
    expect(h.detectChecksMock).not.toHaveBeenCalled();
  });

  it("takes the config file's checks when no flag overrides them", async () => {
    h.loadFileConfigMock.mockReturnValue({ config: { deterministicChecks: ["make ci"] }, path: "/repo/harness.config.json" });

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("checks     make ci   (harness.config.json)");
    expect(printed()).toContain("config     harness.config.json");
  });

  it("warns that QA has no hard signal when checks are turned off", async () => {
    await cli("run", "x", "--repo", "/repo", "--no-dashboard", "--no-checks");

    expect(printed()).toContain("checks     none (--no-checks) — QA has no hard signal");
  });

  it("says so when auto-detection finds nothing to run", async () => {
    h.detectChecksMock.mockReturnValue({ checks: [], source: "no test script" });

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("checks     none (auto-detected from no test script)");
  });

  it("takes budget caps from the flags when given", async () => {
    await cli("run", "x", "--repo", "/repo", "--no-dashboard", "--run-cap", "120", "--task-cap", "15");

    expect(printed()).toContain("budget     run $120 · task $15   (flags)");
  });

  it("takes budget caps from the config file otherwise", async () => {
    h.loadFileConfigMock.mockReturnValue({
      config: { budget: { runCapUsd: 500, taskCapUsd: 25 } },
      path: "/repo/harness.config.json",
    });

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("budget     run $500 · task $25   (harness.config.json)");
  });

  it.each([
    ["--run-cap", "0"],
    ["--run-cap", "-5"],
    ["--task-cap", "not-a-number"],
  ])("refuses %s %s rather than running with a nonsense cap", async (flag, value) => {
    await expect(cli("run", "x", "--repo", "/repo", "--no-dashboard", flag, value)).rejects.toThrow(
      `${flag} must be a positive number, got "${value}"`
    );
  });

  it("reports the skills directories and the tools the agents will be offered", async () => {
    h.detectToolbeltMock.mockReturnValue([{ name: "rtk" }, { name: "gh" }]);
    h.loadFileConfigMock.mockReturnValue({ config: { skillsDirs: ["~/my-skills"] }, path: "/repo/harness.config.json" });

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toMatch(/skills {5}\S*my-skills {3}\(harness\.config\.json\)/);
    expect(printed()).toContain("tools      rtk · gh   (offered to worker + QA agents)");
    // `~` must be expanded before it reaches a config the agents read.
    expect(printed()).not.toContain("~/my-skills");
  });

  it("says nothing about PR mode when there is no GitHub repo to open one on", async () => {
    h.resolveGitHubMock.mockReturnValue({ token: undefined, slug: undefined, source: "no remote and no config" });

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("github     no remote and no config");
    expect(printed()).not.toContain("prs   ");
  });

  it("credits the config file when it asks for the mode that is also the default", async () => {
    h.loadFileConfigMock.mockReturnValue({ config: { prMode: "single" }, path: "/repo/harness.config.json" });

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("prs        one rollup PR for the whole run   (harness.config.json)");
  });

  it("reports per-task PR mode when the config asks for it", async () => {
    h.loadFileConfigMock.mockReturnValue({ config: { prMode: "per-task" }, path: "/repo/harness.config.json" });

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("prs        one PR per task   (harness.config.json)");
  });

  it("warns that other open runs in this repo are invisible to this one", async () => {
    h.storeMethods.listRuns.mockReturnValue([
      { id: "run-a", state: "EXECUTING", assignment: "other work" },
      { id: "run-b", state: "DONE", assignment: "finished work" },
    ]);

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("WARNING    1 run is still open in this repo: run-a (EXECUTING)");
    expect(printed()).toContain("this run forks from the base branch as it is now");
  });

  it("pluralises the staleness warning", async () => {
    h.storeMethods.listRuns.mockReturnValue([
      { id: "run-a", state: "EXECUTING", assignment: "" },
      { id: "run-c", state: "PLANNING", assignment: "" },
    ]);

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("WARNING    2 runs are still open in this repo: run-a (EXECUTING), run-c (PLANNING)");
  });
});

describe("a repository no run can be built in", () => {
  const WHY = "/repo is a git repository with no commits, so there is nothing for a worktree to branch from.\n\n  git add -A && git commit -m \"initial commit\"";
  // Restored between cases: a failed exit code left behind would fail the whole
  // test process, whatever the rest of the suite did.
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    exitCode = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = exitCode;
  });

  it("stops `run` before the intake agent is paid for", async () => {
    h.repoUnusableMock.mockResolvedValue(WHY);
    await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("no commits");
    // Not one of these: no store opened, no .harness written, nothing spent.
    expect(h.RunControllerMock).not.toHaveBeenCalled();
    expect(h.controllerMethods.startRun).not.toHaveBeenCalled();
    expect(h.armCrashLogMock).not.toHaveBeenCalled();
  });

  it("prints the command that fixes it, all of it", async () => {
    h.repoUnusableMock.mockResolvedValue(WHY);
    await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard");
    // The whole reason, not its first line — that is why this is printed and
    // not thrown, since the crash log renders only an error's opening line.
    expect(printed()).toContain('git add -A && git commit -m "initial commit"');
  });

  it("fails the exit code, so a script wrapping the harness can tell", async () => {
    h.repoUnusableMock.mockResolvedValue(WHY);
    await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard");
    expect(process.exitCode).toBe(1);
  });

  it("stops `resume` too — a resumed run needs a worktree just as much", async () => {
    h.repoUnusableMock.mockResolvedValue(WHY);
    await cli("resume", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("no commits");
    expect(h.controllerMethods.resume).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("asks about the repository root, not the directory the operator happened to be in", async () => {
    h.resolveRepoRootMock.mockReturnValue("/repo/root");
    await cli("run", "build a thing", "--repo", "/repo/sub/dir", "--no-dashboard");
    expect(h.repoUnusableMock).toHaveBeenCalledWith("/repo/root");
  });
});

/**
 * What an earlier run in this repo watched the checks do, surfaced at the one
 * moment it is still free to act on. A check that was red before any task
 * started parks every task in the run, and the operator finds out task by task,
 * after paying for each.
 */
describe("what the repo already knows about its checks", () => {
  const RED = ["memory     what earlier runs in this repo watched happen:", "           $ npm test was already failing on the base of run 40da9337 (today)"];

  it("puts it in `run`'s banner, above the plan gate", async () => {
    h.checkMemoryBannerMock.mockReturnValue(RED);
    await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard");
    expect(printed()).toContain("was already failing on the base of run 40da9337");
  });

  it("asks about the checks this run will actually use, not some other run's", async () => {
    await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard", "--check", "pnpm build", "--check", "pnpm test");
    expect(h.checkMemoryBannerMock).toHaveBeenCalledWith(h.storeMethods, ["pnpm build", "pnpm test"]);
  });

  it("adds nothing to the banner when the repo has never been observed", async () => {
    h.checkMemoryBannerMock.mockReturnValue([]);
    await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard");
    expect(printed()).not.toContain("what earlier runs in this repo watched happen");
  });

  it("tells `resume` too — a resumed run inherits the same base", async () => {
    h.checkMemoryBannerMock.mockReturnValue(RED);
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "EXECUTING", assignment: "a" }]);
    h.storeMethods.getRun.mockReturnValue({ id: "run-1", state: "EXECUTING", config: { deterministicChecks: ["npm test"] } });

    await cli("resume", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("was already failing on the base of run 40da9337");
    expect(h.checkMemoryBannerMock).toHaveBeenCalledWith(h.storeMethods, ["npm test"]);
  });

  it("reads `resume`'s corrected checks, not the ones it is abandoning", async () => {
    // The config file has just overridden the run's frozen checks; the memory
    // worth showing is about the commands that are going to run.
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "EXECUTING", assignment: "a" }]);
    h.loadFileConfigMock.mockReturnValue({ config: { deterministicChecks: ["pnpm test"] }, path: "/repo/harness.config.json" });
    h.storeMethods.getRun
      .mockReturnValueOnce({ id: "run-1", state: "EXECUTING", config: { deterministicChecks: ["npm test"] } })
      .mockReturnValue({ id: "run-1", state: "EXECUTING", config: { deterministicChecks: ["pnpm test"] } });

    await cli("resume", "--repo", "/repo", "--no-dashboard");

    expect(h.checkMemoryBannerMock).toHaveBeenLastCalledWith(h.storeMethods, ["pnpm test"]);
  });

  it("survives a resume naming a run this repo has never heard of", async () => {
    h.storeMethods.getRun.mockReturnValue(undefined);
    await cli("resume", "run-nope", "--repo", "/repo", "--no-dashboard");
    expect(h.checkMemoryBannerMock).toHaveBeenCalledWith(h.storeMethods, []);
  });

  it("says nothing on `resume` when there is nothing remembered", async () => {
    h.checkMemoryBannerMock.mockReturnValue([]);
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "EXECUTING", assignment: "a" }]);
    h.storeMethods.getRun.mockReturnValue({ id: "run-1", state: "EXECUTING", config: { deterministicChecks: ["npm test"] } });

    await cli("resume", "--repo", "/repo", "--no-dashboard");

    expect(printed()).not.toContain("what earlier runs in this repo watched happen");
  });
});

describe("harness run — the dashboard", () => {
  it("serves the dashboard by default and prints the URL with its token", async () => {
    await cli("run", "x", "--repo", "/repo");

    expect(h.DashboardMock).toHaveBeenCalledOnce();
    expect(h.dashboardArgs[0]![2]).toEqual({ port: undefined });
    expect(h.dashboardMethods.attach).toHaveBeenCalledWith(h.controllerMethods);
    expect(printed()).toContain("dashboard  http://localhost:4777/#tok   (the fragment is your auth token)");
    expect(h.dashboardMethods.stop).toHaveBeenCalledOnce();
  });

  it("pins the port when asked", async () => {
    await cli("run", "x", "--repo", "/repo", "--port", "5000");

    expect(h.dashboardArgs[0]![2]).toEqual({ port: 5000 });
  });

  it("takes the port from the config file when no flag pins it", async () => {
    h.loadFileConfigMock.mockReturnValue({ config: { dashboardPort: 6001 }, path: "/repo/harness.config.json" });

    await cli("run", "x", "--repo", "/repo");

    expect(h.dashboardArgs[0]![2]).toEqual({ port: 6001 });
  });

  it.each(["0", "65536", "4777.5"])("refuses port %s", async (value) => {
    await expect(cli("run", "x", "--repo", "/repo", "--port", value)).rejects.toThrow(
      `--port must be 1-65535, got "${value}"`
    );
  });

  it("says the plan gate will be answered in the terminal when the dashboard is off", async () => {
    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(h.DashboardMock).not.toHaveBeenCalled();
    expect(printed()).toContain("dashboard  off — the plan gate will be resolved in this terminal");
  });

  it("honours dashboard:false from the config file", async () => {
    h.loadFileConfigMock.mockReturnValue({ config: { dashboard: false }, path: "/repo/harness.config.json" });

    await cli("run", "x", "--repo", "/repo");

    expect(h.DashboardMock).not.toHaveBeenCalled();
  });

  it("lets --dashboard override dashboard:false in the config file", async () => {
    h.loadFileConfigMock.mockReturnValue({ config: { dashboard: false }, path: "/repo/harness.config.json" });

    await cli("run", "x", "--repo", "/repo", "--dashboard");

    expect(h.DashboardMock).toHaveBeenCalledOnce();
  });
});

describe("harness run — intake", () => {
  it("plans straight from an assignment given on the command line", async () => {
    await cli("run", "build the thing", "--repo", "/repo", "--no-dashboard");

    expect(h.TerminalChatMock).not.toHaveBeenCalled();
    expect(h.controllerMethods.startRun).toHaveBeenCalledWith("build the thing", expect.any(Object), undefined);
    expect(printed()).toContain("intake     off — planning directly from the assignment");
  });

  it("opens a conversation when no assignment is given", async () => {
    await cli("run", "--repo", "/repo", "--no-dashboard");

    expect(h.promptSeedMock).toHaveBeenCalledWith(true);
    expect(h.controllerMethods.startRun).toHaveBeenCalledWith(
      "seed from the conversation",
      expect.any(Object),
      expect.objectContaining({ promptSeed: h.promptSeedMock })
    );
    expect(printed()).toContain("intake     conversation before planning   (default)");
    expect(h.chatCloseMock).toHaveBeenCalledOnce();
  });

  it("takes the assignment but still talks it through when --chat is given", async () => {
    await cli("run", "build the thing", "--repo", "/repo", "--no-dashboard", "--chat");

    expect(printed()).toContain("intake     conversation before planning   (--chat)");
    // The assignment on the command line is still what seeds the run.
    expect(h.controllerMethods.startRun).toHaveBeenCalledWith("build the thing", expect.any(Object), expect.any(Object));
  });

  it("skips the conversation when --no-chat is given without an assignment", async () => {
    await cli("run", "--repo", "/repo", "--no-dashboard", "--no-chat");

    // No assignment and no chat: the seed still has to come from somewhere, so
    // the prompter is asked without the conversation flag.
    expect(h.promptSeedMock).toHaveBeenCalledWith(false);
    expect(h.controllerMethods.startRun).toHaveBeenCalledWith("seed from the conversation", expect.any(Object), undefined);
  });

  it("honours chat:false from the config file", async () => {
    h.loadFileConfigMock.mockReturnValue({ config: { chat: false }, path: "/repo/harness.config.json" });

    await cli("run", "build it", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("intake     off");
  });

  it("honours chat:true from the config file", async () => {
    h.loadFileConfigMock.mockReturnValue({ config: { chat: true }, path: "/repo/harness.config.json" });

    await cli("run", "build it", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("intake     conversation before planning   (harness.config.json)");
  });

  it("notifies, closes the chat and stops the dashboard when the run throws", async () => {
    h.controllerMethods.startRun.mockRejectedValue(new Error("the pool died"));

    await expect(cli("run", "x", "--repo", "/repo")).rejects.toThrow("the pool died");

    expect(h.notifyDoneMock).toHaveBeenCalledWith("repo — run stopped", "the pool died");
    expect(h.dashboardMethods.stop).toHaveBeenCalledOnce();
  });

  it("reports a non-Error failure as its string form", async () => {
    h.controllerMethods.startRun.mockRejectedValue("just a string");

    await expect(cli("run", "x", "--repo", "/repo", "--no-dashboard")).rejects.toBe("just a string");

    expect(h.notifyDoneMock).toHaveBeenCalledWith("repo — run stopped", "just a string");
  });
});

describe("wiring the controller", () => {
  it("creates the state directory, arms the crash log, and keeps .harness out of git", async () => {
    h.ensureIgnoredMock.mockReturnValue(true);

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(h.mkdirSyncMock).toHaveBeenCalledWith("/repo/.harness", { recursive: true });
    expect(h.armCrashLogMock).toHaveBeenCalledWith("/repo/.harness");
    expect(h.StoreMock).toHaveBeenCalledWith("/repo/.harness/harness.db");
    expect(printed()).toContain("added .harness/ to .gitignore");
  });

  it("says nothing when .gitignore already covered it", async () => {
    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(printed()).not.toContain("added .harness/");
  });

  it("keeps the GitHub token in this process and hands the adapter the slug", async () => {
    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(h.GitHubAdapterMock).toHaveBeenCalledWith("gh-tok", "acme/widgets");
  });
});

describe("what the run narrates to the terminal", () => {
  const publish = (event: Record<string, unknown>) => busListener()({ event });

  beforeEach(async () => {
    await cli("run", "x", "--repo", "/repo", "--no-dashboard");
    out.length = 0;
  });

  it("prints the first line of an agent log against its task", () => {
    publish({ type: "agent.log", taskId: "pack-download", text: "starting the download\nsecond line" });

    expect(printed()).toBe("  [pack-download] starting the download\n");
  });

  it("attributes a log with no task to the run", () => {
    publish({ type: "agent.log", taskId: null, text: "planning" });

    expect(printed()).toBe("  [run] planning\n");
  });

  it("truncates a very long log line", () => {
    publish({ type: "agent.log", taskId: "t", text: "x".repeat(500) });

    expect(printed()).toBe(`  [t] ${"x".repeat(120)}\n`);
  });

  it("prints run and task state changes, with the reason when there is one", () => {
    publish({ type: "run.state_changed", from: "PLANNING", to: "EXECUTING" });
    publish({ type: "task.state_changed", taskId: "auth", from: "WORKING", to: "QA", reason: "worker finished" });

    expect(printed()).toBe("▶ run: PLANNING → EXECUTING\n▶ task auth: WORKING → QA (worker finished)\n");
  });

  it("treats a task event with a null task id as a run event", () => {
    publish({ type: "task.state_changed", taskId: null, from: "A", to: "B" });

    expect(printed()).toBe("▶ run: A → B\n");
  });

  it("prints spend, QA verdicts and delivered feedback", () => {
    publish({ type: "agent.usage", costUsd: 0.12345, model: "claude-opus-5" });
    publish({ type: "task.qa_verdict", taskId: "auth", iteration: 2, verdict: "REJECTED" });
    publish({ type: "task.feedback", taskId: "auth", delivery: "mid-flight" });

    expect(printed()).toBe("  $ 0.123 (claude-opus-5)\n  QA[auth] iteration 2: REJECTED\n  ✉ your feedback → auth (mid-flight)\n");
  });

  it("ignores an event type it has nothing to say about", () => {
    publish({ type: "task.gate_opened", taskId: "auth" });

    expect(printed()).toBe("");
  });

  it("stays silent for the intake agent, which owns the terminal while it talks", () => {
    publish({ type: "agent.spawned", role: "intake", sessionId: "sess-intake" });
    publish({ type: "agent.log", sessionId: "sess-intake", taskId: null, text: "asking a question" });

    expect(printed()).toBe("");
  });

  it("still narrates other agents while the intake agent is open", () => {
    publish({ type: "agent.spawned", role: "intake", sessionId: "sess-intake" });
    publish({ type: "agent.log", sessionId: "sess-worker", taskId: "auth", text: "working" });

    expect(printed()).toBe("  [auth] working\n");
  });

  it("does not treat a worker spawn as an intake session", () => {
    publish({ type: "agent.spawned", role: "worker", sessionId: "sess-worker" });
    publish({ type: "agent.log", sessionId: "sess-worker", taskId: "auth", text: "working" });

    expect(printed()).toBe("  [auth] working\n");
  });
});

describe("the terminal gates", () => {
  beforeEach(async () => {
    await cli("run", "x", "--repo", "/repo", "--no-dashboard");
    out.length = 0;
  });

  it("shows the PRD and the breakdown, and approves on y", async () => {
    const { close } = answerOnce(" Y ");

    await expect(gatesGiven().resolvePlanGate("the PRD", "the breakdown")).resolves.toEqual({
      approved: true,
      feedback: "",
    });
    expect(printed()).toContain("===== GENERATED PRD =====\nthe PRD");
    expect(printed()).toContain("===== TASK BREAKDOWN =====\nthe breakdown");
    expect(close).toHaveBeenCalledOnce();
  });

  it("treats anything else as rejection feedback", async () => {
    answerOnce("split the auth task in two");

    await expect(gatesGiven().resolvePlanGate("prd", "summary")).resolves.toEqual({
      approved: false,
      feedback: "split the auth task in two",
    });
  });

  it("records an empty rejection as one, rather than as approval", async () => {
    answerOnce("   ");

    await expect(gatesGiven().resolvePlanGate("prd", "summary")).resolves.toEqual({
      approved: false,
      feedback: "rejected without feedback",
    });
  });

  it("routes the budget gate to the cap prompt", async () => {
    answerOnce("s");

    await expect(
      gatesGiven().resolveBudgetGate({ scope: "run", spentUsd: 30, capUsd: 30, runSpentUsd: 30 })
    ).resolves.toBeNull();
  });

  it("tells the operator where a stuck task's work is, and what is suggested", async () => {
    const { close, question } = answerOnce("y");

    const answer = await gatesGiven().resolveTaskGate!({
      ...GATE,
      taskId: "settlement-hold-engine",
      title: "Settlement hold engine",
      why: "still not accepted after 45 minutes\nmore detail",
      branch: "harness/run-1/settlement-hold-engine",
      worktreePath: "/repo/.harness/worktrees/settlement-hold-engine",
      recommendation: "merge the current tip and re-run the suite",
    });

    const shown = printed();
    expect(shown).toContain("===== TASK NEEDS YOU =====");
    expect(shown).toContain("Settlement hold engine (settlement-hold-engine)");
    expect(shown).toContain("still not accepted after 45 minutes");
    expect(shown).not.toContain("more detail");
    expect(shown).toContain("Its work so far is on harness/run-1/settlement-hold-engine");
    expect(shown).toContain("Worktree: /repo/.harness/worktrees/settlement-hold-engine");
    expect(shown).toContain("Suggested answer: merge the current tip and re-run the suite");
    expect(question).toHaveBeenCalledWith("Your guidance [y = send the suggested answer / enter = park the task] ");
    // `y` accepts the suggestion rather than sending the letter y to the agent.
    expect(answer).toBe("merge the current tip and re-run the suite");
    expect(close).toHaveBeenCalledOnce();
  });

  it("sends the operator's own words when they type them", async () => {
    answerOnce("the table is never created — call EnsureTable from main");

    await expect(
      gatesGiven().resolveTaskGate!({ ...GATE, recommendation: "something else" })
    ).resolves.toBe("the table is never created — call EnsureTable from main");
  });

  it("parks the task on an empty answer", async () => {
    const { question } = answerOnce("");

    await expect(
      gatesGiven().resolveTaskGate!(GATE)
    ).resolves.toBeNull();
    // With nothing to suggest, enter is the only shortcut on offer.
    expect(question).toHaveBeenCalledWith("Your guidance [enter = park the task and move on] ");
  });

  it("does not offer to accept a suggestion that does not exist", async () => {
    answerOnce("y");

    // With no recommendation, `y` is the operator's answer, not an acceptance.
    await expect(
      gatesGiven().resolveTaskGate!(GATE)
    ).resolves.toBe("y");
  });
});

/** A pit stop with nothing filled in — each case overrides what it is about. */
const STOP = {
  runId: "run-1",
  number: 1,
  reason: 'the "Sign-in" epic is finished',
  demo: { started: true, howStarted: "pnpm dev", summary: "", journeys: [], couldNotReach: [], artifacts: [] },
  reviews: [],
  merged: ["Sign in (task-a)"],
  upcoming: ["The map (task-b)"],
  parked: [],
  spentUsd: 12,
  capUsd: 100,
  stopCostUsd: 1.5,
  projectedUsd: 40,
  intent: null,
  artifactsDir: "/repo/.harness/run-1/pitstops/1",
  markdown: "# Pit stop 1\n\n**It runs.** pnpm dev",
};

describe("the pit stop gate in the terminal", () => {
  beforeEach(async () => {
    await cli("run", "x", "--repo", "/repo", "--no-dashboard");
    out.length = 0;
  });

  it("prints the report and says how many tasks a redirect would reach", async () => {
    const { question, close } = answerOnce("");

    await expect(gatesGiven().resolvePitStop!(STOP)).resolves.toEqual({ action: "continue", feedback: "" });
    expect(printed()).toContain("**It runs.** pnpm dev");
    expect(question.mock.calls[0]![0]).toContain("send it to the 1 task(s) that have not run yet");
    expect(close).toHaveBeenCalledOnce();
  });

  it("says the parked tasks will get it too, since they do not restart on their own", async () => {
    const { question } = answerOnce("");

    await gatesGiven().resolvePitStop!({ ...STOP, parked: ["Entitlements (task-c) — needs DynamoDB"] });

    expect(question.mock.calls[0]![0]).toContain("and to the 1 parked one(s) for when you revive them");
  });

  it("sends anything they type to the tasks that have not run yet", async () => {
    answerOnce("drop the offline mode, nobody asked for it");

    await expect(gatesGiven().resolvePitStop!(STOP)).resolves.toEqual({
      action: "redirect",
      feedback: "drop the offline mode, nobody asked for it",
    });
  });

  it("re-plans when they say so, and keeps only what they said", async () => {
    answerOnce("replan: build the map first, the packs can wait");

    await expect(gatesGiven().resolvePitStop!(STOP)).resolves.toEqual({
      action: "replan",
      feedback: "build the map first, the packs can wait",
    });
  });

  it("takes a bare replan without the colon too", async () => {
    answerOnce("Replan the whole second epic around search");

    await expect(gatesGiven().resolvePitStop!(STOP)).resolves.toEqual({
      action: "replan",
      feedback: "the whole second epic around search",
    });
  });

  it("parks the run when they want to think", async () => {
    answerOnce("STOP");

    await expect(gatesGiven().resolvePitStop!(STOP)).resolves.toEqual({ action: "stop", feedback: "" });
  });
});

describe("harness resume", () => {
  it("picks the newest run with something left to do", async () => {
    h.storeMethods.listRuns.mockReturnValue([
      { id: "run-done", state: "DONE", assignment: "finished" },
      { id: "run-open", state: "EXECUTING", assignment: "the open one\nsecond line" },
    ]);

    await cli("resume", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("Resuming run run-open [EXECUTING] — the open one");
    expect(h.controllerMethods.resume).toHaveBeenCalledWith("run-open", undefined);
  });

  it("says so plainly when there is nothing to resume", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-done", state: "DONE", assignment: "finished" }]);

    await cli("resume", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("No run to resume");
    expect(h.controllerMethods.resume).not.toHaveBeenCalled();
  });

  it("treats a PR_REVIEW run with recoverable work as resumable", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-pr", state: "PR_REVIEW", assignment: "a" }]);
    h.controllerMethods.hasRecoverableWork.mockReturnValue(true);

    await cli("resume", "--repo", "/repo", "--no-dashboard");

    expect(h.controllerMethods.resume).toHaveBeenCalledWith("run-pr", undefined);
  });

  it("treats a PR_REVIEW run awaiting verification as resumable", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-pr", state: "PR_REVIEW", assignment: "a" }]);
    h.controllerMethods.awaitingVerification.mockReturnValue(true);

    await cli("resume", "--repo", "/repo", "--no-dashboard");

    expect(h.controllerMethods.resume).toHaveBeenCalledWith("run-pr", undefined);
  });

  it("gives the terminal back to a run that stopped mid-conversation", async () => {
    // Run 40da9337 was interrupted holding the question that decided whether its
    // integrations would be real. Resume used to plan straight past it; the
    // conversation now needs somewhere to happen, and only this state needs it —
    // opening readline on any other resume would hold stdin for nothing.
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-chat", state: "INTAKE", assignment: "build it" }]);
    h.storeMethods.getRun.mockReturnValue({ id: "run-chat", state: "INTAKE", config: {} });

    await cli("resume", "--repo", "/repo", "--no-dashboard");

    expect(h.TerminalChatMock).toHaveBeenCalled();
    expect(printed()).toContain("stopped mid-conversation");
    expect(h.controllerMethods.resume).toHaveBeenCalledWith("run-chat", expect.anything());
  });

  it("re-reports a finished run instead of resuming it, and does not notify", async () => {
    h.storeMethods.getRun.mockReturnValue({ id: "run-1", state: "DONE", config: {} });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("Run run-1 already finished (DONE); there is nothing to resume.");
    expect(h.controllerMethods.resume).not.toHaveBeenCalled();
    // Re-reading a finished run is not an event worth a desktop notification.
    expect(h.notifyDoneMock).not.toHaveBeenCalled();
  });

  it("resumes a named run that has never been recorded", async () => {
    h.storeMethods.getRun.mockReturnValue(undefined);

    await cli("resume", "run-x", "--repo", "/repo", "--no-dashboard");

    expect(h.controllerMethods.resume).toHaveBeenCalledWith("run-x", undefined);
  });

  it("prints the dashboard URL and its token warning", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "EXECUTING", assignment: "a" }]);

    await cli("resume", "--repo", "/repo");

    expect(printed()).toContain("Dashboard: http://localhost:4777/#tok\n(keep the fragment — it is your auth token)");
  });

  it("pins the dashboard port from the flag, and honours the config file otherwise", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "EXECUTING", assignment: "a" }]);

    await cli("resume", "--repo", "/repo", "--port", "5050");
    expect(h.dashboardArgs.at(-1)![2]).toEqual({ port: 5050 });

    h.loadFileConfigMock.mockReturnValue({ config: { dashboardPort: 6060 }, path: "/repo/harness.config.json" });
    await cli("resume", "--repo", "/repo");
    expect(h.dashboardArgs.at(-1)![2]).toEqual({ port: 6060 });
  });

  it("runs headless when the config file turns the dashboard off", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "EXECUTING", assignment: "a" }]);
    h.loadFileConfigMock.mockReturnValue({ config: { dashboard: false }, path: "/repo/harness.config.json" });

    await cli("resume", "--repo", "/repo");

    expect(h.DashboardMock).not.toHaveBeenCalled();
  });

  it("notifies and stops the dashboard when the resume throws", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "EXECUTING", assignment: "a" }]);
    h.controllerMethods.resume.mockRejectedValue(new Error("worktree is gone"));

    await expect(cli("resume", "--repo", "/repo")).rejects.toThrow("worktree is gone");

    expect(h.notifyDoneMock).toHaveBeenCalledWith("repo — run stopped", "worktree is gone");
    expect(h.dashboardMethods.stop).toHaveBeenCalledOnce();
  });

  it("reports a non-Error resume failure as its string form", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "EXECUTING", assignment: "a" }]);
    h.controllerMethods.resume.mockRejectedValue("plain string");

    await expect(cli("resume", "--repo", "/repo", "--no-dashboard")).rejects.toBe("plain string");

    expect(h.notifyDoneMock).toHaveBeenCalledWith("repo — run stopped", "plain string");
  });
});

describe("harness resume — settings the operator changed since the run started", () => {
  const existing = (config: Record<string, unknown>) => {
    h.storeMethods.getRun.mockReturnValue({ id: "run-1", state: "EXECUTING", config });
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "EXECUTING", assignment: "a" }]);
  };

  it("updates the checks a run was frozen with", async () => {
    existing({ deterministicChecks: ["cd web && npm test"] });
    h.loadFileConfigMock.mockReturnValue({ config: { deterministicChecks: ["npm test"] }, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(h.storeMethods.patchRunConfig).toHaveBeenCalledWith("run-1", { deterministicChecks: ["npm test"] });
    expect(printed()).toContain("Checks updated from harness.config.json:\n  $ npm test");
  });

  it("leaves the checks alone when the file says the same thing", async () => {
    existing({ deterministicChecks: ["npm test"] });
    h.loadFileConfigMock.mockReturnValue({ config: { deterministicChecks: ["npm test"] }, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(h.storeMethods.patchRunConfig).not.toHaveBeenCalled();
  });

  it("re-routes a role for the rest of the run, which is the point of doing it here", async () => {
    // The reason to change routing mid-run is that the budget is going faster
    // than the work is, and the tasks still queued are the only ones that can
    // still be made cheaper.
    existing({ models: { worker: "claude-sonnet-5", qa: "claude-sonnet-5" } });
    h.loadFileConfigMock.mockReturnValue({ config: {}, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard", "--model", "worker=gpt-5.6-terra");

    expect(h.storeMethods.patchRunConfig).toHaveBeenCalledWith("run-1", {
      models: { worker: "gpt-5.6-terra", qa: "claude-sonnet-5" },
    });
    expect(printed()).toContain("worker re-routed for the rest of the run: claude-sonnet-5 → gpt-5.6-terra");
  });

  it("takes the same change from the config file", async () => {
    existing({ models: { worker: "claude-sonnet-5" } });
    h.loadFileConfigMock.mockReturnValue({ config: { models: { worker: "gpt-5.6-terra" } }, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(h.storeMethods.patchRunConfig).toHaveBeenCalledWith("run-1", { models: { worker: "gpt-5.6-terra" } });
  });

  it("leaves the routing alone when nothing changed", async () => {
    existing({ models: { worker: "claude-sonnet-5" } });
    h.loadFileConfigMock.mockReturnValue({ config: { models: { worker: "claude-sonnet-5" } }, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(h.storeMethods.patchRunConfig).not.toHaveBeenCalled();
  });

  it("refuses a re-route to a provider with no key, before resuming", async () => {
    existing({ models: { worker: "claude-sonnet-5" } });
    h.loadFileConfigMock.mockReturnValue({ config: {}, path: "/repo/harness.config.json" });
    h.missingKeysMock.mockReturnValue(["OPENAI_API_KEY is not set, but worker (gpt-5.6-terra) is routed to openai."]);

    await expect(cli("resume", "run-1", "--repo", "/repo", "--no-dashboard", "--model", "worker=gpt-5.6-terra")).rejects.toThrow(/OPENAI_API_KEY/);
    expect(h.storeMethods.patchRunConfig).not.toHaveBeenCalled();
  });

  it("rejects a malformed pair rather than guessing what was meant", () => {
    expect(() => modelOverrides(["worker"])).toThrow(/expects role=model, got "worker"/);
    expect(() => modelOverrides(["=gpt-5.6-terra"])).toThrow(/expects role=model/);
    expect(() => modelOverrides(["worker="])).toThrow(/expects role=model/);
    expect(modelOverrides()).toEqual({});
    expect(modelOverrides([" worker = gpt-5.6-terra "])).toEqual({ worker: "gpt-5.6-terra" });
  });

  it("rejects a misspelled role instead of silently ignoring it", async () => {
    // A flag that quietly did nothing would leave the operator watching an
    // expensive run they thought they had just made cheap.
    existing({ models: { worker: "claude-sonnet-5" } });
    h.loadFileConfigMock.mockReturnValue({ config: {}, path: "/repo/harness.config.json" });

    await expect(cli("resume", "run-1", "--repo", "/repo", "--no-dashboard", "--model", "wroker=gpt-5.6-terra")).rejects.toThrow(/no role called "wroker"/);
  });

  it("updates the PR mode", async () => {
    existing({ prMode: "per-task" });
    h.loadFileConfigMock.mockReturnValue({ config: { prMode: "single" }, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(h.storeMethods.patchRunConfig).toHaveBeenCalledWith("run-1", { prMode: "single" });
    expect(printed()).toContain("PR mode updated from harness.config.json: single");
  });

  it("raises the parallel worker cap on a run that predates parallel dispatch", async () => {
    existing({ maxParallelWorkers: 1 });
    h.loadFileConfigMock.mockReturnValue({ config: { maxParallelWorkers: 4 }, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(h.storeMethods.patchRunConfig).toHaveBeenCalledWith("run-1", { maxParallelWorkers: 4 });
    expect(printed()).toContain("Parallel workers updated from harness.config.json: 1 → 4");
  });

  it("updates whether the run waits for CI", async () => {
    existing({ waitForChecks: true });
    h.loadFileConfigMock.mockReturnValue({ config: { waitForChecks: false }, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(h.storeMethods.patchRunConfig).toHaveBeenCalledWith("run-1", { waitForChecks: false });
    expect(printed()).toContain("Wait for CI updated from harness.config.json: false");
  });

  it.each([
    ["qaMaxTurns", "QA turn ceiling", 60, 150],
    ["workerMaxTurns", "Worker turn ceiling", 100, 300],
  ])("raises %s so the resumed tasks can reach it", async (key, label, before, after) => {
    existing({ [key]: before });
    h.loadFileConfigMock.mockReturnValue({ config: { [key]: after }, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(h.storeMethods.patchRunConfig).toHaveBeenCalledWith("run-1", { [key]: after });
    expect(printed()).toContain(`${label} updated from harness.config.json: ${before} → ${after}`);
  });

  it.each(["skillRouting", "roleSkills"])("hands the remaining tasks the new %s", async (key) => {
    existing({ [key]: [] });
    const value = key === "skillRouting" ? [{ when: "ui", skills: ["frontend-design"] }] : { qa: ["visual-qa-agent"] };
    h.loadFileConfigMock.mockReturnValue({ config: { [key]: value }, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(h.storeMethods.patchRunConfig).toHaveBeenCalledWith("run-1", { [key]: value });
    expect(printed()).toContain(`${key} updated from harness.config.json for the remaining tasks`);
  });

  it("leaves the routing tables alone when the file has not changed them", async () => {
    existing({ skillRouting: [{ when: "ui", skills: ["frontend-design"] }], roleSkills: {} });
    h.loadFileConfigMock.mockReturnValue({
      config: { skillRouting: [{ when: "ui", skills: ["frontend-design"] }] },
      path: "/repo/harness.config.json",
    });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(h.storeMethods.patchRunConfig).not.toHaveBeenCalled();
  });

  it("extends a finished-looking run past the pull request by setting a production URL", async () => {
    existing({ prodUrl: "" });
    h.loadFileConfigMock.mockReturnValue({ config: { prodUrl: "https://app.example.com" }, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(h.storeMethods.patchRunConfig).toHaveBeenCalledWith("run-1", { prodUrl: "https://app.example.com" });
    expect(printed()).toContain("Production URL updated from harness.config.json: https://app.example.com");
  });

  it("says (none) when the production URL is being cleared", async () => {
    existing({ prodUrl: "https://app.example.com" });
    h.loadFileConfigMock.mockReturnValue({ config: { prodUrl: "" }, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("Production URL updated from harness.config.json: (none)");
  });

  it("patches nothing for a run it has never seen", async () => {
    h.storeMethods.getRun.mockReturnValue(undefined);
    h.loadFileConfigMock.mockReturnValue({
      config: { deterministicChecks: ["npm test"], prMode: "single", maxParallelWorkers: 4, skillRouting: [] },
      path: "/repo/harness.config.json",
    });

    await cli("resume", "run-x", "--repo", "/repo", "--no-dashboard");

    expect(h.storeMethods.patchRunConfig).not.toHaveBeenCalled();
  });
});

describe("harness regroup", () => {
  it("rolls a run's per-task PRs into one and closes the superseded ones", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "PR_REVIEW", assignment: "a" }]);
    h.storeMethods.listTasks.mockReturnValue([{ prNumber: 4 }]);
    h.controllerMethods.regroupPrs.mockResolvedValue({
      pr: { url: "https://github.com/acme/widgets/pull/9" },
      closed: [4, 5],
    });

    await cli("regroup", "--repo", "/repo");

    expect(h.controllerMethods.regroupPrs).toHaveBeenCalledWith("run-1");
    expect(printed()).toContain("Rollup PR: https://github.com/acme/widgets/pull/9");
    expect(printed()).toContain("Closed 2 superseded pull requests: #4, #5");
  });

  it("uses the singular for a single superseded PR", async () => {
    h.controllerMethods.regroupPrs.mockResolvedValue({ pr: { url: "u" }, closed: [4] });

    await cli("regroup", "run-1", "--repo", "/repo");

    expect(printed()).toContain("Closed 1 superseded pull request: #4");
  });

  it("says when nothing needed closing", async () => {
    h.controllerMethods.regroupPrs.mockResolvedValue({ pr: { url: "u" }, closed: [] });

    await cli("regroup", "run-1", "--repo", "/repo");

    expect(printed()).toContain("No per-task pull requests needed closing.");
  });

  it("says so when the run has nothing to roll up", async () => {
    h.controllerMethods.regroupPrs.mockResolvedValue(null);

    await cli("regroup", "run-1", "--repo", "/repo");

    expect(printed()).toContain("Run run-1 has nothing to roll up");
  });

  it("says so when no run has any pull requests at all", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "EXECUTING", assignment: "a" }]);
    h.storeMethods.listTasks.mockReturnValue([{ prNumber: null }]);

    await cli("regroup", "--repo", "/repo");

    expect(printed()).toBe("No run with pull requests to regroup.\n");
    expect(h.controllerMethods.regroupPrs).not.toHaveBeenCalled();
  });
});

/**
 * Diagnosing run 40da9337 took an hour of ad-hoc SQL against its harness.db.
 * The answer — an intake question asked and never answered — was two lines of
 * it, and nothing in the product would have shown it.
 */
describe("harness postmortem", () => {
  it("explains the most recent run when given no id", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "PR_REVIEW", assignment: "build it" }]);
    h.storeMethods.getRun.mockReturnValue({ id: "run-1", state: "PR_REVIEW", assignment: "build it", config: {} });

    await cli("postmortem", "--repo", "/repo");

    expect(printed()).toContain("Run run-1 [state]");
  });

  it("explains a named run", async () => {
    h.storeMethods.getRun.mockReturnValue({ id: "run-x", state: "DONE", assignment: "a thing", config: {} });

    await cli("postmortem", "run-x", "--repo", "/repo");

    expect(printed()).toContain("Run run-x [state]");
  });

  it("says so when the repo has never been run", async () => {
    h.storeMethods.listRuns.mockReturnValue([]);

    await cli("postmortem", "--repo", "/repo");

    expect(printed()).toBe("No runs yet.\n");
  });

  it("names the run it could not find rather than the generic message", async () => {
    h.storeMethods.getRun.mockReturnValue(undefined);

    await cli("postmortem", "nope", "--repo", "/repo");

    expect(printed()).toBe("No run nope in this repo.\n");
  });
});

describe("harness status", () => {
  it("says so when the repo has never been run", async () => {
    await cli("status", "--repo", "/repo");

    expect(printed()).toBe("No runs yet.\n");
  });

  it("lists open runs with their spend and tasks", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "EXECUTING", assignment: "build the companion app" }]);
    h.storeMethods.spentUsd.mockReturnValue(702.348);
    h.storeMethods.listTasks.mockReturnValue([
      { id: "auth", state: "MERGED", qaIterations: 2, prNumber: 7, title: "Auth" },
      { id: "pack", state: "WORKING", qaIterations: 0, prNumber: null, title: "Pack" },
    ]);

    await cli("status", "--repo", "/repo");

    const shown = printed();
    expect(shown).toContain("run run-1 [EXECUTING] $702.35 — build the companion app");
    expect(shown).toContain("  auth [MERGED] qa=2 PR#7");
    expect(shown).toContain("  pack [WORKING] qa=0\n");
    expect(shown).toContain("    https://github.com/acme/widgets/pull/7  Auth");
  });

  it("lists a rollup PR once, not once per task", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "PR_REVIEW", assignment: "a" }]);
    h.storeMethods.listTasks.mockReturnValue([
      { id: "a", state: "MERGED", qaIterations: 1, prNumber: 9, title: "A" },
      { id: "b", state: "MERGED", qaIterations: 1, prNumber: 9, title: "B" },
    ]);

    await cli("status", "--repo", "/repo", "--all");

    expect(printed()).toContain("    https://github.com/acme/widgets/pull/9  2 tasks (rollup)");
  });

  it("falls back to a bare PR number when the repo slug is unknown", async () => {
    h.originSlugMock.mockRejectedValue(new Error("no remote"));
    h.loadFileConfigMock.mockReturnValue({ config: {}, path: null });
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "PR_REVIEW", assignment: "a" }]);
    h.storeMethods.listTasks.mockReturnValue([{ id: "a", state: "MERGED", qaIterations: 0, prNumber: 3, title: "A" }]);

    await cli("status", "--repo", "/repo");

    expect(printed()).toContain("    PR #3  A");
  });

  it("says when a run got far enough to integrate but opened no pull request", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "INTEGRATING", assignment: "a" }]);
    h.storeMethods.listTasks.mockReturnValue([{ id: "a", state: "NEEDS_HUMAN", qaIterations: 3, prNumber: null, title: "A" }]);

    await cli("status", "--repo", "/repo");

    expect(printed()).toContain("  pull requests: none — no task got far enough to open one.");
  });

  it("shows the deploy and production lines when there are any", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "VERIFYING", assignment: "a" }]);
    h.storeMethods.deployStatus.mockReturnValue({ sha: "2efada8ab", state: "failing", failing: ["deploy-prod"] });
    h.storeMethods.prodVerdict.mockReturnValue({ url: "https://app.example.com", verdict: "FAIL", findings: ["500 on /login"] });

    await cli("status", "--repo", "/repo");

    expect(printed()).toContain("  deploy 2efada8: failing — deploy-prod");
    expect(printed()).toContain("  production https://app.example.com: FAIL — 1 finding(s)");
  });

  it("omits the failing list and the finding count when there are none", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "VERIFYING", assignment: "a" }]);
    h.storeMethods.deployStatus.mockReturnValue({ sha: "2efada8ab", state: "pending", failing: [] });
    h.storeMethods.prodVerdict.mockReturnValue({ url: "https://app.example.com", verdict: "PASS", findings: [] });

    await cli("status", "--repo", "/repo");

    expect(printed()).toContain("  deploy 2efada8: pending\n");
    expect(printed()).toContain("  production https://app.example.com: PASS\n");
  });

  it("hides a deploy that never started", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "VERIFYING", assignment: "a" }]);
    h.storeMethods.deployStatus.mockReturnValue({ sha: "abc", state: "none", failing: [] });

    await cli("status", "--repo", "/repo");

    expect(printed()).not.toContain("deploy");
  });

  it("shows the last finished run when nothing is open, and every run under --all", async () => {
    h.storeMethods.listRuns.mockReturnValue([
      { id: "run-2", state: "DONE", assignment: "newest" },
      { id: "run-1", state: "DONE", assignment: "older" },
    ]);

    await cli("status", "--repo", "/repo");
    expect(printed()).toContain("run run-2");
    expect(printed()).not.toContain("run run-1");

    out.length = 0;
    await cli("status", "--repo", "/repo", "--all");
    expect(printed()).toContain("run run-2");
    expect(printed()).toContain("run run-1");
  });
});

describe("harness init", () => {
  it("writes the settings this repo would run with", async () => {
    h.detectChecksMock.mockReturnValue({ checks: ["npm test", "npm run lint"], source: "package.json" });

    await cli("init", "--repo", "/repo");

    const [target, body] = h.writeFileSyncMock.mock.calls[0] as [string, string];
    expect(target).toBe("/repo/harness.config.json");
    expect(JSON.parse(body)).toEqual({
      budget: { runCapUsd: 30, taskCapUsd: 10 },
      deterministicChecks: ["npm test", "npm run lint"],
      dashboard: true,
      skillsDirs: expect.any(Array),
    });
    expect(body.endsWith("\n")).toBe(true);
    expect(printed()).toContain("Wrote /repo/harness.config.json\n  checks: npm test, npm run lint");
  });

  it("names the reason when it found no checks to write", async () => {
    h.detectChecksMock.mockReturnValue({ checks: [], source: "no test script in package.json" });

    await cli("init", "--repo", "/repo");

    expect(printed()).toContain("checks: none (no test script in package.json)");
  });

  it("refuses to overwrite an existing config", async () => {
    h.existsSyncMock.mockReturnValue(true);

    await expect(cli("init", "--repo", "/repo")).rejects.toThrow(
      "/repo/harness.config.json already exists. Pass --force to overwrite."
    );
    expect(h.writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("overwrites when forced", async () => {
    h.existsSyncMock.mockReturnValue(true);

    await cli("init", "--repo", "/repo", "--force");

    expect(h.writeFileSyncMock).toHaveBeenCalledOnce();
  });
});

describe("the closing report", () => {
  /** Runs to completion with a given outcome and returns what the operator read. */
  async function reportFor(outcome: Partial<typeof RUN_OUTCOME>): Promise<string> {
    h.controllerMethods.outcome.mockReturnValue({ ...RUN_OUTCOME, ...outcome } as never);
    await cli("run", "x", "--repo", "/repo", "--no-dashboard");
    return printed();
  }

  it("leads with the run's own summary line and how to see more", async () => {
    const shown = await reportFor({ line: "3 of 4 tasks merged" });

    expect(shown).toContain("Run run-1 finished — 3 of 4 tasks merged.");
    expect(shown).toContain("Full picture: harness status --repo /repo");
    expect(h.notifyDoneMock).toHaveBeenCalledWith("repo — run done", "run-1: 3 of 4 tasks merged.");
  });

  it("puts the intent verdict above the artifacts when it passed", async () => {
    const shown = await reportFor({ intent: { verdict: "PASS", gaps: [], summary: "does what\nwas asked" } as never });

    expect(shown).toContain("Intent check: PASS — does what was asked");
  });

  it("lists every gap when the intent check failed", async () => {
    const shown = await reportFor({
      intent: { verdict: "FAIL", gaps: ["no offline mode", "no receipts"], summary: "two thirds delivered" } as never,
    });

    expect(shown).toContain("Intent check: FAIL — the merged result does not fully deliver what you asked for:");
    expect(shown).toContain("    - no offline mode");
    expect(shown).toContain("    - no receipts");
    expect(shown).toContain("    two thirds delivered");
  });

  it("omits the trailing summary when the validator gave none", async () => {
    const shown = await reportFor({ intent: { verdict: "FAIL", gaps: ["a gap"], summary: "" } as never });

    expect(shown).toContain("    - a gap");
    expect(shown.trimEnd().split("\n").filter((l) => l.trim().startsWith("- ")).length).toBe(1);
  });

  it.each([
    ["passing", "CI: green on https://github.com/acme/widgets/pull/12"],
    ["failing", "CI: RED on https://github.com/acme/widgets/pull/12 — build, lint"],
    ["pending", "CI: still running on https://github.com/acme/widgets/pull/12 (3 check(s))"],
  ])("reports %s CI", async (state, expected) => {
    const shown = await reportFor({
      ci: { prNumber: 12, state, failing: ["build", "lint"], total: 3 } as never,
    });

    expect(shown).toContain(expected);
  });

  it("says nothing about CI the repo does not have", async () => {
    const shown = await reportFor({ ci: { prNumber: 1, state: "none", failing: [], total: 0 } as never });

    expect(shown).not.toContain("CI:");
  });

  it.each([
    ["passing", "Deploy: green on 2efada8 — the change is live"],
    ["failing", "Deploy: RED on 2efada8 — deploy-prod. It is merged but NOT live."],
    ["pending", "Deploy: still running on 2efada8"],
  ])("reports a %s deploy", async (state, expected) => {
    const shown = await reportFor({
      deploy: { sha: "2efada8abcdef", state, failing: ["deploy-prod"], total: 1 } as never,
    });

    expect(shown).toContain(expected);
  });

  it("says nothing about a deploy that never happened", async () => {
    const shown = await reportFor({ deploy: { sha: "abc", state: "none", failing: [], total: 0 } as never });

    expect(shown).not.toContain("Deploy:");
  });

  it("reports production agreeing", async () => {
    const shown = await reportFor({
      prod: { url: "https://app.example.com", verdict: "PASS", findings: [], summary: "checkout works" } as never,
    });

    expect(shown).toContain("Production: verified at https://app.example.com — checkout works");
  });

  it("reports production disagreeing, and says the run stays open", async () => {
    const shown = await reportFor({
      prod: {
        url: "https://app.example.com",
        verdict: "FAIL",
        findings: ["/login 500s"],
        summary: "the deploy is live but broken",
      } as never,
    });

    expect(shown).toContain("Production check: FAIL at https://app.example.com");
    expect(shown).toContain("    - /login 500s");
    expect(shown).toContain("    the deploy is live but broken");
    expect(shown).toContain("the run stays open until production agrees");
  });

  it("omits the production summary line when there is none", async () => {
    const shown = await reportFor({
      prod: { url: "https://app.example.com", verdict: "FAIL", findings: ["broken"], summary: "" } as never,
    });

    expect(shown).toContain("    - broken");
    expect(shown).toContain("harness resume");
  });

  it("prints every pull request as a clickable URL", async () => {
    const shown = await reportFor({ prs: [{ number: 12, title: "Auth" }, { number: 13, title: "Packs" }] as never });

    expect(shown).toContain("Open for review (the harness never merges — that part is yours):");
    expect(shown).toContain("    https://github.com/acme/widgets/pull/12  Auth");
    expect(shown).toContain("    https://github.com/acme/widgets/pull/13  Packs");
  });

  it("falls back to #n when the repo slug cannot be resolved", async () => {
    h.originSlugMock.mockRejectedValue(new Error("no remote"));
    h.loadFileConfigMock.mockReturnValue({ config: {}, path: null });

    const shown = await reportFor({ prs: [{ number: 12, title: "Auth" }] as never });

    expect(shown).toContain("    #12  Auth");
  });

  it("takes the slug from the config file when there is no git remote", async () => {
    h.originSlugMock.mockResolvedValue(null);
    h.loadFileConfigMock.mockReturnValue({ config: { githubRepo: "acme/from-config" }, path: "/repo/harness.config.json" });

    const shown = await reportFor({ prs: [{ number: 12, title: "Auth" }] as never });

    expect(shown).toContain("https://github.com/acme/from-config/pull/12");
  });

  it("says what each parked task is waiting for and where its work is", async () => {
    const shown = await reportFor({
      parked: [
        {
          taskId: "settlement",
          title: "Settlement hold engine",
          issue: 41,
          branch: "harness/run-1/settlement",
          why: "merge conflicts against a tip it   has never seen",
          blocking: ["reporting", "exports"],
        },
      ] as never,
    });

    expect(shown).toContain("Parked, waiting on you (1):");
    expect(shown).toContain("    Settlement hold engine");
    expect(shown).toContain("      https://github.com/acme/widgets/issues/41");
    expect(shown).toContain("      why: merge conflicts against a tip it has never seen");
    expect(shown).toContain("      its work is on harness/run-1/settlement");
    expect(shown).toContain("      2 other task(s) were waiting on it");
  });

  it("prints only what a parked task actually has", async () => {
    const shown = await reportFor({
      parked: [{ taskId: "t", title: "Bare task", issue: null, branch: null, why: "", blocking: [] }] as never,
    });

    expect(shown).toContain("    Bare task");
    expect(shown).not.toContain("      why:");
    expect(shown).not.toContain("      its work is on");
    expect(shown).not.toContain("were waiting on it");
  });

  it("explains that cancelled tasks were never attempted, not abandoned", async () => {
    const shown = await reportFor({ cancelled: 4 });

    expect(shown).toContain("4 task(s) never started");
    expect(shown).toContain("No tokens were spent on them.");
  });
});
