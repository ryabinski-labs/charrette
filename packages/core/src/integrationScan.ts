import { PlannedTask } from "@harness/shared";

/**
 * Which integrations this plan intends to build for real, and which it intends
 * to fake — read off the acceptance criteria, before a worker is paid.
 *
 * Run 40da9337 was asked to "fully implement this product, including all the
 * integrations". It shipped 36 merged tasks and six of seven vendors as
 * `throw liveProviderNotConfigured(...)`, and every one of those tasks passed QA
 * correctly, because the plan's own criteria are what QA checks and the plan's
 * own criteria asked for mocks:
 *
 *   provider-layer      "All seven vendor categories have an interface and a
 *                        deterministic mock"
 *   plaid-integration   "The suite makes no outbound HTTP call"
 *
 * Nothing was broken. The plan promised fakes and the run delivered fakes. The
 * only place that gap was ever visible was the plan gate, and the plan gate
 * said nothing about it — so this is what it says now.
 *
 * This reads text, so it is a prompt for the operator's judgment, not a verdict.
 * It never blocks a plan.
 */

/** An affirmative commitment to a test double as the deliverable. */
const FAKE = /\b(mock|fake|stub|test double|in-memory (?:client|provider|adapter))\b|\bno (?:outbound|external|network) (?:http |api )?(?:call|request)/i;

/** An affirmative commitment to the real thing, in any of the forms that count. */
const LIVE =
  /\b(sandbox|test mode|test-mode|live (?:credential|call|client|provider|key)|real (?:vendor|api|http|request|client)|production api|recorded (?:fixture|response|cassette)|contract test|golden (?:file|response))\b/i;

/** The planner's explicit, operator-visible scope decision. */
const DECLARED = /live is out of scope because/i;

/** Task shapes whose whole job is to talk to something outside the process. */
const INTEGRATION = /\b(integrations?|vendors?|providers?|third[- ]party|api clients?|sdk|gateways?|webhook delivery)\b/i;

export type IntegrationVerdict = "live" | "declared-fake" | "silent-fake" | "undeclared";

export interface IntegrationFinding {
  id: string;
  title: string;
  verdict: IntegrationVerdict;
  /** The criterion or spec sentence the verdict was read from, for the operator to check. */
  evidence: string;
}

/**
 * Classify every task that looks like it talks to an external service.
 *
 * `live` tasks are not returned — the point of the report is what the operator
 * might not expect, and a plan that builds the real thing is what they asked for.
 */
export function scanIntegrations(tasks: PlannedTask[]): IntegrationFinding[] {
  const findings: IntegrationFinding[] = [];
  for (const t of tasks) {
    const criteria = t.acceptanceCriteria;
    const fakeCriterion = criteria.find((c) => FAKE.test(c));
    const liveCriterion = criteria.find((c) => LIVE.test(c));
    const declared = DECLARED.test(t.spec);
    const looksExternal = INTEGRATION.test(`${t.title} ${t.spec}`);

    // A criterion pinning the real path settles it, whatever else is alongside.
    // Mocks and a sandbox test in the same task is a well-built integration.
    if (liveCriterion) continue;

    if (declared) {
      findings.push({ id: t.id, title: t.title, verdict: "declared-fake", evidence: declaredReason(t.spec) });
    } else if (fakeCriterion) {
      // The 40da9337 shape: the criteria commit to a double and nothing commits
      // to the vendor, so the task is complete the moment the double exists.
      findings.push({ id: t.id, title: t.title, verdict: "silent-fake", evidence: fakeCriterion });
    } else if (looksExternal) {
      // Says neither. Nothing will make the worker build the live path, and
      // nothing will make QA notice it did not. The plan schema guarantees at
      // least one criterion, so there is always something to quote.
      findings.push({ id: t.id, title: t.title, verdict: "undeclared", evidence: criteria[0]! });
    }
  }
  return findings;
}

/** The planner's sentence, trimmed to the reason. */
function declaredReason(spec: string): string {
  const m = /live is out of scope because[^.]*\./i.exec(spec);
  return m ? m[0].trim() : "live is out of scope";
}

/**
 * The plan-gate paragraph. Empty when every external task pins the real path,
 * because a gate that always prints a warning is a gate nobody reads.
 */
export function renderIntegrations(findings: IntegrationFinding[]): string {
  if (!findings.length) return "";
  const lines: string[] = ["External services — what this plan will actually talk to:"];
  const say = (verdict: IntegrationVerdict, heading: string) => {
    const rows = findings.filter((f) => f.verdict === verdict);
    if (!rows.length) return;
    lines.push(`  ${heading}`);
    for (const r of rows) lines.push(`    ${r.id} — ${r.title}\n      ${r.evidence.slice(0, 160)}`);
  };
  say("silent-fake", "Built as a test double, with nothing in the criteria that reaches the vendor:");
  say("undeclared", "Says neither. A worker will read these as satisfied by whatever is easiest:");
  say("declared-fake", "Deliberately not live, and the plan says why:");
  lines.push(
    "",
    "A task is finished when its criteria are met, so a criterion that no vendor call",
    "can fail is a task that ships without one. If any of the above should reach a real",
    "sandbox, reject the plan and say so — it is far cheaper here than after the merge."
  );
  return lines.join("\n");
}
