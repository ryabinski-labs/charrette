import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { Store } from "./store.js";
import { RunController, type GateHandler } from "./runController.js";

/**
 * What happens when the light tier turns out to be wrong about a task.
 *
 * The rule in modelTier.ts is deliberately one-way: it refuses on ambiguity, so
 * the tasks it admits are the ones it is most confident about — and this is the
 * path that runs when that confidence was misplaced anyway. It is the only
 * reason the experiment is safe to switch on by default, so it is worth a test
 * that drives it end to end rather than one that asserts the closure in
 * isolation.
 *
 * The arithmetic it protects: Haiku is a third of Sonnet's price, so a cheap
 * session that needs three attempts has already cost more than the expensive
 * one that needed a single. Re-dispatching a task on the model that just died
 * replays the same wall and bills for it twice.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SONNET = "claude-sonnet-5";
const HAIKU = "claude-haiku-4-5-20251001";
const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";

/**
 * One task the light-tier rule admits: sized S, two paths, a probe that exits
 * zero, and nothing in it the risky-domain list matches.
 */
const PLAN =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [
      {
        id: "task-a",
        epicId: "epic-e",
        title: "Rename the badge copy",
        spec: "The badge says Running. Change it to In progress.",
        acceptanceCriteria: ["The badge reads In progress"],
        dependsOn: [],
        touchedPaths: ["src/Badge.tsx", "src/Badge.test.tsx"],
        completionProbe: "true",
        estimatedSize: "S" as const,
      },
    ],
  }) +
  "\n```";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-escalate-"));
  made.push(dir, `${dir}-wt`);
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "harness@example.com");
  gitIn(dir, "config", "user.name", "harness");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-m", "init");
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
 * How each worker session ends. `"ceiling"` is the turn-ceiling error, which
 * falls through to QA with whatever it committed; `"crash"` is the session
 * dying, which is caught and re-dispatched immediately.
 */
type Ending = "ceiling" | "crash" | "done";

/**
 * Runs the one-task plan.
 *
 * `worker(nth)` says how the nth worker session ends and `qaFails` how many QA
 * verdicts reject before one passes — a rejection is what dispatches the task's
 * next worker, so it is the only way to see which model the second attempt got.
 */
async function run(worker: (nth: number) => Ending, qaFails = 0, models: Record<string, string> = {}) {
  let planning = 0;
  let workers = 0;
  let qas = 0;
  const specs: AgentSpec[] = [];
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      const base = { sessionId: `s${specs.length}`, costUsd: 0, turns: 1 };
      if (spec.role === "planner") return { ...base, resultText: planning++ === 0 ? DOCS : PLAN, outcome: "done" as const };
      if (spec.role === "worker") {
        // Committed before the ending is decided: a worker that ran out of turns
        // has usually written something on the way there, and a branch carrying
        // nothing takes a different path than the one under test.
        writeFileSync(path.join(spec.cwd, `w-${specs.length}.txt`), "work\n");
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        const ending = worker(++workers);
        if (ending === "crash") throw new Error("transport closed");
        if (ending === "ceiling") {
          return { ...base, resultText: "", outcome: "error" as const, errorDetail: "error_max_turns (hit the turn ceiling of 120)" };
        }
        return { ...base, resultText: "worker done", outcome: "done" as const };
      }
      if (spec.role === "qa" && qas++ < qaFails) {
        return { ...base, resultText: '{"verdict":"FAIL","reasons":["not done yet"]}', outcome: "done" as const };
      }
      return { ...base, resultText: '{"verdict":"PASS","notes":"ok"}', outcome: "done" as const };
    },
  } as unknown as AgentPool;

  const store = new Store(":memory:");
  const controller = new RunController(store, new Bus(store), pool, new GitHubAdapter(undefined, undefined), gates, repo());
  const runId = await controller.startRun(
    "do a thing",
    RunConfig.parse({ deterministicChecks: [], waitForChecks: false, maxParallelWorkers: 1, models })
  );
  return { store, runId, specs, workerSpecs: () => specs.filter((s) => s.role === "worker") };
}

const events = (store: Store, runId: string) => store.eventsSince(runId, 0, 5000).map((r) => r.event);

const logs = (store: Store, runId: string) =>
  events(store, runId)
    .filter((e) => e.type === "agent.log")
    .map((e) => (e as { text?: string }).text ?? "");

describe("the rule's decision, recorded whether or not it moves anything", () => {
  it("sends a small, scoped, probe-checked task to the light model", async () => {
    const { store, runId, specs, workerSpecs } = await run(() => "done");

    expect(workerSpecs()[0]).toMatchObject({ taskId: "task-a", model: HAIKU, tier: "light" });
    // QA judges on its own model regardless — the saving is the worker's, and
    // buying it by weakening the judge is the thing the routing guard refuses.
    expect(specs.filter((s) => s.role === "qa").every((s) => s.model === SONNET)).toBe(true);

    const [decided, ...rest] = events(store, runId).filter((e) => e.type === "task.tier_decided");
    expect(rest).toEqual([]);
    expect(decided).toMatchObject({ taskId: "task-a", tier: "light", model: HAIKU });
    expect((decided as { why: string }).why).toContain("probe-checked");
  });

  it("still records the decision when the operator has switched the experiment off", async () => {
    // `workerLight` pointed back at `worker` is how that is done. The rule runs,
    // the ledger keeps the record of what the light tier would have taken, and
    // nothing changes model — so nothing may claim it escalated either.
    const { store, runId, workerSpecs } = await run((nth) => (nth === 1 ? "ceiling" : "done"), 1, { workerLight: SONNET });

    expect(workerSpecs().map((s) => s.model)).toEqual([SONNET, SONNET]);
    expect(logs(store, runId).some((t) => t.includes("worker escalated"))).toBe(false);
    expect(events(store, runId).filter((e) => e.type === "task.tier_decided")[0]).toMatchObject({ tier: "light", model: SONNET });
  });
});

describe("a light-tier task that ran out of turns", () => {
  /** Ceiling on the first session, QA rejects once, so a second worker runs. */
  const ranOut = () => run((nth) => (nth === 1 ? "ceiling" : "done"), 1);

  it("finishes on the standard model instead of replaying the wall it just hit", async () => {
    const { workerSpecs } = await ranOut();

    const w = workerSpecs();
    expect(w).toHaveLength(2);
    // Same task, two models: the rule sent it cheap, the ceiling sent it back.
    expect(w[0]).toMatchObject({ taskId: "task-a", model: HAIKU, tier: "light" });
    expect(w[1]).toMatchObject({ taskId: "task-a", model: SONNET });
  });

  it("says in the log which model it left and why", async () => {
    const { store, runId } = await ranOut();

    expect(logs(store, runId).some((t) => t.includes(`worker escalated from ${HAIKU} to ${SONNET}: it exhausted its turn ceiling`))).toBe(true);
  });

  it("escalates once and then stops, rather than climbing on every failure", async () => {
    // Two ceiling deaths. The second is already on the standard model, so there
    // is nowhere further up to go — and a second log line would read as a second
    // decision having been made.
    const { store, runId, workerSpecs } = await run((nth) => (nth <= 2 ? "ceiling" : "done"), 2);

    expect(workerSpecs().map((s) => s.model)).toEqual([HAIKU, SONNET, SONNET]);
    expect(logs(store, runId).filter((t) => t.includes("worker escalated"))).toHaveLength(1);
  });

  it("does not re-decide the tier, so the escalated session still bills to the experiment", async () => {
    // Both worker sessions are light-tier spend. Publishing a second decision
    // saying `standard` would move the cost of being wrong off the tier that
    // was wrong, and that difference is the number the experiment turns on.
    // (What the ledger then does with it: `taskSpend` in ledgerAttribution.)
    const { store, runId, workerSpecs } = await ranOut();

    expect(events(store, runId).filter((e) => e.type === "task.tier_decided")).toHaveLength(1);
    expect(workerSpecs().every((s) => s.tier === "light")).toBe(true);
  });
});

describe("a light-tier session that died rather than finished", () => {
  it("escalates too, because the error string is not worth trusting to tell them apart", async () => {
    // A dropped transport is not evidence about the model. It escalates anyway:
    // the alternative is classifying crashes by their message, and a respawn
    // that guesses wrong pays for the crash twice on a model that was chosen
    // for being cheap.
    const { store, runId, workerSpecs } = await run((nth) => (nth === 1 ? "crash" : "done"));

    expect(workerSpecs().map((s) => s.model)).toEqual([HAIKU, SONNET]);
    expect(logs(store, runId).some((t) => t.includes("the session died on the light tier: Error: transport closed"))).toBe(true);
  });
});
