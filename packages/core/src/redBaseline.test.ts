import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@charrette/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { observeFlakySignatures, recall } from "./memory.js";
import { Store } from "./store.js";

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [
      {
        id: "task-a",
        epicId: "epic-e",
        title: "Webhook delivery",
        spec: "Deliver signed webhooks",
        acceptanceCriteria: ["it delivers"],
        dependsOn: [],
        touchedPaths: [],
        estimatedSize: "S",
      },
    ],
  }) +
  "\n```";

/**
 * The check reads a file that is already committed, so "what the suite does" is
 * a property of the tree — identical on the base, and changed only by a worker
 * that actually breaks something.
 */
const CHECK = "cat failures.txt >&2; exit 1";
const PRE_EXISTING = "✖ card provider rejects an expired token (196.264417ms)";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-baseline-"));
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  writeFileSync(path.join(dir, "failures.txt"), `${PRE_EXISTING}\n`);
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "charrette@example.com");
  gitIn(dir, "config", "user.name", "charrette");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-m", "init");
  return dir;
}

const noGithub = { enabled: false } as unknown as GitHubAdapter;
const approveAll: GateHandler = {
  async resolvePlanGate() {
    return { approved: true, feedback: "" };
  },
  async resolveBudgetGate() {
    return null;
  },
};

/** Plays the happy path; `work` is what the worker does to its worktree. */
function pool(work: (cwd: string) => void) {
  let planning = 0;
  const qaPrompts: string[] = [];
  const agents = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      let resultText = "";
      if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
      else if (spec.role === "worker") {
        work(spec.cwd);
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        resultText = "worker done";
      } else if (spec.role === "qa") {
        qaPrompts.push(spec.prompt as string);
        resultText = '{"verdict":"PASS","notes":"fine"}';
      } else resultText = '{"verdict":"PASS","summary":"n/a"}';
      return { sessionId: `s${qaPrompts.length}${planning}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: agents as unknown as AgentPool, qaPrompts };
}

async function run(work: (cwd: string) => void, checks: string[] = [CHECK], seed?: (store: Store) => void, deterministicCheckTimeoutMinutes?: number) {
  const { pool: agents, qaPrompts } = pool(work);
  const store = new Store(":memory:");
  seed?.(store);
  const events: string[] = [];
  const bus = new Bus(store);
  bus.subscribe(({ event }) => void (event.type === "agent.log" && events.push(event.text)));
  const controller = new RunController(store, bus, agents, noGithub, approveAll, repo());
  const runId = await controller.startRun(
    "build it",
    RunConfig.parse({ deterministicChecks: checks, qaIterationCap: 1, ...(deterministicCheckTimeoutMinutes === undefined ? {} : { deterministicCheckTimeoutMinutes }) })
  );
  return { task: store.getTask(runId, "task-a")!, qaPrompts, events, store };
}

/**
 * Production, run 40da9337: `webhook-delivery-worker` failed its deterministic
 * checks three times on `providers.test.ts` — a test belonging to another task's
 * code, pulled into its worktree by a catch-up merge and already failing on the
 * integration branch. It burned its whole iteration cap on somebody else's bug
 * and escalated to the operator with correct work sitting in the worktree.
 */
describe("a task whose base is already red", () => {
  it("is not charged for a failure it inherited, and reaches QA", async () => {
    const { task, qaPrompts } = await run((cwd) => writeFileSync(path.join(cwd, "feature.ts"), "export const x = 1;\n"));

    expect(task.state).toBe("MERGED");
    // Never spent an iteration: the check failed, and none of it was its doing.
    expect(task.qaIterations).toBe(1); // the QA pass itself, not a check failure
    expect(qaPrompts).toHaveLength(1);
    // And QA is told, so it does not independently fail the task for the same suite.
    expect(qaPrompts[0]).toContain("Already red on the integration branch");
    expect(qaPrompts[0]).toContain(CHECK);
  }, 30_000);

  it("is still charged for the failure it introduced itself", async () => {
    const { task, qaPrompts } = await run((cwd) => {
      writeFileSync(path.join(cwd, "feature.ts"), "export const x = 1;\n");
      appendFileSync(path.join(cwd, "failures.txt"), "✖ webhook signature verifies against the endpoint secret\n");
    });

    // One new failure among the inherited ones is still a failure: cap is 1, so
    // it escalates rather than merging.
    expect(task.state).toBe("NEEDS_HUMAN");
    expect(qaPrompts).toHaveLength(0);
  }, 30_000);
});

/**
 * The other way a task is charged for something it did not do, and the one the
 * base comparison cannot catch: a failure that is not in the tree at all.
 * Run 40da9337 shared one local DynamoDB table across every worktree, and 29 of
 * its 77 gates were failing deterministic checks — a task asked to fix a
 * neighbour's leftover process, spending the iteration cap that opens the gate.
 */
describe("a check that fails for a reason outside the tree", () => {
  // Fails the first time it is run in a directory and passes afterwards, which
  // is what contamination looks like from here. Only fires where the worker has
  // been, so the integration branch stays green and the base comparison — which
  // would otherwise call this inherited — has nothing to say about it.
  const FLAKY = "test -f flaky.txt || exit 0; test -f .ran && exit 0; touch .ran; echo '✖ connection to localhost:8000 refused' >&2; exit 1";

  it("asks again, and does not charge the task for a failure that does not survive", async () => {
    const { task, qaPrompts, events } = await run(
      (cwd) => writeFileSync(path.join(cwd, "flaky.txt"), "x\n"),
      [FLAKY]
    );

    expect(task.state).toBe("MERGED");
    // No iteration spent sending a worker to fix code that was never broken.
    expect(task.qaIterations).toBe(1);
    expect(qaPrompts).toHaveLength(1);
    expect(events.some((t) => /failed once and passed on a re-run — not charged to this task/.test(t))).toBe(true);
  }, 30_000);

  it("still charges it for one that fails both times", async () => {
    // Same shape, minus the flakiness: red wherever the worker has been, and
    // red again when asked a second time. Cap is 1, so it escalates.
    const { task } = await run((cwd) => writeFileSync(path.join(cwd, "feature.ts"), "export const x = 1;\n"), [
      "test -f feature.ts || exit 0; echo '✖ this one is real' >&2; exit 1",
    ]);

    expect(task.state).toBe("NEEDS_HUMAN");
  }, 30_000);
});

/**
 * The shape neither the base comparison nor the command-level re-run can see,
 * from run bc691359: `deploy-container-images-pinned` reopened its gate three
 * times on `cargo test --workspace`, red twice in a row each cycle — but each
 * time on a different pre-existing test its diff never touched. A property
 * test on a fresh draw and a timing assertion under load keep a command red
 * while never failing the same way twice.
 */
describe("a check that fails twice without ever failing the same way", () => {
  // Red only where the worker has been, and a different failing "test" every
  // run: the marker files count how many times it has been asked.
  const GENERATOR = "test -f flaky.txt || exit 0; n=$(ls d.* 2>/dev/null | wc -l | tr -d ' '); touch d.$n; echo \"✖ draw $n\" >&2; exit 1";

  it("is not charged: nothing failed twice, and the draws are remembered as flaky", async () => {
    const { task, events, store } = await run((cwd) => writeFileSync(path.join(cwd, "flaky.txt"), "x\n"), [GENERATOR]);

    expect(task.state).toBe("MERGED");
    expect(task.qaIterations).toBe(1); // the QA pass itself, not a check failure
    expect(events.some((t) => /failed once and passed on a re-run — not charged to this task/.test(t))).toBe(true);
    // The failure the re-run did not reproduce is now a signature-level fact
    // this repository keeps, for the next task that meets it.
    expect(recall(store, "signature").map((o) => [o.subject, o.verdict])).toEqual([["✖ draw 0", "flaky"]]);
  }, 30_000);
});

describe("a failure the repository already knows is weather", () => {
  // Persistent wherever the worker has been — it fails the re-run too, which
  // is exactly what a timing assertion does while the machine is loaded.
  const PERSISTENT = "test -f feature.ts || exit 0; echo '✖ timing test' >&2; exit 1";

  it("is excused when every repeated failure has been watched come and go twice before", async () => {
    const { task, events } = await run(
      (cwd) => writeFileSync(path.join(cwd, "feature.ts"), "export const x = 1;\n"),
      [PERSISTENT],
      (store) => {
        observeFlakySignatures(store, "earlier-run-1", ["✖ timing test"]);
        observeFlakySignatures(store, "earlier-run-2", ["✖ timing test"]);
      }
    );

    expect(task.state).toBe("MERGED");
    expect(task.qaIterations).toBe(1);
    expect(events.some((t) => /known flaky, not charged to this task: ✖ timing test/.test(t))).toBe(true);
  }, 30_000);

  it("is still charged on one prior sighting — an anecdote excuses nothing", async () => {
    const { task } = await run(
      (cwd) => writeFileSync(path.join(cwd, "feature.ts"), "export const x = 1;\n"),
      [PERSISTENT],
      (store) => observeFlakySignatures(store, "earlier-run-1", ["✖ timing test"])
    );

    expect(task.state).toBe("NEEDS_HUMAN");
  }, 30_000);
});

/**
 * Run bc691359, `deploy-container-images-pinned`: `cargo test --workspace`
 * finishes in 21 minutes with 196 suites green, and the charrette killed it at a
 * hardcoded 10 — then reported the kill as a failing test, truncated to a tail
 * of cargo's "Running tests/..." banner. Seven gates and six hours went into
 * looking for a failing test that never existed, and three separate workers
 * correctly reported the tree clean and were sent back anyway.
 */
describe("a check the charrette never let finish", () => {
  // Slow only where the worker has been: the base comparison stays green, so
  // nothing else in the pipeline could excuse this.
  const SLOW = "test -f slow.txt || exit 0; echo 'Running tests/big.rs (target/debug/deps/big-9d1)'; sleep 30";

  it("does not charge the task for a kill, and names the setting that fixes it", async () => {
    const { task, qaPrompts, events } = await run((cwd) => writeFileSync(path.join(cwd, "slow.txt"), "x\n"), [SLOW], undefined, 0.01);

    // A kill decided nothing, so it cannot be the thing that fails the task.
    expect(task.state).toBe("MERGED");
    expect(task.qaIterations).toBe(1); // the QA pass itself, not a check failure
    expect(qaPrompts).toHaveLength(1);
    const said = events.find((t) => t.includes("did not finish inside"));
    expect(said).toContain(SLOW);
    expect(said).toContain("not a test failure and not charged to this task");
    // Said to the operator, because the configuration is the only place it is
    // fixable — a worker reading this can do nothing with it.
    expect(said).toContain("deterministicCheckTimeoutMinutes");
  }, 30_000);

  it("still charges a check that finished and was red", async () => {
    const { task } = await run((cwd) => writeFileSync(path.join(cwd, "feature.ts"), "export const x = 1;\n"), [
      "test -f feature.ts || exit 0; echo '✖ this one is real' >&2; exit 1",
    ], undefined, 0.01);

    expect(task.state).toBe("NEEDS_HUMAN");
  }, 30_000);
});
