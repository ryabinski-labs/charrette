import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SUBPROJECT_DIRS } from "@harness/core";
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

export function detectChecks(repo: string): DetectedChecks {
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
    /** Ceiling on any one deterministic check. Distinct from `checkTimeoutMinutes`, which is how long to wait on the repo's own CI. */
    deterministicCheckTimeoutMinutes: z.number().positive().max(240).optional(),
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
