import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { MAX_NESTING, invocation, rawTokens, segments, stripHeredocBodies, stripQuoted, unquote } from "./shellParse.js";

/**
 * Stop an agent provisioning, mutating or destroying real infrastructure.
 *
 * Agents run with `permissionMode: "bypassPermissions"` — there is no prompt
 * between a command an agent writes and the machine running it. Every guardrail
 * the charrette has around cloud tooling has until now been prose in a system
 * prompt ("READ ONLY", "NEVER `apply`"), which is a request, not a control. For
 * application code that is an acceptable trade: the blast radius is a worktree,
 * and the integration branch is reviewed before anything reaches the operator.
 * Infrastructure has no such property. `terraform destroy` is not a diff someone
 * can decline to merge, and a `kubectl delete` against the operator's live
 * cluster cannot be reverted by parking a task.
 *
 * So the rule that already appears in every infra prompt is enforced here, at
 * the one chokepoint that sees every Bash command an agent runs. The charrette
 * produces reviewed configuration; a human applies it. `terraform plan`,
 * `cdk synth`, `helm template` and `kubectl --dry-run=server` are how the work
 * gets verified, and none of them are blocked.
 *
 * A denial is not a dead end. The agent is told what was blocked, why, and which
 * verb to use instead, so the usual outcome is that it re-runs a `plan` and
 * carries on. There is deliberately no run-config knob to switch this off: the
 * operator's decision was that the charrette produces reviewed configuration and
 * never provisions, and a flag that turns a safety control off is a flag an
 * agent's task spec can talk somebody into setting. The `allow` parameter below
 * exists so the seam is testable, and is never passed by the charrette.
 *
 * Conservative by construction: an unrecognised command is always allowed — this
 * denies a known-dangerous list rather than permitting a known-safe one. What it
 * does read carefully is the shape of the invocation, because the interesting
 * command is often not the first word: `bash -c "cd infra && terraform apply"`
 * and `timeout 600 terraform apply` are both an apply, and the body of a
 * `<<EOF` heredoc writing a deployment runbook is neither.
 *
 * The honest limit: indirection through a file it cannot read — `./deploy.sh`,
 * `make release`, an npm script — is not caught. Prompt rules and review cover
 * that; this catches the direct invocation, which is what agents actually write.
 */

type Resolved = { bin: string; words: string[]; flags: string[] } | { inline: string };

/**
 * What a segment actually invokes, split into the verbs and the flags this
 * guard reasons about.
 *
 * Quoted spans are thrown away rather than unquoted: everything here is matched
 * against a fixed vocabulary of verbs and dry-run flags, and a quoted argument
 * is a value — a bucket name, a message, a path — never one of them.
 */
function resolve(segment: string): Resolved | null {
  const found = invocation(segment);
  if (!found || "inline" in found) return found;
  const words: string[] = [];
  const flags: string[] = [];
  for (const t of found.args) {
    const clean = stripQuoted(t).trim();
    if (!clean) continue;
    (clean.startsWith("-") ? flags : words).push(clean);
  }
  return { bin: found.bin, words, flags };
}

const has = (flags: string[], re: RegExp) => flags.some((f) => re.test(f));

/** A dry run is the whole point of these tools — never block one. */
const DRY_RUN = /^--dry-run(=(client|server|none)?)?$|^--validate-only\b|^--what-if\b|^--preview\b/;

/**
 * Whether a command anywhere in this line asks its tool not to do the thing.
 *
 * Exported because this guard is not the only place the answer matters:
 * `repeatable` has to decide whether re-running a command would change
 * anything, and `kubectl --dry-run=server apply` changes nothing however many
 * times it runs. Two regexes for one question is how two guards come to
 * disagree, which is the reason the lexer under them is shared.
 */
export function hasDryRun(command: string): boolean {
  return rawTokens(command).some((t) => DRY_RUN.test(unquote(t)));
}

type Check = (t: { words: string[]; flags: string[] }) => string | null;

const CHECKS: Record<string, Check> = {
  terraform: terraformish,
  tofu: terraformish,
  pulumi: ({ words }) => {
    const verb = words[0];
    if (verb && /^(up|destroy|import|cancel)$/.test(verb)) return `\`pulumi ${verb}\``;
    if (verb === "state" && words[1] === "delete") return "`pulumi state delete`";
    return null;
  },
  cdk: ({ words }) => {
    const verb = words[0];
    return verb && /^(deploy|destroy|bootstrap|import)$/.test(verb) ? `\`cdk ${verb}\`` : null;
  },
  helm: ({ words, flags }) => {
    const verb = words[0];
    if (!verb || !/^(install|upgrade|rollback|uninstall|delete)$/.test(verb)) return null;
    return has(flags, DRY_RUN) ? null : `\`helm ${verb}\``;
  },
  kubectl: ({ words, flags }) => {
    const verb = words[0];
    if (!verb) return null;
    if (/^(apply|create|delete|patch|replace|scale|rollout|edit|annotate|label|drain|cordon|uncordon|taint|set|expose|autoscale)$/.test(verb)) {
      return has(flags, DRY_RUN) ? null : `\`kubectl ${verb}\``;
    }
    // Not a manifest change, but a shell inside a live pod is not a read either.
    if (/^(exec|attach|port-forward|cp)$/.test(verb)) return `\`kubectl ${verb}\``;
    return null;
  },
  aws: ({ words }) => {
    if (words[0] === "s3") {
      const sub = words[1];
      if (sub && /^(rm|mv)$/.test(sub)) return `\`aws s3 ${sub}\``;
      if (sub && /^(cp|sync)$/.test(sub) && words.slice(2).some((w) => w.startsWith("s3://"))) {
        // Only when something is going INTO a bucket; pulling one down is a read.
        const dest = words[words.length - 1];
        if (dest?.startsWith("s3://")) return `\`aws s3 ${sub}\` writing to ${dest}`;
      }
      return null;
    }
    const mutating = words.find((w) => AWS_VERB.test(w));
    return mutating ? `\`aws … ${mutating}\`` : null;
  },
  gcloud: ({ words, flags }) => {
    const verb = words.find((w) => /^(create|delete|update|deploy|import|patch|resize|start|stop|restart|add-iam-policy-binding|remove-iam-policy-binding|set-iam-policy)$/.test(w));
    if (!verb) return null;
    return has(flags, DRY_RUN) ? null : `\`gcloud … ${verb}\``;
  },
  az: ({ words, flags }) => {
    const verb = words.find((w) => /^(create|delete|update|set|start|stop|restart|deploy|purge)$/.test(w));
    if (!verb) return null;
    return has(flags, DRY_RUN) ? null : `\`az … ${verb}\``;
  },
  docker: pushOnly("docker"),
  podman: pushOnly("podman"),
};

/** AWS spells mutation in its verb: `create-bucket`, `terminate-instances`, … */
const AWS_VERB =
  /^(create|delete|put|update|modify|terminate|run|attach|detach|remove|set|start|stop|reboot|associate|disassociate|authorize|revoke|register|deregister|enable|disable|restore|import|publish|invoke|deploy|execute|cancel|reset|rotate|replace|purchase|request)-/;

function terraformish({ words }: { words: string[] }): string | null {
  const verb = words[0];
  if (!verb) return null;
  if (/^(apply|destroy|import|taint|untaint|force-unlock)$/.test(verb)) return `\`terraform ${verb}\``;
  if (verb === "state" && words[1] && /^(mv|rm|push|replace-provider)$/.test(words[1])) return `\`terraform state ${words[1]}\``;
  return null;
}

/** Building an image locally is useful work; publishing one is outward-facing. */
function pushOnly(name: string): Check {
  return ({ words }) => (words[0] === "push" ? `\`${name} push\`` : null);
}

/** Which safe verb to point the agent at, per tool. */
const INSTEAD: Record<string, string> = {
  terraform: "`terraform validate` and `terraform plan`",
  tofu: "`tofu validate` and `tofu plan`",
  pulumi: "`pulumi preview`",
  cdk: "`cdk synth` and `cdk diff`",
  helm: "`helm lint`, `helm template`, or the same command with `--dry-run`",
  kubectl: "`kubectl --dry-run=server`, `kubectl diff`, or a read verb",
  aws: "a describe/list/get call",
  gcloud: "a describe/list call, or `--validate-only`",
  az: "`az … show`/`list`, or `az deployment … what-if`",
  docker: "`docker build` — leave publishing to the operator",
  podman: "`podman build` — leave publishing to the operator",
};

/**
 * What this command would change in the real world, or null if it changes
 * nothing outside the worktree. Every segment of a compound command is checked:
 * `terraform plan && terraform apply` is an apply.
 */
export function infraMutation(command: string, depth = 0): { what: string; instead: string } | null {
  if (depth > MAX_NESTING) return null;
  for (const segment of segments(stripHeredocBodies(command))) {
    const resolved = resolve(segment);
    if (!resolved) continue;
    if ("inline" in resolved) {
      const nested = infraMutation(resolved.inline, depth + 1);
      if (nested) return nested;
      continue;
    }
    const check = CHECKS[resolved.bin];
    if (!check) continue;
    const what = check(resolved);
    // Every tool in CHECKS has an INSTEAD entry today; the fallback is there so
    // adding a check and forgetting the advice degrades the message rather than
    // the denial. Unreachable until someone does exactly that.
    /* v8 ignore start */
    if (what) return { what, instead: INSTEAD[resolved.bin] ?? "the tool's plan or dry-run mode" };
    /* v8 ignore stop */
  }
  return null;
}

/** The refusal an agent reads — what was blocked, why, and what to run instead. */
export function denialReason(m: { what: string; instead: string }): string {
  return `Blocked: ${m.what} changes real infrastructure, and this charrette produces reviewed configuration rather than provisioned resources — an apply cannot be reviewed after the fact, only undone. Run ${m.instead} instead; that is what verifies this work and it is not blocked. If the task genuinely cannot be completed without provisioning, do not try to work around this: say so plainly in your final summary and stop, so the operator can decide.`;
}

/**
 * PreToolUse hook denying commands that would mutate real infrastructure.
 * `allow` short-circuits it for an operator who wants provisioning.
 */
export function infraGuardHook(allow = false) {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (allow) return {};
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
    const command = (input.tool_input as { command?: unknown })?.command;
    if (typeof command !== "string" || !command.trim()) return {};
    const mutation = infraMutation(command);
    if (!mutation) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denialReason(mutation),
      },
    };
  };
}

/** The tools CHECKS knows, as they appear mid-sentence in a criterion's prose. */
const TOOL_WORD = /\b(terraform|tofu|pulumi|cdk|helm|kubectl|aws|gcloud|az|docker|podman)\b/g;

/**
 * The infrastructure mutation a single acceptance criterion names, or null.
 *
 * Backticked spans are tried first and whole — that is how a plan quotes a
 * command, and `terraform destroy` inside one parses exactly as the guard
 * above would see it at run time. The prose around them is then scanned from
 * each tool word to the end of its sentence, so "shows terraform destroy
 * completing" is caught without its surrounding words confusing the parser.
 */
export function criterionMutation(criterion: string): { what: string; instead: string } | null {
  for (const [, span] of criterion.matchAll(/`([^`]+)`/g)) {
    const m = infraMutation(span!);
    if (m) return m;
  }
  const prose = criterion.replace(/`[^`]*`/g, " ");
  for (const hit of prose.matchAll(TOOL_WORD)) {
    const m = infraMutation(prose.slice(hit.index).split(/[.;:!?\n]/, 1)[0]!);
    if (m) return m;
  }
  return null;
}

/**
 * The acceptance criteria in this plan that name a command `infraGuardHook`
 * will deny, found before anything is built.
 *
 * This is the check that ran too late in run bc691359: `tier1-three-arm-capture`
 * required a committed teardown.log "showing `terraform destroy` completing",
 * three workers each rediscovered that no agent session is permitted to run it,
 * and the escalation reached the operator only after all three had spent their
 * attempts. Every fact in that discovery was in the plan on day one — the
 * criterion named the command, and the guard's deny list is right here.
 *
 * Advisory, like everything at the plan gate: a criterion can name a denied
 * command and still be satisfiable — a runbook that documents the teardown
 * step is written, not run. The gap text says both readings so the adjudicator
 * and the operator can tell which one they are looking at, and a re-planned
 * criterion comes back as a hand-off instead of a dead end.
 */
export function unsatisfiableCriteria(tasks: { id: string; acceptanceCriteria: string[] }[]): { taskId: string; criterion: string; what: string }[] {
  const found: { taskId: string; criterion: string; what: string }[] = [];
  for (const task of tasks) {
    for (const criterion of task.acceptanceCriteria) {
      const m = criterionMutation(criterion);
      if (m) found.push({ taskId: task.id, criterion, what: m.what });
    }
  }
  return found;
}
