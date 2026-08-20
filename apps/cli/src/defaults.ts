import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SUBPROJECT_DIRS, scanCiChecks, type CiCheck, type SkippedStep } from "@harness/core";
import { PitStopConfig, PlanGateConfig, SubscriptionConfig, TaskGateConfig } from "@harness/shared";

export const CONFIG_FILENAME = "harness.config.json";

export const DEFAULT_SKILLS_DIRS = [
  path.join(os.homedir(), ".claude", "skills"),
  path.join(os.homedir(), "skills"),
];

/** Expand a leading `~` so config files can stay machine-independent. */
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Walk up from `start` to the enclosing git repository root, so the CLI works
 * from any subdirectory. `.git` may be a directory or (in a worktree) a file.
 */
export function resolveRepoRoot(start: string): string {
  let dir = path.resolve(expandHome(start));
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `${path.resolve(expandHome(start))} is not inside a git repository.\n` +
      `cd into the target repo, or pass --repo <path>.`
  );
}

export interface DetectedChecks {
  checks: string[];
  /** Human-readable provenance, shown in the run banner. */
  source: string;
  /**
   * CI steps that were read and not lifted, with the reason — so a repository
   * whose pipeline is mostly shell scripts can see that this covered two jobs
   * of its seven rather than believing it covered them all.
   */
  skipped: SkippedStep[];
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function packageManager(repo: string): string {
  if (existsSync(path.join(repo, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(repo, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(repo, "bun.lockb")) || existsSync(path.join(repo, "bun.lock"))) return "bun";
  return "npm";
}

/** Script names worth running before QA, in the order we want them to run. */
const NODE_SCRIPTS = ["typecheck", "type-check", "lint", "test"];

/**
 * Infer deterministic checks from the target repo so a bare `harness run` still
 * gives QA a hard signal. Only conventional, non-destructive commands are
 * inferred; anything else must be passed explicitly with --check.
 */
// Shared with the dependency seeder on purpose: checks inferred for a directory
// the seeder does not install into are a red baseline in every worktree.

/** Node scripts worth running in `dir` (relative to the repo), or [] if none. */
function nodeScriptsIn(repo: string, dir: string): { checks: string[]; pm: string } {
  const root = path.join(repo, dir);
  const scripts = readJson(path.join(root, "package.json"))?.scripts;
  if (!scripts || typeof scripts !== "object") return { checks: [], pm: "" };
  const table = scripts as Record<string, unknown>;
  const present = NODE_SCRIPTS.filter((s) => typeof table[s] === "string");
  // `typecheck` and `type-check` are the same intent — never run both.
  const picked = present.filter((s) => !(s === "type-check" && present.includes("typecheck")));
  if (picked.length === 0) return { checks: [], pm: "" };
  // Prefer the lockfile next to the manifest, falling back to the repo root's.
  const pm = packageManager(existsSync(path.join(root, "pnpm-lock.yaml")) || existsSync(path.join(root, "yarn.lock")) ? root : repo);
  const prefix = dir ? `cd ${dir} && ` : "";
  return { checks: picked.map((s) => `${prefix}${pm} run ${s}`), pm };
}

/**
 * The checks a repository's language convention implies, when nothing better
 * is available. `pnpm run test` because there is a `test` script; `cargo test`
 * because there is a `Cargo.toml`.
 */
function conventionChecks(repo: string): { checks: string[]; source: string } {
  const root = nodeScriptsIn(repo, "");
  if (root.checks.length > 0) {
    return { checks: root.checks, source: `package.json scripts via ${root.pm}` };
  }
  // Every subproject, not the first one found. A repo shaped `frontend/` +
  // `backend/` used to get checks for whichever came first in this list and
  // none at all for the other half of the product — QA's only hard signal,
  // silently covering half the code.
  const subs = SUBPROJECT_DIRS.map((dir) => ({ dir, ...nodeScriptsIn(repo, dir) })).filter((s) => s.checks.length > 0);
  if (subs.length > 0) {
    return {
      checks: subs.flatMap((s) => s.checks),
      source: subs.map((s) => `${s.dir}/package.json scripts via ${s.pm}`).join(", "),
    };
  }
  if (existsSync(path.join(repo, "Cargo.toml"))) {
    return { checks: ["cargo test", "cargo clippy -- -D warnings"], source: "Cargo.toml" };
  }
  if (existsSync(path.join(repo, "go.mod"))) {
    return { checks: ["go build ./...", "go test ./..."], source: "go.mod" };
  }
  return { checks: [], source: "no conventional checks found" };
}

/** Every workflow file in `.github/workflows`, or none if the directory is absent. */
export function readWorkflows(repo: string): { path: string; text: string }[] {
  const dir = path.join(repo, ".github", "workflows");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n));
  } catch {
    return [];
  }
  const files: { path: string; text: string }[] = [];
  for (const name of names.sort()) {
    try {
      files.push({ path: `.github/workflows/${name}`, text: readFileSync(path.join(dir, name), "utf8") });
    } catch {
      // A workflow that cannot be read is one fewer check, not a failed run.
    }
  }
  return files;
}

/** The tool and verb a check is about — `cargo test`, `pnpm run lint`, `go build`. */
function intent(command: string): string {
  // The directory is part of it. A monorepo runs `npm run test` at the root and
  // `cd site && npm run test` in the site, and those are two suites over two
  // trees — collapsing them drops one of them on the floor.
  const cd = /^cd\s+(\S+)\s*&&\s*/.exec(command);
  const words = command.slice(cd ? cd[0].length : 0).split(/\s+/).filter((w) => !w.startsWith("-"));
  // `pnpm run lint` and `pnpm run test` are two different checks; `cargo test`
  // and `cargo build` already differ at the verb.
  return `${cd ? cd[1] : ""}\u0000${words.slice(0, words[1] === "run" ? 3 : 2).join(" ")}`;
}

/**
 * Infer deterministic checks from the target repo so a bare `harness run` still
 * gives QA a hard signal.
 *
 * The repository's own pipeline comes first, because that is the thing the
 * run's pull request will actually be graded by: a check the harness runs in a
 * worktree and CI does not is a check nobody asked for, and a check CI runs and
 * the harness does not is a red pull request found by a human. Convention fills
 * the gaps — a `cargo test` for a repo whose CI only lints — but never
 * duplicates a tool and verb CI already covers, since running `cargo test` and
 * `cargo test --workspace --all-features --locked` in the same worktree pays
 * twice for one answer.
 *
 * Nothing here asks whether the machine can run what it names. `harness init`
 * does, by running them; see `verifyChecks`.
 */
export function detectChecks(repo: string): DetectedChecks {
  const convention = conventionChecks(repo);
  const ci = scanCiChecks(readWorkflows(repo));
  if (ci.checks.length === 0) return { ...convention, skipped: ci.skipped };

  const covered = new Set(ci.checks.map((c: CiCheck) => intent(c.command)));
  const extra = convention.checks.filter((c) => !covered.has(intent(c)));
  const source =
    `${ci.checks.length} step(s) from ${new Set(ci.checks.map((c: CiCheck) => c.source.split(" › ")[0])).size} CI workflow(s)` +
    (extra.length ? `, plus ${extra.length} from ${convention.source}` : "");
  return { checks: [...ci.checks.map((c: CiCheck) => c.command), ...extra], source, skipped: ci.skipped };
}

export interface VerifiedChecks {
  kept: string[];
  dropped: { command: string; reason: string }[];
}

/**
 * Run each candidate check once against the repository as it stands, and keep
 * the ones that actually work here.
 *
 * This is the gate the whole feature rests on. Lifting a command out of a
 * workflow says what CI does; it says nothing about whether this machine can do
 * it. `cargo deny` and `cargo audit` are installed by a `cargo install` step
 * that was correctly refused as setup. `npm run test:e2e` wants browsers. A
 * coverage run that takes twelve minutes will be killed by QA's own ten-minute
 * timeout on every task, forever, and be recorded as a failure each time.
 *
 * Every one of those is a check that is red before any task starts, which is
 * the single failure that parks an entire run — every task inherits it, every
 * task is blamed for it, and none of them can fix it. So a candidate is adopted
 * only after it has been watched to pass, here, in the time QA will give it,
 * and the ones that did not are printed with the reason rather than dropped
 * quietly.
 *
 * Green on the repo's current tree is not a promise it stays green: a run's
 * tasks change the code, and a check is meant to be able to go red. What this
 * rules out is the check that could never have passed.
 */
export function verifyChecks(
  repo: string,
  checks: string[],
  opts: { timeoutMs?: number; onStart?: (command: string) => void; onResult?: (command: string, ms: number, reason: string | null) => void } = {}
): VerifiedChecks {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const kept: string[] = [];
  const dropped: { command: string; reason: string }[] = [];
  for (const command of checks) {
    opts.onStart?.(command);
    const started = Date.now();
    let reason: string | null = null;
    try {
      execFileSync("sh", ["-c", command], { cwd: repo, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      const err = e as { signal?: string; stderr?: Buffer | string; stdout?: Buffer | string; message: string };
      // `err.message` is the fallback rather than a phrase of our own, because
      // the cases with no output are the ones with nothing else to go on: a
      // check that exited 1 in silence, or one that never started because the
      // directory it was pointed at is not there.
      const output = [err.stdout, err.stderr].map((b) => (b ? b.toString() : "")).join("\n").trim();
      reason =
        err.signal === "SIGTERM"
          ? `did not finish in ${Math.round(timeoutMs / 60000)} minute(s) — QA would kill it on every task`
          : firstLine(output) || firstLine(err.message);
    }
    const ms = Date.now() - started;
    opts.onResult?.(command, ms, reason);
    if (reason === null) kept.push(command);
    else dropped.push({ command, reason });
  }
  return { kept, dropped };
}

/** The line of output an operator would look at first. */
function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !/^warning:/i.test(l));
  return (line ?? "").slice(0, 160);
}

/**
 * `harness.config.json` at the repo root: per-repo defaults, committable so a
 * team shares them. Mirrors RunConfig, plus `dashboard`. Strict on purpose —
 * a typo should fail loudly rather than silently do nothing.
 */
export const FileConfig = z
  .object({
    maxParallelWorkers: z.number().int().min(1).max(16).optional(),
    qaIterationCap: z.number().int().min(1).max(3).optional(),
    qaMaxTurns: z.number().int().min(20).max(300).optional(),
    workerMaxTurns: z.number().int().min(20).max(400).optional(),
    workerRespawnCap: z.number().int().min(1).max(3).optional(),
    taskWallClockMinutes: z.number().int().min(5).optional(),
    /**
     * How long a run waits out the account's usage limit before giving up
     * (default six hours). `0` fails the moment the quota window closes.
     */
    usageLimitWaitMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
    models: z
      .object({
        intake: z.string().optional(),
        planner: z.string().optional(),
        worker: z.string().optional(),
        /** The worker model for tasks the light-tier rule admits (modelTier.ts). */
        workerLight: z.string().optional(),
        qa: z.string().optional(),
        /** Accepted and ignored: no agent is ever dispatched with it. */
        integrator: z.string().optional(),
        // The rest of the roles, which this list simply never caught up with:
        // `RunConfig` routes ten and the file accepted five, and because this
        // schema is strict the other five were not ignored but rejected —
        // `models.reviewer` in a harness.config.json failed the whole file.
        advisor: z.string().optional(),
        prod: z.string().optional(),
        demo: z.string().optional(),
        reviewer: z.string().optional(),
        pm: z.string().optional(),
        /** The two-turn re-ask that transcribes an answer already reached. */
        repair: z.string().optional(),
      })
      .optional(),
    budget: z
      .object({
        runCapUsd: z.number().positive().optional(),
        /**
         * Who answers a cap that is reached — a skill name, or `"operator"` to
         * be asked yourself, which is what this always used to do.
         */
        decidedBy: z.string().min(1).optional(),
        /**
         * How far a skill may raise the run cap. Leave it out and it's always
         * yours to raise — the run cap is the agreement.
         */
        ceilingUsd: z.number().positive().optional(),
        /** How many times a skill may raise the same cap before you are asked. */
        autoRaiseRounds: z.number().int().min(0).max(10).optional(),
      })
      .optional(),
    /**
     * The Claude subscriptions this repo's runs may spend, and how close to the
     * plan's weekly limit a run gets before it stops and asks you.
     *
     * The accounts belong in this file; the credentials do not. Write them as
     * `"$VAR"` and they are read from your shell when a session is spawned:
     *
     *   "subscription": {
     *     "accounts": [
     *       { "name": "personal", "env": { "CLAUDE_CODE_OAUTH_TOKEN": "$PERSONAL_CLAUDE_TOKEN" } },
     *       { "name": "work", "env": { "CLAUDE_CONFIG_DIR": "/Users/me/.claude-work" } }
     *     ]
     *   }
     *
     * Unlike everything else here, changes to this reach a run that has already
     * started: `harness resume --account work` is the whole point of the
     * feature, and a subscription frozen at run creation could not be swapped.
     */
    subscription: SubscriptionConfig.partial().optional(),
    /**
     * How often the run stops to demo what it has built and ask you whether it
     * is still what you wanted (docs/PITSTOP.md). Defaults to every epic.
     * `{"pitStop":{"every":"never"}}` turns it off.
     */
    pitStop: PitStopConfig.partial().optional(),
    /**
     * Who answers a task that has escalated — one that QA keeps rejecting, or
     * that is stuck on a probe it is not allowed to edit. A skill name, or
     * `"operator"` to be asked yourself, which is what this always used to do.
     *
     * Not the same thing as `budget.decidedBy`, which answers a task that has
     * run out of *money*. A task can hit either without hitting the other.
     */
    taskGate: TaskGateConfig.partial().optional(),
    /**
     * Who weighs the plan-intent check's gaps before you approve past them — a
     * skill name, or `"operator"` to be shown the list and asked, which is what
     * this always used to do. It can send the plan back; it cannot approve one.
     */
    planGate: PlanGateConfig.partial().optional(),
    skillsDirs: z.array(z.string()).optional(),
    /**
     * Which skills a class of work gets, by name. Declaring this replaces the
     * built-in table rather than extending it — the operator who writes one is
     * saying what their corpus is for, and a silent merge with defaults naming
     * skills they do not have would be harder to reason about than a list they
     * can read. Copy the default out of `RunConfig` and edit it.
     */
    skillRouting: z.array(z.object({ when: z.string(), skills: z.array(z.string()) })).optional(),
    /** Skills a role always carries, keyed by role, whatever the work says. */
    roleSkills: z.record(z.string(), z.array(z.string())).optional(),
    githubRepo: z.string().optional(),
    prMode: z.enum(["single", "per-task"]).optional(),
    deterministicChecks: z.array(z.string()).optional(),
    waitForChecks: z.boolean().optional(),
    checkTimeoutMinutes: z.number().int().min(1).max(120).optional(),
    prodUrl: z.string().optional(),
    deployTimeoutMinutes: z.number().int().min(1).max(240).optional(),
    externalTools: z.array(z.string()).optional(),
    dashboard: z.boolean().optional(),
    dashboardPort: z.number().int().min(1).max(65535).optional(),
    chat: z.boolean().optional(),
  })
  .strict();
export type FileConfig = z.infer<typeof FileConfig>;

export interface ResolvedGitHub {
  /** Undefined leaves the adapter disabled: the run stays local, no issues, no PRs. */
  token?: string;
  /** `owner/repo`. */
  slug?: string;
  /** Human-readable provenance for the run banner. Never contains the token. */
  source: string;
}

/** Run a `gh` subcommand for its stdout, or undefined if gh is missing/unauthenticated. */
function gh(cwd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync("gh", args, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

const githubCache = new Map<string, ResolvedGitHub>();

/**
 * Where the harness gets its GitHub credentials, in order: the environment, then
 * the already-authenticated `gh` CLI. Most machines have `gh` logged in, and
 * requiring GITHUB_TOKEN on top of that is the difference between a run that
 * opens PRs and one that silently does not.
 *
 * The token lives in this process only — it goes to the adapter, never into an
 * agent prompt, a log line, or the banner (SEC: no secrets in agent context).
 */
export function resolveGitHub(repo: string, configuredSlug: string | undefined): ResolvedGitHub {
  const envToken = process.env.GITHUB_TOKEN || undefined;
  const envSlug = process.env.HARNESS_GITHUB_REPO || undefined;
  // Keyed on the environment too: `gh auth token` is a subprocess worth caching,
  // but a caller that changes the environment must not get a stale answer back.
  const cacheKey = [repo, configuredSlug, envToken ? "env-token" : "", envSlug].join(" ");
  const cached = githubCache.get(cacheKey);
  if (cached) return cached;

  const token = envToken ?? gh(repo, ["auth", "token"]);
  const slug =
    envSlug ?? configuredSlug ?? gh(repo, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);

  let source: string;
  if (!token) {
    source = "off — no GITHUB_TOKEN and `gh auth login` has not been run";
  } else if (!slug) {
    source = "off — no GitHub remote found for this repo";
  } else {
    const tokenFrom = envToken ? "GITHUB_TOKEN" : "gh cli";
    const slugFrom = envSlug ? "HARNESS_GITHUB_REPO" : configuredSlug ? CONFIG_FILENAME : "gh cli";
    source = tokenFrom === slugFrom ? tokenFrom : `${tokenFrom} + ${slugFrom}`;
  }
  const resolved: ResolvedGitHub = { token, slug: token && slug ? slug : undefined, source };
  githubCache.set(cacheKey, resolved);
  return resolved;
}

export function loadFileConfig(repo: string): { config: FileConfig; path: string | null } {
  const file = path.join(repo, CONFIG_FILENAME);
  if (!existsSync(file)) return { config: {}, path: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = FileConfig.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`${file} is invalid:\n${issues}`);
  }
  return { config: parsed.data, path: file };
}
