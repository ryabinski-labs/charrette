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

/**
 * Scoring cannot be trusted to find these — measured against a real corpus, the
 * top lexical match for a sanctions task was `testimonial-collector` — so the
 * operator names them and the harness obeys.
 */
describe("skill routing", () => {
  const routedDag = (title: string, spec: string) =>
    "```json\n" +
    JSON.stringify({
      epics: [{ id: "epic-e", title: "E", summary: "s" }],
      tasks: [{ id: "task-a", epicId: "epic-e", title, spec, acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], estimatedSize: "S" }],
    }) +
    "\n```";

  const ROUTED = [
    "architect",
    "security-engineer",
    "performance-engineer",
    "frontend-design",
    "ui-ux-cx-engineer",
    "product-manager",
    "marketing-director",
    "branding-manager",
    "online-sales-specialist",
    "persona-panel",
    "dns-project-iac-engineer",
    "fullstack-app",
    "visual-qa-agent",
  ];

  function routingSkillsDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "skills-routing-"));
    // Deliberately bland bodies: none of these would win on lexical overlap.
    for (const name of ROUTED) {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: guidance for ${name}\n---\nGuidance body for ${name}.`);
    }
    return dir;
  }

  /** The system prompt each of the two task-level roles was handed. */
  async function injectRoles(title: string, spec: string): Promise<{ worker: string; qa: string }> {
    let planning = 0;
    const seen = { worker: "", qa: "" };
    const pool = {
      async run(s: AgentSpec): Promise<AgentResult> {
        if (s.role === "planner") return { sessionId: "p", resultText: planning++ === 0 ? DOCS : routedDag(title, spec), costUsd: 0, turns: 1, outcome: "done" };
        if (s.role === "worker") {
          seen.worker = s.systemPrompt!;
          writeFileSync(path.join(s.cwd, "f.txt"), "done\n");
          gitIn(s.cwd, "add", "-A");
          gitIn(s.cwd, "commit", "-m", "wip");
          return { sessionId: "w", resultText: "done", costUsd: 0, turns: 1, outcome: "done" };
        }
        if (s.role === "qa") seen.qa = s.systemPrompt!;
        return { sessionId: "q", resultText: '{"verdict":"PASS","notes":"ok"}', costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool;
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool, noGithub, approveAll, repo());
    await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], skillsDirs: [routingSkillsDir()] }));
    return seen;
  }

  const inject = async (title: string, spec: string) => (await injectRoles(title, spec)).worker;

  it("gives architecture work the architecture skills by default", async () => {
    const system = await inject("Design the ledger", "Decide the data model and system design for double-entry postings");
    expect(system).toContain('<skill name="architect"');
    expect(system).toContain('<skill name="security-engineer"');
    expect(system).toContain('<skill name="performance-engineer"');
  }, 30_000);

  it("gives UI work the UI skills by default", async () => {
    const system = await inject("Operator dashboard", "Build the web dashboard page with a responsive component layout");
    expect(system).toContain('<skill name="frontend-design"');
    expect(system).toContain('<skill name="ui-ux-cx-engineer"');
  }, 30_000);

  it("injects nothing when no rule matches and nothing scores", async () => {
    const system = await inject("Rotate the log files", "Truncate stale files on disk once a week");
    for (const name of ROUTED) expect(system).not.toContain(`<skill name="${name}"`);
  }, 30_000);

  it("routes marketing, sales and research work to the people who own them", async () => {
    const marketing = await inject("Launch announcement", "Write the campaign messaging and positioning for the launch");
    expect(marketing).toContain('<skill name="marketing-director"');
    expect(marketing).toContain('<skill name="branding-manager"');

    const sales = await inject("Upsell path", "Add an upsell offer to the checkout funnel and track conversion");
    expect(sales).toContain('<skill name="online-sales-specialist"');

    // The panel is consulted on demand, not bolted onto every task.
    const research = await inject("Validate the flow", "Run a usability study with a focus group before we commit");
    expect(research).toContain('<skill name="persona-panel"');
    const unrelated = await inject("Rotate the log files", "Truncate stale files on disk once a week");
    expect(unrelated).not.toContain('<skill name="persona-panel"');
  }, 60_000);

  /**
   * DNS and stack selection are routed *before* architecture, and that ordering
   * is the whole fix rather than an aesthetic choice: both kinds of task also
   * match the architecture vocabulary, which alone fills all four of a role's
   * skill slots. Routed last, the one skill that knows the answer is the one
   * dropped at the cap.
   */
  it("routes DNS work to the DNS engineer even when the task reads as infrastructure", async () => {
    const system = await inject("Migrate DNS to dns-project", "Update the Terraform infrastructure for cert-manager DNS-01 issuers and the ACME solver");
    expect(system).toContain('<skill name="dns-project-iac-engineer"');
    // Four slots, five matching skills: the architecture rule's last one gives way.
    expect(system).not.toContain('<skill name="frontend-design"');
  }, 30_000);

  it("consults the stack skill when a task picks a stack rather than extends one", async () => {
    const greenfield = await inject("Bootstrap the companion service", "Scaffold a new service from scratch with magic-link auth and DynamoDB");
    expect(greenfield).toContain('<skill name="fullstack-app"');

    // ...and it survives a task that is also an architecture decision.
    const both = await inject("Design the companion service", "Decide the system design for a new service, including the technology stack");
    expect(both).toContain('<skill name="fullstack-app"');
    expect(both).toContain('<skill name="architect"');
  }, 60_000);

  /**
   * Building a screen and grading one are different jobs, so they get different
   * playbooks. Handing `visual-qa-agent` to the agent that drew the screen is
   * not a review, and it would also cost a slot on both sides of a cap that only
   * holds four.
   */
  it("sends the design skills to the builder and the visual reviewer to QA", async () => {
    const { worker, qa } = await injectRoles("Sign-in screen", "Build the sign-in screen with a responsive component layout");

    // Shared: both sides argue from the same design playbooks.
    for (const system of [worker, qa]) {
      expect(system).toContain('<skill name="frontend-design"');
      expect(system).toContain('<skill name="ui-ux-cx-engineer"');
    }

    // Split: the product voice builds it, the visual reviewer grades it.
    expect(worker).toContain('<skill name="product-manager"');
    expect(worker).not.toContain('<skill name="visual-qa-agent"');
    expect(qa).toContain('<skill name="visual-qa-agent"');
    expect(qa).not.toContain('<skill name="product-manager"');
  }, 30_000);

  /**
   * The UI vocabulary grew to cover design-system work, and `brand`/`logo` were
   * kept out of it on purpose: the marketing rule owns those words and sits
   * below this one, so a branding task matching both would fill its four slots
   * with frontend skills and drop `branding-manager` at the cap.
   */
  it("leaves branding work to the branding people", async () => {
    const system = await inject("Refresh the brand", "Rework the logo and brand voice across the marketing site");
    expect(system).toContain('<skill name="branding-manager"');
    expect(system).toContain('<skill name="marketing-director"');
  }, 30_000);
});

/**
 * "All product decisions" cannot be satisfied by routing task text: the decisions
 * that matter most — what is in scope, how the work is cut up — are made by
 * intake and the planner, before any task exists. Both carried no skills at all.
 */
describe("skills bound to a role rather than a topic", () => {
  function skillsFixture(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "skills-role-"));
    for (const name of ["product-manager", "branding-manager"]) {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: guidance for ${name}\n---\nGuidance body for ${name}.`);
    }
    return dir;
  }

  /** Captures the system prompt of every role the run spawns. */
  async function systemsByRole(assignment: string): Promise<Record<string, string>> {
    let planning = 0;
    const seen: Record<string, string> = {};
    const pool = {
      async run(s: AgentSpec): Promise<AgentResult> {
        seen[s.role] = s.systemPrompt ?? "";
        if (s.role === "planner") return { sessionId: "p", resultText: planning++ === 0 ? DOCS : DAG, costUsd: 0, turns: 1, outcome: "done" };
        if (s.role === "worker") {
          writeFileSync(path.join(s.cwd, "f.txt"), "done\n");
          gitIn(s.cwd, "add", "-A");
          gitIn(s.cwd, "commit", "-m", "wip");
          return { sessionId: "w", resultText: "done", costUsd: 0, turns: 1, outcome: "done" };
        }
        return { sessionId: "q", resultText: '{"verdict":"PASS","notes":"ok"}', costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool;
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool, noGithub, approveAll, repo());
    await controller.startRun(assignment, RunConfig.parse({ deterministicChecks: [], skillsDirs: [skillsFixture()] }));
    return seen;
  }

  it("puts the product voice in the planner, whatever the assignment says", async () => {
    // No product vocabulary anywhere in this assignment — that is the point.
    const seen = await systemsByRole("Add rate limiting to the API");
    expect(seen.planner).toContain('<skill name="product-manager"');
  }, 30_000);

  it("does not inject a role's standing skills into unrelated roles", async () => {
    const seen = await systemsByRole("Add rate limiting to the API");
    expect(seen.worker).not.toContain('<skill name="product-manager"');
    expect(seen.planner).not.toContain('<skill name="branding-manager"');
  }, 30_000);
});
