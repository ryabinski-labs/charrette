/**
 * Which company's API answers for a given model, and which roles are not
 * allowed to leave Anthropic.
 *
 * The harness has always stored a model as a plain string — `models.worker`
 * is `"claude-sonnet-5"`, not an object with a provider field — and runs
 * already recorded carry those strings in their frozen config. So the provider
 * is *derived* from the name rather than configured beside it: every existing
 * run keeps working, and pointing a role at another vendor stays a one-word
 * edit. `openai/gpt-5.6-terra` is accepted too, for the day a model name does
 * not announce its family.
 */

export const Provider = ["anthropic", "openai", "google"] as const;
export type Provider = (typeof Provider)[number];

/**
 * Families, longest-lived first. Anthropic is also the fallback for a name
 * that matches nothing: the harness spoke only to Anthropic until now, and an
 * unrecognised string reaching the SDK is the behaviour every prior run had.
 */
const FAMILIES: [RegExp, Provider][] = [
  [/^claude[-.]/i, "anthropic"],
  [/^(gpt|o[1-9]|chatgpt)[-.]/i, "openai"],
  [/^gemini[-.]/i, "google"],
];

const EXPLICIT = new Set<string>(Provider);

/**
 * Split `openai/gpt-5.6-terra` into its parts, or infer the vendor from a bare
 * model name. The separator may be `/` or `:` — both read naturally and both
 * appear in other tools' config.
 */
export function splitModel(model: string): { provider: Provider; id: string } {
  const sep = model.search(/[/:]/);
  if (sep > 0) {
    const head = model.slice(0, sep).toLowerCase();
    if (EXPLICIT.has(head)) return { provider: head as Provider, id: model.slice(sep + 1) };
  }
  for (const [re, provider] of FAMILIES) if (re.test(model)) return { provider, id: model };
  return { provider: "anthropic", id: model };
}

/** Which vendor's API this model name routes to. */
export function providerFor(model: string): Provider {
  return splitModel(model).provider;
}

/** The model id to send on the wire, with any `provider/` prefix removed. */
export function modelId(model: string): string {
  return splitModel(model).id;
}

/**
 * Roles that must run on Anthropic, and the reason each one is pinned.
 *
 * Two different kinds of reason, deliberately kept in one list because they
 * have the same consequence for the operator — the run will not start:
 *
 *   - Policy. `qa`, `reviewer` and `prod` are the roles whose verdicts gate a
 *     merge or end a run. A model that judges its own tier of work is the one
 *     place where saving money buys a quieter failure rather than a cheaper
 *     one: a weaker judge does not report that it judged worse, it reports
 *     PASS. The operator's decision was that the judges stay on the model
 *     their thresholds were calibrated against.
 *   - Capability. `intake` asks the operator questions through an in-process
 *     MCP tool (see intake.ts). That tool exists only on the SDK transport, so
 *     an intake session on another vendor could not ask anything — it would
 *     silently invent the answers instead, which is exactly the failure that
 *     shipped fakes in run 40da9337.
 *
 * There is no config knob to unpin these, for the same reason infraGuard has
 * none: a flag that switches a control off is a flag a task spec can talk
 * somebody into setting.
 */
export const PINNED_ROLES: Record<string, string> = {
  qa: "its verdict decides whether a task merges, and a weaker judge reports PASS rather than reporting that it judged worse",
  reviewer: "it is the judgment a pit stop exists to buy — whether the run is still building the right thing",
  prod: "it is the last word on whether the run delivered the assignment",
  intake: "it asks the operator questions through an in-process tool that only the Anthropic transport can expose",
};

/**
 * Which role→model assignments a run config may not have. Returns one sentence
 * per violation, ready to show the operator; an empty array means the routing
 * is allowed.
 *
 * Checked when the config is parsed rather than when the role is dispatched:
 * an intake typo that only surfaces at the `prod` validator would be found
 * after the whole run had been paid for.
 */
export function routingViolations(models: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [role, why] of Object.entries(PINNED_ROLES)) {
    const model = models[role];
    if (model === undefined) continue;
    const provider = providerFor(model);
    if (provider === "anthropic") continue;
    out.push(`models.${role} is pinned to Anthropic but is set to "${model}" (${provider}): ${why}.`);
  }
  return out;
}
