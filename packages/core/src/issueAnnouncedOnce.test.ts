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
  const origin = mkdtempSync(path.join(tmpdir(), "charrette-issue-origin-"));
  gitIn(origin, "init", "--bare", "-b", "release");
  const repo = mkdtempSync(path.join(tmpdir(), "charrette-issue-"));
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

const GAP = "nothing schedules the payout worker";

/**
 * Plans `n` tasks, all of which commit and pass. The merged-tree intent check
 * fails once, which is what puts a second `fileIssues` pass on the board; the
 * plan-gate check — the same `validator` role, told apart by the plan in its
 * prompt — has to pass or the run never leaves planning.
 */
function pool(n: number): AgentPool {
  let planned = 0;
  let files = 0;
  let intent = 0;
  return {
    async run(spec: AgentSpec): Promise<AgentResult> {
      const base = { costUsd: 0, turns: 1, outcome: "done" as const };
      if (spec.role === "qa") return { ...base, sessionId: "sq", resultText: '{"verdict":"PASS","notes":"ok","unverified":[]}' };
      if (spec.role === "validator") {
        if (spec.prompt.includes("<plan>")) return { ...base, sessionId: "sp", resultText: '{"verdict":"PASS","gaps":[],"summary":"ok"}' };
        const failing = intent++ === 0;
        return {
          ...base,
          sessionId: `sv${intent}`,
          resultText: failing
            ? `{"verdict":"FAIL","gaps":[${JSON.stringify(GAP)}],"summary":"a gap"}`
            : '{"verdict":"PASS","gaps":[],"summary":"ok"}',
        };
      }
      if (spec.role === "worker") {
        writeFileSync(path.join(spec.cwd, `w-${++files}.txt`), `c${files}\n`);
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", `feat ${files}`);
        return { ...base, sessionId: `sw${files}`, resultText: "done" };
      }
      return { ...base, sessionId: `s${planned}`, resultText: planned++ === 0 ? DOCS : dag(n) };
    },
  } as unknown as AgentPool;
}

/**
 * A GitHub that files an issue once and finds it every time after, which is
 * what the real adapter does: `ensureIssue` reads the run's issues before it
 * creates one, and only the call that created it comes back `fresh`.
 */
function github() {
  const filed = new Map<string, { number: number; url: string }>();
  const asked: string[] = [];
  const adapter = {
    enabled: true,
    async ensureIssue(_runId: string, id: string) {
      asked.push(id);
      const existing = filed.get(id);
      if (existing) return existing;
      const ref = { number: filed.size + 1, url: `https://example.invalid/${filed.size + 1}` };
      filed.set(id, ref);
      return { ...ref, fresh: true };
    },
    async ensurePR() { return { number: 9, url: "u9" }; },
    async markPrReady() { return true; },
    async closePR() { return true; },
  };
  return { gh: adapter as unknown as GitHubAdapter, filed, asked };
}

const CONFIG = RunConfig.parse({
  deterministicChecks: [], intentFixRounds: 1, waitForChecks: false,
  skillForge: { enabled: false }, checkTimeoutMinutes: 1, deployTimeoutMinutes: 1,
});

/**
 * `fileIssues` walks the whole live plan, and it runs again at every boundary
 * the plan can cross: the approved plan gate, a queued intent fix, a queued
 * spec fix, a pit-stop re-plan. `ensureIssue` is idempotent, so those later
 * passes file nothing — but the event went out per task per pass regardless,
 * and the dashboard prints one "issue #N" line per event. Run a8df0107 wrote
 * 1262 `github.issue_created` events for 127 issues: ten rounds of the same
 * 127 announcements, 1135 of them for issues that had existed for hours, in
 * the one feed an operator reads to see what the run just did.
 */
describe("announcing a filed issue", () => {
  it("announces each issue once, however many passes walk the plan", async () => {
    const repo = repoWithOrigin();
    const { gh, filed, asked } = github();
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool(2), gh, {
      async resolvePlanGate() { return { approved: true, feedback: "" }; },
      async resolveBudgetGate() { return null; },
    }, repo);

    const runId = await controller.startRun("build the thing", CONFIG);

    // The premise: more than one pass walked the plan, so a per-pass
    // announcement would have doubled up. Without this the test passes for the
    // wrong reason the day something stops calling `fileIssues` twice.
    expect(asked.length).toBeGreaterThan(filed.size);

    const announced = store
      .eventsSince(runId, 0)
      .map((r) => r.event)
      .filter((e): e is Extract<typeof e, { type: "github.issue_created" }> => e.type === "github.issue_created");

    expect(announced.length).toBe(filed.size);
    expect(new Set(announced.map((e) => e.issueNumber)).size).toBe(announced.length);
    // Including the task the intent gap queued: a genuinely new issue on the
    // second pass still gets announced.
    expect(announced.map((e) => e.taskId)).toEqual(expect.arrayContaining(["task-0", "task-1"]));
    expect(announced.length).toBeGreaterThan(2);
  }, 120_000);
});
