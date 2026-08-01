import { z } from "zod";

export const ModelRouting = z.object({
  intake: z.string().default("claude-opus-5"),
  planner: z.string().default("claude-opus-5"),
  worker: z.string().default("claude-sonnet-5"),
  qa: z.string().default("claude-sonnet-5"),
  integrator: z.string().default("claude-sonnet-5"),
  /** Drafts the operator's answer when a task escalates (Gate: task-escalation). */
  advisor: z.string().default("claude-sonnet-5"),
});

export const Budget = z.object({
  runCapUsd: z.number().positive().default(30),
  taskCapUsd: z.number().positive().default(10),
});

export const RunConfig = z.object({
  // PRD §11.5: default 3. Independent DAG tasks run concurrently, each in its
  // own worktree; runs recorded before the parallel scheduler keep whatever
  // value is frozen in their config.
  maxParallelWorkers: z.number().int().min(1).max(16).default(3),
  qaIterationCap: z.number().int().min(1).max(3).default(3),
  workerRespawnCap: z.number().int().min(1).max(3).default(3),
  taskWallClockMinutes: z.number().int().min(5).default(45),
  models: ModelRouting.default({}),
  budget: Budget.default({}),
  skillsDirs: z.array(z.string()).default([]),
  githubRepo: z.string().optional(),
  /**
   * The branch the run started from. Component PRs target this, not the run's
   * integration branch: the integrator merges every accepted task into the
   * integration branch before opening its PR, so a PR based there has no commits
   * of its own and GitHub rejects it. Basing on the start branch is also what
   * makes the PR mergeable by a human, which is the point of opening it.
   * Empty when HEAD is detached — PRs are then skipped rather than guessed at.
   */
  baseBranch: z.string().default(""),
  /**
   * How merged work is published. Task branches are cut from the integration
   * branch, so each one carries every merge that landed before it — per-task
   * PRs against the base overlap until the last one is nearly the whole run.
   * "single" (default) opens one PR from the integration branch: the complete
   * diff exactly once, and exactly the tree the intent validator judged.
   * "per-task" keeps the one-PR-per-task behaviour.
   */
  prMode: z.enum(["single", "per-task"]).default("single"),
  deterministicChecks: z.array(z.string()).default([]),
  /**
   * External CLIs (gh, aws, podman, adb, …) advertised to worker and QA agents.
   * Omit for everything found on PATH; `[]` to tell them about nothing.
   */
  externalTools: z.array(z.string()).optional(),
});
export type RunConfig = z.infer<typeof RunConfig>;
