import type { RunState, Runbook, TaskState } from "@harness/shared";
import type { DarkSwitch } from "./darkSwitches.js";

/**
 * What the run delivered, and which half of it is actually on.
 *
 * `outcome()` already answers "what did this run produce" — pull requests,
 * parked tasks, CI, the intent verdict. It answers it in the vocabulary of the
 * *repository*, which is the wrong vocabulary for the question an operator asks
 * at the end: not "did it merge" but "can anyone use it". Those come apart
 * constantly and always in the same direction. Twelve tasks merged, CI green,
 * intent check passed, and the checkout still 500s because nothing set
 * `STRIPE_SECRET_KEY`; the DNS record is in the template and not in the zone;
 * the migration is in the diff and not in the database.
 *
 * So this file re-reads the same run through one ladder:
 *
 *   not-merged   the work exists on a branch nobody merged
 *   merged       it is on the base branch, and no deploy carried it anywhere
 *   deployed     the deploy that carries it went green
 *   verified     something looked at the running system and agreed
 *
 * A feature's status can never exceed the run's reach, which is the rule that
 * makes the report honest under pressure. A run stuck at `merged` has no live
 * features, however good its QA was, and no amount of per-task evidence
 * promotes one — because the thing that would carry it to a user never ran.
 *
 * Pure. The caller reads the store and the diff; this decides what it means.
 */

/**
 * How far the run's work actually travelled.
 *
 * Ordered: `deployed` is strictly more than `merged`, and `reachOf` walks the
 * ladder rung by rung rather than comparing numbers. The renderer keeps its own
 * ranking, because drawing the ladder is the only thing that needs one.
 */
export type Reach = "not-merged" | "merged" | "deployed" | "verified";

/**
 * What one delivered thing is, from the operator's side of the screen.
 *
 * `unproven` is a first-class answer rather than a hedge. The run reached
 * production and nothing looked at this specific feature there; saying "live"
 * would be a claim nobody made, and saying "dark" would be a fault nobody
 * found. `evidence.ts` draws the same distinction for demo artifacts and for
 * the same reason — a struck claim is one the operator never has to un-believe.
 */
export type Activation = "live" | "dark" | "unproven" | "not-delivered";

export interface LedgerTask {
  id: string;
  title: string;
  state: TaskState;
  acceptanceCriteria: string[];
  touchedPaths: string[];
  prNumber: number | null;
  /** QA's own list of what its PASS did not settle. */
  unverified: string[];
  /** Why it stopped, for the states where that is a question. */
  why: string;
  /** The operator's half, when an escalation wrote one. */
  runbook: Runbook | null;
  /** What is waiting on this one. */
  blocking: string[];
}

export interface LedgerInput {
  runState: RunState;
  tasks: LedgerTask[];
  /** Whether a human merged the run's pull request — the boundary the harness does not cross. */
  merged: boolean;
  deploy: { state: "passing" | "failing" | "pending" | "none"; failing: string[] } | null;
  prod: { url: string; verdict: "PASS" | "FAIL"; findings: string[] } | null;
  ci: { state: "passing" | "failing" | "pending" | "none"; failing: string[] } | null;
  intent: { verdict: "PASS" | "FAIL"; gaps: string[] } | null;
  switches: DarkSwitch[];
}

export interface LedgerEntry {
  taskId: string;
  title: string;
  criteria: string[];
  prNumber: number | null;
  status: Activation;
  /** One sentence, in the second person, saying why it is in that column. */
  why: string;
  /** The switches that keep this one off, by name. Empty for everything live. */
  blockedBy: string[];
  /** What turns it on: the escalation's runbook, or the switches' steps folded together. */
  runbook: Runbook | null;
  /** QA's own caveats, carried through rather than dropped. */
  unverified: string[];
}

export interface DeliveryLedger {
  reach: Reach;
  entries: LedgerEntry[];
  switches: DarkSwitch[];
  counts: Record<Activation, number>;
  /** What production said, when anything did. */
  findings: string[];
  /** What the end-of-run intent check said was missing. */
  gaps: string[];
  /** One sentence for the top of the report. Never claims more than `reach`. */
  headline: string;
}

/** How far the run got, read off the facts rather than off the run's state name. */
export function reachOf(input: Pick<LedgerInput, "merged" | "deploy" | "prod">): Reach {
  if (!input.merged) return "not-merged";
  // A repo with no deploy workflow at all (`none`) has not deployed anything,
  // and neither has one whose deploy is still running. Only green is green.
  if (input.deploy?.state !== "passing") return "merged";
  // A FAIL is a look that disagreed — the run reached production and production
  // said no, which is `deployed` with findings, never `verified`.
  if (input.prod?.verdict !== "PASS") return "deployed";
  return "verified";
}

/** The switches that live in files this task wrote. */
function switchesFor(task: LedgerTask, switches: DarkSwitch[]): DarkSwitch[] {
  if (!task.touchedPaths.length) return [];
  return switches.filter((s) =>
    // `where` is `path` or `path:line`, and `name` is a path for the file-shaped
    // kinds. Compare on the path alone so a line number cannot break the link.
    task.touchedPaths.some((p) => {
      const where = s.where.split(", ").map((w) => w.replace(/:\d+$/, ""));
      return where.includes(p);
    })
  );
}

/** The switches' steps, folded into one runbook for this feature. */
function switchRunbook(title: string, switches: DarkSwitch[]): Runbook {
  return {
    blocked: `${title} is merged, but ${switches.length === 1 ? "one switch it depends on is" : `${switches.length} switches it depends on are`} off: ${switches.map((s) => s.name).join(", ")}.`,
    steps: switches.flatMap((s) => s.steps),
    sendBack: "Confirmation that the feature is reachable in the running system — the request you made and what came back, not that the steps are done.",
  };
}

const DELIVERED: TaskState[] = ["MERGED"];

/**
 * Read one run as a ledger of features and switches.
 *
 * Every branch here answers the same question in a different column, and the
 * only rule that matters is the one at the top of each: a feature cannot be
 * more on than the run that carried it.
 */
export function deliveryLedger(input: LedgerInput): DeliveryLedger {
  const reach = reachOf(input);
  const prodFailed = input.prod?.verdict === "FAIL";

  const entries: LedgerEntry[] = input.tasks.map((task) => {
    const mine = switchesFor(task, input.switches);
    const base = {
      taskId: task.id,
      title: task.title,
      criteria: task.acceptanceCriteria,
      prNumber: task.prNumber,
      unverified: task.unverified,
      blockedBy: mine.map((s) => s.name),
    };

    if (task.state === "NEEDS_HUMAN") {
      return {
        ...base,
        status: "not-delivered" as const,
        why: task.why || "This task stopped on something no agent could do, and nobody has come back to it.",
        runbook: task.runbook,
      };
    }
    if (task.state === "CANCELLED") {
      return {
        ...base,
        status: "not-delivered" as const,
        why: task.blocking.length
          ? `Never started — it was waiting on ${task.blocking.join(", ")}, which parked.`
          : task.why || "Never started.",
        runbook: null,
      };
    }
    if (!DELIVERED.includes(task.state)) {
      return {
        ...base,
        status: "not-delivered" as const,
        why: `Still ${task.state.toLowerCase().replace("_", " ")} when the run ended — the work is not in the base branch.`,
        runbook: null,
      };
    }

    // Merged. Now: how far did the thing carrying it actually get?
    if (reach === "not-merged") {
      return {
        ...base,
        status: "dark" as const,
        why: "Merged into the run's integration branch, but nobody merged the pull request — it is not in the base branch and cannot reach anyone.",
        runbook: null,
      };
    }
    if (reach === "merged") {
      const failing = input.deploy?.failing.length ? ` (${input.deploy.failing.slice(0, 3).join(", ")})` : "";
      return {
        ...base,
        status: "dark" as const,
        why:
          input.deploy?.state === "failing"
            ? `In the base branch, and the deploy that would carry it went red${failing}. The change is merged and not live.`
            : input.deploy?.state === "none"
              ? "In the base branch, and nothing deploys this repository automatically. Merging it did not ship it."
              : "In the base branch, and no deploy has been seen to go green on it yet.",
        runbook: null,
      };
    }
    // Deployed at least. A switch of its own outranks everything below.
    if (mine.length) {
      return {
        ...base,
        status: "dark" as const,
        why: `Deployed, and inert: ${mine.map((s) => s.why).join(" ")}`,
        runbook: switchRunbook(task.title, mine),
      };
    }
    if (reach === "deployed") {
      return {
        ...base,
        status: "unproven" as const,
        why: prodFailed
          ? "Deployed, and the production check came back FAIL. Nothing in that check named this feature, so whether it works is genuinely unknown."
          : "Deployed, and nothing has looked at it in the running system. It is not known to be broken and it is not known to work.",
        runbook: null,
      };
    }
    return {
      ...base,
      status: "live" as const,
      why: "In the base branch, deployed green, and production agreed with the assignment when it was checked.",
      runbook: null,
    };
  });

  const counts: Record<Activation, number> = { live: 0, dark: 0, unproven: 0, "not-delivered": 0 };
  for (const e of entries) counts[e.status] += 1;

  // Switches nothing claimed. A secret read by a file no task admits to touching
  // is still off, and dropping it because the join failed is exactly the kind of
  // silent narrowing this report exists to prevent.
  const claimed = new Set(entries.flatMap((e) => e.blockedBy));
  const orphans = input.switches.filter((s) => !claimed.has(s.name));

  return {
    reach,
    entries,
    switches: input.switches,
    counts,
    findings: input.prod?.findings ?? [],
    gaps: input.intent?.verdict === "FAIL" ? input.intent.gaps : [],
    headline: headline(reach, counts, input, orphans.length),
  };
}

/**
 * The sentence at the top, which is the only sentence some people will read.
 *
 * It leads with the weakest true statement rather than the strongest, because
 * every failure this report exists to catch is a run that reported the strongest
 * one: "12 tasks merged" over a product nobody could log into.
 */
function headline(reach: Reach, counts: Record<Activation, number>, input: LedgerInput, orphans: number): string {
  const on = counts.live;
  const off = counts.dark + counts["not-delivered"];
  const unknown = counts.unproven;
  const dark = off + orphans;

  if (reach === "not-merged") {
    return input.ci?.state === "failing"
      ? `Nothing from this run has shipped: the pull request is unmerged and its CI is red (${input.ci.failing.slice(0, 3).join(", ")}).`
      : "Nothing from this run has shipped. The work is on a branch, the pull request is open, and merging it is still someone's decision.";
  }
  if (reach === "merged") {
    const n = counts.dark + counts.unproven + counts.live;
    return `Merged and not shipped: ${n} merged ${plural(n, "feature")} ${n === 1 ? "sits" : "sit"} in the base branch, and no green deploy has carried ${n === 1 ? "it" : "them"} anywhere.`;
  }
  if (reach === "deployed") {
    return input.prod?.verdict === "FAIL"
      ? `Deployed, and production disagreed: ${input.prod.findings.length} ${plural(input.prod.findings.length, "finding")} came back against the running system.`
      : `Deployed, unverified: ${unknown} ${plural(unknown, "feature")} reached production and nothing has looked at ${unknown === 1 ? "it" : "them"} there${dark ? `, and ${dark} ${plural(dark, "thing")} ${dark === 1 ? "is" : "are"} still switched off` : ""}.`;
  }
  // No `unproven` clause here, and it is not an omission: `unproven` is only
  // ever assigned at reach `deployed`, so by the time the run is `verified`
  // every merged feature has been sorted into live or dark. A branch for it
  // would be a branch no run can reach.
  return dark
    ? `${on} ${plural(on, "feature")} live and confirmed in production; ${dark} still dark.`
    : "Everything this run built is live and confirmed in production.";
}

const plural = (n: number, word: string): string => (n === 1 ? word : `${word}s`);
