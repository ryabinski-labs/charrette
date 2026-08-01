import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
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
    tasks: [
      {
        id: "task-a",
        epicId: "epic-e",
        title: "Stripe checkout",
        spec: "Add Stripe checkout payment flow with webhooks",
        acceptanceCriteria: ["checkout works"],
        dependsOn: [],
        touchedPaths: [],
        estimatedSize: "S",
      },
    ],
  }) +
  "\n```";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-skills-"));
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "harness@example.com");
  gitIn(dir, "config", "user.name", "harness");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-m", "init");
  return dir;
}

function skillsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "skills-fixture-"));
  const write = (name: string, description: string, body: string) => {
    mkdirSync(path.join(dir, name));
    writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  };
  write("stripe-setup", "Configure Stripe checkout, billing, and webhooks", "How to set up Stripe payments, checkout sessions, webhooks.");
  write("qa-playbook", "End-to-end testing, verification, and regression evidence", "Run end-to-end tests, write regression tests, capture verification evidence.");
  write("branding-manager", "Brand voice, logo usage, and marketing tone", "Keep brand voice and logo usage consistent across marketing surfaces.");
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

/** A pool that records each role's spec and plays the happy path. */
function recordingPool() {
  let planning = 0;
  const byRole: Record<string, AgentSpec[]> = { worker: [], qa: [] };
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      let resultText = "";
      if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
      else if (spec.role === "worker") {
        byRole.worker!.push(spec);
        writeFileSync(path.join(spec.cwd, "feature.txt"), "done\n");
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        resultText = "worker done";
      } else if (spec.role === "qa") {
        byRole.qa!.push(spec);
        resultText = '{"verdict":"PASS","notes":"fine"}';
      } else resultText = '{"verdict":"PASS","summary":"n/a"}';
      return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, byRole };
}

describe("role-aware skill injection", () => {
  it("workers match on the task, QA gets verification playbooks on top, both are recorded", async () => {
    const { pool, byRole } = recordingPool();
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const controller = new RunController(store, bus, pool, noGithub, approveAll, repo());
    const runId = await controller.startRun(
      "do a thing",
      RunConfig.parse({ deterministicChecks: [], qaIterationCap: 3, skillsDirs: [skillsDir()] })
    );

    // The worker sees what its task is about — and nothing brand-related.
    const workerSystem = byRole.worker![0]!.systemPrompt!;
    expect(workerSystem).toContain('<skill name="stripe-setup"');
    expect(workerSystem).not.toContain("branding-manager");

    // The QA session carries a testing playbook even though the task spec
    // never mentions testing — the harness is opinionated about review.
    const qaSystem = byRole.qa![0]!.systemPrompt!;
    expect(qaSystem).toContain('<skill name="qa-playbook"');
    expect(qaSystem).not.toContain("branding-manager");

    // Provenance: assignedSkills carries the role each skill was injected for.
    const assigned = store.getTask(runId, "task-a")!.assignedSkills;
    expect(assigned.find((s) => s.name === "stripe-setup" && s.role === "worker")).toBeTruthy();
    expect(assigned.find((s) => s.name === "qa-playbook" && s.role === "qa")).toBeTruthy();

    // And the bus told the dashboard which role each injection was for.
    const injections = store
      .eventsSince(runId, 0)
      .map((e) => e.event)
      .filter((e) => e.type === "skills.injected") as { role?: string; skills: { name: string }[] }[];
    expect(injections.map((e) => e.role).sort()).toEqual(["qa", "worker"]);
  });
});
