import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";
import { BudgetExceeded } from "./budget.js";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * The skill forge, end to end: a task nothing matches gets a skillsmith
 * session, and what that session answers decides what the worker carries.
 *
 * Every task here is deliberately bland — title "TASK-A", spec "s" — because
 * the trigger under test is the matcher coming up empty, and a spec with real
 * vocabulary would be one unlucky lexical overlap away from testing nothing.
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-forge-"));
  made.push(dir, `${dir}-wt`);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  return dir;
}

function skillsDirWith(name: string, description: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "forge-skills-"));
  made.push(dir);
  mkdirSync(path.join(dir, name));
  writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.`);
  return dir;
}

const DOCS = "<prd>\n# PRD — Build the thing\n</prd>\n<conventions>\nuse vitest\n</conventions>";
const QA_PASS = '```json\n{"verdict":"PASS","notes":"ok"}\n```';

const dagJson = (tasks: { id: string; dependsOn?: string[] }[] = [{ id: "task-a" }]) =>
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: tasks.map((t) => ({
      id: t.id, epicId: "epic-e", title: t.id.toUpperCase(), spec: "s", acceptanceCriteria: ["x"],
      dependsOn: t.dependsOn ?? [], touchedPaths: [], completionProbe: "", estimatedSize: "S" as const,
    })),
  }) +
  "\n```";

type Answer = string | ((spec: AgentSpec, nth: number) => string | Error);

function fakePool(answers: Partial<Record<string, Answer>>) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      counts[spec.role] = (counts[spec.role] ?? 0) + 1;
      const base: AgentResult = { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: "", costUsd: 0, turns: 1, outcome: "done" };
      const answer = answers[spec.role];
      if (typeof answer === "function") {
        const out = answer(spec, counts[spec.role]!);
        if (out instanceof Error) throw out;
        return { ...base, resultText: out };
      }
      return { ...base, resultText: answer ?? "" };
    },
  };
  return { pool: pool as unknown as AgentPool, specs, counts };
}

const worker = (spec: AgentSpec) => {
  writeFileSync(path.join(spec.cwd, `w-${path.basename(spec.cwd)}.txt`), "done\n");
  execFileSync("git", ["add", "-A"], { cwd: spec.cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=w@x.invalid", "-c", "user.name=W", "commit", "-m", "work"], { cwd: spec.cwd, stdio: "ignore" });
  return "did the work";
};

function build(repoPath: string, pool: AgentPool) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: HarnessEvent[] = [];
  bus.subscribe(({ event }) => void events.push(event));
  const gates: GateHandler = {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
  };
  const controller = new RunController(store, bus, pool, new GitHubAdapter(undefined, undefined), gates, repoPath);
  return { controller, store, events };
}

const logs = (events: HarnessEvent[]) =>
  events.filter((e): e is HarnessEvent & { text: string } => e.type === "agent.log").map((e) => e.text);
const forgedEvents = (events: HarnessEvent[]) =>
  events.filter((e): e is HarnessEvent & { name: string; action: string; path: string } => e.type === "skills.forged");

const CREATE =
  '```json\n{"action":"create","name":"Log Rotation","description":"rotating and truncating stale log files","body":"Rotate carefully, with dates."}\n```';

describe("forging a skill for a task nothing matches", () => {
  it("drafts, installs, injects, and leaves the skill behind for the next run", async () => {
    const dir = repo();
    const { pool, specs } = fakePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      skillsmith: CREATE,
      worker,
      qa: QA_PASS,
    });
    const { controller, store, events } = build(dir, pool);
    const runId = await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [] }));

    // The smith ran read-only in the main repo, on its own model, before the worker.
    const smith = specs.find((s) => s.role === "skillsmith")!;
    expect(smith.cwd).toBe(dir);
    expect(smith.model).toBe("claude-sonnet-5");
    expect(smith.disallowedTools).toContain("Write");
    expect(specs.findIndex((s) => s.role === "skillsmith")).toBeLessThan(specs.findIndex((s) => s.role === "worker"));

    // The worker carried the forged skill full-text, under its slug.
    const workerSpec = specs.find((s) => s.role === "worker")!;
    expect(workerSpec.systemPrompt).toContain('<skill name="log-rotation">');
    expect(workerSpec.systemPrompt).toContain("Rotate carefully, with dates.");

    // Provenance: the event, the task record, and the file all say who made it.
    expect(forgedEvents(events)).toMatchObject([{ name: "log-rotation", action: "created", taskId: "task-a" }]);
    const assigned = store.getTask(runId, "task-a")!.assignedSkills;
    expect(assigned.find((s) => s.name === "log-rotation" && s.role === "worker")!.mode).toBe("full");
    const file = readFileSync(path.join(dir, ".harness", "skills", "log-rotation", "SKILL.md"), "utf8");
    expect(file).toContain(`forged-by: harness run ${runId}, task task-a`);
  });

  it("does not forge when the collection already covers the task", async () => {
    const dir = repo();
    const skills = skillsDirWith("stripe-setup", "Configure Stripe checkout, billing, and webhooks");
    const { pool, counts } = fakePool({
      planner: (s) =>
        s.prompt.includes("PRD")
          ? "```json\n" +
            JSON.stringify({
              epics: [{ id: "epic-e", title: "E", summary: "s" }],
              tasks: [{ id: "task-a", epicId: "epic-e", title: "Stripe checkout", spec: "Add Stripe checkout payment flow with webhooks", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" }],
            }) +
            "\n```"
          : DOCS,
      worker,
      qa: QA_PASS,
    });
    const { controller } = build(dir, pool);
    await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], skillsDirs: [skills] }));
    expect(counts.skillsmith).toBeUndefined();
  });

  it("stays off when the operator switched it off", async () => {
    const dir = repo();
    const { pool, counts } = fakePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker,
      qa: QA_PASS,
    });
    const { controller } = build(dir, pool);
    await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], skillForge: { enabled: false } }));
    expect(counts.skillsmith).toBeUndefined();
  });

  it("honours the per-run cap, counted from events so it survives resume", async () => {
    const dir = repo();
    const { pool, counts } = fakePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson([{ id: "task-a" }, { id: "task-b", dependsOn: ["task-a"] }]) : DOCS),
      skillsmith: CREATE,
      worker,
      qa: QA_PASS,
    });
    const { controller, events } = build(dir, pool);
    await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], skillForge: { maxPerRun: 1 } }));
    // task-b came up empty too — its own text shares nothing with the forged
    // skill — but the run had spent its one forge on task-a.
    expect(counts.skillsmith).toBe(1);
    expect(forgedEvents(events)).toHaveLength(1);
  });

  it("takes a decline as a real answer, with or without a stated reason", async () => {
    const dir = repo();
    const { pool, counts } = fakePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson([{ id: "task-a" }, { id: "task-b" }]) : DOCS),
      skillsmith: (_s, nth) => (nth === 1 ? '```json\n{"action":"none","why":"self-evident from the spec"}\n```' : '```json\n{"action":"none"}\n```'),
      worker,
      qa: QA_PASS,
    });
    const { controller, events, store } = build(dir, pool);
    const runId = await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [] }));
    expect(counts.skillsmith).toBe(2);
    expect(forgedEvents(events)).toHaveLength(0);
    expect(logs(events).some((t) => t.includes("declined to forge a skill: self-evident from the spec"))).toBe(true);
    expect(logs(events).some((t) => t.endsWith("declined to forge a skill"))).toBe(true);
    for (const id of ["task-a", "task-b"]) expect(store.getTask(runId, id)!.assignedSkills).toEqual([]);
  });

  it("rejects a draft that would shadow the operator's own skill", async () => {
    const dir = repo();
    // In the collection but lexically nowhere near the task, so the forge fires.
    const skills = skillsDirWith("deploy-notes", "notes about deployments");
    const { pool } = fakePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      skillsmith: '```json\n{"action":"create","name":"Deploy Notes","description":"x","body":"y"}\n```',
      worker,
      qa: QA_PASS,
    });
    const { controller, events } = build(dir, pool);
    await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], skillsDirs: [skills] }));
    expect(forgedEvents(events)).toHaveLength(0);
    expect(logs(events).some((t) => t.includes('rejected the drafted skill') && t.includes("deploy-notes"))).toBe(true);
  });

  it("extends a skill it forged in an earlier run instead of fragmenting the topic", async () => {
    const dir = repo();
    const forgePath = path.join(dir, ".harness", "skills", "release-notes", "SKILL.md");
    mkdirSync(path.dirname(forgePath), { recursive: true });
    writeFileSync(forgePath, "---\nname: release-notes\ndescription: writing releases\nforged-by: harness run r0, task t0\n---\nOld wisdom.");
    const { pool, specs } = fakePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      skillsmith: (s) => {
        // The smith is briefed on its own prior work before it answers.
        expect(s.prompt).toContain("release-notes: writing releases");
        return '```json\n{"action":"extend","name":"release-notes","addendum":"New wisdom."}\n```';
      },
      worker,
      qa: QA_PASS,
    });
    const { controller, events } = build(dir, pool);
    const runId = await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [] }));

    expect(forgedEvents(events)).toMatchObject([{ name: "release-notes", action: "extended" }]);
    const file = readFileSync(forgePath, "utf8");
    expect(file).toContain(`## Learned in run ${runId} (task task-a)`);
    expect(file).toContain("New wisdom.");
    const workerSpec = specs.find((s) => s.role === "worker")!;
    expect(workerSpec.systemPrompt).toContain('<skill name="release-notes">');
    expect(workerSpec.systemPrompt).toContain("New wisdom.");
  });

  it("logs and moves on when the smith names a skill the forge does not hold", async () => {
    const dir = repo();
    const { pool, counts } = fakePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      skillsmith: '```json\n{"action":"extend","name":"ghost","addendum":"x"}\n```',
      worker,
      qa: QA_PASS,
    });
    const { controller, events } = build(dir, pool);
    await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [] }));
    expect(counts.worker).toBe(1);
    expect(forgedEvents(events)).toHaveLength(0);
    expect(logs(events).some((t) => t.includes("rejected the extension") && t.includes("ghost"))).toBe(true);
  });

  it("a forge crash costs the task its playbook, never the task", async () => {
    const dir = repo();
    const { pool, counts } = fakePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      skillsmith: () => new Error("smith exploded"),
      worker,
      qa: QA_PASS,
    });
    const { controller, store, events } = build(dir, pool);
    const runId = await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [] }));
    expect(counts.worker).toBe(1);
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(logs(events).some((t) => t.includes("skill forge did not complete") && t.includes("smith exploded"))).toBe(true);
  });

  it("lets a budget stop through — that one is about the run, not the forge", async () => {
    const dir = repo();
    const { pool } = fakePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      skillsmith: () => new BudgetExceeded(50, 30, "r1"),
      worker,
      qa: QA_PASS,
    });
    const { controller } = build(dir, pool);
    await expect(controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [] }))).rejects.toThrow(
      /run budget exceeded/
    );
  });
});
