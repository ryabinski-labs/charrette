import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig, type CharretteEvent, type IntakeQuestion } from "@charrette/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { IntakeUi } from "./intake.js";
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
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-skills-"));
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "charrette@example.com");
  gitIn(dir, "config", "user.name", "charrette");
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
    // never mentions testing — the charrette is opinionated about review.
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
 * operator names them and the charrette obeys.
 */
describe("skill routing", () => {
  const routedDag = (title: string, spec: string) =>
    "```json\n" +
    JSON.stringify({
      epics: [{ id: "epic-e", title: "E", summary: "s" }],
      tasks: [{ id: "task-a", epicId: "epic-e", title, spec, acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" }],
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
    "dns-iac-engineer",
    "fullstack-app",
    "visual-qa-agent",
    "github-pipeline-expert",
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
    const system = await inject("Migrate DNS to a managed provider", "Update the Terraform infrastructure for cert-manager DNS-01 issuers and the ACME solver");
    expect(system).toContain('<skill name="dns-iac-engineer"');
    // Four slots, five matching skills: the architecture rule's last one gives way.
    expect(system).not.toContain('<skill name="frontend-design"');
  }, 30_000);

  /**
   * The pipeline is routed ahead of everything for the same cap reason, and it
   * needs the ordering more than DNS does: a CI task matches the architecture
   * vocabulary by its nature. "Infrastructure", "deployment", "latency" and
   * "capacity" are what a bench gate is *about*, so the agent writing
   * `.github/workflows/` would otherwise carry four playbooks, none of them
   * about GitHub Actions.
   */
  it("routes pipeline work to the pipeline expert, ahead of the architecture skills it also matches", async () => {
    const built = await inject("Build the CI pipeline", "Add .github/workflows/ci.yml running fmt, clippy and the test suite behind a coverage floor of 75%");
    expect(built).toContain('<skill name="github-pipeline-expert"');

    // The shape `queueCiFixes` writes, on a check that is itself about latency.
    const fix = await inject(
      "Fix red CI check: dev-loop bench + p99 regression gate",
      "The repo's own CI check failed on the merged branch after a re-run. Reproduce it from the workflow definition in .github/workflows/; the gate measures added latency and throughput against a candidate build."
    );
    expect(fix).toContain('<skill name="github-pipeline-expert"');
    // Four slots, five matching skills: the architecture rule's last one gives way.
    expect(fix).not.toContain('<skill name="frontend-design"');
  }, 60_000);

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

  /**
   * The vocabulary named the container and not the contents: `component` and
   * `screen` routed, `button`, `form`, `dropdown`, `modal` and `page` did not.
   * So "Add a pricing page with a plan selector" — a task that is nothing but
   * interface — reached its worker with no design playbook at all.
   */
  it("routes a task that names the controls rather than the container", async () => {
    const system = await inject("Pricing page", "Add the pricing page with a plan dropdown, a comparison data table and a call-to-action button");
    expect(system).toContain('<skill name="frontend-design"');
    expect(system).toContain('<skill name="ui-ux-cx-engineer"');
  }, 30_000);

  it("routes the states and the polish, not just the structure", async () => {
    const system = await inject("Invoices list", "Add a loading state, an empty state and a tooltip on the icon, and check it in dark mode");
    expect(system).toContain('<skill name="frontend-design"');
    expect(system).toContain('<skill name="ui-ux-cx-engineer"');
  }, 30_000);

  /**
   * Precision matters more than recall here, which inverts the usual instinct
   * about a keyword gate. Since the craft rules ship in every worker's prompt,
   * a miss costs depth — the task still gets the standard. A false positive
   * costs one of four skill slots on a task with no interface, and the slot it
   * takes is the one the relevant skill needed. So the ambiguous words are
   * qualified: a database table is not a data table, a dependency graph is not
   * a chart, a feature toggle is not a toggle switch, and `page size` is
   * pagination.
   */
  it("does not mistake backend vocabulary for interface vocabulary", async () => {
    const db = await inject("Ledger schema", "Create the postings table and backfill it, keyed off the accounts table");
    expect(db).not.toContain('<skill name="frontend-design"');
    expect(db).not.toContain('<skill name="ui-ux-cx-engineer"');

    const paging = await inject("Cursor the exports API", "Return results in batches with a page size and a page token, no offsets");
    expect(paging).not.toContain('<skill name="frontend-design"');

    const flags = await inject("Feature toggles", "Read the toggle from config so a half-built path can ship dark");
    expect(flags).not.toContain('<skill name="frontend-design"');
  }, 90_000);
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

/**
 * The pin is a name, and the collection it names into belongs to the operator.
 * A name that matches nothing used to be dropped where nobody could see it —
 * including `spec` → `prd-to-tdd`, which is the difference between a run
 * specified against a standard and a run specified against an improvisation.
 */
describe("a roleSkills pin this machine cannot honour", () => {
  it("names it on the event log before the run leaves the state it was created in", async () => {
    const { pool } = recordingPool();
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const seen: CharretteEvent[] = [];
    bus.subscribe(({ event }) => void seen.push(event));
    const controller = new RunController(store, bus, pool, noGithub, approveAll, repo());

    // The fixture holds stripe-setup, qa-playbook and branding-manager — none
    // of the three skills the default table pins.
    await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], skillsDirs: [skillsDir()] }));

    const unresolved = seen.filter((e) => e.type === "skills.unresolved");
    expect(unresolved.map((e) => `${e.role}:${e.skill}:${e.reason}`)).toEqual([
      "intake:product-manager:missing",
      "planner:product-manager:missing",
      "spec:prd-to-tdd:missing",
    ]);
    // Early is the whole point: an agent already briefed cannot be re-briefed,
    // so these land before the run has left the state it was created in.
    expect(seen.slice(0, 4).map((e) => e.type)).toEqual(["run.created", "skills.unresolved", "skills.unresolved", "skills.unresolved"]);
  }, 60_000);

  /**
   * The spec pin is the one worth shouting about, and the one thing that must
   * not be shouted about on a run that will never spawn a spec agent: advice
   * the operator cannot act on reads as a bug in the tool.
   */
  it("says nothing about the spec pin when the spec phase is switched off", async () => {
    const { pool } = recordingPool();
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const seen: CharretteEvent[] = [];
    bus.subscribe(({ event }) => void seen.push(event));
    const controller = new RunController(store, bus, pool, noGithub, approveAll, repo());

    await controller.startRun(
      "do a thing",
      RunConfig.parse({ deterministicChecks: [], skillsDirs: [skillsDir()], spec: { enabled: false } })
    );

    const unresolved = seen.filter((e) => e.type === "skills.unresolved");
    expect(unresolved.map((e) => e.role)).toEqual(["intake", "planner"]);
  }, 60_000);

  it("stays quiet about the pins it can honour", async () => {
    const { pool } = recordingPool();
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const seen: CharretteEvent[] = [];
    bus.subscribe(({ event }) => void seen.push(event));
    const dir = skillsDir();
    mkdirSync(path.join(dir, "product-manager"));
    writeFileSync(path.join(dir, "product-manager", "SKILL.md"), "---\nname: product-manager\ndescription: product voice\n---\nBody.");
    const controller = new RunController(store, bus, pool, noGithub, approveAll, repo());

    await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], skillsDirs: [dir] }));

    expect(seen.filter((e) => e.type === "skills.unresolved").map((e) => e.skill)).toEqual(["prd-to-tdd"]);
  }, 60_000);
});

/**
 * The spec phase is the one role whose brief is pinned by name rather than
 * scored, and the only one where a missing brief changes what the run is
 * measured against rather than how well it is done. It is also the one
 * injection nothing records on the bus — `skills.injected` carries the worker
 * and QA roles only — so the session itself is what has to be read.
 */
describe("the spec agent's pinned brief", () => {
  it("reaches the session, by name and in the prompt", async () => {
    let planning = 0;
    const specs: AgentSpec[] = [];
    const pool = {
      async run(s: AgentSpec): Promise<AgentResult> {
        if (s.role === "spec") specs.push(s);
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
    const bus = new Bus(store);
    const seen: CharretteEvent[] = [];
    bus.subscribe(({ event }) => void seen.push(event));
    const dir = skillsDir();
    mkdirSync(path.join(dir, "prd-to-tdd"));
    writeFileSync(
      path.join(dir, "prd-to-tdd", "SKILL.md"),
      "---\nname: prd-to-tdd\ndescription: Turn a PRD into gating scenarios and a test-driven specification\n---\nBody."
    );
    const controller = new RunController(store, bus, pool, noGithub, approveAll, repo());

    // An operator at the keyboard: intake is what calls the spec phase, and
    // with nobody to ask it is skipped along with everything downstream of it.
    const ui: IntakeUi = { async ask(_q: IntakeQuestion) { return "whatever you think"; }, say() {} };
    await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], skillsDirs: [dir] }), ui);

    // Honoured rather than reported missing — the spec pin is gone from the
    // unresolved list, and only the planner-side pin is still absent.
    expect(seen.filter((e) => e.type === "skills.unresolved").map((e) => e.skill)).toEqual(["product-manager", "product-manager"]);
    // The session carries it both ways: named on the spec, so a postmortem can
    // say what the run was specified against, and inlined in the brief.
    expect(specs).not.toHaveLength(0);
    expect(specs[0]!.skills).toEqual(["prd-to-tdd"]);
    expect(specs[0]!.systemPrompt).toContain('<skill name="prd-to-tdd"');
  }, 60_000);
});
