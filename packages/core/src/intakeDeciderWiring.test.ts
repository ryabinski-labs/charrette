import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@charrette/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * What `intake.decidedBy` actually buys the decider.
 *
 * The decider itself is well covered — `intakeDecider.test.ts` drives every
 * refusal it can make. What was never checked is the half above it: that the
 * controller turns a *name* in the config into that skill's playbook in the
 * decider's hands. The two are separate claims, and only the first had a test.
 *
 * It has to be asserted here, at the constructor, because the decider's own
 * session cannot be provoked from a fake pool: it only runs when the intake
 * agent calls `ask_user`, and that tool lives inside an SDK MCP server the
 * pool double never executes. The request object is the last place the wiring
 * is visible before it disappears into a session nobody here can start.
 */
const built = vi.hoisted(() => [] as { decidedBy: string; skills: string[]; skillsBlock: string }[]);

vi.mock("./intakeDecider.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./intakeDecider.js")>();
  return {
    ...real,
    AgentIntake: class extends real.AgentIntake {
      constructor(...args: ConstructorParameters<typeof real.AgentIntake>) {
        built.push(args[2] as (typeof built)[number]);
        super(...args);
      }
    },
  };
});

const made: string[] = [];
afterEach(() => {
  built.length = 0;
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
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-intakewiring-"));
  made.push(dir, `${dir}-wt`);
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "charrette@example.com");
  gitIn(dir, "config", "user.name", "charrette");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-m", "init");
  return dir;
}

/** A skills directory, for the decider to be found in by name. */
function skillsDir(skills: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-intakeskills-"));
  made.push(dir);
  for (const [name, body] of Object.entries(skills)) {
    mkdirSync(path.join(dir, name));
    writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: how ${name} answers intake\n---\n${body}`);
  }
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

const OPEN = "Real vendor accounts wired up, or adapters against sandboxes?";

/** A run interrupted with one question still hanging, which is what resume re-asks. */
function interrupted(dir: string, over: Record<string, unknown>) {
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
  bus.publish({ type: "intake.question", runId: "run-1", sessionId: "s1", question: OPEN, options: [], ts: 1 });
  return store;
}

function pool(): AgentPool {
  let planning = 0;
  return {
    async run(spec: AgentSpec): Promise<AgentResult> {
      const base = { sessionId: "s", costUsd: 0, turns: 1, outcome: "done" as const };
      if (spec.role === "intake") return { ...base, resultText: BRIEF };
      if (spec.role === "planner") return { ...base, resultText: planning++ === 0 ? DOCS : DAG };
      if (spec.role === "worker") {
        writeFileSync(path.join(spec.cwd, "w.txt"), "work\n");
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        return { ...base, resultText: "worker done" };
      }
      return { ...base, resultText: '{"verdict":"PASS","notes":"ok"}' };
    },
  } as unknown as AgentPool;
}

const resume = async (dir: string, over: Record<string, unknown>) => {
  const store = interrupted(dir, over);
  await new RunController(store, new Bus(store), pool(), new GitHubAdapter(undefined, undefined), gates, dir).resume("run-1");
};

describe("the playbook a named intake decider is given", () => {
  it("is the skill it was named after, and not the one the question sounds like", async () => {
    const dir = repo();
    const skills = skillsDir({
      "product-manager": "Prefer sandbox adapters until someone has signed off on spending real money.",
      "integrations-expert": "Vendor accounts, integrations, sandboxes, adapters, credentials, live money.",
    });

    await resume(dir, { skillsDirs: [skills], intake: { decidedBy: "product-manager" } });

    expect(built).toHaveLength(1);
    expect(built[0]!.decidedBy).toBe("product-manager");
    expect(built[0]!.skills).toEqual(["product-manager"]);
    // The playbook travels as a path to read rather than inlined prose, which
    // is what the rest of the run does with a skill it did not pick itself.
    expect(built[0]!.skillsBlock).toContain(path.join(skills, "product-manager", "SKILL.md"));
    // `integrations-expert` is the stronger lexical match for a question about
    // vendor accounts by every word in it. `decidedBy` names who answers; what
    // the question sounds like is a different question, and letting the
    // matcher win here would mean the operator cannot choose the answerer.
    expect(built[0]!.skillsBlock).not.toContain("integrations-expert");
  }, 30_000);

  it("is empty when the named skill is not on this machine, and the decider still answers", async () => {
    // The lookup is a filter, not a requirement. A decider named after a skill
    // this checkout does not have decides anyway — losing the playbook must
    // not quietly turn the gate back into a question for an operator who is
    // not there, which is the failure `decidedBy` exists to prevent.
    const dir = repo();
    const skills = skillsDir({ "integrations-expert": "Vendor accounts, sandboxes, adapters." });

    await resume(dir, { skillsDirs: [skills], intake: { decidedBy: "product-manager" } });

    expect(built).toHaveLength(1);
    expect(built[0]!.decidedBy).toBe("product-manager");
    expect(built[0]!.skills).toEqual([]);
    expect(built[0]!.skillsBlock).toBe("");
  }, 30_000);

  it("is not built at all when the operator is the one deciding", async () => {
    const dir = repo();
    const skills = skillsDir({ "product-manager": "Prefer sandbox adapters." });

    await resume(dir, { skillsDirs: [skills], intake: { decidedBy: "operator" } });

    // No decider, and so no skills lookup: with nobody at the terminal this is
    // the headless resume, which writes the question off out loud rather than
    // indexing a skills directory for a session it will never start.
    expect(built).toEqual([]);
  }, 30_000);
});
