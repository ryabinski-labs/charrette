import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharretteEvent, PlannedTask, RunConfig, RunSpec } from "@charrette/shared";
import { BudgetExceeded } from "./budget.js";
import { Bus } from "./bus.js";
import { GitHubAdapter, type PrChecks } from "./github.js";
import type { IntakeUi } from "./intake.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController } from "./runController.js";
import type { AcceptanceVerdict } from "./acceptance.js";
import { sourceDigest } from "./productionDelivery.js";
import { Store } from "./store.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); vi.restoreAllMocks(); });
const fence = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const command = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string) => { command(cwd, "add", "-A"); command(cwd, "commit", "-m", "fixture changes"); };

async function fixture(options: { auto?: boolean; seed?: boolean; command?: string; fixes?: number; noSkeleton?: boolean; productionBug?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-release-"));
  const bare = mkdtempSync(path.join(tmpdir(), "charrette-release-origin-"));
  cleanup.push(() => { for (const target of [`${dir}-wt`, dir, bare]) rmSync(target, { recursive: true, force: true }); });
  command(dir, "init", "-b", "main");
  command(dir, "config", "user.email", "test@example.invalid");
  command(dir, "config", "user.name", "Test");
  writeFileSync(path.join(dir, "README.md"), "A minimal product fixture\n");
  writeFileSync(path.join(dir, "product.cjs"), "exports.value = null;\n");
  commit(dir);
  command(bare, "init", "--bare", "-b", "main");
  command(dir, "remote", "add", "origin", bare);
  command(dir, "push", "origin", "main");
  const deployed = { sha: "", value: "", serveOld: false, fail: false, revisionReads: 0, changeAfter: Infinity };
  const server: Server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/.well-known/charrette-release" ? { revision: deployed.serveOld || ++deployed.revisionReads > deployed.changeAfter ? "old" : deployed.sha } : { value: deployed.fail ? "broken" : deployed.value }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const spec = RunSpec.parse({
    feature: "working response", requirements: [{ id: "R-1", text: "Return ready to a user", priority: "P0" }],
    scenarios: [{ id: "SC-1", requirement: "R-1", title: "read response", level: "acceptance", priority: "P0", oracle: "GET / returns value ready", testRef: "acceptance.test.cjs" }],
    commands: { all: "node --test --test-reporter=tap acceptance.test.cjs", byId: "node --test --test-reporter=tap --test-name-pattern '{{ids}}' acceptance.test.cjs" },
    criticalPath: { name: "get value", steps: ["Read product response"] },
    release: { environment: "one local fixture service", deploymentChecks: ["deploy-production"], productionScenarioIds: ["SC-1"], productionCommand: options.command ?? "node --test --test-reporter=tap production.test.cjs" },
  });
  const writeTests = (cwd: string) => {
    writeFileSync(path.join(cwd, "acceptance.test.cjs"), "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('SC-1',()=>assert.equal(require('./product.cjs').value,'ready'));\n");
    writeFileSync(path.join(cwd, "production.test.cjs"), "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('SC-1',async()=>{ const r=await fetch(process.env.CHARRETTE_PROD_URL); assert.equal(r.status,200); assert.equal((await r.json()).value,'ready'); });\n");
  };
  const task = PlannedTask.parse({ id: "slice", epicId: "product", title: "Build response", spec: "Return ready", acceptanceCriteria: ["returns ready"], scenarioIds: ["SC-1"], skeleton: !options.noSkeleton, estimatedSize: "S" });
  const store = new Store(":memory:");
  cleanup.push(() => store.db.close());
  const bus = new Bus(store);
  const events: CharretteEvent[] = [];
  bus.subscribe(({ event }) => events.push(event));
  let runId = "seed";
  let observations = true;
  let productionReview: Record<string, unknown> | undefined;
  const specs: AgentSpec[] = [];
  const pool = { async run(request: AgentSpec): Promise<AgentResult> {
    runId = request.runId;
    specs.push(request);
    await request.budgetCheck?.();
    let value = "";
    switch (request.role) {
      case "intake": value = fence({ goal: "A short summary" }); break;
      case "spec": writeTests(request.cwd); value = fence(spec); break;
      case "planner": value = Array.isArray(request.tools) && request.tools.length ? "<prd>\n# PRD\nReturn ready to a user\n</prd>\n<conventions>\nNode.js\n</conventions>" : fence({ epics: [{ id: "product", title: "product", summary: "" }], tasks: [task] }); break;
      case "worker": writeFileSync(path.join(request.cwd, "product.cjs"), `exports.value = 'ready';\nexports.liveValue = '${options.productionBug && !request.taskId?.startsWith("production-fix") ? "broken" : "ready"}';\n`); commit(request.cwd); value = "implemented ready response"; break;
      case "qa": value = fence({ verdict: "PASS", notes: "checked response" }); break;
      case "validator": value = fence({ verdict: "PASS", gaps: [], summary: "response works" }); break;
      case "live": value = fence({ started: true, howStarted: "node product.cjs", documentedStart: "README.md", steps: [{ step: "Read product response", result: "worked", observed: "value ready" }], couldNotReach: [], artifacts: [], commands: [{ command: "node -e \"if(require('./product.cjs').value!=='ready')process.exit(1)\"", shows: "ready response" }], summary: "works" }); break;
      case "prod": value = fence(productionReview ?? { verdict: "PASS", summary: "ready over HTTP", observations: observations ? [{ scenarioId: "SC-1", evidence: `GET ${url} returned ${JSON.stringify(await (await fetch(url)).json())}` }] : [] }); break;
      default: value = fence({ verdict: "on-track", findings: [], question: "" });
    }
    return { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: value, costUsd: 0, turns: 1, outcome: "done" };
  } } as unknown as AgentPool;
  const github = new GitHubAdapter("unused", "test/repo");
  let currentPr = 7;
  const mergedPrs = new Map<number, string>();
  const head = () => command(dir, "rev-parse", `charrette/${runId}/main`);
  const merge = (number = currentPr) => {
    deployed.sha = head();
    const source = command(dir, "show", `${deployed.sha}:product.cjs`);
    deployed.value = source.match(/liveValue = '([^']+)'/)?.[1] ?? (source.includes("'ready'") ? "ready" : "");
    mergedPrs.set(number, deployed.sha);
    command(dir, "push", "origin", `${deployed.sha}:refs/heads/main`);
  };
  const checks = (sha: string) => ({ state: "passing" as const, failing: [], total: 1, names: ["deploy-production"], successful: ["deploy-production"], sha });
  vi.spyOn(github, "ensureIssue").mockResolvedValue({ number: 1, url: "https://example.invalid/issues/1" });
  vi.spyOn(github, "commentOnIssue").mockResolvedValue(true);
  vi.spyOn(github, "closeIssue").mockResolvedValue(true);
  vi.spyOn(github, "issueComments").mockResolvedValue([]);
  vi.spyOn(github, "ensurePR").mockImplementation(async () => {
    if (mergedPrs.has(currentPr)) currentPr++;
    return { number: currentPr, url: `https://example.invalid/pull/${currentPr}` };
  });
  vi.spyOn(github, "markPrReady").mockResolvedValue(true);
  vi.spyOn(github, "prMergeable").mockResolvedValue({ state: "mergeable", mergeStateStatus: "clean" });
  vi.spyOn(github, "prState").mockImplementation(async (number) => mergedPrs.has(number) ? "merged" : "open");
  vi.spyOn(github, "mergedSha").mockImplementation(async (number) => mergedPrs.get(number) ?? null);
  vi.spyOn(github, "prChecks").mockImplementation(async () => checks(head()));
  vi.spyOn(github, "checksForRef").mockImplementation(async (sha) => checks(sha));
  vi.spyOn(github, "mergeApprovedPR").mockImplementation(async (number, _head, _base, sha) => { expect(sha).toBe(head()); merge(number); return true; });
  const controller = new RunController(store, bus, pool, github, {
    async resolvePlanGate() { return { approved: true, feedback: "" }; },
    async resolveBudgetGate() { return null; },
    async resolvePitStop() { return { action: "stop", feedback: "unexpected blocker" }; },
  }, dir);
  const config = RunConfig.parse({ prodUrl: url, delivery: { mode: "production", merge: options.auto ? "auto" : "manual", mergeTimeoutMinutes: 0, fixRounds: options.fixes ?? 0, prdSha256: sourceDigest("Return ready to a user") },
    deterministicChecks: [], skillsDirs: [], roleSkills: {}, planIntentCheck: false, pitStop: { every: "never" }, maxParallelWorkers: 1 });
  if (options.seed) {
    writeTests(dir);
    writeFileSync(path.join(dir, "product.cjs"), "exports.value = 'ready';\n"); commit(dir);
    command(dir, "branch", "charrette/seed/main");
    store.createRun({ id: "seed", repoPath: dir, assignment: "Return ready to a user", state: "PR_REVIEW", config: { ...config, baseBranch: "main" }, prdPath: null, planHash: null, integrationBranch: "charrette/seed/main" });
    store.insertTasks("seed", [{ id: "product", title: "product" }], [{ ...task, state: "MERGED", branch: null, worktreePath: null, githubIssueNumber: null, prNumber: 7, qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null }]);
    bus.publish({ type: "run.spec_ready", runId: "seed", spec, ts: Date.now() });
    store.bindRelease(config.delivery.releaseId, config.delivery.prdSha256, "Return ready to a user", spec, "seed");
    mkdirSync(path.join(dir, ".charrette"), { recursive: true });
  }
  const internals = controller as unknown as {
    deliverProduction(id: string): Promise<boolean>; driveRun(id: string): Promise<void>; reopen(id: string): Promise<void>;
    checkReleaseSkeleton(id: string): Promise<boolean>; ensureReleaseContract(id: string, ui?: IntakeUi): Promise<boolean>;
    specify(id: string, assignment: string, ui: IntakeUi): Promise<boolean>; exerciseLive(id: string): Promise<void>;
    queueLiveFixes(id: string): Promise<string[]>; proofOf(id: string): { proven: boolean; unmet: string[]; held: boolean };
    settleChecks(id: string, read: (ref: string) => Promise<PrChecks | null>, ref: string, timeout: number): Promise<PrChecks | null>;
    validateProd(id: string, url: string): Promise<boolean>; deliveryWasVerifying(id: string): boolean;
    verify(id: string): Promise<boolean>;
    checkAcceptance(id: string): Promise<AcceptanceVerdict | null>; queueScenarioFixes(id: string): Promise<string[]>;
    wt: { freshWorktree(id: string, taskId: string): Promise<string> };
  };
  return { dir, store, events, controller, internals, config, github, spec, specs, deployed, merge, setObservations: (value: boolean) => { observations = value; }, setReview: (value: Record<string, unknown>) => { productionReview = value; } };
}

describe("production delivery lifecycle", () => {
  it("keeps the full PRD when interactive intake returns a shorter summary", async () => {
    const f = await fixture({ auto: true });
    const original = "Return ready to a user\nThe complete original PRD must remain binding.";
    await f.controller.startRun(original, f.config, { async ask() { return "use the declared target"; }, say() {} });
    const run = f.store.listRuns()[0]!;
    expect(run.assignment).toContain(original);
    expect(run.assignment).toContain("A short summary");
    expect(run.config.delivery.prdSha256).toBe(sourceDigest(original));
    expect(run.state, f.controller.outcome(run.id).line).toBe("DONE");
  });

  it("keeps unanswered specification questions blocked without asking an agent to invent answers", async () => {
    const f = await fixture();
    f.spec.openQuestions.push({ id: "OQ-1", question: "Which recovery target?", blocks: ["R-1"], detail: "" });
    await f.controller.startRun("Return ready to a user", f.config);
    const run = f.store.listRuns()[0]!;
    expect(run.state).toBe("BLOCKED");
    expect(f.controller.outcome(run.id).line).toContain("Which recovery target?");
    expect(f.store.runSpec(run.id)!.openQuestions).toHaveLength(1);
    expect(f.specs.filter((s) => s.role === "spec")).toHaveLength(1);
    expect(f.specs.some((s) => s.role === "planner")).toBe(false);
    expect(f.events.some((e) => e.type === "intake.answered")).toBe(false);
  });

  it("resumes a pause before delivery without inventing production evidence", async () => {
    const f = await fixture({ seed: true, auto: true });
    expect(f.internals.deliveryWasVerifying("seed")).toBe(false);
    f.store.transitionRun("seed", "VERIFYING"); f.store.transitionRun("seed", "PAUSED");
    await f.internals.driveRun("seed");
    expect(f.store.getRun("seed")!.state).toBe("PAUSED");
    expect(f.specs.some((s) => s.role === "prod")).toBe(false);
    expect(f.github.mergeApprovedPR).not.toHaveBeenCalled();
  });

  it("waits through unreadable merge status until the operator merges", async () => {
    const f = await fixture({ seed: true });
    f.controller.githubRetryMs = 1;
    f.store.patchRunConfig("seed", { delivery: { ...f.config.delivery, mergeTimeoutMinutes: 1 } });
    vi.mocked(f.github.mergedSha).mockRejectedValueOnce(new Error("API down"));
    vi.mocked(f.github.prState).mockImplementationOnce(async () => { f.merge(); throw new Error("status unavailable"); });
    expect(await f.internals.deliverProduction("seed")).toBe(true);
    expect(f.github.mergeApprovedPR).not.toHaveBeenCalled();
  });

  it("blocks checkout failures without claiming the merged release was tested", async () => {
    const f = await fixture({ seed: true }); f.merge();
    vi.spyOn(f.internals.wt, "freshWorktree").mockRejectedValueOnce(new Error("cannot fetch release"));
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.releaseEvidence("seed")!.unmet.join(" ")).toContain("cannot fetch release");
  });

  it.each([1, 2])("rejects a revision that changes after production check %s", async (changeAfter) => {
    const f = await fixture({ seed: true }); f.merge(); f.deployed.changeAfter = changeAfter;
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.releaseEvidence("seed")).toMatchObject({ phase: "production", verdict: "blocked" });
  });

  it("repairs concrete independent findings but blocks unknown observations", async () => {
    const f = await fixture({ seed: true, fixes: 1 }); f.merge();
    const observations = [{ scenarioId: "SC-1", evidence: "HTTP request observed" }];
    f.setReview({ verdict: "UNKNOWN", observations });
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.productionEvidence("seed")!.unchecked).toEqual(["production reviewer could not reach a verdict"]);
    f.setReview({ verdict: "UNKNOWN", observations, unchecked: ["recovery target is inaccessible"] });
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.productionEvidence("seed")!.unchecked).toEqual(["recovery target is inaccessible"]);
    f.store.transitionRun("seed", "VERIFYING");
    f.setReview({ verdict: "FAIL", observations, findings: ["The documented user journey fails"] });
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.getTask("seed", "production-fix-1")!.spec).toContain("documented user journey fails");
  });

  it("cannot turn an absent independent verdict into a pass", async () => {
    const f = await fixture({ seed: true }); f.merge();
    vi.spyOn(f.internals, "validateProd").mockResolvedValue(false);
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.releaseEvidence("seed")!.unmet).toContain("independent production validation did not pass");
  });

  it("does not create a fake suite repair for blocked-only acceptance", async () => {
    const f = await fixture({ seed: true });
    vi.spyOn(f.internals, "checkAcceptance").mockResolvedValue({ verdict: "red", failing: [], blocked: ["SC-1"], named: false, line: "unanswered", output: "" });
    expect(await f.internals.queueScenarioFixes("seed")).toEqual([]);
  });

  it("cannot inherit waived requirements into a production release", async () => {
    const f = await fixture({ seed: true });
    f.store.appendEvent(CharretteEvent.parse({ type: "run.scope_written_off", runId: "seed", requirementId: "R-1", answer: "skip it", decidedBy: "operator", ts: Date.now() }));
    expect(f.internals.proofOf("seed").unmet).toContain("the release has written-off requirements; a reduced scope needs its own release contract");
  });

  it("takes a PRD through real worktrees, passing tests, authorized merge and HTTP production validation", async () => {
    const f = await fixture({ auto: true });
    await f.controller.startRun("Return ready to a user", f.config);
    const run = f.store.listRuns()[0]!;
    expect(run.state, f.controller.outcome(run.id).line).toBe("DONE");
    expect(f.github.mergeApprovedPR).toHaveBeenCalledOnce();
    expect(f.specs.map((s) => s.role)).toContain("spec");
    const proof = f.store.releaseEvidence(run.id)!;
    expect(proof).toMatchObject({ phase: "production", verdict: "passed", sha: f.deployed.sha, requirements: ["R-1"] });
    expect(JSON.parse(readFileSync(proof.evidencePath, "utf8"))).toMatchObject({ sha: f.deployed.sha, exitCode: 0, verdict: { verdict: "green" } });
    const phases = f.events.filter((e) => e.type === "run.release_evidence" && e.verdict === "passed").map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(expect.arrayContaining(["contract", "skeleton", "merge", "deploy", "production"]));
  });

  it("repairs a production-only defect and verifies the follow-up PR deployment", async () => {
    const f = await fixture({ auto: true, productionBug: true, fixes: 1 });
    await f.controller.startRun("Return ready to a user", f.config);
    const run = f.store.listRuns()[0]!;
    expect(run.state, f.controller.outcome(run.id).line).toBe("DONE");
    expect(f.store.getTask(run.id, "production-fix-1")!.state).toBe("MERGED");
    expect(f.github.mergeApprovedPR).toHaveBeenCalledTimes(2);
    expect(f.deployed.value).toBe("ready");
  });

  it("stops execution before breadth if the plan contains no skeleton", async () => {
    const f = await fixture({ noSkeleton: true });
    await f.controller.startRun("Return ready to a user", f.config);
    const run = f.store.listRuns()[0]!;
    expect(run.state).toBe("BLOCKED");
    expect(f.specs.some((s) => s.role === "worker")).toBe(false);
  });

  it.each(["PAUSED", "BUDGET_HOLD", "LIMIT_HOLD"] as const)("resumes production verification from %s", async (state) => {
    const f = await fixture({ seed: true }); f.merge();
    f.store.transitionRun("seed", "VERIFYING");
    f.store.appendEvent(CharretteEvent.parse({ type: "run.release_evidence", runId: "seed", releaseId: "default", phase: "deploy", verdict: "blocked", ts: Date.now() }));
    f.store.transitionRun("seed", state);
    await f.internals.driveRun("seed");
    expect(f.store.getRun("seed")!.state).toBe("DONE");
  });

  it("reopens an early contract blocker for planning, not integration", async () => {
    const f = await fixture({ seed: true });
    f.store.db.prepare("DELETE FROM tasks WHERE runId='seed'").run();
    f.store.transitionRun("seed", "BLOCKED");
    await f.internals.reopen("seed");
    expect(f.store.getRun("seed")!.state).toBe("PLANNING");
  });

  it("waits for manual merge, blocks honestly, then resumes to DONE without replanning", async () => {
    const f = await fixture({ seed: true });
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.getRun("seed")!.state).toBe("BLOCKED");
    expect(f.github.mergeApprovedPR).not.toHaveBeenCalled();
    f.merge();
    await f.internals.reopen("seed");
    expect(f.store.getRun("seed")!.state).toBe("VERIFYING");
    await f.internals.driveRun("seed");
    expect(f.store.getRun("seed")!.state).toBe("DONE");
    expect(f.specs.map((s) => s.role)).not.toContain("planner");
  });

  it("rejects a healthy deployment of the wrong revision", async () => {
    const f = await fixture({ seed: true }); f.merge(); f.deployed.serveOld = true;
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.releaseEvidence("seed")).toMatchObject({ phase: "deploy", verdict: "blocked" });
    expect(f.specs).toHaveLength(0);
  });

  it("requires observations, not an empty independent PASS", async () => {
    const f = await fixture({ seed: true }); f.merge(); f.setObservations(false);
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.prodVerdict("seed")!.findings).toEqual([expect.stringContaining("SC-1")]);
    expect(f.store.getRun("seed")!.state).toBe("BLOCKED");
  });

  it("queues a bounded repository repair when real production behavior fails", async () => {
    const f = await fixture({ seed: true, fixes: 1 }); f.merge(); f.deployed.fail = true;
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.getRun("seed")!.state).toBe("EXECUTING");
    expect(f.store.getTask("seed", "production-fix-1")!.spec).toContain("frozen release contract");
    f.store.transitionRun("seed", "INTEGRATING"); f.store.transitionRun("seed", "PR_REVIEW");
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.getRun("seed")!.state).toBe("BLOCKED");
    expect(f.store.getTask("seed", "production-fix-2")).toBeUndefined();
  });

  it("rejects a production suite selecting zero scenarios", async () => {
    const f = await fixture({ seed: true, command: "exit 0" }); f.merge();
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.releaseEvidence("seed")!.unmet.join(" ")).toContain("no passing execution result");
  });

  it("interrupts a long production command when the operator pauses", async () => {
    const f = await fixture({ seed: true, command: "node -e 'setTimeout(()=>{},300000)'" }); f.merge();
    const active = f.controller as unknown as { activeProductionChecks: Map<string, AbortController> };
    const stopped = expect(f.internals.deliverProduction("seed")).rejects.toThrow("paused by the operator");
    await vi.waitFor(() => expect(active.activeProductionChecks.has("seed")).toBe(true), { timeout: 20_000 });
    expect(f.controller.pauseRun("seed")).toContain("pausing");
    await stopped;
    expect(active.activeProductionChecks.size).toBe(0);
    expect(f.store.releaseEvidence("seed")?.phase).not.toBe("production");
  });

  it("refuses startup without GitHub authority or with a changed PRD", async () => {
    const f = await fixture({ seed: true });
    await expect(f.controller.startRun("a reduced PRD", f.config)).rejects.toThrow("different PRD");
    vi.spyOn(f.github, "enabled", "get").mockReturnValue(false);
    await expect(f.controller.startRun("Return ready to a user", f.config)).rejects.toThrow("GitHub");
  });

  it("restores the original specification across runs and refuses contract drift", async () => {
    const f = await fixture({ seed: true });
    f.store.db.prepare("DELETE FROM events WHERE runId='seed' AND type='run.spec_ready'").run();
    expect(await f.internals.ensureReleaseContract("seed")).toBe(true);
    expect(f.store.runSpec("seed")).toEqual(f.spec);
    f.store.appendEvent({ type: "run.spec_ready", runId: "seed", spec: { ...f.spec, scenarios: [] }, ts: Date.now() });
    expect(await f.internals.ensureReleaseContract("seed")).toBe(false);
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.releaseEvidence("seed")!.unmet.join(" ")).toContain("changed");
  });

  it("rejects a mismatched source digest and disabled proof gates on resume", async () => {
    const f = await fixture({ seed: true });
    f.store.patchRunConfig("seed", { delivery: { ...f.config.delivery, prdSha256: "changed" } });
    expect(await f.internals.ensureReleaseContract("seed")).toBe(false);
    f.store.patchRunConfig("seed", { prodUrl: "invalid" });
    vi.spyOn(f.github, "enabled", "get").mockReturnValue(false);
    expect(await f.internals.ensureReleaseContract("seed")).toBe(false);
    expect(f.store.releaseEvidence("seed")!.unmet.join(" ")).toContain("GitHub");
  });

  it("does not manufacture an answer when specification needs an absent operator", async () => {
    const f = await fixture({ seed: true });
    f.store.db.prepare("DELETE FROM release_contracts").run();
    f.store.db.prepare("DELETE FROM events WHERE type='run.spec_ready'").run();
    vi.spyOn(f.internals, "specify").mockImplementation(async (_id, _assignment, ui) => {
      await expect(ui.ask({ question: "Where deploy?" } as never)).rejects.toThrow("No operator is attached");
      ui.say("missing access");
      return false;
    });
    expect(await f.internals.ensureReleaseContract("seed")).toBe(false);
    expect(f.store.releaseContract("default")).toBeNull();
    f.store.appendEvent({ type: "run.spec_ready", runId: "seed", spec: f.spec, ts: Date.now() });
    expect(await f.internals.ensureReleaseContract("seed")).toBe(true);
    expect(f.store.releaseContract("default")!.spec).toEqual(f.spec);
  });

  it("requires an actual skeleton and holds breadth until its evidence exists", async () => {
    const f = await fixture({ seed: true });
    const exercise = vi.spyOn(f.internals, "exerciseLive").mockResolvedValue();
    const fixes = vi.spyOn(f.internals, "queueLiveFixes").mockResolvedValue([]);
    f.store.updateTask("seed", "slice", { skeleton: false });
    expect(await f.internals.checkReleaseSkeleton("seed")).toBe(false);
    f.store.updateTask("seed", "slice", { skeleton: true });
    f.store.db.prepare("UPDATE tasks SET state='PENDING' WHERE runId='seed'").run();
    expect(await f.internals.checkReleaseSkeleton("seed")).toBe(true);
    await f.internals.reopen("seed");
    expect(f.store.getRun("seed")!.state).toBe("EXECUTING");
    expect(exercise).not.toHaveBeenCalled();
    f.store.transitionRun("seed", "BLOCKED");
    f.store.db.prepare("UPDATE tasks SET state='READY' WHERE runId='seed'").run();
    await f.internals.reopen("seed");
    expect(f.store.getRun("seed")!.state).toBe("EXECUTING");
    f.store.db.prepare("UPDATE tasks SET state='CANCELLED' WHERE runId='seed'").run();
    expect(await f.internals.checkReleaseSkeleton("seed")).toBe(false);
    f.store.db.prepare("UPDATE tasks SET state='MERGED' WHERE runId='seed'").run();
    expect(await f.internals.checkReleaseSkeleton("seed")).toBe(false);
    f.store.appendEvent(CharretteEvent.parse({ type: "run.live_verdict", runId: "seed", verdict: "broken", why: "cannot start", ts: Date.now() }));
    expect(await f.internals.checkReleaseSkeleton("seed")).toBe(false);
    expect(f.store.releaseEvidence("seed")!.unmet).toEqual(["cannot start"]);
    fixes.mockResolvedValueOnce(["slice"]);
    expect(await f.internals.checkReleaseSkeleton("seed")).toBe(true);
    f.store.appendEvent(CharretteEvent.parse({ type: "run.live_verdict", runId: "seed", verdict: "worked", ts: Date.now() }));
    expect(await f.internals.checkReleaseSkeleton("seed")).toBe(true);
    exercise.mockClear();
    expect(await f.internals.checkReleaseSkeleton("seed")).toBe(true);
    expect(exercise).not.toHaveBeenCalled();
  });

  it("never auto-merges an unproven, untested or changed PR", async () => {
    const f = await fixture({ seed: true, auto: true });
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    vi.spyOn(f.internals, "proofOf").mockReturnValue({ proven: true, unmet: [], held: true });
    const base: PrChecks = { state: "passing", sha: command(f.dir, "rev-parse", "charrette/seed/main"), total: 1, failing: [], successful: ["test"] };
    for (const value of [null, { ...base, unavailable: true }, { ...base, state: "pending" as const }, { ...base, sha: "changed" }, { ...base, total: 0 }, { ...base, successful: [] }]) {
      f.store.transitionRun("seed", "VERIFYING");
      vi.mocked(f.github.prChecks).mockResolvedValueOnce(value);
      expect(await f.internals.deliverProduction("seed")).toBe(false);
    }
    expect(f.github.mergeApprovedPR).not.toHaveBeenCalled();
    f.store.transitionRun("seed", "VERIFYING");
    vi.mocked(f.github.prChecks).mockRejectedValueOnce(new Error("API down"));
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    f.store.transitionRun("seed", "VERIFYING");
    vi.mocked(f.github.mergeApprovedPR).mockResolvedValueOnce(false);
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.releaseEvidence("seed")!.unmet.join(" ")).toContain("GitHub refused");
  });

  it("blocks when there is no PR or when it was closed without merging", async () => {
    const f = await fixture({ seed: true });
    f.store.updateTask("seed", "slice", { prNumber: null });
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.releaseEvidence("seed")!.unmet).toContain("no release pull request exists");
    f.store.updateTask("seed", "slice", { prNumber: 7 });
    f.store.patchRunConfig("seed", { delivery: { ...f.config.delivery, mergeTimeoutMinutes: 1 } });
    vi.mocked(f.github.prState).mockResolvedValueOnce("closed");
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.releaseEvidence("seed")!.unmet.join(" ")).toContain("closed without merging");
  });

  it("waits for late deployment checks and distinguishes failures from missing evidence", async () => {
    const f = await fixture({ seed: true }); f.merge();
    const settle = vi.spyOn(f.internals, "settleChecks");
    settle.mockImplementation(async (_id, read, sha) => {
      vi.mocked(f.github.checksForRef).mockResolvedValueOnce(null);
      expect((await read(sha))!.state).toBe("pending");
      vi.mocked(f.github.checksForRef).mockResolvedValueOnce({ state: "passing", sha, total: 1, names: ["build"], successful: ["build"], failing: [] });
      expect((await read(sha))!.state).toBe("pending");
      vi.mocked(f.github.checksForRef).mockResolvedValueOnce({ state: "failing", sha, total: 1, successful: [], failing: ["deploy-production"] });
      return read(sha);
    });
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.releaseEvidence("seed")!.unmet.join(" ")).toContain("deploy-production");
    settle.mockResolvedValueOnce(null);
    expect(await f.internals.deliverProduction("seed")).toBe(false);
    expect(f.store.releaseEvidence("seed")!.unmet.join(" ")).toContain("could not be read");
  });

  /**
   * Every one of these is GitHub failing to answer a question the run has
   * already done the work to earn. None of them may be read as "not merged":
   * the merge is a fact about the repository, and an unreadable answer is the
   * charrette's ignorance of it, not evidence against it.
   */
  describe("when GitHub stops answering about the merge", () => {
    it("does not claim a release unmerged when the read-back after an authorized merge fails", async () => {
      const f = await fixture({ seed: true, auto: true });
      vi.spyOn(f.internals, "proofOf").mockReturnValue({ proven: true, unmet: [], held: true });
      // Open on the first read, so the auto-merge runs; unreadable on the
      // read-back, which is the one call whose answer cannot be invented — the
      // deploy is followed by that sha and nothing else.
      vi.mocked(f.github.mergedSha).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("API down"));

      expect(await f.internals.deliverProduction("seed")).toBe(false);

      expect(f.github.mergeApprovedPR).toHaveBeenCalledOnce();
      // Blocked with the resume line, not merged-and-verified: the operator is
      // told the release is in flight, and `charrette resume` reads the sha
      // once GitHub is answering again.
      expect(f.store.releaseEvidence("seed")!.unmet.join(" ")).toContain("has not merged");
    });

    it("keeps waiting when one poll for the merge fails", async () => {
      const f = await fixture({ seed: true });
      f.controller.githubRetryMs = 1;
      f.store.patchRunConfig("seed", { delivery: { ...f.config.delivery, mergeTimeoutMinutes: 1 } });
      // Not merged, then unreadable, then merged. Giving up on the middle
      // answer would end delivery a poll before the operator's merge landed.
      vi.mocked(f.github.mergedSha).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("API down"));
      vi.mocked(f.github.prState).mockImplementationOnce(async () => { f.merge(); return "open"; });

      expect(await f.internals.deliverProduction("seed")).toBe(true);
    });

    it("leaves the run in PR_REVIEW rather than following a deploy it cannot name", async () => {
      const f = await fixture({ seed: true });
      vi.mocked(f.github.mergedSha).mockRejectedValueOnce(new Error("API down"));

      expect(await f.internals.verify("seed")).toBe(false);
      // Not VERIFYING: that transition is the claim that a merge happened, and
      // `resume` re-enters here once GitHub can say whether one did.
      expect(f.store.getRun("seed")!.state).toBe("PR_REVIEW");
    });

    it("reads an unanswerable check as no answer, and still lets a stopped run stop", async () => {
      const f = await fixture({ seed: true });

      await expect(f.internals.settleChecks("seed", async () => { throw new Error("API down"); }, "sha", 0)).resolves.toBeNull();

      // The exception to the rule above. A budget wall is not GitHub failing to
      // answer — it is the run ending — and swallowing it here would spend the
      // rest of the wait, and the rest of the money, on a run that is over.
      await expect(
        f.internals.settleChecks("seed", async () => { throw new BudgetExceeded(1200, 1000, "seed"); }, "sha", 0)
      ).rejects.toBeInstanceOf(BudgetExceeded);
    });
  });
});

/**
 * The production validator is the one agent that runs against the deployed
 * system rather than a worktree, and the operator's own validation playbooks
 * are exactly what it should be running it with. The pin reaching it had never
 * been checked.
 */
describe("briefing the production validator", () => {
  it("carries the playbook the operator pinned to its role", async () => {
    const f = await fixture({ seed: true });
    const skills = mkdtempSync(path.join(tmpdir(), "charrette-release-skills-"));
    cleanup.push(() => rmSync(skills, { recursive: true, force: true }));
    mkdirSync(path.join(skills, "prod-smoke"));
    writeFileSync(
      path.join(skills, "prod-smoke", "SKILL.md"),
      "---\nname: prod-smoke\ndescription: How to validate this service once it is deployed\n---\nCurl the health endpoint, then read the logs."
    );
    f.store.patchRunConfig("seed", { skillsDirs: [skills], roleSkills: { prod: ["prod-smoke"] } });

    expect(await f.internals.validateProd("seed", f.config.prodUrl)).toBe(true);

    const session = f.specs.find((s) => s.role === "prod")!;
    expect(session.skills).toEqual(["prod-smoke"]);
    expect(session.systemPrompt).toContain('<skill name="prod-smoke"');
  });
});

/**
 * `reopen` decides what a resumed release goes back to, from the phase on the
 * record. Three of its readings had never been taken: a release already past
 * the merge that is not blocked, a skeleton phase with nothing queued behind
 * it, and a run resumed straight into VERIFYING.
 */
describe("resuming a release from where it actually is", () => {
  const evidence = (f: Awaited<ReturnType<typeof fixture>>, phase: string, verdict: string) =>
    f.store.appendEvent({
      type: "run.release_evidence",
      runId: "seed",
      releaseId: f.config.delivery.releaseId,
      phase: phase as "merge" | "deploy" | "production" | "skeleton" | "contract",
      verdict: verdict as "passed" | "failed" | "blocked",
      sha: "",
      url: f.config.prodUrl,
      requirements: [],
      unmet: [],
      evidencePath: "",
      ts: Date.now(),
    });

  it("leaves a release past the merge where it is when nothing blocked it", async () => {
    const f = await fixture({ seed: true });
    evidence(f, "deploy", "passed");

    await f.internals.reopen("seed");

    // The transition to VERIFYING is for a run the release *blocked*. A run in
    // review is already where it belongs, and moving it would claim a deploy
    // is being waited on that nobody is waiting on.
    expect(f.store.getRun("seed")!.state).toBe("PR_REVIEW");
  });

  it("does not retry a working skeleton with no queued work behind it", async () => {
    const f = await fixture({ seed: true });
    evidence(f, "skeleton", "passed");
    f.store.transitionRun("seed", "BLOCKED");

    await f.internals.reopen("seed");

    // Everything the plan had is merged. Going back to EXECUTING would put the
    // run in a state with nothing to dispatch, which reads to an operator as
    // work in progress that will never move.
    expect(f.store.getRun("seed")!.state).not.toBe("EXECUTING");
  });

  it("does nothing at all when the run it is handed is already finished", async () => {
    const f = await fixture({ seed: true });
    f.store.transitionRun("seed", "VERIFYING");
    f.store.transitionRun("seed", "DONE");
    const before = f.specs.length;

    await f.internals.driveRun("seed");

    // The verification tail belongs to a run in review. A finished run driven
    // again — `charrette resume` on a run that already ended — must not
    // re-publish, re-verify or re-deliver anything.
    expect(f.store.getRun("seed")!.state).toBe("DONE");
    expect(f.specs).toHaveLength(before);
    expect(f.github.mergeApprovedPR).not.toHaveBeenCalled();
  });

  it("finishes a release from VERIFYING rather than starting the run over", async () => {
    const f = await fixture({ seed: true });
    f.store.transitionRun("seed", "VERIFYING");
    const before = f.specs.length;

    await f.internals.driveRun("seed");

    // Nothing merged it, so the release is not complete — and a run that is not
    // EXECUTING is not re-driven on the way out. Dispatching from here would
    // rebuild work that is already on the branch the release PR carries.
    expect(f.store.getRun("seed")!.state).not.toBe("DONE");
    expect(f.specs.slice(before).some((s) => s.role === "worker")).toBe(false);
  });
});
