import { PlannedTask } from "@charrette/shared";

/**
 * The dimensions of a production application that a plan can simply not have a
 * task for — read off the plan, before a worker is paid.
 *
 * `integrationScan` catches the plan that owns an integration and defines it as
 * a mock. This catches the plan that owns it nowhere at all, which is the other
 * way run 40da9337's product came out shy of the assignment: the brief said
 * "production", 36 tasks merged, and nothing in the plan was ever going to
 * produce a deployment, a login, or a designed screen. Each of those was an
 * hour of somebody's surprise at the end of a two-day run.
 *
 * Demand-driven, in both directions:
 *
 *   demand   what the assignment and the PRD actually ask for
 *   supply   the task that would produce it
 *
 * A finding needs demand and no supply. A library that never says "deploy" has
 * no deployment gap, and this reports nothing at all for it — which matters more
 * than catching every case, because a gate that prints a paragraph on every plan
 * is a gate the operator learns to scroll past.
 *
 * This reads text. It is a prompt for the operator's judgment, not a verdict,
 * and it never blocks a plan. The LLM plan-intent check alongside it is the one
 * that can tell a task that owns a dimension hollowly from one that owns it.
 */

export type Dimension = "deploy" | "security" | "design" | "observability";

interface Probe {
  dimension: Dimension;
  /** What the operator asked for, in the words briefs actually use. */
  demand: RegExp;
  /** Evidence that some task is on the hook for it. Deliberately generous: a
   *  false negative here costs a paragraph, a false positive costs trust. */
  supply: RegExp;
  /** The sentence the operator reads. */
  says: string;
}

const PROBES: Probe[] = [
  {
    dimension: "deploy",
    demand:
      /\b(deploys?|deployed|deployment|deployable|production|infrastructure|terraform|cloudformation|pulumi|kubernetes|hosting|hosted|go[- ]live|ci\/cd)\b/i,
    supply:
      /\b(deploy|terraform|cloudformation|pulumi|helm|kubernetes|k8s|dockerfile|compose|ci\/cd|github actions|workflow file|infrastructure|iac|provision|cdk|serverless\.yml)\b/i,
    says: "Nothing in this plan produces a deployment. Every task can pass on a laptop and the product still has nowhere to run.",
  },
  {
    dimension: "security",
    demand:
      /\b(auth|authn|authz|authentication|authorization|log[- ]?in|sign[- ]?in|sign[- ]?up|account|permissions?|roles?|rbac|multi[- ]tenant|tenancy|secrets?|credentials?|pii|gdpr|soc ?2|hipaa|pci)\b/i,
    supply:
      /\b(auth|login|log in|session|token|jwt|oauth|passkey|password|permission|role|rbac|tenant|secret|credential|encrypt|csrf|rate[- ]limit)\b/i,
    says: "No task owns authentication or authorization. Whatever this ships is open to whoever finds the URL.",
  },
  {
    dimension: "design",
    demand: /\b(ui|ux|front[- ]?end|interface|design|designed|look and feel|branding|brand|responsive|graphics|visual|screens?)\b/i,
    supply:
      /\b(design system|style guide|styles?|visual|mockup|wireframe|component library|css|tailwind|layout|responsive|figma|palette|typography|renders?|screen|page)\b/i,
    says: "No task owns how it looks. A working UI with no design task is a default-styled one, and that is what will ship.",
  },
  {
    dimension: "observability",
    demand: /\b(monitor(?:ing|ed)?|observability|alert(?:s|ing)?|logging|metrics|tracing|on[- ]call|uptime|sentry|datadog)\b/i,
    supply: /\b(log|logging|metric|trace|tracing|monitor|alert|health ?check|readiness|sentry|datadog|opentelemetry|otel|prometheus)\b/i,
    says: "Nothing makes failure visible. When this breaks in production the first report will come from a user.",
  },
];

export interface ProductionFinding {
  dimension: Dimension;
  /** The word in the brief that asked for it, so the operator can judge the match. */
  asked: string;
  says: string;
}

/**
 * Dimensions the brief asks for that no task in the plan is on the hook for.
 *
 * The whole plan is one haystack for supply: it does not matter which task owns
 * the deployment, only that some task does. Splitting a dimension across tasks
 * is normal and correct, and asking "which one owns it" would report a gap on
 * plans that have none.
 */
export function scanProduction(brief: string, tasks: PlannedTask[]): ProductionFinding[] {
  const plan = tasks.map((t) => `${t.title} ${t.spec} ${t.acceptanceCriteria.join(" ")}`).join("\n");
  const findings: ProductionFinding[] = [];
  for (const probe of PROBES) {
    const asked = probe.demand.exec(brief);
    if (!asked || probe.supply.test(plan)) continue;
    findings.push({ dimension: probe.dimension, asked: asked[0], says: probe.says });
  }
  return findings;
}

/**
 * The plan-gate paragraph. Empty when the plan covers everything the brief asked
 * for, which is the common case and the reason this is worth reading when it is
 * not empty.
 */
export function renderProduction(findings: ProductionFinding[]): string {
  if (!findings.length) return "";
  return [
    "Production shape — asked for in the brief, owned by no task:",
    ...findings.map((f) => `  ${f.dimension} (you said "${f.asked}")\n    ${f.says}`),
    "",
    "Each of these is cheaper to add as a task now than to discover after the merge.",
    "If one is deliberately out of scope, approve and it stays out.",
  ].join("\n");
}
