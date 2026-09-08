import path from "node:path";
import fs from "node:fs";
import type { RunState } from "@harness/shared";
import type { Store } from "./store.js";
import { git } from "./git.js";
import { envNames, scanDarkSwitches, scannable, type ScannedFile } from "./darkSwitches.js";
import { deliveryLedger, type LedgerTask } from "./deliveryLedger.js";
import { specCoverage } from "./acceptance.js";
import { scopeLedger } from "./scopeLedger.js";
import type { CompletionReport, ReportPr } from "./completionReport.js";

/**
 * Assemble the completion report from what the run recorded.
 *
 * Split out of the controller and given its dependencies rather than reaching
 * for them, because the interesting cases are all shapes of run that are
 * expensive to produce for real: a run that merged and never deployed, one
 * whose production check came back FAIL, one whose whole plan parked. Each of
 * those is a fixture here and a two-day run otherwise.
 *
 * The controller's job is the I/O — reading the diff, reading the environment
 * files, running the reporter agent — and this decides what all of it means.
 */

/** The subset of `RunController.outcome()` this needs. */
export interface OutcomeFacts {
  parked: { taskId: string; why: string; blocking: string[] }[];
  deploy: { state: "passing" | "failing" | "pending" | "none"; failing: string[] } | null;
  prod: { url: string; verdict: "PASS" | "FAIL"; findings: string[] } | null;
  ci: { state: "passing" | "failing" | "pending" | "none"; failing: string[] } | null;
  intent: { verdict: "PASS" | "FAIL" | "UNKNOWN"; gaps: string[] } | null;
}

export interface ReportSources {
  store: Store;
  runId: string;
  /** The name a person calls this project. */
  project: string;
  /** Files the run's merged work changed, already read. */
  changed: ScannedFile[];
  /** Environment names something on this machine already sets. */
  configured: string[];
  outcome: OutcomeFacts;
  /** Whether a human merged the run's pull request. The harness never does. */
  merged: boolean;
  prs: ReportPr[];
  /** The reporter agent's list of what it could not settle. */
  couldNotCheck: string[];
  method: string;
  now: number;
}

const HOUR_MS = 3_600_000;

export function buildCompletionReport(src: ReportSources): CompletionReport {
  const run = src.store.getRun(src.runId);
  if (!run) throw new Error(`unknown run ${src.runId}`);
  const parkedBy = new Map(src.outcome.parked.map((p) => [p.taskId, p]));

  const tasks: LedgerTask[] = src.store.listTasks(src.runId).map((t): LedgerTask => {
    const parked = parkedBy.get(t.id);
    return {
      id: t.id,
      title: t.title,
      state: t.state,
      acceptanceCriteria: t.acceptanceCriteria,
      touchedPaths: t.touchedPaths,
      prNumber: t.prNumber,
      unverified: t.unverified,
      why: parked?.why ?? src.store.taskStateReason(src.runId, t.id),
      // Only the states where a person is being asked for something carry one.
      // A merged task's old escalation is answered, and reprinting it as though
      // it were outstanding is how a report invents work.
      runbook: t.state === "NEEDS_HUMAN" ? src.store.taskRunbook(src.runId, t.id) : null,
      blocking: parked?.blocking ?? [],
    };
  });

  const ledger = deliveryLedger({
    runState: run.state as RunState,
    tasks,
    merged: src.merged,
    deploy: src.outcome.deploy,
    prod: src.outcome.prod,
    ci: src.outcome.ci,
    intent: src.outcome.intent,
    switches: scanDarkSwitches(src.changed, src.configured),
  });

  return {
    runId: src.runId,
    project: src.project,
    assignment: run.assignment,
    state: run.state,
    generatedAt: src.now,
    ledger,
    prs: src.prs,
    prodUrl: src.outcome.prod?.url || run.config.prodUrl,
    spentUsd: src.store.spentUsd(src.runId),
    wallClockHours: Math.max(0, run.updatedAt - run.createdAt) / HOUR_MS,
    sessions: src.store.listSessions(src.runId).length,
    couldNotCheck: src.couldNotCheck,
    method: src.method,
    coverage: coverageOf(src.store, src.runId),
    live: src.store.liveVerdict(src.runId),
    scope: scopeOf(src.store, src.runId),
  };
}

/**
 * What became of each requirement the brief named.
 *
 * Null for a run with no specification: it promised nothing in this
 * vocabulary, and a section of zeroes would read as a run that promised
 * nothing and delivered it.
 */
function scopeOf(store: Store, runId: string): CompletionReport["scope"] {
  const spec = store.runSpec(runId);
  if (!spec || !spec.requirements.length) return null;
  const tasks = store.listTasks(runId).map((t) => ({
    id: t.id,
    title: t.title,
    state: t.state,
    scenarioIds: t.scenarioIds,
    why: t.errorSummary || store.taskStateReason(runId, t.id),
  }));
  const ledger = scopeLedger(spec, tasks, store.scopeWriteOffs(runId));
  return {
    shipped: ledger.shipped,
    writtenOff: ledger.entries.filter((e) => e.status === "written-off").map((e) => ({ id: e.id, text: e.text, answer: e.answer })),
    dropped: ledger.dropped.map((e) => ({ id: e.id, text: e.text, why: e.claimants.map((c) => `${c.id} ${c.state}${c.why ? ` (${c.why})` : ""}`).join("; ") })),
    unclaimed: ledger.unclaimed.map((e) => ({ id: e.id, text: e.text })),
  };
}

/**
 * What the run's specification proves, if it had one.
 *
 * Null rather than a row of zeroes for a run that was never specified: "nothing
 * is proven because nothing was ever checked" and "nothing is proven because
 * every check failed" are opposite facts, and a section of zeroes reads as the
 * second.
 */
function coverageOf(store: Store, runId: string): (ReturnType<typeof specCoverage> & { line: string }) | null {
  const spec = store.runSpec(runId);
  if (!spec || !spec.requirements.length) return null;
  const verdict = store.acceptanceVerdict(runId);
  const coverage = specCoverage(spec, verdict?.failing ?? []);
  const line = !verdict
    ? "The scenarios were written, and the acceptance gate never ran — so nothing here has been checked against what shipped."
    : verdict.verdict === "green"
      ? verdict.line
      : verdict.verdict === "no-opinion"
        ? `The acceptance gate has no opinion: ${verdict.line} — nothing below was proven either way.`
        : verdict.named
          ? `The acceptance gate is red: ${verdict.line}.`
          : `The acceptance gate is red and its output named no scenario, so which promise broke is not known — every requirement below is unproven rather than passing.`;
  return { ...coverage, line };
}

/**
 * The run's own record of where its work got to.
 *
 * The controller's `outcome()` answers this and more, but it is a method on a
 * live controller — it needs GitHub, a pool and a worktree to exist. The
 * completion report is read long after all three are gone, most often by a CLI
 * that opened the database read-only. These are the four facts the ledger
 * actually turns on, and every one of them is already a row.
 */
export function outcomeFacts(store: Store, runId: string): OutcomeFacts {
  const tasks = store.listTasks(runId);
  const parked = tasks
    .filter((t) => t.state === "NEEDS_HUMAN")
    .map((t) => ({
      taskId: t.id,
      why: t.errorSummary || store.taskStateReason(runId, t.id),
      blocking: tasks.filter((o) => o.dependsOn.includes(t.id)).map((o) => o.title),
    }));
  return { parked, deploy: store.deployStatus(runId), prod: store.prodVerdict(runId), ci: store.ciStatus(runId), intent: store.intentVerdict(runId) };
}

/**
 * Whether a person merged the run's pull request. The harness never does it
 * itself, so this is always a fact about the world rather than about the run.
 *
 * Two sources, and the order matters. What the run recorded is free and often
 * enough: VERIFYING is only ever entered off a merged SHA, DONE only through
 * it, and a deploy status is never recorded for a commit that is not on the
 * base branch. But a run that stopped at PR_REVIEW and was merged by a human an
 * hour later recorded none of that, and its own history says — correctly, and
 * uselessly — that nothing was merged.
 *
 * That gap is not academic. Run 1e7d3df3's report was published headlined
 * "Nothing Shipped Yet", over a pull request that had been merged: the run
 * ended at PR_REVIEW, nobody resumed it, and the report repeated the run's last
 * memory as though it were the state of the world. So `askGitHub` is consulted
 * whenever the caller has a way to ask, and it is the answer that wins.
 */
export async function wasMerged(store: Store, runId: string, askGitHub?: (prNumber: number) => Promise<string | null>): Promise<boolean> {
  const run = store.getRun(runId);
  if (run?.state === "VERIFYING" || run?.state === "DONE" || store.deployStatus(runId) !== null) return true;
  if (!askGitHub) return false;
  const pr = rollupPrNumber(store, runId);
  if (pr === null) return false;
  // A question that cannot be reached leaves the run's own record standing.
  // Reporting "not merged" because the network was down is the same mistake in
  // the other direction, but it is the one the rest of the page already says
  // out loud: the method paragraph names what it could and could not check.
  return (await askGitHub(pr).catch(() => null)) !== null;
}

/**
 * The pull request the most tasks point at — the one a human would have merged.
 *
 * Mirrors the controller's own `rollupPr`, and is the only pull request worth
 * asking about: per-task pull requests all stack on the same branch, so the one
 * carrying the run is the one carrying the most tasks.
 */
export function rollupPrNumber(store: Store, runId: string): number | null {
  const counts = new Map<number, number>();
  for (const t of store.listTasks(runId)) if (t.prNumber !== null) counts.set(t.prNumber, (counts.get(t.prNumber) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  return best ? best[0] : null;
}

/** Environment names something in this checkout actually sets. */
export function configuredEnv(repoPath: string): string[] {
  const names: string[] = [];
  for (const file of [".env", ".env.local", ".env.production"]) {
    const full = path.join(repoPath, file);
    // A missing file is the common case, not an error — most repos keep their
    // real environment out of the checkout entirely, which is the correct thing
    // to do and also why this list is never treated as complete.
    if (!fs.existsSync(full)) continue;
    names.push(...envNames(fs.readFileSync(full, "utf8")));
  }
  return names;
}

/** Files big enough that scanning them says more about the scanner than the repo. */
const MAX_FILE_BYTES = 400_000;
const MAX_FILES = 600;

/** What the run changed, and how that was worked out. */
export interface RunDiff {
  files: ScannedFile[];
  /** One clause naming the basis, for the report's own account of itself. */
  basis: string;
  /** False when git could not be made to say what this run changed at all. */
  read: boolean;
}

const lines = (out: string): string[] =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * The files the run's work changed, with their contents.
 *
 * Read out of git rather than off disk: the working tree has moved on, and a
 * report about what run ec40b527 delivered has to read ec40b527's files.
 *
 * Two bases, because a run's own diff becomes unreadable the moment it
 * succeeds. While the pull request is open, `base...integration` is exact. Once
 * a human merges it, the integration branch is an *ancestor* of the base branch
 * and that same command correctly returns nothing — the run changed nothing
 * relative to a base that now contains it. Every finished run reaches that
 * state, so the interesting case is the one the obvious command cannot answer.
 *
 * The fallback walks the integration branch's own first-parent history back to
 * the last commit that predates the run. The harness made every commit above
 * that line, during the run, so the line is exactly where the run began. It is
 * reconstruction rather than record — the clean fix is for a run to write its
 * base SHA down when it creates the branch, and this is what reads the runs
 * that did not.
 *
 * `read: false` is the answer that matters most. A report that says "no
 * switches were found" because the branch was pruned looks identical to one
 * that says it because the run left nothing off, and that is precisely the
 * confusion this whole feature exists to prevent.
 */
export async function changedFiles(
  repoPath: string,
  base: string,
  ref: string,
  startedAt: number,
  /**
   * Which of the changed paths are worth reading.
   *
   * `scannable` by default, which is the dark-switch scanner's question: which
   * files can declare a switch. The gap ledger asks a different one — which
   * files are documentation — and a filter that answers only the first reads
   * no markdown at all, which is every file the gap ledger exists to measure.
   */
  keep: (path: string) => boolean = scannable
): Promise<RunDiff> {
  const resolved = await git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "");
  if (!resolved.trim()) {
    return {
      files: [],
      read: false,
      basis: `the run's branch \`${ref}\` no longer exists in this checkout, so nothing could be scanned`,
    };
  }

  let paths = lines(await git(repoPath, ["diff", "--name-only", `${base}...${ref}`]).catch(() => ""));
  let basis = `the ${paths.length} files between \`${base}\` and the run's branch`;
  let from = ref;

  if (!paths.length) {
    // Merged, most likely. Find where the run's own history starts.
    const at = new Date(startedAt).toISOString();
    const forked = (await git(repoPath, ["rev-list", "--first-parent", `--before=${at}`, "-n", "1", ref]).catch(() => "")).trim();
    if (!forked) return { files: [], read: false, basis: `git could not be made to say where run history on \`${ref}\` begins` };
    paths = lines(await git(repoPath, ["diff", "--name-only", forked, ref]).catch(() => ""));
    basis = `the ${paths.length} files the run's branch changed since ${forked.slice(0, 8)}, the last commit that predates it`;
    from = ref;
  }

  const files: ScannedFile[] = [];
  // Filtered before the read, not after: fetching a blob is a subprocess each,
  // and a run that touched a thousand lockfile lines and six templates should
  // cost six reads.
  for (const p of paths.filter(keep).slice(0, MAX_FILES)) {
    // A file the run deleted has no content at the tip and nothing to scan, so
    // it is simply absent — a switch cannot be declared by a file that is gone.
    const text = await git(repoPath, ["show", `${from}:${p}`]).catch(() => "");
    if (text && text.length <= MAX_FILE_BYTES) files.push({ path: p, text });
  }
  return { files, basis, read: true };
}

/** Where a run's report lives, so the controller and the CLI cannot disagree. */
export function reportPath(repoPath: string, runId: string): string {
  return path.join(repoPath, ".harness", "reports", `${runId}.html`);
}

export interface ReportRequest {
  store: Store;
  repoPath: string;
  runId: string;
  /** Whether a person merged the pull request. */
  merged: boolean;
  /**
   * `owner/name` when the caller resolved one from the git remote. Falls back
   * to what the run was configured with, which is what the controller has.
   */
  slug?: string;
  /** Which caller: the run finishing, or someone asking after the fact. */
  origin: "done" | "cli";
  now: number;
}

/**
 * Everything between "a run id" and "a report", in one place.
 *
 * It was two places for about an hour — the controller's DONE hook and the CLI
 * command — and they had already drifted on which method paragraph they wrote.
 * Two callers assembling the same document from the same store is exactly the
 * shape that produces a report whose footnote describes a different report.
 */
export async function assembleReport(req: ReportRequest): Promise<CompletionReport> {
  const run = req.store.getRun(req.runId);
  if (!run) throw new Error(`unknown run ${req.runId}`);
  const slug = req.slug || run.config.githubRepo || "";
  const diff = await changedFiles(req.repoPath, run.config.baseBranch || "HEAD", run.integrationBranch, run.createdAt);
  const prs = [...new Set(req.store.listTasks(req.runId).flatMap((t) => (t.prNumber === null ? [] : [t.prNumber])))];

  return buildCompletionReport({
    store: req.store,
    runId: req.runId,
    // The repository's own name, not `owner/repo`: this becomes the page's
    // title, and an owner prefix pushes the part that identifies the run onto a
    // fourth line of the masthead.
    project: slug ? slug.slice(slug.lastIndexOf("/") + 1) : path.basename(req.repoPath),
    changed: diff.files,
    configured: configuredEnv(req.repoPath),
    outcome: outcomeFacts(req.store, req.runId),
    merged: req.merged,
    prs: prs.map((n) => ({ number: n, title: `#${n}`, url: slug ? `https://github.com/${slug}/pull/${n}` : "" })),
    // An unreadable diff is the one thing this must never round down to
    // "nothing found": the two are indistinguishable on the page and opposite
    // in meaning.
    couldNotCheck: diff.read
      ? []
      : [`What the run changed could not be read from git — ${diff.basis}. The Dark section is empty for want of evidence, not for want of switches.`],
    method:
      req.origin === "done"
        ? `Written when the run reached DONE, from its own event log and a scan of ${diff.basis}. Nothing in it was verified against the running system beyond the production check the run itself ran.`
        : `Derived from run ${req.runId}'s own event log, and from a scan of ${diff.basis}. Nothing here was verified against the running system by this command.`,
    now: req.now,
  });
}

/**
 * What the reporter agent is asked to settle, and the inventory it must account
 * for.
 *
 * The agent is never asked "find what is not turned on" — an agent asked that
 * finds what it thinks to look for, and the whole point of `darkSwitches` is
 * that the list does not depend on what occurred to anyone. It is handed the
 * derived list and asked, per row, whether the switch is in fact off in the
 * running system. Rows it cannot reach come back as `couldNotCheck` rather than
 * as either verdict.
 */
export function reporterBrief(report: CompletionReport): string {
  const rows = report.ledger.switches.map((s, i) => `${i + 1}. [${s.kind}] ${s.name} — declared at ${s.where}`);
  const live = report.ledger.entries.filter((e) => e.status === "live").map((e) => `- ${e.title}`);
  return [
    `Project: ${report.project}`,
    `Assignment: ${report.assignment.slice(0, 1500)}`,
    report.prodUrl ? `Production: ${report.prodUrl}` : "Production: no URL is configured for this run.",
    "",
    rows.length ? `Switches derived from the merged diff — account for every one:\n${rows.join("\n")}` : "No switches were derived from the merged diff.",
    "",
    live.length ? `Reported as live, on the strength of the deploy and the production check alone:\n${live.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
