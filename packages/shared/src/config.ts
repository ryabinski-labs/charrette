import { z } from "zod";

export const ModelRouting = z.object({
  planner: z.string().default("claude-opus-5"),
  worker: z.string().default("claude-sonnet-5"),
  qa: z.string().default("claude-sonnet-5"),
  integrator: z.string().default("claude-sonnet-5"),
});

export const Budget = z.object({
  runCapUsd: z.number().positive().default(30),
  taskCapUsd: z.number().positive().default(10),
});

export const RunConfig = z.object({
  maxParallelWorkers: z.number().int().min(1).max(16).default(1),
  qaIterationCap: z.number().int().min(1).max(3).default(3),
  workerRespawnCap: z.number().int().min(1).max(3).default(3),
  taskWallClockMinutes: z.number().int().min(5).default(45),
  models: ModelRouting.default({}),
  budget: Budget.default({}),
  skillsDirs: z.array(z.string()).default([]),
  githubRepo: z.string().optional(),
  deterministicChecks: z.array(z.string()).default([]),
});
export type RunConfig = z.infer<typeof RunConfig>;
