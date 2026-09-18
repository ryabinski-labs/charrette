import { createHash } from "node:crypto";
import { blockingQuestions, type RunConfig, type RunSpec } from "@charrette/shared";
import type { PrChecks } from "./github.js";

export const sourceDigest = (text: string): string => createHash("sha256").update(text).digest("hex");
export const required = (r: { priority: string }): boolean => r.priority === "P0" || r.priority === "P1";

export function deliveryConfigProblems(config: RunConfig): string[] {
  if (config.delivery.mode !== "production") {
    return [config.delivery.merge === "auto" ? "automatic merge requires production delivery mode" : "",
      config.delivery.productionTestScope ? "production test-write authority requires production delivery mode" : ""].filter(Boolean);
  }
  const problems: string[] = [];
  try {
    const url = new URL(config.prodUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error();
    if (new URL(config.delivery.revisionPath, url).origin !== url.origin) problems.push("the revision endpoint must use the production origin");
  } catch { problems.push("production delivery requires a prodUrl using HTTP(S), without credentials, query or fragment"); }
  if (!config.spec.enabled || !config.spec.requireExecutionEvidence) problems.push("production delivery requires the specification and execution-evidence gates");
  if (!config.live.enabled || !config.holdUntilProven || !config.holdUntilGreen || !config.waitForChecks) problems.push("production delivery requires live verification, holdUntilProven, holdUntilGreen and waitForChecks");
  if (config.prMode !== "single") problems.push("production delivery requires a single rollup PR");
  return problems;
}

/** No planner can remove a promise by omitting its scenarios. */
export function releaseSpecProblems(spec: RunSpec | null): string[] {
  if (!spec) return ["the release has no executable specification"];
  const problems: string[] = [];
  const requirements = spec.requirements.filter(required);
  for (const gap of spec.notCovered) problems.push(`the specification leaves release scope uncovered: ${gap}`);
  for (const question of blockingQuestions(spec)) problems.push(`${question.id}: ${question.question} is unanswered`);
  if (!requirements.length) problems.push("the release has no required capabilities");
  if (!spec.criticalPath.steps.length) problems.push("the release has no critical path");
  if (!spec.commands.all.trim()) problems.push("the release has no acceptance command");
  if (!spec.release.environment.trim()) problems.push("the release has no declared deployment topology");
  if (!spec.release.deploymentChecks.length) problems.push("the release names no deployment CI checks");
  if (!spec.release.productionCommand.trim()) problems.push("the release has no production validation command");
  const scenarioIds = new Set(spec.scenarios.map((s) => s.id));
  if (scenarioIds.size !== spec.scenarios.length || new Set(spec.requirements.map((r) => r.id)).size !== spec.requirements.length) problems.push("release requirement and scenario IDs must be unique");
  for (const id of spec.release.productionScenarioIds) {
    if (!scenarioIds.has(id)) problems.push(`production scenario ${id} is not in the specification`);
  }
  for (const r of requirements) {
    if (r.blockedBy.length) problems.push(`${r.id} is blocked on ${r.blockedBy.join(", ")}`);
    const scenarios = spec.scenarios.filter((s) => s.requirement === r.id && required(s));
    if (!scenarios.length) problems.push(`${r.id} has no required scenario`);
    if (!scenarios.some((s) => s.level === "acceptance")) problems.push(`${r.id} has no behavioral acceptance scenario`);
    if (!scenarios.some((s) => s.level === "acceptance" && spec.release.productionScenarioIds.includes(s.id))) problems.push(`${r.id} has no production validation scenario`);
  }
  for (const s of spec.scenarios.filter(required)) {
    if (s.level === "acceptance" && !spec.release.productionScenarioIds.includes(s.id)) problems.push(`${s.id} is a required acceptance scenario missing from production validation`);
    if (!spec.requirements.some((r) => r.id === s.requirement)) problems.push(`${s.id} names no requirement`);
    if (!s.oracle.trim()) problems.push(`${s.id} has no observable oracle`);
    // Blocked questions remain visible and cannot become successful evidence.
    if (s.blocked) problems.push(`${s.id} is blocked on an unanswered question`);
  }
  return problems;
}

export function deploymentProblems(checks: PrChecks | null, expected: string[], sha: string): string[] {
  if (!checks) return ["deployment checks could not be read"];
  const problems: string[] = [];
  if (checks.sha !== sha) problems.push("deployment checks are not bound to the merged revision");
  if (checks.unavailable) problems.push("not all deployment check sources could be read");
  if (checks.state !== "passing") problems.push(`deployment checks are ${checks.state}`);
  for (const name of new Set(expected)) {
    const needed = Math.max(expected.filter((n) => n === name).length, checks.names?.filter((n) => n === name).length ?? 0);
    if ((checks.successful?.filter((n) => n === name).length ?? 0) < needed) problems.push(`deployment check ${name} has not succeeded (missing, skipped or failed)`);
  }
  return problems;
}

/** The network reading comes from the controller, independently of the reviewing agent. */
export async function deployedRevision(prodUrl: string, revisionPath: string, expectedSha: string): Promise<{ ok: boolean; why: string }> {
  try {
    const base = new URL(prodUrl);
    const endpoint = new URL(revisionPath, base);
    if (endpoint.origin !== base.origin) return { ok: false, why: "the revision endpoint must use the production origin" };
    if (!expectedSha) return { ok: false, why: "the merged revision is unknown" };
    const response = await fetch(endpoint, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { "cache-control": "no-cache" } });
    if (!response.ok) return { ok: false, why: `the production revision endpoint returned HTTP ${response.status}` };
    let body = "";
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, why: "the production revision response is empty" };
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 8192) { await reader.cancel(); return { ok: false, why: "the production revision response exceeds 8 KiB" }; }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    const value = JSON.parse(body) as { revision?: string };
    return value.revision === expectedSha
      ? { ok: true, why: `production serves ${expectedSha}` }
      : { ok: false, why: "production is serving an unknown or different revision" };
  } catch { return { ok: false, why: "the production revision endpoint is unavailable or returned invalid JSON" }; }
}

export function productionPlanInstructions(config: RunConfig): string {
  if (config.delivery.mode !== "production") return "";
  return `\nProduction delivery contract (${config.delivery.releaseId}):\n` +
    `The destination is ${config.prodUrl}. A pull request is an intermediate result. The run must deploy the merged commit and validate every required capability there.\n` +
    `Production test authority: ${config.delivery.productionTestScope ? `test-data writes only within ${config.delivery.productionTestScope}; never real payments, outbound messages, customer data or infrastructure changes` : "read-only; mutation-dependent checks require the operator to declare an isolated production test scope"}.\n` +
    `Build the packaging and CI deployment workflow, using the operator's established deployment credentials and target. Name its exact successful check names in release.deploymentChecks. No new paid resource or account is authorized by this mode; surface missing access as a prerequisite.\n` +
    `Serve JSON {"revision":"<full deployed git SHA>"} at ${config.delivery.revisionPath}, populated by the deployment workflow from the actual build revision. Never hardcode a guessed SHA.\n` +
    `In the specification, populate release.environment, release.productionCommand and release.productionScenarioIds. Every P0/P1 requirement needs behavioral acceptance scenarios, and every required acceptance scenario must be validated in production. The command receives CHARRETTE_PROD_URL and CHARRETTE_DEPLOY_SHA. It must test the deployed service, print each scenario ID and its pass/fail result, and fail on skipped or unavailable required behavior. Respect the production test authority above; checks requiring unauthorized test writes, destructive failure injection, human trials or unavailable credentials stay blocked until the operator has provided the necessary authority/evidence.\n` +
    `Cover the PRD's durability, recovery, topology, security, load and performance requirements through real acceptance tests in an isolated representative environment; do not substitute a short soak or a single-node topology for a different requirement.\n` +
    `Mark the smallest real end-to-end slice and its prerequisites as skeleton tasks. It will be exercised before other tasks can start. Deferral or documentation does not satisfy a requirement.\n`;
}
