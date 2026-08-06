import { z } from "zod";
import { routingViolations } from "./providers.js";

export const ModelRoutingShape = z.object({
  intake: z.string().default("claude-opus-5"),
  planner: z.string().default("claude-opus-5"),
  worker: z.string().default("claude-sonnet-5"),
  qa: z.string().default("claude-sonnet-5"),
  integrator: z.string().default("claude-sonnet-5"),
  /** Drafts the operator's answer when a task escalates (Gate: task-escalation). */
  advisor: z.string().default("claude-sonnet-5"),
  /** Judges the deployed system against the assignment. The last word, so: Opus. */
  prod: z.string().default("claude-opus-5"),
  /** Starts the half-built product at a pit stop and drives it. Mostly tool work. */
  demo: z.string().default("claude-sonnet-5"),
  /**
   * Reads the demo through one named lens and says whether the run is still
   * building the right thing. This is the judgment the whole pit stop exists to
   * buy, and it is judgment rather than tool work, so: Opus.
   */
  reviewer: z.string().default("claude-opus-5"),
  /**
   * Decides what the run does next at a pit stop, having read the demo and
   * every reviewer. It is the only agent in the harness whose output redirects
   * or re-plans the remaining work on its own, so it is the last place to save
   * money: Opus.
   */
  pm: z.string().default("claude-opus-5"),
});

/**
 * Any role may be pointed at another vendor except the ones `PINNED_ROLES`
 * names — see providers.ts for why each is pinned.
 *
 * Enforced here, where the config is parsed, rather than where the role is
 * dispatched. A run whose `prod` validator is misrouted would otherwise be
 * discovered by the validator itself, after every worker had been paid for;
 * this refuses at `harness run`, before the first agent spawns. The stored
 * config of an existing run cannot trip it — nothing that violates this could
 * ever have been written.
 */
export const ModelRouting = ModelRoutingShape.superRefine((models, ctx) => {
  for (const message of routingViolations(models)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  }
});

/**
 * How often the run stops and shows the operator what it has built.
 *
 * `"epic"` is the default because it is the only boundary that is about the
 * product rather than the run: a count, a budget or a clock can cut an epic in
 * half and demo something that was never meant to stand alone. The others exist
 * for plans whose epics are too coarse to be a useful checkpoint.
 */
export const PitStopEvery = z.union([
  z.literal("epic"),
  z.literal("never"),
  z.object({ tasks: z.number().int().min(1) }),
  z.object({ usd: z.number().positive() }),
  z.object({ minutes: z.number().int().min(1) }),
]);
export type PitStopEvery = z.infer<typeof PitStopEvery>;

export const PitStopConfig = z.object({
  every: PitStopEvery.default("epic"),
  /**
   * The lenses the built product is reviewed through, by skill name. Each one is
   * a separate short session, so this is also the pit stop's price: four lenses
   * is four reviews. Skills absent from `skillsDirs` still get their lens — the
   * name alone tells the reviewer which hat to wear — but they read far better
   * with the operator's own playbook in front of them.
   *
   * `ui-ux-cx-engineer` is here because the pit stop is the only place anyone
   * looks at the whole product at once. Task-level QA judges one screen against
   * one task's criteria and cannot see that six of them disagree about spacing,
   * button weight and where the primary action lives. It is also newly worth
   * paying for: the demo agent could not photograph anything until it was given
   * a browser, so this lens would have been reviewing prose.
   */
  reviewers: z
    .array(z.string())
    .max(4)
    .default(["product-manager", "critical-challenger", "qa-agent", "ui-ux-cx-engineer"]),
  /**
   * The demo agent's turn ceiling. It has to start a product it has never seen
   * and drive it, which is the expensive half of a pit stop; a ceiling that is
   * too low produces a report that says only "I could not start it".
   */
  demoMaxTurns: z.number().int().min(20).max(200).default(80),
  /**
   * Who decides what the run does next, by skill name — or `"operator"` to be
   * asked, which is what this used to be unconditionally.
   *
   * A pit stop already buys four opinions from four named lenses. What it did
   * with them was print them and block until a human typed a letter, which
   * means the checkpoint only works while someone is watching: the run that
   * stops at 2am for a decision its own reviewers had already made is a run
   * that has stopped, and the operator wakes to a demo, four reviews and no
   * progress. The named skill reads the same report and answers the same four
   * ways, so the checkpoint keeps its judgment and loses its dependence on
   * someone being awake for it.
   *
   * The operator is not cut out of anything they had: the report is still
   * written, still published, and the decision and its reasoning are recorded
   * next to it. What they lose is having to be there.
   *
   * A decider that fails, or answers with something that is not one of the four
   * actions, falls back to asking — a pit stop is never resolved by a guess.
   */
  decidedBy: z.string().min(1).default("product-manager"),
  /**
   * How many times the closing pit stop may send the run back to work before
   * the next one goes to the operator whatever `decidedBy` says.
   *
   * The closing pit stop is the one that repeats. Every other pit stop happens
   * at a new point in the plan — a decider that redirects at three consecutive
   * epics is doing its job — but this one fires on a FAIL from the intent
   * check, and "back to work" returns the run to the same verdict on a tree it
   * has already judged. Answered by a human that loop ends when they lose
   * patience; answered by an agent it ends when the run hits its cap, having
   * paid for a demo, four reviewers, a decider and a round of workers each time
   * round. Two goes, and then the question is one only a person can settle.
   */
  backToWorkRounds: z.number().int().min(0).max(10).default(2),
});
export type PitStopConfig = z.infer<typeof PitStopConfig>;

export const Budget = z.object({
  runCapUsd: z.number().positive().default(30),
  taskCapUsd: z.number().positive().default(10),
});

/**
 * The vocabulary of user-interface work, written once because three rules match
 * on it. Splitting the UI rule by role is the point — see `skillRouting` — and
 * three copies of a regex this long is three chances for them to drift apart.
 */
// Deliberately excludes `brand`, `logo` and `visual identity`: those are the
// marketing rule's words, that rule sits below this one, and a branding task
// that tripped both would spend its four slots on frontend skills and drop
// `branding-manager` at the cap. Design-system vocabulary is named instead.
//
// Tuned for precision rather than recall, which is the opposite of how a
// keyword gate is usually written — because since `INTERFACE_STANDARD` the
// craft rules reach every worker unconditionally, from the prompt. This regex
// no longer decides whether a task gets design guidance at all; it decides
// whether it also gets two 200-line playbooks, against a four-skill cap. A miss
// now costs depth. A false positive costs a slot on a task with no surface, and
// that slot is the one the genuinely relevant skill needed.
//
// So the ambiguous words are qualified rather than dropped: bare `table` is a
// database table far more often than a data grid, bare `graph` is a dependency
// graph, bare `toggle` is a feature flag, and `page` is pagination whenever it
// is followed by size/token/cursor/number. `form` is excluded before "of" for
// the same reason — "in the form of" appears in ordinary prose.
// Every countable noun here carries `s?`, which the original vocabulary did
// not: `\bicon\b` does not match "icons", so "Replace the emoji with proper
// icons" routed nowhere, and neither did "responsive components". A gate that
// depends on a planner writing the singular is not a gate.
const UI_WHEN =
  "\\b(" +
  // Surfaces and the design system itself.
  "ui|ux|frontend|front-end|dashboards?|console|web pages?|landing|components?|css|styling|layouts?|responsive|" +
  "accessib\\w+|design systems?|design tokens?|design language|style guides?|screens?|themes?|palettes?|" +
  "typograph\\w+|wordmarks?|pages?(?! ?(size|token|cursor|number))|" +
  // Controls a person points at. The rule about using the app's own components,
  // and the one about scaling a control to its data, are only checkable when a
  // task that names the control rather than the container still routes.
  "buttons?|forms?(?! of)|input fields?|text fields?|dropdowns?|drop-?downs?|combo ?box(es)?|autocomplete|" +
  "typeahead|date ?pickers?|checkbox(es)?|radio groups?|toggle switch(es)?|sliders?|modals?|dialogs?|" +
  "tooltips?|popovers?|toasts?|snackbars?|banners?|hero|breadcrumbs?|nav|navbars?|navigation|sidebars?|" +
  "menus?|tab bars?|steppers?|wizards?|data ?tables?|table views?|list views?|grid views?|charts?|" +
  "visuali[sz]ations?|icons?|iconograph\\w+|avatars?|" +
  // The states everyone forgets, and the polish that separates a screen that
  // works from one that is pleasant to use.
  "empty states?|loading states?|error states?|spinners?|placeholders?|helper text|microcopy|onboarding|" +
  "dark mode|light mode|contrast ratios?|focus states?|hover states?|animations?|micro-?interactions?|" +
  // Where it is looked at.
  "mobile|ios|android|tablet|touch targets?|safe areas?" +
  ")\\b";

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
  /**
   * How long a single agent session may spend waiting for the account's usage
   * limit to reset before it gives up and reports the failure.
   *
   * Per session, not per run: the limit is account-wide, so a run long enough to
   * meet two quota windows would have its second one refused by a budget the
   * first had spent. What this bounds is how long any one session is allowed to
   * go quiet; a long run can survive several outages, each of them this long.
   *
   * A quota window closing is not a fault in the work: every session in flight
   * dies at once with "You've hit your session limit · resets 8:20pm", and the
   * only remedy is time. Read as an ordinary error it ends runs — three planner
   * attempts inside one second, `harness: fatal`, and an intake conversation the
   * operator sat through thrown away with it.
   *
   * Six hours covers a five-hour window reached at its very start, with slack
   * for a message quoting a reset the account then honours a little late. Longer
   * suits an operator who leaves runs going overnight and wants a weekly limit
   * slept through too; `0` restores the old behaviour of failing immediately.
   */
  usageLimitWaitMinutes: z.number().int().min(0).max(7 * 24 * 60).default(360),
  models: ModelRouting.default({}),
  budget: Budget.default({}),
  /**
   * How often the run stops, demos what it has built, and asks the operator
   * whether it is still the thing they wanted. See docs/PITSTOP.md.
   *
   * On by default, at every epic boundary. The two runs that motivated this
   * both produced accurate findings — a broken endpoint seam, a $721 tree
   * nobody could describe — that arrived only after the money was spent, and
   * the harness had no checkpoint between "approve this plan" and "here is the
   * diff". `{"pitStop":{"every":"never"}}` restores that.
   */
  pitStop: PitStopConfig.default({}),
  /**
   * How many times a failing intent check may queue work to close its own gaps.
   *
   * The validator reads the merged tree as a whole and answers the only question
   * task-level QA never asks: does the sum of this do what was asked? Its verdict
   * used to be a note in the log. Run 40da9337 merged 36 tasks, opened its pull
   * requests, and reported success carrying a FAIL that said none of the workers
   * that move money were scheduled to run anywhere outside a test — seven gaps,
   * every one of them a task the harness could have written.
   *
   * One round by default: the gaps are small, concrete and derived from a tree
   * that already exists, so a second pass rarely finds what the first could not,
   * and an unbounded loop is a run that never lets go. `0` restores the old
   * behaviour of reporting the verdict and stopping there.
   */
  intentFixRounds: z.number().int().min(0).max(3).default(1),
  /**
   * Ask, at the plan gate, whether this plan could deliver the assignment at all
   * — before a worker is dispatched.
   *
   * The same question is already asked at the end of every run, and asking it
   * there is what makes the answer expensive. Run 40da9337's plan gave every one
   * of seven vendor categories acceptance criteria that a deterministic mock
   * satisfies, against an assignment that said "including all the integrations".
   * Nothing was wrong with the execution; the plan promised less than the brief
   * and no one compared them until $773.55 later. One agent call at the gate is
   * roughly a dollar.
   *
   * Off restores the old behaviour: the operator reads the plan and is the only
   * thing standing between a hollow plan and a run that faithfully builds it.
   */
  planIntentCheck: z.boolean().default(true),
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
   *
   * `roles` narrows a rule to the sessions that should carry it — omit it and
   * every role does, which is the older behaviour. The reason it exists is that
   * some skills are for building and some are for grading, and handing the agent
   * that wrote the screen the playbook for judging it is not a review. It also
   * relieves the per-role cap: a builder skill and a grader skill no longer
   * compete for the same four slots.
   */
  skillRouting: z
    .array(
      z.object({
        when: z.string(),
        skills: z.array(z.string()),
        roles: z.array(z.enum(["intake", "planner", "worker", "qa", "prod"])).optional(),
      })
    )
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
      // UI work, split by who is doing what. The build side gets a product voice
      // alongside the design ones; the grading side gets the specialist that
      // looks at pixels, and never reaches the agent that drew them.
      { when: UI_WHEN, skills: ["frontend-design", "ui-ux-cx-engineer"] },
      { when: UI_WHEN, skills: ["product-manager"], roles: ["worker"] },
      { when: UI_WHEN, skills: ["visual-qa-agent"], roles: ["qa"] },
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
