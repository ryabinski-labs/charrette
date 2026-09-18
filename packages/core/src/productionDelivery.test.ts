import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig, RunSpec } from "@charrette/shared";
import { acceptanceVerdict, passedScenarios } from "./acceptance.js";
import { deploymentProblems, deployedRevision, deliveryConfigProblems, productionPlanInstructions, releaseSpecProblems, sourceDigest } from "./productionDelivery.js";
import { scopeLedger, scopeUnmet, replanDrops, type ScopedTask } from "./scopeLedger.js";
import { Store } from "./store.js";
import { prodValidatorSystemPrompt } from "./prompts.js";

export const releaseSpec = () => RunSpec.parse({
  feature: "counter", requirements: [{ id: "R-1", text: "Read the durable counter", priority: "P0" }],
  scenarios: [{ id: "SC-1", requirement: "R-1", level: "acceptance", priority: "P0", oracle: "GET /counter returns the persisted value" }],
  commands: { all: "node --test acceptance.test.cjs", byId: "node --test --test-name-pattern '{{ids}}' acceptance.test.cjs" },
  criticalPath: { name: "read counter", steps: ["Request the counter", "Observe its value"] },
  release: { deploymentChecks: ["deploy-production"], productionCommand: "node --test production.test.cjs", productionScenarioIds: ["SC-1"], environment: "One service with durable storage" },
});

describe("production release prerequisites", () => {
  it("requires explicit production mode, target and non-bypassable gates", () => {
    expect(deliveryConfigProblems(RunConfig.parse({}))).toEqual([]);
    expect(deliveryConfigProblems(RunConfig.parse({ delivery: { merge: "auto" } }))).toHaveLength(1);
    expect(deliveryConfigProblems(RunConfig.parse({ delivery: { productionTestScope: "test tenant" } }))).toHaveLength(1);
    expect(deliveryConfigProblems(RunConfig.parse({ delivery: { mode: "production" } }))).toEqual([expect.stringContaining("prodUrl")]);
    const config = RunConfig.parse({ prodUrl: "https://app.example", delivery: { mode: "production" } });
    expect(deliveryConfigProblems(config)).toEqual([]);
    expect(deliveryConfigProblems({ ...config, spec: { ...config.spec, requireExecutionEvidence: false }, live: { ...config.live, enabled: false }, prMode: "per-task" })).toHaveLength(3);
    for (const prodUrl of ["file:///tmp/app", "https://user:secret@app.example", "https://app.example?token=x", "oops"]) expect(deliveryConfigProblems({ ...config, prodUrl })).not.toEqual([]);
    expect(productionPlanInstructions(config)).toContain("read-only");
    expect(productionPlanInstructions({ ...config, delivery: { ...config.delivery, productionTestScope: "test tenant" } })).toContain("test-data writes only within test tenant");
    expect(deliveryConfigProblems({ ...config, delivery: { ...config.delivery, revisionPath: "//another.example/revision" } })).toEqual([expect.stringContaining("origin")]);
    expect(productionPlanInstructions(RunConfig.parse({}))).toBe("");
  });

  it("requires behavioral production coverage and rejects blocked or incomplete scope", () => {
    expect(releaseSpecProblems(null)).not.toEqual([]);
    expect(releaseSpecProblems(RunSpec.parse({ feature: "empty" }))).toHaveLength(6);
    const spec = releaseSpec();
    expect(releaseSpecProblems(spec)).toEqual([]);
    spec.requirements[0]!.blockedBy = ["OQ-1"];
    spec.scenarios[0]!.blocked = true;
    spec.scenarios[0]!.oracle = "";
    spec.scenarios[0]!.level = "unit";
    expect(releaseSpecProblems(spec)).toEqual(expect.arrayContaining([expect.stringContaining("OQ-1"), expect.stringContaining("no behavioral"), expect.stringContaining("no production"), expect.stringContaining("no observable"), expect.stringContaining("unanswered")]));
    spec.scenarios.push({ ...spec.scenarios[0]!, requirement: "missing" });
    spec.release.productionScenarioIds.push("SC-unknown");
    expect(releaseSpecProblems(spec)).toEqual(expect.arrayContaining([expect.stringContaining("unique"), expect.stringContaining("SC-unknown"), expect.stringContaining("names no requirement")]));
  });

  it("does not hide unresolved questions or a second missing behavioral scenario", () => {
    const spec = releaseSpec();
    spec.requirements.push({ ...spec.requirements[0]!, id: "R-2", priority: "P1" }, { ...spec.requirements[0]!, id: "R-3", priority: "P2" });
    spec.scenarios.push({ ...spec.scenarios[0]!, id: "SC-2", priority: "P1" }, { ...spec.scenarios[0]!, id: "SC-optional", priority: "P2" });
    spec.openQuestions = [{ id: "OQ-1", question: "Which target?", detail: "", blocks: ["R-2"] }];
    spec.notCovered = ["Disaster recovery is not tested"];
    const problems = releaseSpecProblems(spec);
    expect(problems).toContain("the specification leaves release scope uncovered: Disaster recovery is not tested");
    expect(problems).toContain("OQ-1: Which target? is unanswered");
    expect(problems).toContain("R-2 has no required scenario");
    expect(problems).toContain("SC-2 is a required acceptance scenario missing from production validation");
  });

  it("pins the whole release across runs and refuses narrower replacements", () => {
    const store = new Store(":memory:");
    try {
      const spec = releaseSpec();
      const digest = sourceDigest("full PRD");
      store.bindRelease("ga", digest, "full PRD", spec, "first");
      store.bindRelease("ga", digest, "full PRD", spec, "second");
      expect(store.releaseContract("ga")?.runId).toBe("first");
      expect(store.releaseContract("missing")).toBeNull();
      expect(store.productionEvidence("missing")).toBeNull();
      expect(() => store.bindRelease("ga", sourceDigest("smaller PRD"), "smaller PRD", spec, "third")).toThrow("different contract");
      expect(() => store.bindRelease("ga", digest, "full PRD", { ...spec, scenarios: [] }, "third")).toThrow("different contract");
    } finally { store.db.close(); }
  });

  it("requires named successful deployment jobs on the exact merged SHA", () => {
    const checks = { state: "passing" as const, total: 1, failing: [], sha: "merged", successful: ["build"] };
    expect(deploymentProblems(null, ["deploy"], "merged")).not.toEqual([]);
    expect(deploymentProblems(checks, ["deploy"], "merged")).toEqual([expect.stringContaining("missing, skipped or failed")]);
    expect(deploymentProblems({ ...checks, successful: ["deploy"] }, ["deploy"], "merged")).toEqual([]);
    expect(deploymentProblems({ ...checks, state: "pending", successful: ["deploy"] }, ["deploy"], "another")).toHaveLength(2);
    expect(deploymentProblems({ ...checks, names: ["deploy", "deploy"], successful: ["deploy"] }, ["deploy"], "merged")).toHaveLength(1);
    expect(deploymentProblems({ ...checks, names: ["deploy", "deploy"], successful: ["deploy", "deploy"] }, ["deploy"], "merged")).toEqual([]);
    expect(deploymentProblems({ ...checks, successful: undefined }, ["deploy"], "merged")).toHaveLength(1);
    expect(deploymentProblems({ ...checks, successful: ["deploy"], unavailable: true }, ["deploy"], "merged")).toEqual([expect.stringContaining("could be read")]);
  });
});

describe("positive scenario execution evidence", () => {
  it("keeps the explicit review-only legacy override separate from production policy", () => {
    expect(acceptanceVerdict(releaseSpec(), { exitCode: 0, output: "" }, false).verdict).toBe("green");
    expect(prodValidatorSystemPrompt("", "", "charrette test tenant")).toContain("writes ONLY in this isolated scope: charrette test tenant");
  });
  it.each(["", "0 tests", "ok 1 - SC-1 # SKIP unavailable", "ok 1 - SC-1 # TODO later", "✓ SC-10", "✓ SC-1\nFAIL SC-1"]) ("rejects an exit-zero suite without unambiguous evidence: %s", (output) => {
    expect(acceptanceVerdict(releaseSpec(), { exitCode: 0, output }).verdict).toBe("red");
  });
  it.each(["✓ SC-1", "\u001b[32m✔ SC-1\u001b[0m", "ok 1 - SC-1", "test_SC-1 PASSED", "--- PASS: SC-1", "test SC-1 ... ok"]) ("accepts explicit supported runner evidence: %s", (output) => {
    expect(passedScenarios(output, ["SC-1"])).toEqual(["SC-1"]);
    expect(acceptanceVerdict(releaseSpec(), { exitCode: 0, output }).verdict).toBe("green");
    expect(acceptanceVerdict(releaseSpec(), { exitCode: 1, output }).verdict).toBe("red");
  });
  it("does not lose part of a requirement when another scenario merged", () => {
    const spec = releaseSpec();
    spec.scenarios.push({ ...spec.scenarios[0]!, id: "SC-2" });
    const tasks: ScopedTask[] = [
      { id: "read", title: "read", scenarioIds: ["SC-1"], state: "MERGED", why: "" },
      { id: "restart", title: "restart", scenarioIds: ["SC-2"], state: "CANCELLED", why: "too hard" },
    ];
    expect(scopeLedger(spec, tasks).dropped.map((r) => r.id)).toEqual(["R-1"]);
    tasks[1]!.state = "PENDING";
    expect(scopeUnmet(scopeLedger(spec, tasks))).toEqual([expect.stringContaining("still in progress")]);
    expect(replanDrops(spec, [{ ...tasks[1]!, scenarioIds: ["UNKNOWN"] }], [])).toEqual([]);
    expect(replanDrops(spec, tasks, [{ id: "read-again", scenarioIds: ["SC-1"] }])).toEqual([expect.stringContaining("R-1")]);
    tasks[1]!.state = "MERGED";
    expect(scopeLedger(spec, tasks).shipped).toBe(1);
  });
});

describe("controller-owned network identity check", () => {
  const servers: Server[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())); });
  async function endpoint(body: string, status = 200, headers = {}) {
    const server = createServer((_req, res) => { res.writeHead(status, headers); res.end(body); }).listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  it("verifies a real HTTP response and rejects an old otherwise healthy deployment", async () => {
    const url = await endpoint(JSON.stringify({ revision: "full-merged-sha" }));
    expect((await deployedRevision(url, "/.well-known/charrette-release", "full-merged-sha")).ok).toBe(true);
    expect((await deployedRevision(url, "/.well-known/charrette-release", "new-sha")).ok).toBe(false);
    expect((await deployedRevision(url, "//example.invalid/escape", "new-sha")).ok).toBe(false);
    expect((await deployedRevision(url, "/revision", "")).ok).toBe(false);
    expect((await deployedRevision("invalid-url", "/revision", "sha")).ok).toBe(false);
  });
  it("rejects HTTP failures, redirects, oversized bodies, and malformed JSON", async () => {
    for (const url of [await endpoint("down", 503), await endpoint("", 204), await endpoint("", 302, { location: "https://example.invalid" }), await endpoint("x".repeat(8193)), await endpoint("not-json")]) {
      expect((await deployedRevision(url, "/revision", "sha")).ok).toBe(false);
    }
  });
});
