import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@charrette/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController } from "./runController.js";
import { Store } from "./store.js";

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const gitIn = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "ignore" });

function repoWithOrigin(): string {
  const origin = mkdtempSync(path.join(tmpdir(), "charrette-pub-origin-"));
  gitIn(origin, "init", "--bare", "-b", "release");
  const repo = mkdtempSync(path.join(tmpdir(), "charrette-pub-"));
  writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  gitIn(repo, "init", "-b", "release");
  gitIn(repo, "config", "user.email", "charrette@example.com");
  gitIn(repo, "config", "user.name", "charrette");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", "init");
  gitIn(repo, "remote", "add", "origin", origin);
  gitIn(repo, "push", "-u", "origin", "release");
  return repo;
}

const dag = (n: number) =>
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `task-${i}`, epicId: "epic-e", title: `Task ${i}`, spec: "s",
      acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S",
    })),
  }) +
  "\n```";

/** Plans `n` tasks; every task commits and passes unless `parks` names it. */
function pool(n: number, parks: string[] = []): AgentPool {
  let planned = 0;
  let files = 0;
  return {
    async run(spec: AgentSpec): Promise<AgentResult> {
      if (spec.role === "qa") return { sessionId: "sq", resultText: '{"verdict":"PASS","notes":"ok","unverified":[]}', costUsd: 0, turns: 1, outcome: "done" };
      if (spec.role === "validator") return { sessionId: "sv", resultText: '{"verdict":"PASS","gaps":[],"summary":"ok"}', costUsd: 0, turns: 1, outcome: "done" };
      if (spec.role === "worker") {
        // A task that never commits delivers an empty branch and parks.
        if (!parks.includes(spec.taskId ?? "")) {
          writeFileSync(path.join(spec.cwd, `w-${++files}.txt`), `c${files}\n`);
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", `feat ${files}`);
        }
        return { sessionId: `sw${files}`, resultText: "done", costUsd: 0, turns: 1, outcome: "done" };
      }
      return { sessionId: `s${planned}`, resultText: planned++ === 0 ? DOCS : dag(n), costUsd: 0, turns: 1, outcome: "done" };
    },
  } as unknown as AgentPool;
}

/** A GitHub whose `ensurePR` is whatever the test needs it to be. */
function github(ensurePR: () => { number: number; url: string } | null) {
  const adapter = {
    enabled: true,
    async ensureIssue() { return null; },
    async ensurePR() { return ensurePR(); },
    async markPrReady() { return true; },
    async closePR() { return true; },
  };
  return adapter as unknown as GitHubAdapter;
}

function build(repo: string, agents: AgentPool, gh: GitHubAdapter) {
  const store = new Store(":memory:");
  const controller = new RunController(store, new Bus(store), agents, gh, {
    async resolvePlanGate() { return { approved: true, feedback: "" }; },
    async resolveBudgetGate() { return null; },
  }, repo);
  return { store, controller };
}

const CONFIG = RunConfig.parse({
  deterministicChecks: [], intentFixRounds: 0, waitForChecks: false,
  skillForge: { enabled: false }, checkTimeoutMinutes: 1, deployTimeoutMinutes: 1,
});

/**
 * A run that merged work and could not publish it.
 *
 * `greenGate` keys every check on the rollup pull request's number, and a run
 * with no number used to reach its `proceed` escape hatch whatever the reason.
 * That is right for a run whose foundation tasks parked — no diff, nothing to
 * hold — and wrong for one that merged 127 tasks and had its body refused as
 * oversized, which is how ledger-app a8df0107 reported itself in review over a
 * branch nothing had ever checked with `holdUntilGreen` on.
 *
 * These are the shapes that distinction has to survive.
 */
describe("a run that merged work it could not publish", () => {
  it("adopts a pull request the operator opened by hand, and lets the gates engage on it", async () => {
    // The predicted next symptom for a8df0107: the rollup was opened by hand as
    // #128, so a resumed run's `ensurePR` finds it already open on the head
    // branch and takes it. That has to clear the publish failure and hand the
    // gates a number, rather than leaving the run parked over a PR that exists.
    const repo = repoWithOrigin();
    let opened = false;
    const gh = github(() => {
      if (!opened) throw Object.assign(new Error("Validation Failed: body is too long (maximum is 65536 characters)"), { status: 422 });
      return { number: 128, url: "u128" };
    });
    const { store, controller } = build(repo, pool(2), gh);
    const runId = await controller.startRun("build the thing", CONFIG);

    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.publishFailure(runId)).toContain("body is too long");

    opened = true;
    await controller.resume(runId);

    expect(store.publishFailure(runId)).toBeNull();
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.listTasks(runId).every((t) => t.prNumber === 128)).toBe(true);
  }, 120_000);

  it("keeps parking while the failure repeats, and never once reports itself in review", async () => {
    const repo = repoWithOrigin();
    const gh = github(() => {
      throw new Error("GitHub is down");
    });
    const { store, controller } = build(repo, pool(2), gh);
    const runId = await controller.startRun("build the thing", CONFIG);

    expect(store.getRun(runId)!.state).toBe("PAUSED");
    await controller.resume(runId);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    await controller.resume(runId);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.publishFailure(runId)).toContain("GitHub is down");

    // The point of the whole change: not once, across three attempts, did this
    // run describe itself as something a human could go and review.
    const states = store
      .eventsSince(runId, 0)
      .map((r) => r.event)
      .filter((e): e is Extract<typeof e, { type: "run.state_changed" }> => e.type === "run.state_changed")
      .map((e) => e.to);
    expect(states).not.toContain("PR_REVIEW");
  }, 120_000);

  it("loses neither the publish nor a parked task when both are outstanding", async () => {
    // `reopen` — which asks the operator about parked tasks — only examines a
    // run in PR_REVIEW, and a publish failure now parks the run instead. The
    // parked task must survive that: not cancelled, not silently revived, and
    // still reachable once the publish is repaired.
    const repo = repoWithOrigin();
    let fail = true;
    const gh = github(() => {
      if (fail) throw new Error("GitHub is down");
      return { number: 9, url: "u9" };
    });
    const { store, controller } = build(repo, pool(2, ["task-1"]), gh);
    const runId = await controller.startRun("build the thing", CONFIG);

    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.getTask(runId, "task-0")!.state).toBe("MERGED");
    expect(store.getTask(runId, "task-1")!.state).toBe("NEEDS_HUMAN");

    fail = false;
    await controller.resume(runId);

    expect(store.getTask(runId, "task-0")!.prNumber).toBe(9);
    expect(store.getTask(runId, "task-1")!.state).toBe("NEEDS_HUMAN");
    expect(store.publishFailure(runId)).toBeNull();
    // PR_REVIEW with recoverable work: the next resume is the one that asks
    // about the parked task, through `reopen`. One more resume, nothing lost.
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(controller.hasRecoverableWork(runId)).toBe(true);
  }, 120_000);
});
