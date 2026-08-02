import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

/**
 * Stop an agent provisioning, mutating or destroying real infrastructure.
 *
 * Agents run with `permissionMode: "bypassPermissions"` — there is no prompt
 * between a command an agent writes and the machine running it. Every guardrail
 * the harness has around cloud tooling has until now been prose in a system
 * prompt ("READ ONLY", "NEVER `apply`"), which is a request, not a control. For
 * application code that is an acceptable trade: the blast radius is a worktree,
 * and the integration branch is reviewed before anything reaches the operator.
 * Infrastructure has no such property. `terraform destroy` is not a diff someone
 * can decline to merge, and a `kubectl delete` against the operator's live
 * cluster cannot be reverted by parking a task.
 *
 * So the rule that already appears in every infra prompt is enforced here, at
 * the one chokepoint that sees every Bash command an agent runs. The harness
 * produces reviewed configuration; a human applies it. `terraform plan`,
 * `cdk synth`, `helm template` and `kubectl --dry-run=server` are how the work
 * gets verified, and none of them are blocked.
 *
 * A denial is not a dead end. The agent is told what was blocked, why, and which
 * verb to use instead, so the usual outcome is that it re-runs a `plan` and
 * carries on. There is deliberately no run-config knob to switch this off: the
 * operator's decision was that the harness produces reviewed configuration and
 * never provisions, and a flag that turns a safety control off is a flag an
 * agent's task spec can talk somebody into setting. The `allow` parameter below
 * exists so the seam is testable, and is never passed by the harness.
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

/** Shell separators that start a fresh command, when they are not inside quotes. */
const SEPARATOR = /^(?:\|\||&&|;|\||&|\n)/;

/** Remove quoted spans so prose about a command never reads as the command. */
function stripQuoted(segment: string): string {
  return segment.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
}

/**
 * Drop the bodies of any heredocs, keeping the lines that are actually commands.
 *
 * An infra task writes deployment runbooks, and a runbook lists `terraform apply`
 * on a line of its own because that is what a human runs. Read as a script, that
 * document is an apply; blocking it would stop the harness documenting the very
 * work it is allowed to do.
 */
function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    kept.push(line);
    i++;
    // Each heredoc opened on this line consumes a body, in the order opened.
    for (const m of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) {
      while (i < lines.length && lines[i]!.trim() !== m[2]!) i++;
      i++; // and the terminator line itself
    }
  }
  return kept.join("\n");
}

/**
 * The commands one Bash invocation actually runs.
 *
 * Quote-aware, because a naive split is wrong in the direction that matters for
 * ordinary work: `echo "kubectl delete && kubectl apply -f x" >> notes.md` is
 * one command that runs neither of them.
 */
function segments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  const flush = () => {
    if (current.trim()) out.push(current);
    current = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const sep = SEPARATOR.exec(command.slice(i));
    if (sep) {
      flush();
      i += sep[0].length - 1;
      continue;
    }
    current += ch;
  }
  flush();
  return out;
}

/** Whitespace-separated tokens, with quoted spans held together. */
function rawTokens(segment: string): string[] {
  return segment.match(/(?:[^\s'"]|'[^']*'|"[^"]*")+/g) ?? [];
}

const unquote = (token: string) =>
  /^(['"]).*\1$/s.test(token) ? token.slice(1, -1) : token;

/** Binaries that only prefix another command; the interesting one is behind them. */
const WRAPPERS = new Set(["sudo", "doas", "env", "timeout", "nohup", "nice", "ionice", "stdbuf", "command", "xargs", "time"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** A short-option bundle taking an argument must end in the option letter: `-c`, `-lc`. */
const DASH_C = /^-{1,2}[a-zA-Z]*c$/;

type Resolved = { bin: string; words: string[]; flags: string[] } | { inline: string };

/**
 * What a segment actually invokes, seeing past environment assignments, wrapper
 * binaries and an inline `-c` script.
 */
function resolve(segment: string): Resolved | null {
  const tokens = rawTokens(segment);
  let i = 0;
  for (;;) {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
    const token = tokens[i];
    if (!token) return null;
    const bin = unquote(token).split("/").pop() ?? "";
    if (WRAPPERS.has(bin)) {
      i++;
      // Skip the wrapper's own arguments: its flags, `-u <user>`, and the bare
      // duration `timeout`/`nice` take before the command they wrap.
      while (i < tokens.length) {
        const t = tokens[i]!;
        if (/^-{1,2}(u|user|n|adjustment)$/.test(t)) i += 2;
        else if (t.startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(t)) i++;
        else break;
      }
      continue;
    }
    const rest = tokens.slice(i + 1);
    if (SHELLS.has(bin)) {
      const c = rest.findIndex((t) => DASH_C.test(t));
      if (c !== -1) {
        const script = rest.slice(c + 1).find((t) => !t.startsWith("-"));
        if (script) return { inline: unquote(script) };
      }
    }
    const words: string[] = [];
    const flags: string[] = [];
    for (const t of rest) {
      const clean = stripQuoted(t).trim();
      if (!clean) continue;
      (clean.startsWith("-") ? flags : words).push(clean);
    }
    return { bin, words, flags };
  }
}

const has = (flags: string[], re: RegExp) => flags.some((f) => re.test(f));

/** A dry run is the whole point of these tools — never block one. */
const DRY_RUN = /^--dry-run(=(client|server|none)?)?$|^--validate-only\b|^--what-if\b|^--preview\b/;

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
  // `bash -c "bash -c ..."` is nobody's idiom, but the recursion needs a floor.
  if (depth > 3) return null;
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
    if (what) return { what, instead: INSTEAD[resolved.bin] ?? "the tool's plan or dry-run mode" };
  }
  return null;
}

/** The refusal an agent reads — what was blocked, why, and what to run instead. */
export function denialReason(m: { what: string; instead: string }): string {
  return `Blocked: ${m.what} changes real infrastructure, and this harness produces reviewed configuration rather than provisioned resources — an apply cannot be reviewed after the fact, only undone. Run ${m.instead} instead; that is what verifies this work and it is not blocked. If the task genuinely cannot be completed without provisioning, do not try to work around this: say so plainly in your final summary and stop, so the operator can decide.`;
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
