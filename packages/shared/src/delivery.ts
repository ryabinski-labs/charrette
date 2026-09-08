import { z } from "zod";

/** Authority is configuration supplied by the operator, never planner output. */
export const DeliveryConfig = z.object({
  mode: z.enum(["review", "production"]).default("review"),
  releaseId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/).default("default"),
  merge: z.enum(["manual", "auto"]).default("manual"),
  prdSha256: z.string().default(""),
  revisionPath: z.string().startsWith("/").default("/.well-known/harness-release"),
  /** Empty means read-only. Nonempty authorizes writes only within this isolated test scope. */
  productionTestScope: z.string().default(""),
  mergeTimeoutMinutes: z.number().min(0).max(1440).default(60),
  validationTimeoutMinutes: z.number().positive().max(1440).default(30),
  fixRounds: z.number().int().min(0).max(5).default(2),
});
export type DeliveryConfig = z.infer<typeof DeliveryConfig>;

/** Derived before implementation, reviewed with the plan, frozen across runs. */
export const ReleaseVerification = z.object({
  deploymentChecks: z.array(z.string().min(1)).default([]),
  productionCommand: z.string().default(""),
  productionScenarioIds: z.array(z.string().min(1)).default([]),
  /** Describes the real deployment topology the acceptance tests must exercise. */
  environment: z.string().default(""),
});

export const ReleaseEvidence = z.object({
  releaseId: z.string(),
  phase: z.enum(["contract", "skeleton", "merge", "deploy", "production"]),
  verdict: z.enum(["passed", "failed", "blocked"]),
  sha: z.string().default(""),
  url: z.string().default(""),
  requirements: z.array(z.string()).default([]),
  unmet: z.array(z.string()).default([]),
  evidencePath: z.string().default(""),
});
export type ReleaseEvidence = z.infer<typeof ReleaseEvidence>;
