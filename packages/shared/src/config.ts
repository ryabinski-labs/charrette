import { z } from "zod";

export const ModelRouting = z.object({
  intake: z.string().default("claude-opus-5"),
  planner: z.string().default("claude-opus-5"),
  worker: z.string().default("claude-sonnet-5"),
  qa: z.string().default("claude-sonnet-5"),
  integrator: z.string().default("claude-sonnet-5"),
  /** Drafts the operator's answer when a task escalates (Gate: task-escalation). */
  advisor: z.string().default("claude-sonnet-5"),
  /** Judges the deployed system against the assignment. The last word, so: Opus. */
  prod: z.string().default("claude-opus-5"),
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
  /**
   * How many turns a QA session gets before the SDK cuts it off.
   *
   * A QA agent that runs out of turns never writes its verdict, and a task can
   * only be judged by a QA session that finished. Sixty turns is plenty to read
   * a diff and run `tsc && jest`; it is not enough where verifying means booting
   * an emulator or building an image, so this is a per-repo knob. The retry also
   * raises it on its own (see `dispatchTask`) — a ceiling that was too low once
   * is too low twice.
   */
  qaMaxTurns: z.number().int().min(20).max(300).default(90),
  /**
   * How many turns a worker session gets before the SDK cuts it off.
   *
   * The same knob as `qaMaxTurns`, for the role that actually keeps hitting the
   * wall: one run lost $65 across 17 worker sessions to `error_max_turns`
   * against $14 across 8 QA sessions, and the worker's ceiling was hardcoded
   * where QA's was configurable. A worker dies at the ceiling having done the
   * most work of any session in the run, and the re-dispatch starts over.
   * Raised on retry too — a ceiling that truncated once truncates twice.
   */
  workerMaxTurns: z.number().int().min(20).max(400).default(120),
  workerRespawnCap: z.number().int().min(1).max(3).default(3),
  taskWallClockMinutes: z.number().int().min(5).default(45),
  models: ModelRouting.default({}),
  budget: Budget.default({}),
  skillsDirs: z.array(z.string()).default([]),
  /**
   * Skills bound to a class of work, by name, ahead of any scoring.
   *
   * Lexical matching alone cannot decide this. Measured against a real 47-skill
   * corpus and a 36-task payments plan, the top match for the sanctions-screening
   * task was `testimonial-collector`, for card tokenization `branding-manager`,
   * for a state machine `cartographer` — each scoring *above* every genuinely
   * relevant skill, with and without idf weighting, matching on descriptions or
   * on bodies. No threshold separates those, because the ranking itself is noise:
   * a backend task has no lexical neighbour in a corpus of marketing and ops
   * skills, so the matcher returns the nearest thing rather than nothing.
   *
   * So the operator says it outright. `when` is a case-insensitive regular
   * expression tested against the task's title and spec; every named skill that
   * exists in `skillsDirs` is injected, and scoring only fills what is left.
   */
  skillRouting: z
    .array(z.object({ when: z.string(), skills: z.array(z.string()) }))
    .default([
      // First, because both of these lose the per-role cap to the architecture
      // rule otherwise. A DNS task and a greenfield task both match the
      // architecture vocabulary, and that rule alone fills all four slots — so
      // the one skill that knows the actual answer would be the one dropped.
      {
        when: "\\b(dns|dns-project|nameservers?|name server|cname|txt record|mx record|zone file|subdomain|apex domain|custom domain|cert-?manager|clusterissuer|dns-?01|let'?s encrypt|route ?53)\\b",
        skills: ["dns-project-iac-engineer"],
      },
      {
        when: "\\b(greenfield|from scratch|scaffold\\w*|boilerplate|new (project|service|application)|tech(nology)? stack|stack (choice|selection)|dynamodb|magic[- ]link|webauthn|passwordless|serverless|lambda|cloudfront|api gateway)\\b",
        skills: ["fullstack-app"],
      },
      {
        when: "\\b(architect(ure|ural)?|system design|data model|schema design|infrastructur\\w*|terraform|cloudformation|kubernetes|k8s|deployment topology|scalab\\w+|throughput|latency|capacity)\\b",
        skills: ["architect", "security-engineer", "performance-engineer", "frontend-design"],
      },
      {
        when: "\\b(ui|ux|frontend|front-end|dashboard|console|web page|landing|component|css|styling|layout|responsive|accessib\\w+|design system)\\b",
        skills: ["frontend-design", "ui-ux-cx-engineer"],
      },
      {
        when: "\\b(product|roadmap|prioriti\\w+|user stor(y|ies)|onboarding|activation|retention|churn|pricing|monetiz\\w+|scope|mvp|kpi|north star|funnel|success metric)\\b",
        skills: ["product-manager"],
      },
      {
        when: "\\b(marketing|campaign|brand(ing)?|copy(writing)?|messaging|positioning|seo|content strategy|newsletter|social media|launch|press|announcement)\\b",
        skills: ["marketing-director", "branding-manager"],
      },
      {
        when: "\\b(sales|selling|conversion|upsell|cross-sell|lead gen\\w*|crm|pipeline|quote|discount|paywall|trial|subscription tier|checkout funnel)\\b",
        skills: ["online-sales-specialist"],
      },
      {
        when: "\\b(focus group|persona panel|user research|customer interview|usability (test|study)|voice of (the )?customer|survey)\\b",
        skills: ["persona-panel"],
      },
    ]),
  /**
   * Skills a role always carries, whatever the text says.
   *
   * `skillRouting` binds a skill to a *topic*; this binds one to a *job*. The
   * distinction matters for the agents whose whole output is a product decision:
   * the intake agent decides what gets built and the planner decides how it is
   * cut up, and neither of those is reliably signalled by a keyword in the
   * operator's one-line assignment. "Add rate limiting" contains no product
   * vocabulary and is still a product decision.
   *
   * Keyed by role (`intake`, `planner`, `worker`, `qa`, `prod`). Named skills
   * absent from `skillsDirs` are ignored, and these count against the same
   * per-role cap as routed and scored skills.
   */
  roleSkills: z
    .record(z.string(), z.array(z.string()))
    .default({ intake: ["product-manager"], planner: ["product-manager"] }),
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
   * Wait for the pull request's own checks before calling the run finished.
   *
   * The deterministic checks prove one task's worktree was green in isolation;
   * the repo's CI is the only thing that judges the merged branch the way the
   * repo does — including the conflicts and the workflow steps no worktree ever
   * runs. A run that reports "1 pull request open for review" over a red branch
   * has told the operator the opposite of the truth. Off skips the wait.
   */
  waitForChecks: z.boolean().default(true),
  /** How long to wait for those checks before reporting them as still pending. */
  checkTimeoutMinutes: z.number().int().min(1).max(120).default(20),
  /**
   * The live URL this repo deploys to. Set it and a run does not end at the
   * pull request: once a human merges, the harness follows the deploy and sends
   * an agent to check the running system against the original assignment.
   *
   * Empty (the default) keeps the old behaviour — the run ends at PR_REVIEW.
   */
  prodUrl: z.string().default(""),
  /** How long to wait for the merge commit's deploy before giving up on it. */
  deployTimeoutMinutes: z.number().int().min(1).max(240).default(30),
  /**
   * External CLIs (gh, aws, podman, adb, …) advertised to worker and QA agents.
   * Omit for everything found on PATH; `[]` to tell them about nothing.
   */
  externalTools: z.array(z.string()).optional(),
});
export type RunConfig = z.infer<typeof RunConfig>;
