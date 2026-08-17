/**
 * Whether merging this change is itself the production deploy, and whether it
 * deploys ahead of infrastructure nothing in the repo will have applied yet —
 * read off the diff, at the task gate, while a worker can still fix it.
 *
 * Run 1e7d3df3 took dns-project's console down. The work was a cookie/jti session
 * cutover: `control-plane/internal/api/auth.go` began checking every
 * authenticated request's `jti` against a revocation store, and
 * `infra/aws/dynamodb/main.tf` gained the table that store reads —
 * `aws_dynamodb_table.sessions`. Commit af60742 changed both files.
 *
 * The run understood the hazard completely. It wrote a 207-line cutover plan
 * that called the ordering "mandatory, not a preference", quoted auth.go's own
 * doc comment explaining that the revocation check fails closed, traced the
 * failure to `errSessionCheckUnavailable` -> HTTP 503, and stated the
 * consequence in as many words: if the new image rolls before the table
 * exists, "every authenticated request returns 503 - not a partial
 * degradation, a full outage of the console and every scoped API token". It
 * then ran `aws dynamodb describe-table` against the live account and recorded
 * the real answer, ResourceNotFoundException: the table did not exist. It put
 * the ordered steps in a PRODUCTION-HANDOVER.md for a human to perform.
 *
 * Then the pull request went green on all ten checks and was merged. And
 * `.github/workflows/deploy-web.yml` is CD `on: push: branches: [main]` with
 * `control-plane/**` among its paths, so the merge built the image and rolled
 * it — before any human read the handover, because merging was never a step in
 * the handover. Every authenticated request began returning 503. The operator
 * found it the ordinary way: logged out, logged back in, and got "Couldn't
 * load your zones - session check failed".
 *
 * Nothing here was a testing gap. The tests were right, the plan was right,
 * the prose was right, and the outage was written down in advance by the run
 * that caused it. What was missing was anyone asking whether the document had
 * a chance to be obeyed. A handover that says "apply the table first" is a
 * true sentence about an ordering that the merge button had already decided,
 * and no check in the repo or the harness compared those two facts.
 *
 * So they get compared here, on the diff, before the task is done. The
 * question has one right answer and needs two files the harness already has in
 * front of it: does a workflow deploy this change on the merge, and is there a
 * resource in this change that no such workflow applies? When both hold, the
 * deploy is ordered ahead of its own prerequisite and the only thing standing
 * between that and an outage is a human reading a runbook in the right order.
 *
 * The trigger has to be read, not just the command. This repo would have
 * defeated a lazier check: `deploy-edge.yml` does run `tofu apply`, so "does
 * any workflow apply Terraform?" answers yes and stays quiet. That apply is
 * `workflow_dispatch` only and points at a different stack. An apply a human
 * must launch is not a thing the merge does - it is the very human step whose
 * ordering is in question, which is why only a push-to-main apply counts as
 * one the merge will have performed.
 *
 * Pure and I/O-free, like `evidence` and `deployCapability` - the caller
 * supplies the bytes, so the rule is testable without a repo, a worktree, a
 * cluster or a cloud account.
 */

/** A file the caller has read: where it lives, and what is in it. */
export interface SourceFile {
  path: string;
  text: string;
}

/** A Terraform resource this change declares. */
export interface DeclaredResource {
  file: string;
  /** `aws_dynamodb_table`, `aws_iam_policy`, … */
  type: string;
  /** The local name in the block header. */
  name: string;
}

/** What a workflow's `on: push:` says, once. */
export interface PushTrigger {
  /** Branches it fires on. Empty when it names none, which means all of them. */
  branches: string[];
  /** Its `paths:` filter, or null when it has none and therefore deploys anything. */
  paths: string[] | null;
}

export interface OrderFinding {
  /** The workflow whose merge-to-main trigger ships this change. */
  deployer: string;
  /** The changed file it will ship. */
  deploys: string;
  /** The `paths:` entry that matched, or "" when the workflow filters on none. */
  via: string;
  /** Resources this change declares that no merge-triggered workflow applies. */
  resources: DeclaredResource[];
}

/** Where Terraform/OpenTofu configuration lives. */
const TERRAFORM_FILE = /\.tf$/i;

/** A resource block header: `resource "aws_dynamodb_table" "sessions" {`. */
const RESOURCE_BLOCK = /^\s*resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/;

/** The branches a repo's merge lands on. */
const DEFAULT_BRANCHES = new Set(["main", "master"]);

/** A command that creates real infrastructure from that configuration. */
const APPLY_COMMAND = /\b(?:terraform|tofu)\b[^\n]*\bapply\b/;

/**
 * A step that puts code in front of users.
 *
 * Without this the rule asks "does a workflow run on the merge?", and the
 * answer in every repo is yes — `ci.yml` runs on push to main with no paths
 * filter, so it matches every file changed. Measured over forty commits each
 * of dns-project, billing-app and waf, that reading fired on twenty of the twenty
 * commits that touched any `.tf` file and stayed silent on none of them. A
 * check that never clears is one people learn to click past, which costs the
 * gate the one time it is right.
 *
 * The hazard is not that something ran on the merge. It is that the merge made
 * code live before the thing that code needs existed. Tests do not go live, so
 * a workflow that only builds and tests cannot create the ordering problem no
 * matter what it triggers on. The verbs below are the ones these repos
 * actually deploy with, taken from their workflows rather than guessed at.
 */
/**
 * The workflow with its comments removed.
 *
 * Every command question below is asked of this and not of the raw file. A
 * comment is prose about the workflow, not a step in it, and reading the two
 * alike goes wrong in both directions: dns-project's `ci.yml` says
 * `# unit-tested with doctl+dig faked.` and was read as a deploy, while a note
 * reading `we run terraform apply by hand` would have satisfied the
 * merge-applies-it test and switched the whole gate off — silently, on exactly
 * the repo that documents its manual apply. Being talked out of a finding by a
 * sentence is the failure this gate exists to stop.
 *
 * Quotes are tracked so a `#` inside a string stays put; YAML has no escape
 * inside single quotes, and a `\"` inside double quotes is handled.
 */
export function withoutComments(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (quote) {
          if (c === "\\" && quote === '"') i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        // A `#` only opens a comment at the start of a line or after a space.
        else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

const DEPLOY_COMMAND = new RegExp(
  [
    /\bkubectl\s+(?:apply|rollout|set\s+image|patch|create|delete)\b/,
    /\bhelm\s+(?:upgrade|install)\b/,
    /\baws\s+(?:s3\s+(?:sync|cp)|cloudfront|ecs|lambda|elasticbeanstalk|deploy)\b/,
    /\bdocker\s+(?:push|buildx\s+build[^\n]*--push)\b/,
    /\bdoctl\s+\w+[^\n]*\b(?:create|update|delete|replace|restore|apply)\b/,
    /\b(?:flyctl|fly)\s+deploy\b|\bvercel\b|\bnetlify\b|\bserverless\s+deploy\b/,
    /\bansible-playbook\b|\bpulumi\s+up\b|\bnpm\s+publish\b/,
    /\bgh\s+release\s+create\b/,
    APPLY_COMMAND.source,
  ]
    .map((r) => (typeof r === "string" ? r : r.source))
    .join("|"),
);

/**
 * A job condition that holds only when a human launched the workflow by hand.
 *
 * The reason this is read at all: a workflow can trigger on push to main and
 * still keep its apply behind `if: github.event_name == 'workflow_dispatch'`,
 * which is exactly what dns-project's `deploy-edge.yml` does — and what makes
 * "this workflow runs on the merge and contains an apply" the wrong question.
 * Deciding which job an `if:` guards would mean resolving the whole workflow
 * graph; deciding whether the file gates anything on a hand-launch is one
 * regex and answers the ordering question, because a repo that writes this
 * guard at all has an apply somebody has to remember to run.
 *
 * Being wrong here costs a paragraph in front of QA on a repo that was fine.
 * Being wrong the other way costs what run 1e7d3df3 cost, so where the two
 * readings disagree this takes the one that asks.
 */
const DISPATCH_GUARD = /github\.event_name\s*==\s*["']workflow_dispatch["']/;

/**
 * A file that ships on the merge but does not illustrate why that matters —
 * documentation, tests and tool configuration. Not excluded from the finding,
 * only passed over when naming it: see the pick in `scanDeployOrder`.
 */
const INCIDENTAL = /(?:^|\/)(?:README|CHANGELOG|LICENSE)|\.(?:md|txt|coveragerc|editorconfig|gitignore)$|(?:^|\/)docs?\/|_test\.go$|\.(?:test|spec)\.[jt]sx?$/i;

/**
 * Every Terraform resource declared in this file.
 *
 * The whole file rather than only its added lines, for the same reason
 * `namedIamResources` reads the whole template: the harness has the changed
 * file list and the file, not a per-hunk diff, and a resource that was added
 * three commits ago and is still unapplied is the same hazard as one added
 * now. The cost of the wider read is a question asked about a file someone
 * touched, which is where the answer is cheapest to act on.
 */
export function declaredResources(file: SourceFile): DeclaredResource[] {
  if (!TERRAFORM_FILE.test(file.path)) return [];
  const found: DeclaredResource[] = [];
  for (const line of file.text.split(/\r?\n/)) {
    const block = RESOURCE_BLOCK.exec(line);
    if (block) found.push({ file: file.path, type: block[1]!, name: block[2]! });
  }
  return found;
}

/**
 * The lines of a mapping's body: everything indented past the key line, up to
 * the next line that is not.
 *
 * A hand-rolled walk rather than a YAML parse, for the reason
 * `deployCapability` gives and one more: `on` is a YAML 1.1 boolean, so a
 * stock loader hands back a key of `true` and the shape of the answer starts
 * depending on which loader was installed. Nothing here resolves a value; it
 * only needs to know which keys are present and what is listed under them.
 */
function block(lines: string[], start: number): string[] {
  const indent = /^\s*/.exec(lines[start]!)![0].length;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (/^\s*/.exec(line)![0].length <= indent) break;
    body.push(line);
  }
  return body;
}

/** The index of `key:` at the top of `lines`, or -1. */
function keyLine(lines: string[], key: string): number {
  return lines.findIndex((l) => new RegExp(`^\\s*["']?${key}["']?\\s*:`).test(l));
}

/**
 * The values under a YAML key, in either form GitHub accepts: the inline flow
 * sequence `branches: [main]` and the block sequence of `- main` beneath it.
 * Returns null when the key is absent, which is a different answer from
 * present-and-empty everywhere it is used here.
 */
function listUnder(lines: string[], key: string): string[] | null {
  const at = keyLine(lines, key);
  if (at < 0) return null;
  const inline = /:\s*\[(.*)\]\s*(?:#.*)?$/.exec(lines[at]!);
  const clean = (s: string) => s.trim().replace(/^["']|["']$/g, "");
  if (inline) {
    return inline[1]!
      .split(",")
      .map(clean)
      .filter(Boolean);
  }
  return block(lines, at)
    .filter((l) => /^\s*-\s*/.test(l))
    .map((l) => clean(l.replace(/^\s*-\s*/, "").replace(/\s*#.*$/, "")))
    .filter(Boolean);
}

/**
 * What this workflow's `on: push:` says, or null when it has none.
 *
 * `on: push` and `on: [push, pull_request]` are both legal and both mean every
 * branch with no path filter, which is the broadest possible deploy trigger —
 * so they are read as a trigger rather than skipped for having no body.
 */
export function pushTrigger(text: string): PushTrigger | null {
  const lines = text.split(/\r?\n/);
  const on = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l));
  if (on < 0) return null;

  // `on: push` / `on: [push, workflow_dispatch]` — a trigger with no body. The
  // comment goes first: `on:  # what fires this` is a mapping whose triggers
  // are in the block below, and a regex that reads the trailing comment as the
  // value decides the workflow triggers on something called "#" and stops
  // looking.
  const scalar = /^["']?on["']?\s*:\s*(.+)$/.exec(lines[on]!.replace(/\s+#.*$/, "").trimEnd());
  if (scalar) {
    const named = scalar[1]!.replace(/[[\]"']/g, "").split(",").map((s) => s.trim());
    return named.includes("push") ? { branches: [], paths: null } : null;
  }

  const body = block(lines, on);
  const push = keyLine(body, "push");
  if (push < 0) return null;
  const inner = block(body, push);
  return {
    branches: listUnder(inner, "branches") ?? [],
    paths: listUnder(inner, "paths"),
  };
}

/** Whether this trigger fires on the branch a pull request merges into. */
function firesOnMerge(trigger: PushTrigger | null): trigger is PushTrigger {
  if (!trigger) return false;
  return trigger.branches.length === 0 || trigger.branches.some((b) => DEFAULT_BRANCHES.has(b));
}

/**
 * Whether a GitHub path filter matches a changed file.
 *
 * `**` crosses separators, `*` and `?` do not, and a trailing `/` or a bare
 * directory matches everything beneath it — GitHub's own rules, kept narrow
 * because the only consequence of being wrong is which sentence a human reads.
 */
export function pathMatches(glob: string, file: string): boolean {
  const pattern = glob.endsWith("/") ? `${glob}**` : glob;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  if (new RegExp(`^${re}$`).test(file)) return true;
  // A bare directory stands for everything under it. A glob that already has a
  // wildcard does not get the same courtesy: `control-plane/*` means the files
  // directly in it, and reading it as a prefix would make every `*` behave
  // like `**` and quietly widen every filter in the repo.
  return !/[*?]/.test(pattern) && new RegExp(`^${re}/`).test(file);
}

/**
 * A change that a merge deploys ahead of infrastructure the merge does not
 * apply.
 *
 * Silent unless all of it is true: the change declares a Terraform resource,
 * no workflow that runs on the merge applies Terraform, and a workflow that
 * runs on the merge ships some other file in the same change. Each of those
 * alone is ordinary. A repo whose deployment the harness cannot see is a repo
 * this says nothing about, for the reason `deployCapability` gives — a gate
 * that cries on ordinary work is one nobody reads by the third task.
 *
 * Only the first deploying file is reported per workflow. The finding is an
 * ordering, not an inventory, and the second path through the same workflow
 * says nothing the first did not.
 */
export function scanDeployOrder(changed: SourceFile[], workflows: SourceFile[]): OrderFinding[] {
  const resources = changed.flatMap(declaredResources);
  if (!resources.length) return [];

  const declaring = new Set(resources.map((r) => r.file));
  const triggers = workflows.map((w) => ({ ...w, trigger: pushTrigger(w.text), steps: withoutComments(w.text) }));

  // An apply the merge performs settles the ordering by itself. An apply some
  // human launches is the step whose ordering is in question, so it does not —
  // and a workflow can be both, triggering on push while keeping its apply
  // behind a hand-launch guard. Only an unguarded one counts.
  if (triggers.some((w) => firesOnMerge(w.trigger) && APPLY_COMMAND.test(w.steps) && !DISPATCH_GUARD.test(w.steps))) return [];

  const findings: OrderFinding[] = [];
  for (const workflow of triggers) {
    if (!firesOnMerge(workflow.trigger)) continue;
    // Running on the merge is not deploying on the merge. See DEPLOY_COMMAND.
    if (!DEPLOY_COMMAND.test(workflow.steps)) continue;
    const shipped: { file: string; via: string }[] = [];
    for (const file of changed.map((f) => f.path)) {
      // A workflow is not the code it ships, and neither is the rest of CI's
      // furniture. Naming one of these as the deployed file makes a true
      // finding read like a false one.
      if (file.startsWith(".github/")) continue;
      // The configuration itself riding along is not what gets deployed; the
      // code that will run against the resource is.
      if (declaring.has(file)) continue;
      const via = workflow.trigger.paths?.find((p) => pathMatches(p, file));
      if (workflow.trigger.paths && via === undefined) continue;
      shipped.push({ file, via: via ?? "" });
    }
    // Report the file that makes the ordering obvious. Every one of these ships
    // on the merge, so any of them proves the finding — but a reader shown
    // `deploy-edge.yml deploys README.md` reads a true finding as a false one
    // and stops there. Running against dns-project's history this picked a
    // `.coveragerc`, a README and a `_test.go` on three of five real findings.
    const pick = shipped.find((s) => !INCIDENTAL.test(s.file)) ?? shipped[0];
    if (pick) findings.push({ deployer: workflow.path, deploys: pick.file, via: pick.via, resources });
  }
  return findings;
}

/**
 * The paragraph QA reads — the ordering, and where the guarantee has to come
 * from.
 *
 * Written as an instruction because the reader has to act on it in this task
 * or not at all, and pointed at the one fix that is not a document: something
 * has to make the code tolerate the resource being absent, or something has to
 * stop the merge from being the deploy. A runbook is neither, which is the
 * whole lesson of the run that produced this gate.
 */
export function renderDeployOrder(findings: OrderFinding[]): string {
  if (!findings.length) return "";
  const resources = findings[0]!.resources;
  const lines: string[] = ["Deploy order — merging this change deploys it before the infrastructure it needs exists:"];
  for (const f of findings) {
    lines.push(
      `  ${f.deployer} runs on push to main and ships ${f.deploys}${f.via ? ` (paths: ${f.via})` : " (no paths filter — it ships everything)"}`
    );
  }
  lines.push(
    `  this change declares ${resources.map((r) => `${r.type}.${r.name}`).join(", ")} in ${[...new Set(resources.map((r) => r.file))].join(", ")}`,
    "  no workflow that runs on the merge applies it",
    "",
    "So the merge is the deploy, and the apply is not. The new code reaches production",
    "first and runs against a resource that does not exist yet. Whether that is a brief",
    "degradation or a full outage depends entirely on what the code does when the",
    "resource is missing — and a store lookup that fails closed, which is the correct",
    "way to write a revocation or authorization check, turns it into the second: every",
    "authenticated request errors until a human applies the configuration.",
    "",
    "This is exactly how run 1e7d3df3 took dns-project's console down. That run wrote the",
    "ordering out in full, confirmed against the live account that the table was",
    "missing, and handed a human an ordered runbook — and none of it mattered, because",
    "nothing in the runbook could run before the merge that had already shipped the",
    "code. Ten green checks, then 503 on every request. A document cannot sequence a",
    "deploy it does not gate.",
    "",
    "Send it back to be fixed in this task, in whichever direction the work intends:",
    "  - make the new code tolerate the resource being absent — degrade to the old path,",
    "    or read the dependency behind a flag that is off until the apply lands. This is",
    "    the one that keeps the merge safe on its own, and it is usually right; or",
    "  - take the deploying paths out of this change, so the configuration merges first",
    "    and the code that needs it merges after the apply is confirmed; or",
    "  - have the merge apply it too, if the pipeline is allowed to. Note that a",
    "    workflow_dispatch apply does not count — that is the human step whose ordering",
    "    is the problem.",
    "",
    "A runbook, a handover document or a plan that states the order is not one of these.",
    "It is a true sentence about a sequence nothing enforces.",
    "",
    "This is a FAIL rather than a note. Nothing downstream of you checks it."
  );
  return lines.join("\n");
}
