import { withoutComments } from "./deployOrder.js";

/**
 * The commands a repository's own pipeline runs to judge a pull request, read
 * off its workflow files so a run's checks are the checks it will be graded on.
 *
 * `detectChecks` infers a suite from the language: a `Cargo.toml` gets
 * `cargo test` and `cargo clippy -- -D warnings`, and that is the whole set. A
 * repository whose CI runs seven jobs therefore has five of them running
 * nowhere but GitHub, after the pull request is already open — which is the
 * expensive end of the run. Run bc691359 is what that costs. Its CI ran
 * `build`, `fmt`, `clippy`, `test`, `coverage`, `patch-coverage` and `fuzz`,
 * plus `cargo deny` and `cargo audit` in a second workflow; the harness ran two
 * of those nine, merged 30-odd tasks that were green against the two, and the
 * formatting and licence failures were found by a human reading the pull
 * request. Both were one line of `cargo` away from being caught in the worktree
 * that caused them, before any merge.
 *
 * `awaitChecks` already says this in its own comment — deterministic checks
 * "never run the repo's workflow" — and treats asking GitHub as the fix. Asking
 * GitHub is the right last word and the wrong first one: it costs a push, a
 * queue, a runner and a round of `ciFixRounds` to learn something `cargo fmt
 * --check` answers locally in four seconds.
 *
 * ## Why so little of a workflow is lifted
 *
 * A check that cannot pass in a fresh worktree is worse than no check at all:
 * it fails for every task, every task is blamed for it, and none of them can
 * fix it — the run parks whole. So this reads a workflow the way a careful
 * operator would, and refuses far more than it accepts:
 *
 *   - only workflows that judge a pull request, because those are the ones
 *     whose verdict blocks the merge;
 *   - only steps whose script is a single command, after `set -e` and friends
 *     are discarded. A multi-line `run:` is a shell program — WAF's `fmt` step
 *     builds a package list with `cargo metadata` and `jq` before it formats —
 *     and deciding that an arbitrary shell program is side-effect-free is not a
 *     thing this can do correctly, so it does not try;
 *   - only commands whose tool *and verb* are known to verify rather than
 *     change something. `cargo test` is a check; `cargo install` and `npm ci`
 *     are the setup that CI needs and a worktree already has;
 *   - never a formatter without its check flag, because `cargo fmt` and
 *     `prettier --write` rewrite the tree they are supposed to be judging;
 *   - never a step carrying `${{ }}`, `$GITHUB_*` or a secret, because those
 *     have no value outside Actions and a command built from an empty variable
 *     is a command that means something else.
 *
 * What is refused is not thrown away — it comes back as `skipped`, with the
 * reason, so the operator can see which of their CI jobs this run is not
 * covering and add it by hand if they want it. Silence about the gap would be
 * the same mistake as the gap.
 *
 * This module is pure text in, commands out. Whether the machine can actually
 * run what it names — is `cargo-deny` installed? — is the caller's question,
 * and the CLI asks it before writing anything down.
 */

/** A workflow file, read from `.github/workflows`. */
export interface WorkflowFile {
  path: string;
  text: string;
}

export interface CiCheck {
  /** The command, exactly as CI runs it, with the workflow's own `env:` resolved. */
  command: string;
  /** Where it came from — `ci.yml › fmt › cargo fmt --check`, for the banner. */
  source: string;
}

/** A CI step this refused to lift, and why, so the gap is visible rather than silent. */
export interface SkippedStep {
  source: string;
  reason: string;
}

export interface CiCheckScan {
  checks: CiCheck[];
  skipped: SkippedStep[];
}

/**
 * Tools whose named verbs verify the tree and change nothing outside it.
 *
 * Written verb-first on purpose: the verb is what separates `cargo test` from
 * `cargo install` and `npm run lint` from `npm ci`, and a tool-level list would
 * have to deny the dangerous verbs by name — a list that is wrong the moment a
 * tool grows a new one. Here a verb nobody listed is simply not a check.
 */
const CHECK_COMMAND: RegExp[] = [
  // `cargo +nightly fmt` and `cargo xtask check-repo` both come through here.
  /^cargo\s+(?:\+\S+\s+)?(?:build|check|clippy|fmt|test|nextest|deny|audit|udeps|machete|llvm-cov|tarpaulin|sort|semver-checks)\b/,
  /^cargo\s+(?:\+\S+\s+)?xtask\s+(?:check|lint|test|verify|audit|fmt)\S*\b/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|type-check|check|build)\b/,
  /^(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(?:tsc|eslint|prettier|biome|vitest|jest|stylelint|depcheck|knip)\b/,
  /^(?:tsc|eslint|prettier|biome|vitest|jest|stylelint|knip)\b/,
  /^go\s+(?:build|test|vet)\b/,
  /^golangci-lint\s+run\b/,
  /^(?:pytest|mypy|pyright|ruff|flake8|black|isort|bandit|tox)\b/,
  /^(?:poetry|uv|hatch|pdm)\s+run\s+\S+/,
  /^(?:make|just)\s+(?:check|test|lint|fmt|format|ci|verify|audit)\b/,
  /^dotnet\s+(?:build|test|format)\b/,
  /^(?:\.\/gradlew|gradle)\s+(?:build|test|check)\b/,
  /^mvn\s+(?:-\S+\s+)*(?:verify|test)\b/,
  /^(?:shellcheck|shfmt|hadolint|yamllint|actionlint|markdownlint|typos|codespell|gitleaks)\b/,
  /^(?:terraform|tofu)\s+(?:fmt|validate)\b/,
];

/**
 * Tools that rewrite the tree unless told to report instead, and the flag that
 * tells them to.
 *
 * A formatter run without it is not a check that can fail — it is an edit, made
 * inside the worktree whose diff QA is about to read, attributed to whichever
 * task happened to be holding it.
 */
const REWRITES: { tool: RegExp; readOnly: RegExp }[] = [
  { tool: /^cargo\s+(?:\+\S+\s+)?fmt\b/, readOnly: /--check\b/ },
  { tool: /^(?:npx\s+|bunx\s+|pnpm\s+dlx\s+)?prettier\b/, readOnly: /(?:^|\s)(?:--check|-c|--list-different|-l)\b/ },
  { tool: /^(?:npx\s+|bunx\s+)?biome\s+format\b/, readOnly: /--(?:check|verify)\b/ },
  { tool: /^black\b/, readOnly: /--check\b/ },
  { tool: /^isort\b/, readOnly: /--check(?:-only)?\b/ },
  { tool: /^ruff\s+format\b/, readOnly: /--(?:check|diff)\b/ },
  { tool: /^shfmt\b/, readOnly: /(?:^|\s)-[dl]\b/ },
  { tool: /^dotnet\s+format\b/, readOnly: /--verify-no-changes\b/ },
  { tool: /^(?:terraform|tofu)\s+fmt\b/, readOnly: /(?:^|\s)-check\b/ },
  { tool: /^(?:eslint|golangci-lint\s+run)\b/, readOnly: /^(?!.*(?:--fix|--write))/ },
];

/** Shell that sets up a script's error handling rather than doing anything. */
const SCAFFOLD = /^(?:set\s+[-+][\w\s-]*|shopt\s+[-\w\s]*|:)$/;

/** Actions context: no value outside a runner, so no command that reads it can be lifted. */
const CI_CONTEXT = /\$\{\{|\$GITHUB_|\bGITHUB_(?:ENV|PATH|OUTPUT|STEP_SUMMARY|TOKEN)\b|\bsecrets\./;

/** Anything that reaches outside the process or writes where the command was not asked to. */
const ESCAPES = /[>`]|\$\(|\|\||&&|;|\|/;

/**
 * Read every liftable check out of a repository's workflows.
 *
 * Order is the repository's own — file, then job, then step — because that is
 * the order its authors decided their pipeline runs in, and nothing here knows
 * better. Duplicates across workflows are dropped, keeping the first sighting
 * and its provenance.
 */
export function scanCiChecks(files: WorkflowFile[]): CiCheckScan {
  const checks: CiCheck[] = [];
  const skipped: SkippedStep[] = [];
  const seen = new Set<string>();
  const refused = new Set<string>();

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const text = withoutComments(file.text);
    if (!judgesPullRequests(text)) continue;
    const env = workflowEnv(text);
    const name = file.path.split("/").pop()!;

    for (const step of steps(text)) {
      // A step with no `run:` is an action — checkout, cache, upload. There is
      // no command in it to lift and no gap in not lifting it, so it is not
      // reported either: a skip list padded with every `uses:` in the file is
      // one nobody reads, and the point of the list is that it gets read.
      if (step.script.trim() === "") continue;
      const where = `${name} › ${step.job} › ${step.name || step.script.split("\n")[0]!.slice(0, 40)}`;
      const verdict = lift(step.script, step.guarded, env);
      if (typeof verdict !== "string") {
        // One gap, not eight. Run bc691359's workflows install rustup in every
        // job, so an undeduplicated list is eighty-five lines of the same four
        // sentences — and a list that long is one the operator scrolls past,
        // which is the same outcome as not printing it.
        const gap = `${verdict.reason}\u0000${step.script.trim().split("\n")[0]}`;
        if (!refused.has(gap)) {
          refused.add(gap);
          skipped.push({ source: where, reason: verdict.reason });
        }
        continue;
      }
      const command = step.workingDirectory ? `cd ${step.workingDirectory} && ${verdict}` : verdict;
      const key = command.replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      checks.push({ command, source: where });
    }
  }
  return { checks, skipped };
}

/**
 * The command this step contributes, or why it contributes none.
 *
 * Every rejection is a reason rather than a silent drop: an operator reading
 * "9 CI steps, 6 lifted" wants to know which three and what stopped them, and
 * the answer is usually either "that is setup" or "that one needs a flag I
 * cannot guess".
 */
function lift(script: string, guarded: boolean, env: Record<string, string>): string | { reason: string } {
  if (guarded) return { reason: "runs only under an `if:` condition, so it is not part of every build" };

  // A trailing backslash is one command wearing several lines. Joining first
  // is what makes run bc691359's `clippy` and `coverage` steps liftable at all:
  // both are a single `cargo` invocation with its flags wrapped for the eye,
  // and counting the wrapped lines as separate commands refuses the two checks
  // in that pipeline with the most to say.
  const lines = script
    .replace(/\s*\\\n\s*/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !SCAFFOLD.test(l));
  if (lines.length === 0) return { reason: "no command" };
  if (lines.length > 1) return { reason: `${lines.length}-line shell script — only a single command can be lifted safely` };

  const raw = lines[0]!;
  if (CI_CONTEXT.test(raw)) return { reason: "reads an Actions expression, secret or `$GITHUB_*` variable" };

  const resolved = substitute(raw, env);
  if (resolved === null) return { reason: "reads a variable this workflow does not define" };
  if (ESCAPES.test(resolved)) return { reason: "pipes, chains or redirects — more than one thing is happening" };
  if (!CHECK_COMMAND.some((r) => r.test(resolved))) return { reason: `\`${head(resolved)}\` is not a known verification command` };

  const rewriter = REWRITES.find((r) => r.tool.test(resolved));
  if (rewriter && !rewriter.readOnly.test(resolved)) {
    return { reason: `\`${head(resolved)}\` would rewrite the tree rather than report on it` };
  }
  return resolved;
}

/** The tool and verb, for a reason line that names what was refused. */
function head(command: string): string {
  return command.split(/\s+/).slice(0, 2).join(" ");
}

/**
 * `$NAME` and `${NAME}` replaced from the workflow's own `env:`, or null when
 * one of them is not there.
 *
 * Null rather than an empty string, and that is the whole point: run bc691359's
 * `fmt` step excludes a vendored crate by name via `$VENDOR_PACKAGE`. Left
 * unresolved it formats the vendored crate too, fails in every worktree, and
 * parks the run — a check that is not merely useless but actively destructive,
 * produced by substituting nothing for something.
 */
function substitute(command: string, env: Record<string, string>): string | null {
  let missing = false;
  const out = command.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, braced: string | undefined, bare: string | undefined) => {
    const key = braced ?? bare!;
    const value = env[key];
    if (value === undefined) {
      missing = true;
      return "";
    }
    return value;
  });
  return missing ? null : out;
}

/**
 * Whether this workflow's verdict is one a pull request has to satisfy.
 *
 * `pull_request` is the direct answer. `push` to a default branch counts too:
 * a repository that gates only the merge still expects that suite to be green,
 * and a run whose whole output is one pull request into that branch is going to
 * meet it either way.
 */
function judgesPullRequests(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const on = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l));
  if (on < 0) return false;

  const scalar = /^["']?on["']?\s*:\s*(.+)$/.exec(lines[on]!.trimEnd());
  if (scalar) {
    const named = scalar[1]!.replace(/[[\]"']/g, "").split(",").map((s) => s.trim());
    return named.includes("pull_request") || named.includes("push");
  }
  const body = block(lines, on);
  if (keyLine(body, "pull_request") >= 0) return true;
  const push = keyLine(body, "push");
  if (push < 0) return false;
  const branches = listUnder(block(body, push), "branches");
  return branches === null || branches.length === 0 || branches.some((b) => b === "main" || b === "master");
}

/**
 * The workflow-level `env:` map, literal scalars only.
 *
 * Job- and step-level `env:` are deliberately not merged in. They would need
 * the job graph to attribute correctly, and a value read from the wrong scope
 * is exactly the silent wrongness `substitute` refuses to produce — a step
 * whose variable is defined on its own job simply does not resolve, and is
 * reported as skipped rather than lifted with somebody else's value.
 */
function workflowEnv(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^["']?env["']?\s*:\s*$/.test(l.trimEnd()));
  if (at < 0) return {};
  const env: Record<string, string> = {};
  for (const line of block(lines, at)) {
    const kv = /^\s*(\w+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2]!.trim().replace(/^["']|["']$/g, "");
    // A block scalar or an Actions expression is not a literal; leaving the key
    // out means any command using it is skipped, which is the safe direction.
    if (value === "" || value === "|" || value === ">" || /\$\{\{/.test(value)) continue;
    env[kv[1]!] = value;
  }
  return env;
}

interface Step {
  job: string;
  name: string;
  script: string;
  guarded: boolean;
  /** The directory CI runs the step in, relative to the repo root, or "". */
  workingDirectory: string;
}

/** Every step with a `run:`, in the order the file lists them. */
function steps(text: string): Step[] {
  const lines = text.split(/\r?\n/);
  const jobsAt = lines.findIndex((l) => /^["']?jobs["']?\s*:/.test(l));
  if (jobsAt < 0) return [];
  const jobsBody = block(lines, jobsAt);
  const jobIndent = jobsBody.length ? indent(jobsBody[0]!) : 0;

  const found: Step[] = [];
  for (let i = 0; i < jobsBody.length; i++) {
    const header = /^\s*([\w.-]+)\s*:\s*$/.exec(jobsBody[i]!);
    if (!header || indent(jobsBody[i]!) !== jobIndent) continue;
    const job = header[1]!;
    const body = block(jobsBody, i);
    const stepsAt = keyLine(body, "steps");
    if (stepsAt < 0) continue;
    // `defaults: run: working-directory:` applies to every step in the job that
    // does not name its own. A monorepo's site or frontend job is nothing but
    // this — `npm run build` at the repo root is a different command, and
    // usually a failing one.
    const defaultsAt = keyLine(body, "defaults");
    const jobDir = defaultsAt < 0 ? "" : workingDirectory(block(block(body, defaultsAt), Math.max(keyLine(block(body, defaultsAt), "run"), 0)));
    for (const item of sequence(block(body, stepsAt))) {
      const step = readStep(item);
      found.push({ job, ...step, workingDirectory: step.workingDirectory || jobDir });
    }
  }
  return found;
}

/** One step's `name`, `run` and whether an `if:` guards it. */
function readStep(item: string[]): Omit<Step, "job"> {
  const nameAt = keyLine(item, "name");
  const name = nameAt < 0 ? "" : /:\s*(.*)$/.exec(item[nameAt]!)![1]!.trim().replace(/^["']|["']$/g, "");
  const dir = workingDirectory(item);
  const runAt = keyLine(item, "run");
  if (runAt < 0) return { name, script: "", guarded: false, workingDirectory: dir };

  const inline = /^\s*run\s*:\s*(.*)$/.exec(item[runAt]!)![1]!.trim();
  // `run: |`, `run: >-`, `run: |+` — the script is the block beneath, and its
  // own indentation is stripped so the command starts at column zero.
  const script = /^[|>][+-]?$/.test(inline) || inline === "" ? dedent(block(item, runAt)) : inline.replace(/^["']|["']$/g, "");
  return { name, script, guarded: keyLine(item, "if") >= 0, workingDirectory: dir };
}

/** A `working-directory:` among these lines, normalized away from "." and "./". */
function workingDirectory(lines: string[]): string {
  const at = keyLine(lines, "working-directory");
  if (at < 0) return "";
  const value = /:\s*(.*)$/.exec(lines[at]!)![1]!.trim().replace(/^["']|["']$/g, "").replace(/^\.\//, "").replace(/\/$/, "");
  return value === "." ? "" : value;
}

/** The items of a `-` sequence, each with its dash replaced by a space so keys line up. */
function sequence(lines: string[]): string[][] {
  const items: string[][] = [];
  const dash = lines.find((l) => /^\s*-\s/.test(l));
  if (!dash) return items;
  const at = indent(dash);
  for (const line of lines) {
    if (indent(line) === at && /^\s*-\s/.test(line)) items.push([line.replace(/^(\s*)-(\s)/, "$1 $2")]);
    else if (items.length) items[items.length - 1]!.push(line);
  }
  return items;
}

/** Lines indented past `lines[start]`, up to the first that is not. */
function block(lines: string[], start: number): string[] {
  const at = indent(lines[start]!);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      body.push(line);
      continue;
    }
    if (indent(line) <= at) break;
    body.push(line);
  }
  while (body.length && body[body.length - 1]!.trim() === "") body.pop();
  return body;
}

/** The index of `key:` among the shallowest lines of `lines`, or -1. */
function keyLine(lines: string[], key: string): number {
  const outer = lines.reduce((min, l) => (l.trim() === "" ? min : Math.min(min, indent(l))), Infinity);
  return lines.findIndex((l) => l.trim() !== "" && indent(l) === outer && new RegExp(`^\\s*["']?${key}["']?\\s*:`).test(l));
}

/** Values under a key, in either the `[a, b]` or the `- a` form; null when absent. */
function listUnder(lines: string[], key: string): string[] | null {
  const at = keyLine(lines, key);
  if (at < 0) return null;
  const clean = (s: string) => s.trim().replace(/^["']|["']$/g, "");
  const inline = /:\s*\[(.*)\]\s*$/.exec(lines[at]!.trimEnd());
  if (inline) return inline[1]!.split(",").map(clean).filter(Boolean);
  return block(lines, at)
    .filter((l) => /^\s*-\s*/.test(l))
    .map((l) => clean(l.replace(/^\s*-\s*/, "")))
    .filter(Boolean);
}

function indent(line: string): number {
  return /^\s*/.exec(line)![0].length;
}

/**
  * A block scalar with its common indentation removed.
  *
  * A blank line has no indentation to contribute — measuring it would make
  * every wrapped command flush left and lose the continuation.
  */
function dedent(lines: string[]): string {
  const width = lines.reduce((min, l) => (l.trim() === "" ? min : Math.min(min, indent(l))), Infinity);
  return lines.map((l) => l.slice(width)).join("\n");
}
