import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@charrette/shared";

/**
 * The `read_issue` half of intake.
 *
 * An operator's opening line is very often nothing but a link. Before this the
 * intake agent had Read, Glob and Grep and no way to reach GitHub, so it did the
 * only thing left: asked the operator to paste the issue back at the charrette
 * that files issues for a living. These tests cover the tool that closed that,
 * and — just as much — the cases where it comes back empty, because an agent
 * that is handed a blank specification writes a brief for the wrong product.
 *
 * Same interception as intakeAsk: `tool()` is stubbed so the handlers defined
 * inside `runIntake` can be executed directly.
 */
const { toolMock, createSdkMcpServerMock } = vi.hoisted(() => ({
  toolMock: vi.fn((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    schema,
    handler,
  })),
  createSdkMcpServerMock: vi.fn((args: unknown) => ({ sdkServer: args })),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ tool: toolMock, createSdkMcpServer: createSdkMcpServerMock }));

import { Bus } from "./bus.js";
import { Store } from "./store.js";
import { parseIssueRef, runIntake, type IntakeRequest } from "./intake.js";
import { GitHubAdapter, type IssueRead } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";

type ReadHandler = (args: { reference: string }) => Promise<{ content: { type: string; text: string }[] }>;

const BRIEF = "```json\n" + JSON.stringify({ goal: "g", context: "", decisions: [] }) + "\n```";

const ISSUE = (over: Partial<IssueRead> = {}): IssueRead => ({
  slug: "owner/repo",
  number: 480,
  url: "https://github.com/owner/repo/issues/480",
  title: "Conflict engine misses overlapping holds",
  state: "open",
  author: "operator",
  labels: ["bug"],
  body: "Two holds on the same slot both settle.",
  comments: [],
  omittedComments: 0,
  ...over,
});

let store: Store;
let bus: Bus;

function poolThat(body?: (spec: AgentSpec) => Promise<void>): { pool: AgentPool; specs: AgentSpec[] } {
  const specs: AgentSpec[] = [];
  return {
    specs,
    pool: {
      async run(spec: AgentSpec): Promise<AgentResult> {
        specs.push(spec);
        await body?.(spec);
        return { sessionId: "intake-session", resultText: BRIEF, costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool,
  };
}

function request(over: Partial<IntakeRequest> = {}): IntakeRequest {
  return {
    runId: "r1",
    seed: "implement owner/repo#480",
    repoPath: "/repo",
    config: RunConfig.parse({}),
    ui: { async ask() { return ""; }, say() {} },
    budgetCheck: () => {},
    ...over,
  };
}

/** The handler `runIntake` registered under a given tool name. */
function handler(name: string): ReadHandler {
  const made = toolMock.mock.results.map((r) => r.value as { name: string; handler: ReadHandler });
  return made.find((t) => t.name === name)!.handler;
}

/** Run one `read_issue` call against a stubbed reader and return what the agent is told. */
async function reads(reference: string, reader: IntakeRequest["readIssue"]): Promise<string> {
  let text = "";
  const { pool } = poolThat(async () => {
    text = (await handler("read_issue")({ reference })).content[0]!.text;
  });
  await runIntake(pool, bus, request({ readIssue: reader }));
  return text;
}

beforeEach(() => {
  toolMock.mockClear();
  createSdkMcpServerMock.mockClear();
  store = new Store(":memory:");
  bus = new Bus(store);
});

describe("making sense of however the operator wrote the reference", () => {
  it.each([
    ["a browser URL", "https://github.com/owner/repo/issues/480", { slug: "owner/repo", number: 480 }],
    ["a pull request URL", "https://github.com/owner/repo/pull/480", { slug: "owner/repo", number: 480 }],
    ["a URL inside a sentence", "see https://github.com/a/b/issues/7 for the spec", { slug: "a/b", number: 7 }],
    ["a cross-repo reference", "owner/repo#480", { slug: "owner/repo", number: 480 }],
    ["a bare hash", "#480", { number: 480 }],
    ["a bare number", "480", { number: 480 }],
    ["surrounding whitespace", "  #480  ", { number: 480 }],
  ])("reads %s", (_case, text, expected) => {
    expect(parseIssueRef(text)).toEqual(expected);
  });

  /**
   * Null rather than a guess. Fetching *some* issue and presenting it as the one
   * that was asked for is the one outcome worse than failing.
   */
  it.each([
    ["prose with no reference", "the rate limiting one"],
    ["an empty string", ""],
    ["a repo with no issue number", "owner/repo"],
    ["a number buried in a sentence", "look at issue 480 please"],
  ])("refuses to guess at %s", (_case, text) => {
    expect(parseIssueRef(text)).toBeNull();
  });
});

describe("what the agent is told", () => {
  it("renders the issue with its labels, its author and its thread", async () => {
    const text = await reads("owner/repo#480", async () =>
      ISSUE({ comments: [{ author: "someone-else", body: "only when both are pending" }] })
    );

    expect(text).toContain("owner/repo#480 — Conflict engine misses overlapping holds");
    expect(text).toContain("state: open   opened by: operator   labels: bug");
    expect(text).toContain("https://github.com/owner/repo/issues/480");
    expect(text).toContain("Two holds on the same slot both settle.");
    expect(text).toContain("--- 1 comment(s) ---");
    expect(text).toContain("@someone-else:\nonly when both are pending");
  });

  it("leaves out the label and comment sections when there are none", async () => {
    const text = await reads("#480", async () => ISSUE({ labels: [] }));

    expect(text).toContain("state: open   opened by: operator\n");
    expect(text).not.toContain("labels:");
    expect(text).not.toContain("comment(s)");
  });

  /**
   * An agent that believes it has read the whole thread writes the brief as
   * though the comment it happened to stop at was the last word on the subject.
   */
  it("says how much of the thread it did not get", async () => {
    const text = await reads("#480", async () =>
      ISSUE({ comments: [{ author: "operator", body: "first" }], omittedComments: 2488 })
    );

    expect(text).toContain("--- 1 comment(s) (2488 more not shown — read them at the URL above) ---");
  });

  it("still says so when the budget left it with no comments at all", async () => {
    const text = await reads("#480", async () => ISSUE({ comments: [], omittedComments: 2500 }));

    expect(text).toContain("--- thread not shown (2500 more not shown — read them at the URL above) ---");
  });

  /** An issue that is only a title still says so, rather than trailing off. */
  it("names an empty description instead of showing a blank", async () => {
    const text = await reads("#480", async () => ISSUE({ body: "" }));

    expect(text).toContain("(no description)");
  });

  it("passes the repository through when the reference names one, and omits it otherwise", async () => {
    const seen: (string | undefined)[] = [];
    const reader = async (_n: number, slug?: string): Promise<IssueRead | null> => {
      seen.push(slug);
      return ISSUE();
    };

    await reads("other/project#12", reader);
    await reads("#12", reader);

    expect(seen).toEqual(["other/project", undefined]);
  });
});

describe("when there is nothing to read", () => {
  /**
   * The agent's next move — ask the operator to paste it — is the right one, and
   * it can only make it if the miss is stated plainly.
   */
  it("says the issue could not be read and what to do instead", async () => {
    const text = await reads("owner/repo#480", async () => null);

    expect(text).toContain("owner/repo#480 could not be read");
    expect(text).toContain("Ask the operator to paste the contents instead.");
  });

  it("names an unqualified issue by its number alone", async () => {
    const text = await reads("#480", async () => null);

    expect(text).toContain("#480 could not be read");
  });

  it("reports an unreadable reference without calling GitHub at all", async () => {
    const reader = vi.fn(async () => ISSUE());
    const text = await reads("the rate limiting one", reader);

    expect(text).toContain('Could not read an issue number out of "the rate limiting one"');
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("whether the tool is offered at all", () => {
  it("mounts read_issue and allows it when the run can reach GitHub", async () => {
    const { pool, specs } = poolThat();

    await runIntake(pool, bus, request({ readIssue: async () => ISSUE() }));

    expect(specs[0]!.allowedTools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "mcp__charrette_intake__ask_user",
      "mcp__charrette_intake__read_issue",
    ]);
    const server = createSdkMcpServerMock.mock.calls[0]![0] as { tools: { name: string }[] };
    expect(server.tools.map((t) => t.name)).toEqual(["ask_user", "read_issue"]);
    expect(specs[0]!.systemPrompt).toContain("read_issue tool");
  });

  /**
   * A local-only run has no token, so a mounted reader could only ever fail —
   * and an agent told it has one asks the operator for an issue it cannot fetch,
   * then has to walk it back. Better to never claim it.
   */
  it("offers neither the tool nor the instruction when it cannot", async () => {
    const { pool, specs } = poolThat();

    await runIntake(pool, bus, request());

    expect(specs[0]!.allowedTools).toEqual(["Read", "Glob", "Grep", "mcp__charrette_intake__ask_user"]);
    const server = createSdkMcpServerMock.mock.calls[0]![0] as { tools: { name: string }[] };
    expect(server.tools.map((t) => t.name)).toEqual(["ask_user"]);
    expect(specs[0]!.systemPrompt).not.toContain("read_issue");
  });
});

/**
 * The wiring, end to end: an operator types a link, and the issue comes back
 * from the same token the run files its own issues with. Everything above this
 * point stubs the reader — this is the test that would have caught the charrette
 * shipping a `read_issue` tool that reached nothing.
 */
describe("the reader the controller hands intake", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "charrette-intake-github-"));
    made.push(dir, `${dir}-wt`);
    writeFileSync(path.join(dir, "README.md"), "# fixture\n");
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.email", "charrette@example.com"],
      ["config", "user.name", "charrette"],
      ["add", "-A"],
      ["commit", "-m", "init"],
    ]) {
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    }
    return dir;
  }

  const gates: GateHandler = {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
    async resolveTaskGate() {
      return null;
    },
  };

  /**
   * Reads the issue during intake and then kills the session, so the assertion
   * is about the tool rather than about a whole run's worth of planning.
   */
  async function intakeReads(github: GitHubAdapter, reference: string): Promise<string> {
    const dir = repo();
    const store = new Store(":memory:");
    let text = "unread";
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        if (spec.role !== "intake") throw new Error("intake was expected to be first");
        text = (await handler("read_issue")({ reference })).content[0]!.text;
        throw new Error("that is all this test needed");
      },
    } as unknown as AgentPool;

    await expect(
      new RunController(store, new Bus(store), pool, github, gates, dir).startRun(
        `implement ${reference}`,
        RunConfig.parse({ deterministicChecks: [], waitForChecks: false }),
        { async ask() { return ""; }, say() {} }
      )
    ).rejects.toThrow("that is all this test needed");
    return text;
  }

  it("reaches GitHub with the run's own token", async () => {
    const github = new GitHubAdapter("token", "owner/repo");
    const get = vi.fn(async () => ({
      data: {
        number: 480,
        html_url: "https://github.com/owner/repo/issues/480",
        title: "Conflict engine misses overlapping holds",
        state: "open",
        user: { login: "operator" },
        labels: [],
        body: "Two holds on the same slot both settle.",
      },
    }));
    (github as unknown as { octokit: unknown }).octokit = {
      rest: { issues: { get, listComments: vi.fn() } },
      paginate: vi.fn(async () => []),
    };

    const text = await intakeReads(github, "https://github.com/owner/repo/issues/480");

    expect(get).toHaveBeenCalledWith({ owner: "owner", repo: "repo", issue_number: 480 });
    expect(text).toContain("Two holds on the same slot both settle.");
  }, 30_000);

  it("hands intake no reader at all on a run with no GitHub configured", async () => {
    const dir = repo();
    const store = new Store(":memory:");
    const specs: AgentSpec[] = [];
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        specs.push(spec);
        throw new Error("that is all this test needed");
      },
    } as unknown as AgentPool;

    await expect(
      new RunController(store, new Bus(store), pool, new GitHubAdapter(undefined, undefined), gates, dir).startRun(
        "implement #480",
        RunConfig.parse({ deterministicChecks: [], waitForChecks: false }),
        { async ask() { return ""; }, say() {} }
      )
    ).rejects.toThrow("that is all this test needed");

    expect(specs[0]!.allowedTools).not.toContain("mcp__charrette_intake__read_issue");
  }, 30_000);
});
