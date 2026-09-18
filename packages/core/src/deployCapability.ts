/**
 * Whether the pipeline that will deploy this template is allowed to create
 * what the template now declares — read off the diff, at the task gate, while
 * a worker can still fix it.
 *
 * api-service's CD went red on `main` and stayed red. The task added one
 * resource to a CloudFormation template:
 *
 *   DeliveryLogRunnerPolicy:
 *     Type: AWS::IAM::ManagedPolicy
 *     Properties:
 *       ManagedPolicyName: delivery-log-runner-write
 *
 * and the repo's deploy step ran `sam deploy --capabilities CAPABILITY_IAM`.
 * CloudFormation splits that acknowledgement in two — it will generate a
 * physical name under CAPABILITY_IAM, and demands CAPABILITY_NAMED_IAM for a
 * resource the template names itself — so the changeset was refused with
 * `Requires capabilities : [CAPABILITY_NAMED_IAM]`.
 *
 * The interesting part is not the rule, it is which gates the change walked
 * through first. Capabilities are an argument to CreateChangeSet, not a
 * property of the template, so nothing that reads the template can see the
 * problem: `sam validate --lint` passed, `sam build` passed, a suite at 100%
 * coverage passed, QA passed, the pull request went green and merged. The
 * first thing on earth that could tell was CloudFormation, and by then the
 * change was on the operator's main branch and every subsequent push had
 * nowhere to land. That is the whole failure — a check that was correct and
 * ran too late.
 *
 * So it runs here instead, on the diff, before the task is done. This is not a
 * lint for infrastructure in general: it asks one question that has one right
 * answer, comparing two files the charrette already has in front of it, and it
 * is silent on every repo that has no template, no deployer, or no named
 * resource. What it says when it does fire is the fix, in both directions the
 * work might intend.
 *
 * Pure and I/O-free, like `evidence` — the caller supplies the bytes, so the
 * rule is testable without a repo, a worktree or a deployment.
 */

/** A file the caller has read: where it lives, and what is in it. */
export interface SourceFile {
  path: string;
  text: string;
}

/** An IAM resource whose physical name the template chose rather than CloudFormation. */
export interface NamedIamResource {
  logicalId: string;
  /** `AWS::IAM::Role`, `AWS::IAM::ManagedPolicy`, … */
  type: string;
  /** The property that names it — what makes it "custom-named" to CloudFormation. */
  via: string;
}

export interface CapabilityFinding {
  template: string;
  /** The workflow or script whose deploy command cannot create them. */
  deployer: string;
  /** Every CAPABILITY_* that deployer passes. Empty when it passes none. */
  capabilities: string[];
  resources: NamedIamResource[];
}

/**
 * The naming property per IAM resource type, from CloudFormation's own
 * "Acknowledging IAM resources" table.
 *
 * `AWS::IAM::Policy` maps to null because `PolicyName` is required on it —
 * declaring an inline policy resource at all needs CAPABILITY_NAMED_IAM, so
 * there is no property to look for.
 */
const NAMING_PROPERTY: Record<string, string | null> = {
  "AWS::IAM::Role": "RoleName",
  "AWS::IAM::ManagedPolicy": "ManagedPolicyName",
  "AWS::IAM::User": "UserName",
  "AWS::IAM::Group": "GroupName",
  "AWS::IAM::InstanceProfile": "InstanceProfileName",
  "AWS::IAM::Policy": null,
};

/** Where a CloudFormation template plausibly lives. Keeps prose out of the parse. */
const TEMPLATE_FILE = /\.(ya?ml|json|template)$/i;

/** The line that declares a resource's type, and the indentation it sits at. */
const TYPE_LINE = /^(\s*)Type:\s*["']?(AWS::IAM::[A-Za-z]+)["']?\s*(?:#.*)?$/;

/** A mapping key on its own line — how a resource's logical id appears above its body. */
const KEY_LINE = /^(\s*)([A-Za-z0-9_]+):\s*(?:#.*)?$/;

const indentOf = (line: string) => /^\s*/.exec(line)![0].length;
const blank = (line: string) => line.trim() === "";

/**
 * Every IAM resource in this template that carries its own name.
 *
 * A hand-rolled walk rather than a YAML parse, for one reason: CloudFormation
 * templates are full of short intrinsic tags (`!Ref`, `!Sub`, `!GetAtt`) that
 * a stock YAML loader rejects outright, and adding a dependency and a custom
 * multi-constructor to answer "is there a RoleName in this block" would be a
 * lot of machinery pointed at two regexes' worth of question. Nothing here
 * resolves a value; it only needs to know which properties are present.
 */
export function namedIamResources(text: string): NamedIamResource[] {
  const lines = text.split(/\r?\n/);
  const found: NamedIamResource[] = [];
  for (let i = 0; i < lines.length; i++) {
    const type = TYPE_LINE.exec(lines[i]!);
    if (!type) continue;
    const property = NAMING_PROPERTY[type[2]!];
    if (property === undefined) continue;

    // Walk back to the mapping key this Type belongs to. The first less-indented
    // key line above it is the resource's logical id.
    let start = -1;
    for (let j = i - 1; j >= 0; j--) {
      const key = KEY_LINE.exec(lines[j]!);
      if (key && key[1]!.length < indentOf(lines[i]!)) {
        start = j;
        break;
      }
    }
    // A `Type:` with no key above it is not a resource in a `Resources:` map.
    // Nothing to report and nothing to name.
    if (start < 0) continue;

    // Search the whole resource body, not just what follows `Type:`. Templates
    // put `Properties:` on either side of it and both are correct YAML.
    const bodyIndent = indentOf(lines[start]!);
    let named = property === null;
    if (property !== null) {
      const wanted = new RegExp(`^\\s*${property}:`);
      for (let j = start + 1; j < lines.length; j++) {
        if (!blank(lines[j]!) && indentOf(lines[j]!) <= bodyIndent) break;
        if (wanted.test(lines[j]!)) {
          named = true;
          break;
        }
      }
    }
    if (named) found.push({ logicalId: KEY_LINE.exec(lines[start]!)![2]!, type: type[2]!, via: property ?? "PolicyName (required)" });
  }
  return found;
}

/** A command that hands a template to CloudFormation to create or update. */
const DEPLOY_COMMAND = /\bsam deploy\b|\baws\s+cloudformation\s+(?:deploy|create-stack|update-stack|create-change-set)\b/;

/**
 * The capabilities a deploy file acknowledges, or null if it deploys nothing.
 *
 * Every `CAPABILITY_*` in the file counts, wherever it appears — a workflow
 * that names it in a comment and not in the command is not a shape worth
 * modelling, and reading the flag positionally out of a multi-line shell
 * script (line continuations, `if` branches, an args array built above the
 * call) is how a checker starts being wrong about repos that are fine. The
 * question here is whether anyone has thought about NAMED_IAM at all; when the
 * answer is yes this stays quiet and the deployment settles it.
 */
export function deployCapabilities(text: string): string[] | null {
  if (!DEPLOY_COMMAND.test(text)) return null;
  return [...new Set(text.match(/CAPABILITY_[A-Z_]+/g) ?? [])];
}

/**
 * Templates in this change that declare named IAM against deployers that
 * cannot create it.
 *
 * Silent unless all three are true: a template names a resource, a deploy
 * command exists to be checked against, and it does not acknowledge named IAM.
 * A repo whose deployment the charrette cannot see is a repo this says nothing
 * about — guessing there would put a paragraph in front of QA on every task
 * that touches a YAML file, and a gate that cries on ordinary work is one
 * nobody reads by the third task.
 */
export function scanDeployCapability(changed: SourceFile[], deployers: SourceFile[]): CapabilityFinding[] {
  const templates = changed
    .filter((f) => TEMPLATE_FILE.test(f.path))
    .map((f) => ({ path: f.path, resources: namedIamResources(f.text) }))
    .filter((t) => t.resources.length > 0);
  if (!templates.length) return [];

  const findings: CapabilityFinding[] = [];
  for (const deployer of deployers) {
    const capabilities = deployCapabilities(deployer.text);
    if (!capabilities || capabilities.includes("CAPABILITY_NAMED_IAM")) continue;
    for (const template of templates) {
      findings.push({ template: template.path, deployer: deployer.path, capabilities, resources: template.resources });
    }
  }
  return findings;
}

/**
 * The paragraph QA reads — the finding, and the two directions the fix can go.
 *
 * Written as an instruction rather than an observation because the reader has
 * to act on it in this task or not at all. Which direction is right is a
 * question about the work, not about CloudFormation: a name that something
 * outside the stack refers to has to stay, and a name nothing refers to was
 * probably not worth having.
 */
export function renderDeployCapability(findings: CapabilityFinding[]): string {
  if (!findings.length) return "";
  const lines: string[] = ["Deploy capability — this change declares infrastructure the repo's own deploy command cannot create:"];
  for (const f of findings) {
    lines.push(
      `  ${f.template} names ${f.resources.map((r) => `${r.logicalId} (${r.type}, via ${r.via})`).join(", ")}`,
      `  ${f.deployer} deploys with ${f.capabilities.length ? f.capabilities.join(" ") : "no --capabilities at all"}`
    );
  }
  lines.push(
    "",
    "CloudFormation splits the IAM acknowledgement in two: it generates the physical name",
    "for a resource under CAPABILITY_IAM, and requires CAPABILITY_NAMED_IAM for one the",
    "template names itself. Deploying with only the first fails the changeset with",
    '`Requires capabilities : [CAPABILITY_NAMED_IAM]` — and it fails there and nowhere',
    "earlier, because capabilities are an argument to CreateChangeSet rather than a property",
    "of the template. `sam validate`, `sam build`, `cfn-lint` and a green suite all pass on a",
    "template that cannot be deployed, so the first report of this is the operator's",
    "deployment failing after the merge, with every later push stuck behind it.",
    "",
    "Send it back to be fixed in this task, in whichever direction the work intends:",
    "  - add CAPABILITY_NAMED_IAM alongside CAPABILITY_IAM in the deploy command — both, as",
    "    the named one does not subsume the plain one and generated roles still need it; or",
    "  - drop the explicit name and let CloudFormation generate it, if nothing outside the",
    "    stack refers to that resource by name. A grant a human attaches by ARN does.",
    "",
    "This is a FAIL rather than a note. Nothing downstream of you checks it."
  );
  return lines.join("\n");
}
