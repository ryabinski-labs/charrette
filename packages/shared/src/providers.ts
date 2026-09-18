/**
 * Which company's API answers for a given model, and which roles are not
 * allowed to leave Anthropic.
 *
 * The charrette has always stored a model as a plain string — `models.worker`
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
 * that matches nothing: the charrette spoke only to Anthropic until now, and an
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

/** The vendor's own name, for a message an operator reads. */
const VENDOR_NAME: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

/**
 * Roles whose vendor is not the operator's to choose — and, per `JUDGING_FLOOR`
 * below, not that vendor's small tier either. One list, because every entry has
 * the same consequence for the operator: the run will not start.
 *
 * Three kinds of reason, deliberately kept together:
 *
 *   - Policy, pinned to Anthropic. `qa` and `prod` are the roles whose verdicts
 *     gate a merge or end a run. A model that judges its own tier of work is
 *     the one place where saving money buys a quieter failure rather than a
 *     cheaper one: a weaker judge does not report that it judged worse, it
 *     reports PASS. These stay on the model their thresholds were calibrated
 *     against.
 *   - Policy, pinned to Google. `reviewer` reads the built product through one
 *     named lens and says whether the run is still building the right thing.
 *     Every line it is judging was written by an Anthropic worker, and a judge
 *     drawn from the same family as the author shares the author's blind spots
 *     — it is fluent in exactly the reasoning that produced the work, so the
 *     failure it is least likely to name is the one the whole pit stop exists
 *     to catch. A second vendor is the cheapest independence available: it
 *     costs one API key and buys an opinion whose errors are uncorrelated with
 *     the ones already in the diff. `qa` and `prod` do not move with it because
 *     their thresholds are calibrated and their verdicts are mechanical
 *     (criteria against a diff); the reviewer's judgment is the open-ended one,
 *     which is both why independence helps it most and why nothing downstream
 *     depends on its wording.
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
export const PINNED_ROLES: Record<string, { provider: Provider; why: string }> = {
  qa: {
    provider: "anthropic",
    why: "its verdict decides whether a task merges, and a weaker judge reports PASS rather than reporting that it judged worse",
  },
  reviewer: {
    provider: "google",
    why: "it is the judgment a pit stop exists to buy — whether the run is still building the right thing — and it is held off the family that wrote the code so its errors are uncorrelated with the ones already in the diff",
  },
  prod: {
    provider: "anthropic",
    why: "it is the last word on whether the run delivered the assignment",
  },
  intake: {
    provider: "anthropic",
    why: "it asks the operator questions through an in-process tool that only the Anthropic transport can expose",
  },
};

/**
 * The small tier of each pinned vendor, refused for the roles above.
 *
 * `PINNED_ROLES` was written to stop a judging role changing *company*, and for
 * most of its life that was the same thing as stopping it getting weaker —
 * every Anthropic model the charrette routed to was Sonnet or Opus. Pointing
 * `demo` and `repair` at Haiku ended that: `models.qa = "claude-haiku-4-5-…"`
 * is an Anthropic model, so the vendor check waved it through, and the guard
 * whose entire stated reason is "a weaker judge reports PASS rather than
 * reporting that it judged worse" permitted exactly that. Pinning `reviewer` to
 * Google reopens the same hole on the other side — `gemini-3.5-flash-lite` is a
 * Google model — so the floor is per vendor rather than a single regex.
 *
 * Matched on the family word rather than on a list of ids, so a future
 * `claude-haiku-5` or `gemini-4-flash-lite` is refused the day it exists rather
 * than the day somebody remembers to add it. Only reached for models that
 * already passed the vendor check, which is what makes a bare family word
 * enough to go on: within Anthropic "haiku" names the small tier and has since
 * the first one, and within Gemini "lite" does the same. Note that this is why
 * the floor is `lite` and not `flash` — Flash is the mid tier Gemini actually
 * ships a judging-capable model in, and `models.reviewer` points at one.
 *
 * The cost of being wrong here is asymmetric in the same direction as
 * modelTier.ts: a refusal the operator disagrees with is a one-line config
 * error at `charrette run`, and a permission it should not have granted is a
 * merge nobody caught.
 */
const JUDGING_FLOOR: Partial<Record<Provider, { below: RegExp; instead: string }>> = {
  anthropic: { below: /haiku/i, instead: "Point it at a Sonnet or Opus model." },
  google: { below: /lite/i, instead: "Point it at a Flash or Pro model." },
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
  for (const [role, pin] of Object.entries(PINNED_ROLES)) {
    const model = models[role];
    if (model === undefined) continue;
    const provider = providerFor(model);
    if (provider !== pin.provider) {
      out.push(`models.${role} is pinned to ${VENDOR_NAME[pin.provider]} but is set to "${model}" (${provider}): ${pin.why}.`);
      continue;
    }
    const floor = JUDGING_FLOOR[provider];
    if (floor && floor.below.test(modelId(model))) {
      out.push(
        `models.${role} is set to "${model}", which is below the capability floor for a judging role: ${pin.why}. ` + floor.instead
      );
    }
  }
  return out;
}
