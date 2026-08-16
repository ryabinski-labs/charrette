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
    getTask: vi.fn(() => undefined as unknown),
    amendProbe: vi.fn(),
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
    replannable: vi.fn(() => false),
    raiseBudget: vi.fn(() => "ok"),
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
    liveDashboardUrlMock: vi.fn(async () => null as string | null),
    recordDashboardMock: vi.fn(),
    clearDashboardMock: vi.fn(),
    // Null = no dashboard was recorded for this repo, which is every test that
    // is not about resuming onto the operator's existing tab.
    recordedDashboardMock: vi.fn((): { port: number; token: string } | null => null),
    StoreMock: vi.fn(() => storeMethods),
    BusMock: vi.fn(),
    AgentPoolMock: vi.fn(),
    GitHubAdapterMock: vi.fn(),
    RunControllerMock: vi.fn(),
    DashboardMock: vi.fn(),
    detectToolbeltMock: vi.fn(() => [] as { name: string }[]),
    missingKeysMock: vi.fn(() => [] as string[]),
    accountEnvMock: vi.fn(() => ({}) as Record<string, string>),
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
    // Takes the path it is asked about: `readOnlyStore` distinguishes the
    // store's own file from everything else, so a zero-arg mock cannot express
    // what these tests need to say.
    existsSyncMock: vi.fn((_p: string) => false),
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
  // Resolving an account's credentials is unit-tested in core against real
  // environments; what the CLI owes is refusing a `resume --account` naming
  // one it cannot resolve, so this stands in to let a test drive that path.
  accountEnv: h.accountEnvMock,
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
vi.mock("./dashboardLink.js", () => ({
  liveDashboardUrl: h.liveDashboardUrlMock,
  recordDashboard: h.recordDashboardMock,
  clearDashboard: h.clearDashboardMock,
  recordedDashboard: h.recordedDashboardMock,
}));

import type { GateHandler } from "@harness/core";
import { buildProgram, modelOverrides, parseRunConfig } from "./cli.js";

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
  h.storeMethods.getTask.mockReturnValue(undefined);
  h.storeMethods.spentUsd.mockReturnValue(0);
  h.storeMethods.deployStatus.mockReturnValue(null);
  h.storeMethods.prodVerdict.mockReturnValue(null);
  h.controllerMethods.startRun.mockResolvedValue("run-1");
  h.controllerMethods.resume.mockResolvedValue(undefined);
  h.controllerMethods.outcome.mockReturnValue({ ...RUN_OUTCOME });
  h.controllerMethods.regroupPrs.mockResolvedValue(null);
  h.controllerMethods.hasRecoverableWork.mockReturnValue(false);
  h.controllerMethods.awaitingVerification.mockReturnValue(false);
  h.controllerMethods.replannable.mockReturnValue(false);
  h.controllerMethods.raiseBudget.mockReturnValue("ok");
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
  h.accountEnvMock.mockReset().mockReturnValue({});
  h.ensureIgnoredMock.mockReset().mockReturnValue(false);
  h.repoUnusableMock.mockReset().mockResolvedValue(null);
  h.checkMemoryBannerMock.mockReset().mockReturnValue([]);
  h.originSlugMock.mockReset().mockResolvedValue("acme/widgets");
  h.detectChecksMock.mockReset().mockReturnValue({ checks: ["npm test"], source: "package.json" });
  h.loadFileConfigMock.mockReset().mockReturnValue({ config: {}, path: null });
  h.resolveGitHubMock.mockReset().mockReturnValue({ token: "gh-tok", slug: "acme/widgets", source: "git remote" });
  h.resolveRepoRootMock.mockReset().mockImplementation((p: string) => p);
  // False for everything except the store itself: the default repo in these
  // tests is one that has been run before, which is what every command that
  // reads a run assumes. The never-run repo is its own case, and the tests
  // that want it say so by making this false for the database too.
  h.existsSyncMock.mockReset().mockImplementation((p: string) => String(p).endsWith("harness.db"));
  h.mkdirSyncMock.mockReset();
  h.writeFileSyncMock.mockReset();
  h.createInterfaceMock.mockReset();
  h.notifyDoneMock.mockReset();
  h.liveDashboardUrlMock.mockReset().mockResolvedValue(null);
  h.recordDashboardMock.mockReset();
  h.clearDashboardMock.mockReset();
  h.recordedDashboardMock.mockReset();
  h.recordedDashboardMock.mockReturnValue(null);
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
    expect(banner).toContain("budget     $30   (defaults)");
    expect(banner).toContain("github     acme/widgets   (git remote)");
    expect(banner).toContain("prs        one rollup PR for the whole run   (default)");
    expect(banner).toContain("tools      none detected on PATH");
  });

  it("says nothing about models when every role is on its default", async () => {
    // A line that never changes is a line nobody reads. This is also what
    // stopped holding when `reviewer` was pinned to Google: the banner used to
    // list every role that was not Anthropic, which from that day forward meant
    // every single run printed a models line naming a role the operator neither
    // chose nor can change.
    await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard");
    expect(printed()).not.toContain("models     ");
  });

  it("names each role the operator moved, and only those", async () => {
    h.loadFileConfigMock.mockReturnValue({
      config: { models: { worker: "gpt-5.6-terra", demo: "gemini-3.5-flash-lite" } },
      path: "/repo/harness.config.json",
    });
    await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard");

    const banner = printed();
    expect(banner).toContain("worker→gpt-5.6-terra");
    expect(banner).toContain("demo→gemini-3.5-flash-lite");
    expect(banner).toContain("pinned roles are not movable");
    // The pinned Gemini reviewer is a default, not a move, so it stays out of a
    // line whose entire job is to show what the operator changed.
    expect(banner).not.toContain("reviewer→");
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

  it("refuses a judging role dropped to the small tier, whichever way it was asked for", async () => {
    // Anthropic, so the vendor pin waves it through — and a weaker judge does
    // not report that it judged worse, it reports PASS.
    h.loadFileConfigMock.mockReturnValue({ config: {}, path: null });
    await expect(
      cli("run", "build a thing", "--repo", "/repo", "--no-dashboard", "--model", "qa=claude-haiku-4-5-20251001")
    ).rejects.toThrow(/below the capability floor/);
    expect(h.RunControllerMock).not.toHaveBeenCalled();
  });

  it("says what is wrong in a sentence, rather than handing over a JSON dump", async () => {
    // `RunConfig.parse` throws a ZodError whose message is its serialised
    // issue list, and the crash handler prints that plus a stack trace. The
    // routing rules are the ones an operator trips on purpose, while trying to
    // make a run cheaper, so the reason has to survive being skimmed.
    h.loadFileConfigMock.mockReturnValue({ config: { models: { reviewer: "claude-haiku-4-5-20251001" } }, path: "/repo/harness.config.json" });
    const err = await cli("run", "build a thing", "--repo", "/repo", "--no-dashboard").then(
      () => null,
      (e: Error) => e
    );

    expect(err?.message).toContain("that run configuration cannot be used:");
    expect(err?.message).toContain("  models: ");
    expect(err?.message).not.toContain('"code": "custom"');
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

  it("starts on the subscription named on the command line", async () => {
    // The flag beats the file for the same reason `--model` does: it is what
    // you reach for when *this* run needs to be spending something else.
    const accounts = [{ name: "work", env: { CLAUDE_CONFIG_DIR: "/w" } }];
    h.loadFileConfigMock.mockReturnValue({ config: { subscription: { accounts, active: "personal" } }, path: "/repo/harness.config.json" });

    await cli("run", "x", "--repo", "/repo", "--no-dashboard", "--account", "work");

    expect(h.controllerMethods.startRun).toHaveBeenCalledWith(
      "x",
      // Matched loosely on the account: the config is parsed on the way through,
      // so each one comes back carrying the schema's defaults too.
      expect.objectContaining({
        subscription: expect.objectContaining({ active: "work", accounts: [expect.objectContaining({ name: "work", env: { CLAUDE_CONFIG_DIR: "/w" } })] }),
      }),
      undefined
    );
  });

  it("spends the account it was configured with when the command line says nothing", async () => {
    h.loadFileConfigMock.mockReturnValue({ config: { subscription: { active: "personal" } }, path: "/repo/harness.config.json" });

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(h.controllerMethods.startRun).toHaveBeenCalledWith(
      "x",
      expect.objectContaining({ subscription: expect.objectContaining({ active: "personal" }) }),
      undefined
    );
  });

  it("takes the budget cap from the flag when given", async () => {
    await cli("run", "x", "--repo", "/repo", "--no-dashboard", "--run-cap", "120");

    expect(printed()).toContain("budget     $120   (flags)");
  });

  it("takes the budget cap from the config file otherwise", async () => {
    h.loadFileConfigMock.mockReturnValue({
      config: { budget: { runCapUsd: 500 } },
      path: "/repo/harness.config.json",
    });

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("budget     $500   (harness.config.json)");
  });

  it.each([
    ["--run-cap", "0"],
    ["--run-cap", "-5"],
    ["--run-cap", "not-a-number"],
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

  it("never inherits the token a previous run served on", async () => {
    // Only `resume` comes back to an operator's open tab. A new run is a new
    // run: re-serving the last one's credential would hand whoever still has
    // that URL a live door into work they were never shown.
    h.recordedDashboardMock.mockReturnValue({ port: 4791, token: "0123456789abcdef0123456789abcdef" });

    await cli("run", "x", "--repo", "/repo");

    expect(h.recordedDashboardMock).not.toHaveBeenCalled();
    expect(h.dashboardArgs[0]![2]).toEqual({ port: undefined, preferPort: undefined, token: undefined });
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

describe("the live budget command channel", () => {
  /** Fakes a TTY stdin and gives back the handler watchBudgetCommands registered, plus the "off" spy. */
  function fakeTty() {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    let handler: ((chunk: Buffer | string) => void) | undefined;
    vi.spyOn(process.stdin, "on").mockImplementation((event: string, fn: unknown) => {
      if (event === "data") handler = fn as (chunk: Buffer | string) => void;
      return process.stdin;
    });
    const offSpy = vi.spyOn(process.stdin, "off").mockReturnValue(process.stdin);
    return { emit: (text: string) => handler?.(text), offSpy };
  }

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
  });

  it("raises the cap for the run in progress once the run id is known from the bus", async () => {
    const tty = fakeTty();

    await cli("run", "x", "--repo", "/repo", "--no-dashboard");
    busListener()({ event: { type: "run.state_changed", runId: "run-1", from: "PLANNING", to: "EXECUTING" } });
    tty.emit("budget run 50\n");

    expect(h.controllerMethods.raiseBudget).toHaveBeenCalledWith("run-1", 50);
    expect(tty.offSpy).toHaveBeenCalledWith("data", expect.any(Function));
  });

  it("raises the cap for a resumed run by the id resume already knows", async () => {
    const tty = fakeTty();

    await cli("resume", "run-9", "--repo", "/repo", "--no-dashboard");
    tty.emit("budget run 10\n");

    expect(h.controllerMethods.raiseBudget).toHaveBeenCalledWith("run-9", 10);
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

  it("says when a skill answered an escalation you were never asked about", () => {
    // The whole point of `taskGate.decidedBy` is that nobody is interrupted —
    // which must not become nobody being told. The gate you *were* asked is
    // already on screen as a prompt, so printing it again would be noise.
    publish({ type: "task.gate_resolved", taskId: "auth", parked: false, guidance: "the fixture moved\nto test/fixtures", decidedBy: "product-manager" });
    publish({ type: "task.gate_resolved", taskId: "auth", parked: true, guidance: "", decidedBy: "operator" });

    expect(printed()).toBe("  ⚑ product-manager answered auth's escalation: the fixture moved\n");
  });

  it("says when a skill answered a plan or budget gate you were never asked about", () => {
    // The budget one is the line that matters most on this stream: it is money
    // moved without anyone being asked, so it must not be findable only by
    // reading the database afterwards. The gate you *were* asked arrived as a
    // terminal prompt, so it is already on screen and does not print twice.
    publish({ type: "run.gate_resolved", kind: "budget", resolution: "approved", feedback: "task cap raised to $40.00\nthe migration is written", decidedBy: "product-manager" });
    publish({ type: "run.gate_resolved", kind: "plan", resolution: "rejected", feedback: "the ingest seam has no owner", decidedBy: "product-manager" });
    publish({ type: "run.gate_resolved", kind: "budget", resolution: "approved", feedback: "raised by hand", decidedBy: "operator" });

    expect(printed()).toBe(
      "  ⚑ product-manager resolved the budget gate: task cap raised to $40.00\n" +
        "  ⚑ product-manager resolved the plan gate: the ingest seam has no owner\n"
    );
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

    await expect(gatesGiven().resolveBudgetGate({ spentUsd: 30, capUsd: 30 })).resolves.toBeNull();
  });

  it("routes the subscription gate to the account prompt", async () => {
    // The other ceiling, and the one an operator cannot raise by typing a
    // bigger number: enter parks the run rather than spending the rest.
    answerOnce("");

    await expect(
      gatesGiven().resolveSubscriptionGate!({
        window: "seven_day",
        percent: 96,
        resetsAt: null,
        pauseAtPercent: 95,
        summary: "96% of the weekly limit",
        untilReset: "3d 4h",
        account: "personal",
        alternatives: ["work"],
      })
    ).resolves.toEqual({ action: "park" });
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
  demo: {
      started: true,
      howStarted: "pnpm dev",
      summary: "",
      plannedJourneys: [],
      coverage: { status: "inconclusive" as const, planned: 0, reached: 0, proof: 0, firstBlocked: "", why: "the demo never said which journeys it set out to drive" },
      journeys: [],
      couldNotReach: [],
      artifacts: [],
      commands: [],
    },
  reviews: [],
  skippedReviewers: [],
  merged: ["Sign in (task-a)"],
  upcoming: ["The map (task-b)"],
  parked: [],
  cancelled: [],
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

  it("refuses when the resumed table needs a key, even though this command line moved nothing", async () => {
    // A run planned when everything was Anthropic is rewritten to the pinned
    // Gemini reviewer by `freezeReviewer` at open, so it acquires a Google
    // dependency between one command and the next without being asked. The
    // key check used to run only when `--model` changed something, which left
    // that run resuming into a pit stop it could not pay for — and a reviewer
    // that cannot start is not reported as a failure, it is degraded to
    // `verdict: "on-track"`. The epic gets bought and rubber-stamped.
    h.storeMethods.getRun.mockReturnValue({
      id: "run-old",
      state: "EXECUTING",
      config: { models: { reviewer: "gemini-3.6-flash" }, deterministicChecks: [] },
    });
    h.missingKeysMock.mockReturnValue(["GEMINI_API_KEY is not set, but reviewer (gemini-3.6-flash) is routed to google."]);

    await expect(cli("resume", "run-old", "--repo", "/repo", "--no-dashboard")).rejects.toThrow(/GEMINI_API_KEY is not set/);
    expect(h.controllerMethods.resume).not.toHaveBeenCalled();
  });

  it("comes back on the port and token the paused run was serving", async () => {
    // The whole point of a pause the operator planned to come back from: the
    // tab they left open is still pointed at that URL, and the fragment in it
    // is the only credential the dashboard accepts. A fresh token would not
    // move them to a new page — it would 401 the one they are looking at.
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-paused", state: "PAUSED", assignment: "a" }]);
    h.recordedDashboardMock.mockReturnValue({ port: 4791, token: "0123456789abcdef0123456789abcdef" });

    await cli("resume", "--repo", "/repo");

    expect(h.recordedDashboardMock).toHaveBeenCalledWith("/repo");
    // A preference, not a pin: something else on 4791 must not stop the resume.
    expect(h.dashboardArgs.at(-1)![2]).toEqual({
      port: undefined,
      preferPort: 4791,
      token: "0123456789abcdef0123456789abcdef",
    });
  });

  it("still takes the port the operator pinned, on the token they already hold", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-paused", state: "PAUSED", assignment: "a" }]);
    h.recordedDashboardMock.mockReturnValue({ port: 4791, token: "0123456789abcdef0123456789abcdef" });

    await cli("resume", "--repo", "/repo", "--port", "5050");

    expect(h.dashboardArgs.at(-1)![2]).toMatchObject({ port: 5050, token: "0123456789abcdef0123456789abcdef" });
  });

  it("takes a fresh port and token when nothing was recorded", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-open", state: "EXECUTING", assignment: "a" }]);

    await cli("resume", "--repo", "/repo");

    expect(h.dashboardArgs.at(-1)![2]).toEqual({ port: undefined, preferPort: undefined, token: undefined });
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

  it("treats a run that failed in planning as resumable", async () => {
    // The state run f338b5c8 was stuck in: FAILED before it produced a task,
    // holding an intake conversation the operator was otherwise going to have
    // to sit through again. A FAILED run with work in flight still stays shut.
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-planless", state: "FAILED", assignment: "build the thing" }]);
    h.controllerMethods.replannable.mockReturnValue(true);

    await cli("resume", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("Resuming run run-planless [FAILED]");
    expect(h.controllerMethods.resume).toHaveBeenCalledWith("run-planless", undefined);
  });

  it("leaves a run that failed with work in flight closed", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-failed", state: "FAILED", assignment: "build the thing" }]);

    await cli("resume", "--repo", "/repo", "--no-dashboard");

    expect(printed()).toContain("No run to resume");
    expect(h.controllerMethods.resume).not.toHaveBeenCalled();
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

  it("refuses to re-route a judge onto the small tier mid-run, readably", async () => {
    // The resume line is where an operator reaches for a cheaper model, because
    // the reason to re-route is almost always that the budget is going faster
    // than the work. `qa` is the one that must not get cheaper.
    existing({ models: { qa: "claude-sonnet-5" } });
    h.loadFileConfigMock.mockReturnValue({ config: {}, path: "/repo/harness.config.json" });

    await expect(
      cli("resume", "run-1", "--repo", "/repo", "--no-dashboard", "--model", "qa=claude-haiku-4-5-20251001")
    ).rejects.toThrow(/that run configuration cannot be used:[\s\S]*below the capability floor/);
    expect(h.storeMethods.patchRunConfig).not.toHaveBeenCalled();
  });

  it("names the whole config when what is wrong is the config, not one field", () => {
    expect(() => parseRunConfig("not a config")).toThrow(/^that run configuration cannot be used:\n {2}\(root\): /);
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

  it("moves the rest of the run onto another Claude subscription", async () => {
    // The reason this is a flag and not a config edit: a run parked at 96% of
    // its weekly window is being resumed *because* the operator has another
    // subscription, and typing JSON is not what they want to be doing.
    existing({ subscription: { accounts: [{ name: "work", env: { CLAUDE_CONFIG_DIR: "/w" }, note: "" }], active: "", windows: ["seven_day"], pauseAtPercent: 95, preflight: true } });
    h.loadFileConfigMock.mockReturnValue({ config: {}, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard", "--account", "work");

    expect(h.storeMethods.patchRunConfig).toHaveBeenCalledWith("run-1", expect.objectContaining({ subscription: expect.objectContaining({ active: "work" }) }));
    expect(printed()).toContain("Subscription for the rest of the run: work");
  });

  it("takes an account the operator has only just configured", async () => {
    // The accounts come from the file rather than from the run: a subscription
    // added after the run started is exactly the one it needs.
    const accounts = [{ name: "work", env: { CLAUDE_CONFIG_DIR: "/w" }, note: "" }];
    existing({ subscription: { accounts: [], active: "", windows: ["seven_day"], pauseAtPercent: 95, preflight: true } });
    h.loadFileConfigMock.mockReturnValue({ config: { subscription: { accounts } }, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard", "--account", "work");

    expect(h.storeMethods.patchRunConfig).toHaveBeenCalledWith("run-1", expect.objectContaining({ subscription: expect.objectContaining({ accounts, active: "work" }) }));
  });

  it("refuses an account it cannot authenticate as, before the run starts spending", async () => {
    // Resolved here so a missing `$TOKEN` is a sentence, rather than a run that
    // starts, authenticates as the account it was told to leave, and says it
    // switched.
    existing({ subscription: { accounts: [], active: "", windows: ["seven_day"], pauseAtPercent: 95, preflight: true } });
    h.loadFileConfigMock.mockReturnValue({ config: {}, path: "/repo/harness.config.json" });
    h.accountEnvMock.mockImplementation(() => {
      throw new Error('No subscription account named "work" — known accounts: none configured');
    });

    await expect(cli("resume", "run-1", "--repo", "/repo", "--no-dashboard", "--account", "work")).rejects.toThrow(/No subscription account named "work"/);
    expect(h.storeMethods.patchRunConfig).not.toHaveBeenCalled();
  });

  it("hands a run back to the login the operator is sitting at", async () => {
    // `--account ""` is the way back: a run moved onto a work subscription for
    // an afternoon should not need a config edit to come home.
    existing({ subscription: { accounts: [{ name: "work", env: { CLAUDE_CONFIG_DIR: "/w" }, note: "" }], active: "work", windows: ["seven_day"], pauseAtPercent: 95, preflight: true } });
    h.loadFileConfigMock.mockReturnValue({ config: {}, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard", "--account", "");

    expect(printed()).toContain("Subscription for the rest of the run: (the account you are logged into)");
  });

  it("says nothing about a subscription nobody changed", async () => {
    existing({ subscription: { accounts: [], active: "", windows: ["seven_day"], pauseAtPercent: 95, preflight: true } });
    h.loadFileConfigMock.mockReturnValue({ config: {}, path: "/repo/harness.config.json" });

    await cli("resume", "run-1", "--repo", "/repo", "--no-dashboard");

    expect(h.storeMethods.patchRunConfig).not.toHaveBeenCalled();
    expect(printed()).not.toContain("Subscription for the rest of the run");
  });

  it("gives a run frozen before subscriptions existed the defaults it has been behaving as", async () => {
    // Its config JSON has no such key at all, and reading `.active` off it
    // would throw on the resume of every run older than this feature.
    existing({ deterministicChecks: [] });
    h.loadFileConfigMock.mockReturnValue({ config: {}, path: "/repo/harness.config.json" });

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

describe("harness probe", () => {
  const stuck = { id: "ui-login", state: "WORKING", completionProbe: "! rg -qi 'passkey' src" };

  beforeEach(() => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "EXECUTING", assignment: "a" }]);
    h.storeMethods.getTask.mockReturnValue(stuck);
    process.exitCode = undefined;
  });

  it("rewrites the probe of the newest run holding that task, and says it lands without a restart", async () => {
    await cli("probe", "ui-login", "! rg -qi 'passkey' src -g '!**/*.gen.ts'", "--repo", "/repo", "--why", "the only hit is a generated enum");

    expect(h.storeMethods.amendProbe).toHaveBeenCalledWith("run-1", "ui-login", "! rg -qi 'passkey' src -g '!**/*.gen.ts'", "operator", "the only hit is a generated enum");
    expect(printed()).toContain("was  ! rg -qi 'passkey' src");
    expect(printed()).toContain("now  ! rg -qi 'passkey' src -g '!**/*.gen.ts'");
    expect(printed()).toContain("you do not need to resume it");
  });

  it("withdraws the probe on --clear", async () => {
    await cli("probe", "ui-login", "--clear", "--repo", "/repo");

    expect(h.storeMethods.amendProbe).toHaveBeenCalledWith("run-1", "ui-login", "", "operator", "");
    expect(printed()).toContain("QA alone decides this task");
  });

  it("shows the current probe rather than guessing when given neither", async () => {
    // "No new probe" and "withdraw the probe" are one keystroke apart and one is
    // irreversible, so the empty case asks rather than acts.
    await cli("probe", "ui-login", "--repo", "/repo");

    expect(h.storeMethods.amendProbe).not.toHaveBeenCalled();
    expect(printed()).toContain("! rg -qi 'passkey' src");
    expect(process.exitCode).toBe(1);
  });

  it("does not report a change when the probe is already what you typed", async () => {
    await cli("probe", "ui-login", "! rg -qi 'passkey' src", "--repo", "/repo");

    expect(h.storeMethods.amendProbe).not.toHaveBeenCalled();
    expect(printed()).toContain("already held to exactly that");
  });

  it("says so when no run in the repo has that task", async () => {
    h.storeMethods.getTask.mockReturnValue(undefined);

    await cli("probe", "nope", "true", "--repo", "/repo");

    expect(printed()).toContain("No run in this repo has a task called nope");
    expect(h.storeMethods.amendProbe).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("names the run you asked about when the task is not in that one", async () => {
    // Different mistake, different fix: with --run the task may well exist, in
    // the run next to the one you typed, and "no run has this task" would send
    // you looking for a typo in the task id instead.
    h.storeMethods.getTask.mockReturnValue(undefined);

    await cli("probe", "ui-login", "true", "--run", "run-9", "--repo", "/repo");

    expect(printed()).toContain("No task ui-login in run run-9");
    expect(h.storeMethods.amendProbe).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("says a task has no probe rather than printing an empty line where one goes", async () => {
    // Most tasks have no probe at all, so this is the common way to arrive here
    // — and a blank line under "currently held to:" reads as a display bug.
    h.storeMethods.getTask.mockReturnValue({ ...stuck, completionProbe: "" });

    await cli("probe", "ui-login", "--repo", "/repo");

    expect(printed()).toContain("currently held to:\n  (no probe)");
    expect(process.exitCode).toBe(1);
  });

  it("gives a task that never had a probe one, and shows what it was before", async () => {
    h.storeMethods.getTask.mockReturnValue({ ...stuck, completionProbe: "" });

    await cli("probe", "ui-login", "test -f dist/main.js", "--repo", "/repo");

    expect(h.storeMethods.amendProbe).toHaveBeenCalledWith("run-1", "ui-login", "test -f dist/main.js", "operator", "");
    expect(printed()).toContain("was  (no probe)");
    expect(printed()).toContain("now  test -f dist/main.js");
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

  it("fails when the run it was told to explain does not exist", async () => {
    // `probe` and `regroup` already exit 1 for a named target that is not
    // there. Reporting a typo as success is what lets the second half of
    // `harness postmortem $ID && …` run against a run nobody looked at.
    h.storeMethods.getRun.mockReturnValue(undefined);
    process.exitCode = undefined;

    await cli("postmortem", "nope", "--repo", "/repo");

    expect(process.exitCode).toBe(1);
    // The process is shared with every other test in this file; a leaked 1
    // fails the next one that asserts on it.
    process.exitCode = undefined;
  });

  it("succeeds when nothing specific was asked for and there is nothing to explain", async () => {
    // Not the same failure: no run was named, so "No runs yet" is a true and
    // complete answer, and a script asking "has anything happened here?"
    // should not have to treat "no" as an error.
    h.storeMethods.listRuns.mockReturnValue([]);
    process.exitCode = undefined;

    await cli("postmortem", "--repo", "/repo");

    expect(process.exitCode).toBeUndefined();
  });

  it("does not bring a state directory into being to report that there is none", async () => {
    h.existsSyncMock.mockReturnValue(false);

    await cli("postmortem", "--repo", "/repo");

    expect(printed()).toBe("No runs yet.\n");
    expect(h.StoreMock).not.toHaveBeenCalled();
    expect(h.mkdirSyncMock).not.toHaveBeenCalled();
    expect(h.writeFileSyncMock).not.toHaveBeenCalled();
  });
});

describe("harness status", () => {
  it("leaves a repository it was only asked to read exactly as it found it", async () => {
    // `harness status` in a checkout that has never been run used to create
    // `.harness/`, open an empty database in it and add a `.gitignore` entry —
    // three writes to answer a question about whether anything had happened.
    h.existsSyncMock.mockReturnValue(false);

    await cli("status", "--repo", "/repo");

    expect(printed()).toBe("No runs yet.\n");
    expect(h.StoreMock).not.toHaveBeenCalled();
    expect(h.mkdirSyncMock).not.toHaveBeenCalled();
    expect(h.writeFileSyncMock).not.toHaveBeenCalled();
    expect(h.armCrashLogMock).not.toHaveBeenCalled();
  });

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

  it("names the command that opens a dashboard when none is running", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "PR_REVIEW", assignment: "a" }]);

    await cli("status", "--repo", "/repo");

    expect(printed()).toContain("dashboard  none running — `harness dashboard` serves this repo's runs");
  });

  it("links the dashboard a run is serving right now", async () => {
    // The whole point: the url was printed once, in the banner of a run that
    // has been going for hours, in a terminal the operator may not even still
    // have open. `status` is where they look instead. Whether the server is
    // really up is dashboardLink's question, and is tested there.
    h.liveDashboardUrlMock.mockResolvedValue("http://127.0.0.1:4813/#livetoken");
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "EXECUTING", assignment: "a" }]);

    await cli("status", "--repo", "/repo");

    expect(printed()).toContain("dashboard  http://127.0.0.1:4813/#livetoken   (the fragment is your auth token)");
  });

  it("asks the repo it was pointed at, not the working directory", async () => {
    h.storeMethods.listRuns.mockReturnValue([{ id: "run-1", state: "DONE", assignment: "a" }]);

    await cli("status", "--repo", "/somewhere/else");

    expect(h.liveDashboardUrlMock).toHaveBeenCalledWith("/somewhere/else");
  });
});

describe("harness pause", () => {
  /**
   * The run lives in another process, so pausing is a request sent to its
   * dashboard. This is that dashboard: it answers `/api/state` with whatever the
   * test says is running, and records the pause it was asked for.
   */
  function servingRun(runs: { id: string; state: string }[], pause: { ok?: boolean; body?: unknown } = {}) {
    const calls: { url: string; method: string; auth: string | undefined; type: string | undefined }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        auth: init?.headers?.authorization,
        type: init?.headers?.["content-type"],
      });
      const json = url.endsWith("api/state") ? { runs } : (pause.body ?? { ok: true, message: "pausing — the agents stop at their next message" });
      return { ok: url.endsWith("api/state") ? true : pause.ok !== false, json: async () => json };
    });
    vi.stubGlobal("fetch", fetchMock);
    h.liveDashboardUrlMock.mockResolvedValue("http://127.0.0.1:4777/#tok");
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finds the running run itself, and says how to get it back", async () => {
    const calls = servingRun([
      { id: "run-done", state: "DONE" },
      { id: "run-1", state: "EXECUTING" },
    ]);

    await cli("pause", "--repo", "/repo");

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET http://127.0.0.1:4777/api/state",
      "POST http://127.0.0.1:4777/api/runs/run-1/pause",
    ]);
    // The fragment is the credential; a request without it is a 401.
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
    // Neither request carries a body, so neither may claim a content type: a
    // JSON body parser answers that with a 400 before the route is reached.
    expect(calls.every((c) => c.type === undefined)).toBe(true);
    expect(printed()).toContain("pausing — the agents stop at their next message");
    expect(printed()).toContain("harness resume run-1");
    expect(printed()).toContain("It comes back on this same dashboard: http://127.0.0.1:4777/#tok");
  });

  it("pauses the run the operator named, without asking which is running", async () => {
    const calls = servingRun([{ id: "run-1", state: "EXECUTING" }]);

    await cli("pause", "run-7", "--repo", "/repo");

    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4777/api/runs/run-7/pause"]);
  });

  it("says there is nothing to pause when no dashboard is serving this repo", async () => {
    h.liveDashboardUrlMock.mockResolvedValue(null);

    await cli("pause", "--repo", "/repo");

    expect(printed()).toContain("nothing to pause — no run is serving a dashboard for this repo.");
  });

  it("says there is nothing to pause when the dashboard's runs have all finished", async () => {
    servingRun([{ id: "run-1", state: "PR_REVIEW" }]);

    await cli("pause", "--repo", "/repo");

    expect(printed()).toContain("nothing to pause — that dashboard has no run still working.");
  });

  it("treats a dashboard that stops answering as nothing to pause", async () => {
    // It was alive a moment ago — `liveDashboardUrl` asked it — and died between
    // the two requests. Nothing was paused, and saying so is the whole job.
    h.liveDashboardUrlMock.mockResolvedValue("http://127.0.0.1:4777/#tok");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));

    await cli("pause", "--repo", "/repo");

    expect(printed()).toContain("nothing to pause — that dashboard has no run still working.");
  });

  it("still says how to get the run back when the dashboard answers with nothing", async () => {
    servingRun([{ id: "run-1", state: "EXECUTING" }], { body: {} });

    await cli("pause", "--repo", "/repo");

    expect(printed()).toContain("pausing\n");
    expect(printed()).toContain("harness resume run-1");
  });

  it("reports the status code when a refusal says nothing", async () => {
    h.liveDashboardUrlMock.mockResolvedValue("http://127.0.0.1:4777/#tok");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: url.endsWith("api/state"),
      status: url.endsWith("api/state") ? 200 : 500,
      json: async () => {
        if (url.endsWith("api/state")) return { runs: [{ id: "run-1", state: "EXECUTING" }] };
        throw new Error("not json");
      },
    })));

    await cli("pause", "--repo", "/repo");

    expect(printed()).toContain("could not pause: 500");
  });

  it("passes on the controller's refusal rather than claiming it worked", async () => {
    servingRun([{ id: "run-1", state: "EXECUTING" }], {
      ok: false,
      body: { error: "this run is PAUSED — only a run that is still working can be paused" },
    });

    await cli("pause", "--repo", "/repo");

    expect(printed()).toContain("could not pause: this run is PAUSED");
    expect(printed()).not.toContain("harness resume");
  });
});

describe("harness dashboard", () => {
  it("serves the repo's runs, finished ones included, until the operator stops it", async () => {
    // A run that ends leaves `listOpenRuns`, which is right for a dashboard
    // attached to a run and wrong for this one: the finished run is the whole
    // reason the operator opened it.
    const running = cli("dashboard", "--repo", "/repo");
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.dashboardArgs.at(-1)![2]).toMatchObject({ includeFinished: true });
    expect(printed()).toContain("http://localhost:4777/#tok   (the fragment is your auth token)");
    expect(printed()).toContain("Read-only");

    process.emit("SIGINT");
    await running;

    expect(h.dashboardMethods.stop).toHaveBeenCalled();
    expect(printed()).toContain("dashboard stopped.");
  });

  it("leaves no signal handler behind once it has stopped", async () => {
    const before = process.listenerCount("SIGTERM");
    const running = cli("dashboard", "--repo", "/repo");
    await new Promise((resolve) => setImmediate(resolve));
    process.emit("SIGINT");
    await running;

    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("binds the port the operator pinned", async () => {
    const running = cli("dashboard", "--repo", "/repo", "--port", "5000");
    await new Promise((resolve) => setImmediate(resolve));
    process.emit("SIGINT");
    await running;

    expect(h.dashboardArgs.at(-1)![2]).toMatchObject({ port: 5000 });
  });
});

describe("harness init", () => {
  it("writes the settings this repo would run with", async () => {
    h.detectChecksMock.mockReturnValue({ checks: ["npm test", "npm run lint"], source: "package.json" });

    await cli("init", "--repo", "/repo");

    const [target, body] = h.writeFileSyncMock.mock.calls[0] as [string, string];
    expect(target).toBe("/repo/harness.config.json");
    expect(JSON.parse(body)).toEqual({
      budget: { runCapUsd: 30 },
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

  it("says so, loudly, when the repo's CI never ran on the branch", async () => {
    const shown = await reportFor({ ci: { prNumber: 1, state: "none", failing: [], total: 0 } as never });

    expect(shown).toContain("CI: NONE");
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
