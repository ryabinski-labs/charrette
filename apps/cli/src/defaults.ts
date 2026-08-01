import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

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
export function detectChecks(repo: string): DetectedChecks {
  const pkg = readJson(path.join(repo, "package.json"));
  const scripts = pkg?.scripts;
  if (scripts && typeof scripts === "object") {
    const table = scripts as Record<string, unknown>;
    const present = NODE_SCRIPTS.filter((s) => typeof table[s] === "string");
    // `typecheck` and `type-check` are the same intent — never run both.
    const picked = present.filter((s) => !(s === "type-check" && present.includes("typecheck")));
    if (picked.length > 0) {
      const pm = packageManager(repo);
      return { checks: picked.map((s) => `${pm} run ${s}`), source: `package.json scripts via ${pm}` };
    }
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
    workerRespawnCap: z.number().int().min(1).max(3).optional(),
    taskWallClockMinutes: z.number().int().min(5).optional(),
    models: z
      .object({
        intake: z.string().optional(),
        planner: z.string().optional(),
        worker: z.string().optional(),
        qa: z.string().optional(),
        integrator: z.string().optional(),
      })
      .optional(),
    budget: z
      .object({
        runCapUsd: z.number().positive().optional(),
        taskCapUsd: z.number().positive().optional(),
      })
      .optional(),
    skillsDirs: z.array(z.string()).optional(),
    githubRepo: z.string().optional(),
    deterministicChecks: z.array(z.string()).optional(),
    dashboard: z.boolean().optional(),
    chat: z.boolean().optional(),
  })
  .strict();
export type FileConfig = z.infer<typeof FileConfig>;

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
