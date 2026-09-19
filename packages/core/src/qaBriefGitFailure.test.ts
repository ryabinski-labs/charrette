import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@charrette/shared";
import { describe, expect, it, vi } from "vitest";

/**
 * One git invocation fails: the diffstat QA is briefed with.
 *
 * It is the only call in the QA hand-off that reads the repository, and it is
 * read across a two-dot-three range spanning the integration branch — the one
 * ref a catch-up merge, a force-push or a pruned worktree can move out from
 * under a task while its worker is still running. Everything else on this path
 * is already committed and already in the tree.
 *
 * Mocked at the module rather than driven through a broken repository because
 * a repository broken enough to fail this is broken enough to fail the commit,
 * the merge and the checkout too, and then the test proves nothing about which
 * failure the gate survived. `WorktreeManager` keeps its own reference to the
 * real `git`, so the worktrees this run builds are real.
 */
vi.mock("./git.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./git.js")>();
  return {
    ...real,
    git: async (cwd: string, args: string[], opts?: Parameters<typeof real.git>[2]) => {
      if (args[0] === "diff" && args[1] === "--stat") throw new Error("fatal: bad revision 'charrette/x/main...HEAD'");
      return real.git(cwd, args, opts);
    },
  };
});

import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [{ id: "task-a", epicId: "epic-e", title: "Webhook delivery", spec: "Deliver signed webhooks", acceptanceCriteria: ["it delivers"], dependsOn: [], touchedPaths: [], estimatedSize: "S" }],
  }) +
  "\n```";

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-qabrief-"));
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "charrette@example.com");
  run("config", "user.name", "charrette");
  run("add", "-A");
  run("commit", "-m", "init");
  return dir;
}

describe("briefing QA when the diffstat cannot be read", () => {
  it("still hands the task over, and says the diffstat is unavailable", async () => {
    const qaPrompts: string[] = [];
    let planning = 0;
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        let resultText = "";
        if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
        else if (spec.role === "worker") {
          writeFileSync(path.join(spec.cwd, "feature.ts"), "export const x = 1;\n");
          execFileSync("git", ["add", "-A"], { cwd: spec.cwd, stdio: "ignore" });
          execFileSync("git", ["commit", "-m", "wip"], { cwd: spec.cwd, stdio: "ignore" });
          resultText = "worker done";
        } else if (spec.role === "qa") {
          qaPrompts.push(spec.prompt as string);
          resultText = '{"verdict":"PASS","notes":"fine"}';
        } else resultText = '{"verdict":"PASS","summary":"n/a"}';
        return { sessionId: "s1", resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool;

    const store = new Store(":memory:");
    const gates: GateHandler = {
      async resolvePlanGate() { return { approved: true, feedback: "" }; },
      async resolveBudgetGate() { return null; },
    };
    const controller = new RunController(store, new Bus(store), pool, { enabled: false } as unknown as GitHubAdapter, gates, repo());

    const runId = await controller.startRun("build it", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 1 }));

    // The reviewer is told, rather than shown an empty diffstat it would read
    // as "this task changed nothing" — which is a FAIL against every criterion
    // the task actually met.
    expect(qaPrompts).toHaveLength(1);
    expect(qaPrompts[0]).toContain("Diffstat vs integration branch:\nunavailable");
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  }, 30_000);
});
