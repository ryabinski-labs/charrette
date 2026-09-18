import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@charrette/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { IntakeUi } from "./intake.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [
      { id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" },
    ],
  }) +
  "\n```";
const BRIEF = '```json\n{"goal":"g","context":"c","decisions":[],"constraints":[],"outOfScope":[],"openQuestions":[]}\n```';

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-resume-intake-"));
  made.push(dir, `${dir}-wt`);
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "charrette@example.com");
  gitIn(dir, "config", "user.name", "charrette");
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

const OPEN = 'For "all the integrations" — do you want real vendor accounts wired up, or adapters against sandboxes?';

/**
 * Stand up a run interrupted exactly where run 40da9337 was: one question
 * answered, the decisive one asked and hanging.
 */
function interrupted(dir: string, over: Record<string, unknown> = {}) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  store.createRun({
    id: "run-1",
    repoPath: dir,
    assignment: "fully implement this product, including all the integrations",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: "charrette/run-1/main",
    config: RunConfig.parse({ deterministicChecks: [], waitForChecks: false, ...over }),
  });
  store.transitionRun("run-1", "INTAKE");
  bus.publish({ type: "intake.question", runId: "run-1", sessionId: "s1", question: "Which backlog?", options: [], ts: 1 });
  bus.publish({ type: "intake.answered", runId: "run-1", sessionId: "s1", question: "Which backlog?", answer: "use gh cli", decidedBy: "operator", ts: 2 });
  bus.publish({ type: "intake.question", runId: "run-1", sessionId: "s1", question: OPEN, options: [], ts: 3 });
  return { store, bus };
}

function pool(specs: AgentSpec[]): AgentPool {
  let planning = 0;
  return {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      const base = { sessionId: `s${specs.length}`, costUsd: 0, turns: 1, outcome: "done" as const };
      // The decider runs as `intake` too — it is part of the same conversation
      // and billed to it. Its system prompt is what tells the two apart.
      if (spec.role === "intake" && spec.systemPrompt.includes("standing in for the operator")) {
        return { ...base, resultText: JSON.stringify({ answer: "Sandbox adapters, no live money.", why: "no vendor creds in the repo" }) };
      }
      if (spec.role === "intake") return { ...base, resultText: BRIEF };
      if (spec.role === "planner") return { ...base, resultText: planning++ === 0 ? DOCS : DAG };
      if (spec.role === "worker") {
        writeFileSync(path.join(spec.cwd, `w-${specs.length}.txt`), "work\n");
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        return { ...base, resultText: "worker done" };
      }
      return { ...base, resultText: '{"verdict":"PASS","notes":"ok"}' };
    },
  } as unknown as AgentPool;
}

/**
 * Run 40da9337: $773.55, 36 merged tasks, and six of seven vendor integrations
 * shipped as `throw liveProviderNotConfigured(...)` — because the intake agent
 * asked whether the operator wanted real vendor accounts, the process died
 * before they answered, and resume planned straight past the question. This is
 * the line that used to read `transitionRun(runId, "PLANNING", "resumed
 * mid-intake")` and nothing else.
 */
describe("resuming a run that stopped mid-conversation", () => {
  it("asks the question again instead of planning without the answer", async () => {
    const dir = repo();
    const { store } = interrupted(dir);
    const specs: AgentSpec[] = [];
    const asked: string[] = [];
    const ui: IntakeUi = {
      async ask(q) {
        asked.push(q.question);
        return "sandbox adapters, real clients, no live money";
      },
      say() {},
    };

    await new RunController(store, new Bus(store), pool(specs), new GitHubAdapter(undefined, undefined), gates, dir).resume("run-1", ui);

    const intake = specs.find((s) => s.role === "intake");
    expect(intake).toBeDefined();
    // The open question is put back in front of the agent, verbatim…
    expect(intake!.prompt).toContain(OPEN);
    expect(intake!.prompt).toContain("Put it to the operator first");
    // …and the one already answered is handed back as settled, so the operator
    // is not made to answer the same thing twice.
    expect(intake!.prompt).toContain("→ use gh cli");
    expect(intake!.prompt).toContain("never ask them again");
  }, 30_000);

  it("says out loud what went unanswered when there is nobody to ask", async () => {
    // Headless resume — a daemon, a cron, a test. It still plans from the
    // assignment as it always did, but the dropped question is now on the record
    // instead of vanishing into a reason line that said only that time passed.
    const dir = repo();
    const { store, bus } = interrupted(dir);
    const logs: string[] = [];
    bus.subscribe(({ event }) => void (event.type === "agent.log" && logs.push(event.text)));
    const specs: AgentSpec[] = [];

    await new RunController(store, bus, pool(specs), new GitHubAdapter(undefined, undefined), gates, dir).resume("run-1");

    expect(specs.some((s) => s.role === "intake")).toBe(false);
    expect(logs.some((t) => t.includes(OPEN) && /went unanswered/.test(t))).toBe(true);
    const reason = store.db
      .prepare("SELECT payload FROM events WHERE runId='run-1' AND type='run.state_changed' AND payload LIKE '%PLANNING%' ORDER BY seq LIMIT 1")
      .get() as { payload: string };
    expect(JSON.parse(reason.payload).reason).toBe("resumed mid-intake, 1 question(s) unanswered");
  }, 30_000);

  it("does not claim an unanswered question when the conversation was complete", async () => {
    const dir = repo();
    const store = new Store(":memory:");
    const bus = new Bus(store);
    store.createRun({
      id: "run-1",
      repoPath: dir,
      assignment: "build it",
      state: "CREATED",
      prdPath: null,
      planHash: null,
      integrationBranch: "charrette/run-1/main",
      config: RunConfig.parse({ deterministicChecks: [], waitForChecks: false }),
    });
    store.transitionRun("run-1", "INTAKE");
    bus.publish({ type: "intake.question", runId: "run-1", sessionId: "s1", question: "Which backlog?", options: [], ts: 1 });
    bus.publish({ type: "intake.answered", runId: "run-1", sessionId: "s1", question: "Which backlog?", answer: "gh", decidedBy: "operator", ts: 2 });

    await new RunController(store, bus, pool([]), new GitHubAdapter(undefined, undefined), gates, dir).resume("run-1");

    const reason = store.db
      .prepare("SELECT payload FROM events WHERE runId='run-1' AND type='run.state_changed' AND payload LIKE '%PLANNING%' ORDER BY seq LIMIT 1")
      .get() as { payload: string };
    expect(JSON.parse(reason.payload).reason).toBe("resumed mid-intake");
  }, 30_000);
});

/**
 * The same interrupted run, resumed by a cron rather than a person.
 *
 * This is the case run 40da9337 lost $773 to, and until now the only honest
 * thing to do about it was write down that the question went unanswered. A
 * named decider answers it instead — with the repository in front of it, and
 * with the standing right to hand back anything it should not settle alone.
 */
describe("resuming unattended, with a decider named", () => {
  it("holds the conversation instead of writing off the question nobody could answer", async () => {
    const dir = repo();
    const { store, bus } = interrupted(dir, { intake: { decidedBy: "product-manager" } });
    const specs: AgentSpec[] = [];
    const logs: string[] = [];
    bus.subscribe(({ event }) => {
      if (event.type === "agent.log") logs.push(event.text);
    });

    // No `ui` argument at all: nobody is at the terminal. Before this, that
    // meant the run planned from the assignment and recorded that the decisive
    // question had gone unanswered — which is exactly what cost run 40da9337
    // $773 and six of seven integrations.
    await new RunController(store, new Bus(store), pool(specs), new GitHubAdapter(undefined, undefined), gates, dir).resume("run-1");

    // The conversation happened: an intake session ran, and it was given the
    // question the dead process was holding.
    const intake = specs.find((s) => s.role === "intake");
    expect(intake).toBeDefined();
    expect(intake!.prompt).toContain(OPEN);
    // And the "there is nobody to ask" path was not taken.
    expect(logs.join("\n")).not.toContain("Resumed with no way to ask");
  }, 30_000);

  it("still writes the question off when no decider is named and nobody is there", async () => {
    // The other half of the same branch, unchanged: `decidedBy` defaults to the
    // operator, so a headless resume behaves exactly as it always has.
    const dir = repo();
    const { store, bus } = interrupted(dir);
    const logs: string[] = [];
    bus.subscribe(({ event }) => {
      if (event.type === "agent.log") logs.push(event.text);
    });

    await new RunController(store, new Bus(store), pool([]), new GitHubAdapter(undefined, undefined), gates, dir).resume("run-1");

    expect(logs.join("\n")).toContain("Resumed with no way to ask");
  }, 30_000);
});
