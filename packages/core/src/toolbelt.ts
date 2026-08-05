import { accessSync, constants } from "node:fs";
import path from "node:path";

/**
 * External CLIs a worker or QA agent may use inside its worktree.
 *
 * Workers already have Bash and inherit the operator's PATH, so these have
 * always been *reachable* — but an agent does not try a tool it was never told
 * about, and it will not guess that `podman` is the way to stand up a test
 * environment. Detection is by PATH lookup in this process, so what is
 * advertised is exactly what the agent will find.
 *
 * `use` doubles as the guardrail: it is pasted into the system prompt verbatim,
 * so anything an agent must not do with a tool belongs there.
 */
export interface ExternalTool {
  name: string;
  path: string;
  use: string;
}

const CANDIDATES: { name: string; use: string }[] = [
  {
    name: "gh",
    use: "GitHub CLI, already authenticated. READ ONLY: `gh issue view`, `gh run view/log`, `gh api` GETs. Never `gh pr create`, `gh pr merge`, `gh repo` writes, or anything that pushes — the harness owns integration.",
  },
  {
    name: "aws",
    use: "AWS CLI with the operator's live credentials. READ ONLY unless the task spec names the exact resource to change: describe/list/get calls are fine, and so is anything against a localstack or sandbox endpoint. Never delete, terminate, scale, or modify a resource you did not create.",
  },
  {
    name: "terraform",
    use: "Infrastructure as code. `init -backend=false`, `fmt -check`, `validate` and `plan` are the verification loop — run them, they are how an IaC change is checked. NEVER `apply`, `destroy`, `import`, `state mv/rm`, or `taint`: those change the operator's real infrastructure. You write reviewed configuration; a human applies it.",
  },
  {
    name: "tofu",
    use: "OpenTofu, the Terraform fork — same commands, same rule. `init -backend=false`, `fmt -check`, `validate`, `plan` yes; `apply`/`destroy`/`import`/`state` writes never.",
  },
  {
    name: "kubectl",
    use: "Kubernetes. `--dry-run=server` (or `-o yaml`) validates a manifest against the live API without changing anything, and `kubectl explain` settles schema questions — use both. Read verbs (get/describe/logs/diff) are fine. NEVER apply/create/delete/patch/scale/rollout without --dry-run: the cluster is production.",
  },
  {
    name: "helm",
    use: "Helm charts. `helm lint`, `helm template` and `helm install --dry-run` render and check a chart without touching a cluster. NEVER `install`, `upgrade`, `rollback` or `uninstall` for real.",
  },
  {
    name: "pulumi",
    use: "Infrastructure as code. `pulumi preview` is the check. NEVER `pulumi up`, `destroy`, or `state` writes.",
  },
  {
    name: "cdk",
    use: "AWS CDK. `cdk synth` (emits the CloudFormation template — read it, that is the real artifact) and `cdk diff` are the checks. NEVER `cdk deploy` or `cdk destroy`.",
  },
  {
    name: "gcloud",
    use: "Google Cloud CLI with the operator's live credentials. READ ONLY: describe/list/get. Many commands take `--dry-run` or `--validate-only` — prefer those. Never create, delete, or update a resource.",
  },
  {
    name: "az",
    use: "Azure CLI with the operator's live credentials. READ ONLY: show/list. `az deployment ... what-if` and `--validate-only` check a template without deploying it. Never create, delete, or update a resource.",
  },
  {
    name: "conftest",
    use: "Policy checks over IaC and manifests (`conftest test <dir>`). If the repo ships policies, an infra change is not verified until they pass.",
  },
  {
    name: "checkov",
    use: "Static security scanning for IaC (`checkov -d <dir>`). Catches the class of defect a plan never shows: public ingress, unencrypted volumes, IAM wildcards, missing deletion protection.",
  },
  {
    name: "tflint",
    use: "Terraform linter (`tflint --recursive`). Provider-aware, so it catches invalid instance types and deprecated arguments that `terraform validate` accepts.",
  },
  {
    name: "podman",
    use: "Containers. Use `podman compose up -d` (or `podman run`) to stand up the app and its dependencies for a real end-to-end check instead of guessing. Tear down what you start.",
  },
  {
    name: "docker",
    use: "Containers, if the repo requires Docker specifically. Prefer podman when both are present. Tear down what you start.",
  },
  {
    name: "playwright",
    use: "Headless browser — the only way to see a rendered page. `playwright screenshot --wait-for-timeout=2000 <url> <file.png>` captures what a user would actually see; a curl of the same URL is not a screenshot and must not be reported as one. `--full-page` for the whole scrollable page, `--device 'iPhone 15'` for mobile, `--save-har <file.har>` to record the requests behind it. If it reports a missing browser, `playwright install chromium`. Local URLs only — never drive a production site or sign into a real account.",
  },
  {
    name: "adb",
    use: "Android debug bridge: install, launch and drive the app on a running emulator.",
  },
  {
    name: "emulator",
    use: "Android emulator. `emulator -list-avds`, then `emulator -avd <name> -no-snapshot -no-boot-anim &` and wait for `adb shell getprop sys.boot_completed`.",
  },
  {
    name: "xcrun",
    use: "iOS simulator via `xcrun simctl` (list/boot/install/launch), and other Xcode tooling.",
  },
  {
    name: "maestro",
    use: "Cross-platform mobile UI flows — the lightest way to drive a booted emulator or simulator end to end.",
  },
];

/** First PATH entry holding an executable named `name`. */
export function onPath(name: string, pathVar: string): string | null {
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here — keep looking
    }
  }
  return null;
}

/**
 * The tools present on this machine, optionally narrowed to an allowlist.
 * `allow` of `[]` disables the toolbelt entirely; undefined means everything found.
 */
export function detectToolbelt(allow?: string[], env: NodeJS.ProcessEnv = process.env): ExternalTool[] {
  if (allow?.length === 0) return [];
  const pathVar = env.PATH ?? "";
  const wanted = allow ? CANDIDATES.filter((c) => allow.includes(c.name)) : CANDIDATES;
  const found: ExternalTool[] = [];
  for (const candidate of wanted) {
    const resolved = onPath(candidate.name, pathVar);
    if (resolved) found.push({ ...candidate, path: resolved });
  }
  return found;
}

/** Prompt fragment listing the toolbelt. Empty string when nothing was found. */
export function toolbeltBlock(tools: ExternalTool[]): string {
  if (!tools.length) return "";
  const lines = tools.map((t) => `- \`${t.name}\` — ${t.use}`);
  return `\nExternal tools available on this machine (via Bash, already installed and authenticated as the operator):\n${lines.join(
    "\n"
  )}\nThey run as the operator, against their real accounts. Treat anything outside your worktree as production unless the task says otherwise.`;
}
