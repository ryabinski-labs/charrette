import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { BudgetExceeded } from "./budget.js";
import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * A QA session that finished cleanly and wrote something other than its verdict
 * JSON. The verification happened; only the formatting is missing, and the whole
 * investigation is still in that session's context. Booking a FAIL instead sends
 * the worker back to fix nothing and spends one of three iterations doing it.
 */
const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [{ id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" }],
  }) +
  "\n```";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-reask-"));
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "harness@example.com");
  gitIn(dir, "config", "user.name", "harness");
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

/** Records every spec so the test can assert what was and was not re-dispatched. */
function poolThatForgetsTheJson(opts: { retryAnswers: string | Error }) {
  let planning = 0;
  const specs: AgentSpec[] = [];
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      if (spec.role === "planner") {
        return { sessionId: `s${specs.length}`, resultText: planning++ === 0 ? DOCS : DAG, costUsd: 0, turns: 1, outcome: "done" };
      }
      if (spec.role === "worker") {
        writeFileSync(path.join(spec.cwd, "feature.txt"), "done\n");
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        return { sessionId: `s${specs.length}`, resultText: "worker done", costUsd: 0, turns: 1, outcome: "done" };
      }
      // The verification, which wanders off-contract, and the re-ask that
      // transcribes what it decided. Separate roles since the re-ask moved to
      // the cheap tier: it resumes QA's session but it is not doing QA's job.
      if (spec.role === "qa") {
        return {
          sessionId: `s${specs.length}`,
          sdkSessionId: "sdk-qa-1",
          resultText: "I verified the acceptance criteria and everything checks out. Looks good to me!",
          costUsd: 0,
          turns: 1,
          outcome: "done",
        };
      }
      if (spec.role === "repair") {
        if (opts.retryAnswers instanceof Error) throw opts.retryAnswers;
        return { sessionId: `s${specs.length}`, sdkSessionId: "sdk-qa-1", resultText: opts.retryAnswers, costUsd: 0, turns: 1, outcome: "done" };
      }
      return { sessionId: `s${specs.length}`, resultText: '{"verdict":"PASS","summary":"n/a"}', costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, specs };
}

describe("QA that finished without writing its verdict", () => {
  it("is asked for the JSON alone, in the session that already did the work", async () => {
    const { pool, specs } = poolThatForgetsTheJson({ retryAnswers: '```json\n{"verdict":"PASS","notes":"criteria met"}\n```' });
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool, noGithub, approveAll, repo());
    const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 3 }));

    const retry = specs.find((s) => s.role === "repair");
    expect(retry?.resume).toBe("sdk-qa-1");
    // Cheap and pointed: no re-investigation, just the missing shape.
    expect(retry?.maxTurns).toBe(2);
    expect(retry?.prompt).toContain("do not change your judgment");
    // On the cheap tier, and — the part that matters — NOT on the QA model. The
    // judging already happened in the session this resumes; what is left is
    // transcription, and it must not be billed or reasoned about as a verdict.
    expect(retry?.model).toBe("claude-haiku-4-5-20251001");
    expect(retry?.model).not.toBe(specs.find((s) => s.role === "qa")?.model);

    const task = store.getTask(runId, "task-a")!;
    expect(task.state).toBe("MERGED");
    // One QA iteration, one worker dispatch: the re-ask is not a second opinion
    // and the worker was never sent back to fix nothing.
    expect(task.qaIterations).toBe(1);
    expect(specs.filter((s) => s.role === "worker")).toHaveLength(1);
  });

  it("keeps the FAIL when the retry will not answer either", async () => {
    const { pool, specs } = poolThatForgetsTheJson({ retryAnswers: "still not JSON, sorry" });
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool, noGithub, approveAll, repo());
    const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 1 }));

    expect(specs.some((s) => s.role === "repair" && s.resume === "sdk-qa-1")).toBe(true);
    // A QA agent that ignores its output contract twice is a real finding about
    // the run, and the task must not merge on the strength of prose.
    expect(store.getTask(runId, "task-a")!.state).not.toBe("MERGED");
  });

  it("lets a run that hit its cap stop, instead of swallowing it as another bad answer", async () => {
    // Every other way the re-ask can fail is caught and turned into "keep the
    // FAIL". The budget is the exception: a run over its cap does not get to
    // spend two more turns being polite about it, and a `null` here would hide
    // the stop behind a verdict and let the task loop carry on.
    const { pool, specs } = poolThatForgetsTheJson({ retryAnswers: new BudgetExceeded(31, 30) });
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool, noGithub, approveAll, repo());

    await expect(controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 3 }))).rejects.toThrow(
      "run budget exceeded"
    );
    // It got as far as the re-ask, and the stop came back out rather than
    // being turned into "the retry would not answer either".
    expect(specs.some((s) => s.role === "repair")).toBe(true);
  });
});
