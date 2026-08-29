import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CHECK_TIMEOUT_MINUTES, ModelRoutingShape, RunConfig, RunState, SubscriptionConfig } from "@harness/shared";
import { AgentPool, Bus, GateHandler, GitHubAdapter, RunController, Store, accountEnv, assembleReport, checkMemoryBanner, detectToolbelt, ensureIgnored, harnessBuild, missingKeys, originSlug, postmortem, renderPostmortem, reportPath, runLockHolder, standaloneReport, repoUnusable, wasMerged } from "@harness/core";
import { Dashboard } from "@harness/dashboard";
import { promptForNewCap, watchBudgetCommands } from "./budget.js";
import { promptForAccount } from "./subscription.js";
import {
  CONFIG_FILENAME,
  DEFAULT_SKILLS_DIRS,
  detectChecks,
  verifyChecks,
  expandHome,
  loadFileConfig,
  resolveGitHub,
  resolveRepoRoot,
} from "./defaults.js";
import { TerminalChat } from "./chat.js";
import { armCrashLog } from "./crashlog.js";
import { clearDashboard, liveDashboardUrl, recordDashboard, recordedDashboard } from "./dashboardLink.js";
import { notifyDone } from "./notify.js";
import { mailBanner, mailTarget, watchGateMail } from "./gateMail.js";

/**
 * The run a dashboard is currently working on, so `harness pause` does not make
 * the operator look up an id to stop the only thing that is running.
 *
 * Deliberately narrow: only EXECUTING and INTEGRATING can be paused, so a page
 * showing a finished run answers "nothing to pause" rather than sending a
 * request the controller will refuse.
 */
async function runningRunId(base: string, headers: Record<string, string>): Promise<string | null> {
  try {
    const res = await fetch(`${base}api/state`, { headers });
    const state = (await res.json()) as { runs?: { id: string; state: string }[] };
    return state.runs?.find((r) => ["EXECUTING", "INTEGRATING"].includes(r.state))?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Start the dashboard for a run, or nothing when it is turned off. Kept in one
 * place so `run` and `resume` cannot drift apart on port handling.
 */
function makeDashboardFactory(want: boolean, port: number | undefined, repoPath: string, reuse = false): {
  gateOverride?: (bus: Bus, store: Store) => GateHandler;
  connect: (controller: RunController) => void;
  start: () => Promise<string | null>;
  stop: (keepLink?: boolean) => Promise<void>;
} {
  if (!want) return { connect: () => undefined, start: async () => null, stop: async () => undefined };
  // Only `resume` reuses: a run being picked up should come back at the URL the
  // operator still has open, port and token both, rather than sending them to
  // find a new one. An explicit --port still wins — they are naming a port
  // precisely because they want that one.
  const prior = reuse ? recordedDashboard(repoPath) : null;
  let dash: Dashboard | undefined;
  return {
    gateOverride: (bus, store) => {
      dash = new Dashboard(store, bus, { port, preferPort: prior?.port, token: prior?.token });
      return dash;
    },
    // The dashboard is born inside makeController, before the controller exists;
    // feedback flows the other way (browser → controller), so it is wired after.
    connect: (controller) => dash?.attach(controller),
    // Written down as well as printed: the banner scrolls away, and `harness
    // status` in another terminal is where an operator looks for the run.
    start: async () => {
      const url = await dash!.start();
      recordDashboard(repoPath, url);
      return url;
    },
    // Guarded the same way `connect` is: a caller is free not to wire
    // `gateOverride` into anything, and then there is no server to stop.
    //
    // `keepLink` is for a run that stopped without finishing. The link file is
    // the only record of the port and the token, and `resume` reuses both so
    // that the tab the operator still has open keeps working — so clearing it
    // on the way out is precisely what makes `harness pause`'s own promise,
    // "It comes back on this same dashboard", false. Leaving a stale record
    // behind costs nothing: `liveDashboardUrl` asks the port before trusting
    // it and clears the file itself when nothing answers.
    stop: async (keepLink = false) => {
      if (dash) {
        await dash.stop();
        if (!keepLink) clearDashboard(repoPath);
      }
    },
  };
}

/**
 * Run states that mean the run stopped without finishing, and `harness resume`
 * is what picks it back up. Every one of them is the run waiting on a person: a
 * pit stop answered `stop`, a cap reached, a subscription spent.
 */
const HELD_STATES: ReadonlySet<RunState> = new Set<RunState>(["PAUSED", "BUDGET_HOLD", "LIMIT_HOLD"]);

/**
 * What becomes of the dashboard once the controller returns.
 *
 * A run that reached DONE, PR_REVIEW, FAILED or ABORTED is over, and a server
 * still listening on a finished run is a port and a bearer token left lying
 * around for nothing. Stop it, and clear the link so the next command does not
 * go knocking on a dead port.
 *
 * A held run is the opposite case, and it is the one this function exists for.
 * `stop` at a pit stop is not the run giving up — it is the run asking the
 * operator something it has no authority to decide, and the question it asked
 * is on the dashboard. Tearing the dashboard down in the same breath hands them
 * a URL that stopped answering at the exact moment they were asked to reply,
 * and leaves the question readable only out of SQLite or a pit stop artifacts
 * directory. Nobody should have to go there to answer their own run. So on a
 * held run the server stays up and this waits.
 *
 * Ctrl-C (or SIGTERM) closes it, and even then the link record survives, because
 * `resume` reuses the recorded port and token: either way the operator comes
 * back at the URL they already have open.
 *
 * Two guards on holding. Nothing is held when the dashboard is off, because
 * there is nothing to hold — `--no-dashboard` resolves its gates in the
 * terminal, which has already come back. And nothing is held without a TTY: an
 * unattended `run` that pauses has to exit, or a scripted invocation hangs
 * forever on a person who was never there. That is the same test `run` already
 * uses to decide whether intake may open a terminal chat.
 */
async function settleDashboard(
  dash: { stop: (keepLink?: boolean) => Promise<void> },
  url: string | null,
  state: RunState | undefined
): Promise<void> {
  const held = state !== undefined && HELD_STATES.has(state);
  if (!held) {
    await dash.stop();
    return;
  }
  if (url === null || !process.stdin.isTTY) {
    await dash.stop(true);
    return;
  }
  process.stdout.write(
    `\n  The run is ${state} and the dashboard is still serving, so you can read what it asked:\n` +
      `    ${url}\n` +
      "  Answer it there, then `harness resume` — it comes back on this same URL.\n" +
      "  Ctrl-C closes the dashboard. The run keeps its state either way.\n"
  );
  // Both handlers come off together: whichever signal arrives, the other must
  // not be left behind holding a reference to a resolved promise. Same shape as
  // the `dashboard` command, which is the other place this process is the
  // server and nothing else.
  await new Promise<void>((resolve) => {
    const signals = ["SIGINT", "SIGTERM"] as const;
    const done = () => {
      for (const sig of signals) process.off(sig, done);
      resolve();
    };
    for (const sig of signals) process.on(sig, done);
  });
  await dash.stop(true);
}

/**
 * The store for a command that only reads, without bringing a run's worth of
 * state into being to read it.
 *
 * `makeController` creates `.harness/`, arms the crash log and adds a
 * `.gitignore` entry, because every one of its callers is about to write a
 * run's worth of state. `status` and `postmortem` are not: they answer "what
 * has happened here", and in a repo where nothing has, the honest answer is
 * "nothing" — not a new state directory, an empty database and a modified
 * `.gitignore` in someone's clean checkout. Running `harness status` to look
 * at a repository should leave it exactly as it was found.
 *
 * Null means the repo has never been run, which every caller already has a
 * sentence for.
 */
function readOnlyStore(repoPath: string): Store | null {
  const db = path.join(repoPath, ".harness", "harness.db");
  return existsSync(db) ? new Store(db) : null;
}

function makeController(
  repoPath: string,
  gateOverride?: (bus: Bus, store: Store) => GateHandler
): { controller: RunController; store: Store; bus: Bus; liveRunId: () => string | undefined } {
  const stateDir = path.join(repoPath, ".harness");
  mkdirSync(stateDir, { recursive: true });
  // The first moment there is somewhere durable to write down why this process
  // stopped. Every run and resume passes through here.
  armCrashLog(stateDir);
  // Every run and resume passes through here, so this is the one place the state
  // directory is known to exist before anything writes to it.
  if (ensureIgnored(repoPath, ".harness/")) process.stdout.write("  added .harness/ to .gitignore (harness run state, not source)\n");
  const store = new Store(path.join(stateDir, "harness.db"));
  const bus = new Bus(store);
  // The intake agent owns the terminal while it is talking to the operator, so
  // its own log/tool traffic must not interleave with the conversation.
  const intakeSessions = new Set<string>();
  // The run does not exist until `startRun` creates it, so this is how a
  // stdin budget command (typed before the id is known any other way) finds
  // out what to raise the cap on: every event carries it, and this process
  // never publishes for more than one run at a time.
  let runId: string | undefined;
  bus.subscribe(({ event }) => {
    runId = event.runId;
    if (event.type === "agent.spawned" && event.role === "intake") {
      intakeSessions.add(event.sessionId);
      return;
    }
    if ("sessionId" in event && typeof event.sessionId === "string" && intakeSessions.has(event.sessionId)) return;
    if (event.type === "agent.log") {
      process.stdout.write(`  [${event.taskId ?? "run"}] ${event.text.split("\n")[0]!.slice(0, 120)}\n`);
    } else if (event.type === "run.state_changed" || event.type === "task.state_changed") {
      const scope = "taskId" in event && event.taskId ? `task ${event.taskId}` : "run";
      process.stdout.write(`▶ ${scope}: ${event.from} → ${event.to}${event.reason ? ` (${event.reason})` : ""}\n`);
    } else if (event.type === "agent.usage") {
      process.stdout.write(`  $ ${event.costUsd.toFixed(3)} (${event.model})\n`);
    } else if (event.type === "task.qa_verdict") {
      process.stdout.write(`  QA[${event.taskId}] iteration ${event.iteration}: ${event.verdict}\n`);
    } else if (event.type === "task.feedback") {
      process.stdout.write(`  ✉ your feedback → ${event.taskId} (${event.delivery})\n`);
    } else if (event.type === "task.gate_resolved" && event.decidedBy !== "operator") {
      // The escalation you were not asked about. Printed because a run that
      // answers its own questions still owes you the fact that it had one.
      process.stdout.write(`  ⚑ ${event.decidedBy} answered ${event.taskId}'s escalation: ${event.guidance.split("\n")[0]!.slice(0, 120)}\n`);
    } else if (event.type === "run.gate_resolved" && event.decidedBy !== "operator") {
      // Same flag, for the two gates that now answer themselves. The budget one
      // is money you were not asked about, which is the single most important
      // thing on this stream — it is never worth losing in the agent chatter.
      process.stdout.write(`  ⚑ ${event.decidedBy} resolved the ${event.kind} gate: ${event.feedback.split("\n")[0]!.slice(0, 140)}\n`);
    }
  });
  const pool = new AgentPool(store, bus);
  // The token comes from the environment or from `gh`, and stays in this process.
  const gh = resolveGitHub(repoPath, loadFileConfig(repoPath).config.githubRepo);
  const github = new GitHubAdapter(gh.token, gh.slug);
  const terminalGates: GateHandler = {
    async resolvePlanGate(prd, summary) {
      process.stdout.write(`\n===== GENERATED PRD =====\n${prd}\n\n===== TASK BREAKDOWN =====\n${summary}\n\n`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question("Approve plan? [y = approve / anything else = rejection feedback] ")).trim();
      rl.close();
      if (answer.toLowerCase() === "y") return { approved: true, feedback: "" };
      return { approved: false, feedback: answer || "rejected without feedback" };
    },
    resolveBudgetGate: (gate) => promptForNewCap(gate),
    // Gate: subscription. The other ceiling — the account's plan rather than
    // this run's dollars — and the one an operator cannot raise by typing a
    // bigger number.
    resolveSubscriptionGate: (gate) => promptForAccount(gate),
    // Gate: task-escalation. A task at its cap is one answer away from either a
    // fresh set of iterations or a parked branch — so ask, in the same terminal
    // that has been narrating the failures the operator is about to explain.
    async resolveTaskGate(gate) {
      process.stdout.write(
        `\n===== TASK NEEDS YOU =====\n` +
          `${gate.title} (${gate.taskId})\n` +
          `${gate.why.split("\n")[0]}\n` +
          (gate.branch ? `Its work so far is on ${gate.branch}\n` : "") +
          (gate.worktreePath ? `Worktree: ${gate.worktreePath}\n` : "") +
          (gate.recommendation ? `Suggested answer: ${gate.recommendation}\n` : "") +
          `Answer it and the worker continues with your words and a fresh iteration budget.\n`
      );
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (
        await rl.question(
          gate.recommendation
            ? "Your guidance [y = send the suggested answer / enter = park the task] "
            : "Your guidance [enter = park the task and move on] "
        )
      ).trim();
      rl.close();
      if (gate.recommendation && answer.toLowerCase() === "y") return gate.recommendation;
      return answer || null;
    },
    // Gate: pit stop. Everything above interrupts the operator about a problem;
    // this one interrupts them about the product, which is the only question
    // they actually wanted to be asked.
    async resolvePitStop(stop) {
      process.stdout.write(`\n${stop.markdown}\n\n`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (
        await rl.question(
          `What now?\n` +
            `  enter          keep going\n` +
            `  <anything>     send it to the ${stop.upcoming.length} task(s) that have not run yet` +
            (stop.parked.length ? `, and to the ${stop.parked.length} parked one(s) for when you revive them` : "") +
            `\n` +
            `  replan <words> re-plan the remaining work around what you say\n` +
            `  stop           park the run; \`harness resume\` picks it up where it is\n> `
        )
      ).trim();
      rl.close();
      if (!answer) return { action: "continue", feedback: "" };
      if (answer.toLowerCase() === "stop") return { action: "stop", feedback: "" };
      const replan = /^replan\b[:\s]*/i.exec(answer);
      if (replan) return { action: "replan", feedback: answer.slice(replan[0].length).trim() };
      return { action: "redirect", feedback: answer };
    },
  };
  const gates = gateOverride ? gateOverride(bus, store) : terminalGates;
  return { controller: new RunController(store, bus, pool, github, gates, repoPath), store, bus, liveRunId: () => runId };
}

/**
 * The last thing the operator reads. It used to say "Review PRs on GitHub" whatever
 * happened — including for a run whose foundation tasks all parked, which opens no
 * pull request at all and sends them hunting for work that was never pushed.
 *
 * Every pull request is printed as a full URL, because "PR #118" is not something
 * you can click, and a run of thirty tasks is not something you want to page
 * through on GitHub to find the four that landed.
 */
async function reportOutcome(
  controller: RunController,
  repoPath: string,
  runId: string,
  opts: { notify?: boolean } = {}
): Promise<void> {
  const out = controller.outcome(runId);
  const slug = (await originSlug(repoPath).catch(() => null)) ?? loadFileConfig(repoPath).config.githubRepo;
  const link = (kind: "pull" | "issues", n: number) => (slug ? `https://github.com/${slug}/${kind}/${n}` : `#${n}`);
  const lines = [`\nRun ${runId} finished — ${out.line}.`];

  // The validator's verdict comes first: it is the answer to "did this do what
  // I asked?", which outranks the list of artifacts that tried to.
  if (out.intent) {
    if (out.intent.verdict === "PASS") {
      lines.push("", `  Intent check: PASS — ${out.intent.summary.replace(/\s+/g, " ").slice(0, 240)}`);
    } else {
      lines.push("", `  Intent check: FAIL — the merged result does not fully deliver what you asked for:`);
      for (const gap of out.intent.gaps) lines.push(`    - ${gap.replace(/\s+/g, " ").slice(0, 240)}`);
      if (out.intent.summary) lines.push(`    ${out.intent.summary.replace(/\s+/g, " ").slice(0, 240)}`);
    }
  }

  // Ahead of CI, because it outranks it. A green check on a branch that will not
  // merge describes a pull request nobody can act on, and the operator has to be
  // told which of the two they are looking at before they read anything else.
  if (out.mergeable && out.mergeable.state !== "mergeable" && out.prs.length) {
    if (out.mergeable.state === "conflicting") {
      lines.push(
        "",
        `  CANNOT MERGE: this run's branch conflicts with ${out.mergeable.baseBranch || "its base"}.`,
        `    ${out.mergeable.baseBranch || "The base branch"} moved while the run was working. The harness merged it in, gave an`,
        "    agent the conflict and could not resolve it, so the branch is unchanged and the pull",
        "    request is held as a draft — there is no version of it a reviewer can merge yet."
      );
      for (const f of out.mergeable.conflicts.slice(0, 10)) lines.push(`    - ${f}`);
      if (out.mergeable.conflicts.length > 10) lines.push(`    …and ${out.mergeable.conflicts.length - 10} more`);
      lines.push("    Resolve it in the run's integration worktree, then `harness resume`.");
    } else {
      lines.push("", `  Mergeable: UNCONFIRMED — GitHub did not settle whether this branch merges into ${out.mergeable.baseBranch || "its base"}.`);
    }
  }

  // What the repo and the world said, in the order they said it. A green CI over
  // a red deploy, or a green deploy over a production that disagrees, are the two
  // shapes of "merged but not actually done" — both belong above the artifacts.
  if (out.ci) {
    lines.push(
      "",
      out.ci.state === "passing"
        ? `  CI: green on ${link("pull", out.ci.prNumber)}`
        : out.ci.state === "failing"
          ? `  CI: RED on ${link("pull", out.ci.prNumber)} — ${out.ci.failing.join(", ")}`
          : out.ci.state === "none"
            ? `  CI: NONE — nothing checked ${link("pull", out.ci.prNumber)}. Every green result in this run came from a per-task worktree, never this branch.`
            : `  CI: still running on ${link("pull", out.ci.prNumber)} (${out.ci.total} check(s))`
    );
  }
  if (out.deploy && out.deploy.state !== "none") {
    lines.push(
      out.deploy.state === "passing"
        ? `  Deploy: green on ${out.deploy.sha.slice(0, 7)} — the change is live`
        : out.deploy.state === "failing"
          ? `  Deploy: RED on ${out.deploy.sha.slice(0, 7)} — ${out.deploy.failing.join(", ")}. It is merged but NOT live.`
          : `  Deploy: still running on ${out.deploy.sha.slice(0, 7)}`
    );
  }
  if (out.prod) {
    if (out.prod.verdict === "PASS") {
      lines.push(`  Production: verified at ${out.prod.url} — ${out.prod.summary.replace(/\s+/g, " ").slice(0, 240)}`);
    } else {
      lines.push("", `  Production check: FAIL at ${out.prod.url} — the deployed system does not do what you asked:`);
      for (const f of out.prod.findings) lines.push(`    - ${f.replace(/\s+/g, " ").slice(0, 240)}`);
      if (out.prod.summary) lines.push(`    ${out.prod.summary.replace(/\s+/g, " ").slice(0, 240)}`);
      lines.push("    Fix it, then `harness resume` to re-check — the run stays open until production agrees.");
    }
  }

  if (out.prs.length) {
    lines.push("", "  Open for review (the harness never merges — that part is yours):");
    for (const pr of out.prs) lines.push(`    ${link("pull", pr.number)}  ${pr.title}`);
  }

  if (out.parked.length) {
    lines.push("", `  Parked, waiting on you (${out.parked.length}):`);
    for (const t of out.parked) {
      lines.push(`    ${t.title}`);
      if (t.issue) lines.push(`      ${link("issues", t.issue)}`);
      if (t.why) lines.push(`      why: ${t.why.replace(/\s+/g, " ").slice(0, 300)}`);
      if (t.branch) lines.push(`      its work is on ${t.branch}`);
      if (t.blocking.length) lines.push(`      ${t.blocking.length} other task(s) were waiting on it`);
    }
  }

  // "Cancelled" reads like a decision someone made. It is not: these tasks were
  // never attempted, because the DAG gave them no legal start.
  if (out.cancelled) {
    lines.push(
      "",
      `  ${out.cancelled} task(s) never started: each depends, directly or through another`,
      "  task, on something parked above, so there was never a legal point at which to",
      "  begin it. No tokens were spent on them. A finished run does not reopen — take",
      "  the parked work forward on its branch, or start a fresh run once you know why",
      "  it stalled."
    );
  }

  lines.push("", `  Full picture: harness status --repo ${repoPath}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  // Re-reading a finished run is not an event worth a desktop notification.
  if (opts.notify !== false) notifyDone(`${path.basename(repoPath)} — run done`, `${runId}: ${out.line}.`);
}

const DEFAULT_RUN_CAP = 30;

interface RunOpts {
  repo: string;
  runCap: string;
  check?: string[];
  checks: boolean;
  dashboard?: boolean;
  port?: string;
  chat?: boolean;
  model?: string[];
  /** Which configured Claude subscription this run spends; `""` is the ambient login. */
  account?: string;
  /** A skill that answers the intake agent in the operator's place. */
  intakeDecider?: string;
}

interface Resolved {
  repo: string;
  config: RunConfig;
  dashboard: boolean;
  /** undefined = take the first free port, so several repos can run at once. */
  dashboardPort: number | undefined;
  chat: boolean;
  banner: string[];
}

function positive(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number, got "${value}"`);
  return n;
}

/**
 * The cap already written down for this repo, or nothing if there is none.
 *
 * Deliberately forgiving where the rest of the CLI is strict. Every other
 * reader of the config file wants a parse failure — a typo that silently does
 * nothing is the bug that costs the most. This one is called on the way to
 * overwriting the file, and refusing to rewrite a file because it could not
 * first be read is backwards: a config truncated by a Ctrl-C mid-write is
 * exactly what `init --force` is for. So an unreadable file yields no cap and
 * the write goes ahead with the default.
 */
/**
 * The config file already on disk, or `{}` when there is none to read.
 *
 * `init --force` is the command that catches a config up to changed CI, and it
 * used to rewrite the whole file to do it — so every field the operator chose
 * and `init` does not detect was silently reset to a default. The cap was fixed
 * first because it was the loudest, but it was never the only one:
 * `deterministicCheckTimeoutMinutes` is the sharpest of the rest, since
 * `verifyChecks` prints "Raise deterministicCheckTimeoutMinutes above its honest
 * wall clock" as a drop reason — the operator raises it, re-inits, and it goes
 * back to the default with the file still looking right. `models`, `pitStop`,
 * `taskGate`, `planGate`, `ciFixRounds`, `intentFixRounds` and `subscription`
 * all went the same way.
 */
function existingConfig(repo: string): Record<string, unknown> {
  try {
    return (loadFileConfig(repo).config ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function port(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port must be 1-65535, got "${value}"`);
  return n;
}

/**
 * `RunConfig.parse`, with the failure written for the person who typed the
 * flag.
 *
 * Zod's own `.parse` throws a ZodError whose `message` is a JSON dump of its
 * issues, and `recordFatal` prints that plus a stack trace — so refusing
 * `-m qa=claude-haiku-4-5-…` produced fourteen lines of JSON and a trace
 * around one sentence that was already written to be read on its own. The
 * routing rules are the ones an operator trips while deliberately
 * experimenting with cheaper models, which is exactly when the message needs
 * to survive being skimmed.
 *
 * Same shape `loadFileConfig` uses for the config file, so a bad flag and a bad
 * file read the same way.
 */
export function parseRunConfig(input: unknown): RunConfig {
  const parsed = RunConfig.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
  throw new Error(`that run configuration cannot be used:\n${issues}`);
}

/**
 * Layer the run settings: CLI flag > harness.config.json > auto-detection >
 * built-in default. Every resolved value is reported in the banner so a bare
 * `harness run` is never silently doing something surprising.
 */
function resolveRun(cmd: Command, opts: RunOpts, assignment: string | undefined): Resolved {
  const repo = resolveRepoRoot(opts.repo);
  const { config: file, path: filePath } = loadFileConfig(repo);
  const fromCli = (name: string): boolean => cmd.getOptionValueSource(name) === "cli";
  const via = filePath ? CONFIG_FILENAME : "";
  // Which harness this is, at the one moment the operator can still act on it.
  // Every session this run spawns is stamped with the same string, so a
  // postmortem months later can say which fixes it actually had.
  const banner: string[] = [`repo       ${repo}`, `build      ${harnessBuild()}`];

  let checks: string[];
  let checksFrom: string;
  if (opts.checks === false) {
    checks = [];
    checksFrom = "--no-checks";
  } else if (opts.check && opts.check.length > 0) {
    checks = opts.check;
    checksFrom = "--check";
  } else if (file.deterministicChecks) {
    checks = file.deterministicChecks;
    checksFrom = via;
  } else {
    const detected = detectChecks(repo);
    checks = detected.checks;
    // Lifted out of the repo's workflows but not yet run here, and a check that
    // cannot pass in a fresh worktree parks every task in the run. `harness
    // init` runs each one before writing it down; this path has no moment at
    // which it could, so it says so instead of implying they are proven.
    checksFrom = detected.skipped.length || /CI workflow/.test(detected.source)
      ? `auto-detected from ${detected.source} — not yet run here; \`harness init\` proves them first`
      : `auto-detected from ${detected.source}`;
  }
  banner.push(
    checks.length > 0
      ? `checks     ${checks.join(" · ")}   (${checksFrom})`
      : `checks     none (${checksFrom}) — QA has no hard signal; pass --check "<cmd>" to add one`
  );

  const runCapUsd = fromCli("runCap")
    ? positive(opts.runCap, "--run-cap")
    : file.budget?.runCapUsd ?? DEFAULT_RUN_CAP;
  const budgetFrom = fromCli("runCap") ? "flags" : file.budget ? via : "defaults";
  banner.push(`budget     $${runCapUsd}   (${budgetFrom})`);

  const every = file.pitStop?.every ?? "epic";
  banner.push(
    every === "never"
      ? `pit stops  off — nothing between the plan gate and the diff   (${via})`
      : `pit stops  ${
          every === "epic"
            ? "after every epic"
            : "tasks" in every
              ? `every ${every.tasks} merged tasks`
              : "usd" in every
                ? `every $${every.usd} spent`
                : `every ${every.minutes} minutes`
        }   (${file.pitStop?.every ? via : "default"})`
  );

  const skillsDirs = (file.skillsDirs ?? DEFAULT_SKILLS_DIRS).map(expandHome);
  banner.push(`skills     ${skillsDirs.join(" · ")}   (${file.skillsDirs ? via : "defaults"})`);

  const github = resolveGitHub(repo, file.githubRepo);
  banner.push(github.slug ? `github     ${github.slug}   (${github.source})` : `github     ${github.source}`);
  if (github.slug) {
    banner.push(
      (file.prMode ?? "single") === "single"
        ? `prs        one rollup PR for the whole run   (${file.prMode ? via : "default"})`
        : `prs        one PR per task   (${via})`
    );
  }

  const toolbelt = detectToolbelt(file.externalTools);
  banner.push(
    toolbelt.length > 0
      ? `tools      ${toolbelt.map((t) => t.name).join(" · ")}   (offered to worker + QA agents)`
      : `tools      none detected on PATH`
  );

  const dashboard = fromCli("dashboard") ? opts.dashboard === true : file.dashboard ?? true;
  const dashboardPort = fromCli("port") ? port(opts.port!) : file.dashboardPort;
  // An assignment on the command line is taken as final; without one, the intake
  // agent is the only way the operator gets to say what they want.
  const chat = fromCli("chat") ? opts.chat === true : file.chat ?? assignment === undefined;
  const intakeDecider = opts.intakeDecider ?? file.intake?.decidedBy;
  banner.push(
    chat
      ? `intake     conversation before planning   (${fromCli("chat") ? "--chat" : file.chat !== undefined ? via : "default"})` +
          (intakeDecider && intakeDecider !== "operator" ? `\n           ${intakeDecider} answers what you are not here to answer` : "")
      : `intake     off — planning directly from the assignment`
  );

  const config = parseRunConfig({
    maxParallelWorkers: file.maxParallelWorkers,
    qaIterationCap: file.qaIterationCap,
    qaMaxTurns: file.qaMaxTurns,
    workerMaxTurns: file.workerMaxTurns,
    workerRespawnCap: file.workerRespawnCap,
    taskWallClockMinutes: file.taskWallClockMinutes,
    usageLimitWaitMinutes: file.usageLimitWaitMinutes,
    // The flag wins over the file: it is the thing you reach for when the run
    // in front of you needs to get cheaper right now.
    models: { ...file.models, ...modelOverrides(opts.model) },
    budget: { runCapUsd },
    // The subscriptions this run may spend, and which one it starts on. The
    // flag wins over the file for the same reason `--model` does: it is what
    // the operator reaches for when *this* run needs to go somewhere else.
    subscription: { ...file.subscription, ...(opts.account === undefined ? {} : { active: opts.account }) },
    pitStop: file.pitStop,
    // The flag wins over the file, as `--model` and `--account` do: it is what
    // the operator reaches for when *this* run has to go unattended.
    intake: { ...file.intake, ...(opts.intakeDecider === undefined ? {} : { decidedBy: opts.intakeDecider }) },
    skillsDirs,
    skillRouting: file.skillRouting,
    roleSkills: file.roleSkills,
    // Persist the resolved slug so the dashboard can link issues and PRs on a resume.
    githubRepo: github.slug ?? file.githubRepo,
    prMode: file.prMode,
    deterministicChecks: checks,
    deterministicCheckTimeoutMinutes: file.deterministicCheckTimeoutMinutes,
    waitForChecks: file.waitForChecks,
    checkTimeoutMinutes: file.checkTimeoutMinutes,
    prodUrl: file.prodUrl,
    deployTimeoutMinutes: file.deployTimeoutMinutes,
    externalTools: file.externalTools,
  });

  // A role pointed at another vendor needs that vendor's key before anything
  // is spent, not at the moment that role is first dispatched. `demo` first
  // runs at a pit stop, after every worker in the epic has been paid for;
  // discovering there that OPENAI_API_KEY was never exported wastes the epic.
  const missing = missingKeys(config.models);
  if (missing.length) {
    // Not "point that role back at an Anthropic model" any more: `reviewer` is
    // pinned to Google, so for that one there is no back to point it at, and
    // advice the operator cannot take reads as a bug in the tool.
    throw new Error(`${missing.join(" ")} Export the key, or — for a role that is not pinned — route it to a vendor you have one for.`);
  }

  // Say who answers for what, but only where the operator actually moved
  // something: a line that never changes is a line nobody reads. Compared
  // against the default table rather than against "is it Anthropic", which
  // stopped meaning the same thing when `reviewer` was pinned to Google — that
  // predicate now fires on every run, for a role nobody chose and nobody can
  // change, which is precisely the unread line this condition exists to avoid.
  const defaults = ModelRoutingShape.parse({});
  const moved = Object.entries(config.models).filter(([role, model]) => model !== defaults[role as keyof typeof defaults]);
  if (moved.length) {
    banner.push(`models     ${moved.map(([role, model]) => `${role}→${model}`).join(" · ")}   (pinned roles are not movable)`);
  }

  if (filePath) banner.push(`config     ${CONFIG_FILENAME}`);
  return { repo, config, dashboard, dashboardPort, chat, banner };
}

/**
 * Build the command tree.
 *
 * A function, not a module-level `program`, so a test can construct a fresh
 * one per case: commander keeps parsed option values on the command objects,
 * and a shared instance would carry one test's flags into the next.
 */
/** Gathers a repeatable option into an array. */
const collect = (value: string, previous: string[]) => [...previous, value];

/**
 * Parse repeated `--model role=model` pairs into a partial routing table.
 *
 * A typo has to be loud. `--model wroker=gpt-5.6-terra` that quietly did
 * nothing would leave the operator watching an expensive run they thought they
 * had just made cheap, which is the exact situation this flag exists for.
 */
export function modelOverrides(pairs: string[] = []): Record<string, string> {
  const roles = Object.keys(ModelRoutingShape.shape);
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const role = eq < 0 ? "" : pair.slice(0, eq).trim();
    const model = eq < 0 ? "" : pair.slice(eq + 1).trim();
    if (!role || !model) throw new Error(`--model expects role=model, got "${pair}"`);
    if (!roles.includes(role)) throw new Error(`--model: no role called "${role}". Roles: ${[...roles].sort().join(", ")}`);
    out[role] = model;
  }
  return out;
}

/**
 * Refuse to start in a repository no run can be built in, before a token is
 * spent on it.
 *
 * Printed rather than thrown: the reason is several lines and the line that
 * matters is the command to run, while the crash log renders only an error's
 * first line. The exit code still fails, so a script wrapping the harness can
 * tell.
 */
async function repoBlocked(repoPath: string): Promise<boolean> {
  const why = await repoUnusable(repoPath);
  if (!why) return false;
  process.stdout.write(`\n${why}\n`);
  process.exitCode = 1;
  return true;
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("harness").description("Multi-agent development harness: assignment in, reviewed PRs out");

  program
    .command("run")
    .description("plan and build an assignment in the current repo")
    .argument("[assignment]", "what to build; omit to describe it in a conversation")
    .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
    .option("--run-cap <usd>", "run budget cap in USD", String(DEFAULT_RUN_CAP))
    .option("--check <cmd...>", "deterministic checks run before QA (default: auto-detected)")
    .option("--no-checks", "run no deterministic checks")
    .option("--dashboard", "serve the monitoring dashboard and resolve gates there (default)")
    .option("--no-dashboard", "run headless; resolve gates in this terminal")
    .option("--port <n>", "pin the dashboard port (default: the first free port from 4777)")
    .option("--chat", "talk the assignment through with an intake agent first (default when no assignment is given)")
    .option("--no-chat", "skip the conversation; plan directly from the assignment")
    .option(
      "--intake-decider <skill>",
      "let a skill answer the intake agent in your place, so the run can start unattended (default: operator)"
    )
    .option("-m, --model <role=model>", "route one role to a model, e.g. worker=gpt-5.6-terra; repeatable", collect, [])
    .option("--account <name>", "spend a named Claude subscription from subscription.accounts (default: the account you are logged into)")
    .action(async (assignment: string | undefined, opts: RunOpts, cmd: Command) => {
      if (await repoBlocked(resolveRepoRoot(opts.repo))) return;
      const { repo, config, dashboard: wantDashboard, dashboardPort, chat: wantChat, banner } = resolveRun(cmd, opts, assignment);
      const dash = makeDashboardFactory(wantDashboard, dashboardPort, repo);
      const { controller, store, bus, liveRunId } = makeController(repo, dash.gateOverride);
      // A new run forks from the base branch as it is right now. Another run whose
      // work is merged locally but not yet in that base is invisible to it — so the
      // two plan against different trees, build the same thing twice, and the second
      // pull request lands in conflicts against the first. Nothing else warns.
      // VERIFYING and DONE runs are already merged, so they are in the base this
      // run forks from and pose no staleness risk.
      const unlanded = store.listRuns().filter((r) => !["DONE", "VERIFYING", "FAILED", "ABORTED"].includes(r.state));
      if (unlanded.length) {
        banner.push(
          `WARNING    ${unlanded.length} run${unlanded.length === 1 ? " is" : "s are"} still open in this repo: ${unlanded
            .map((r) => `${r.id} (${r.state})`)
            .join(", ")}`,
          "           this run forks from the base branch as it is now, so their unmerged work is invisible to it"
        );
      }
      // What earlier runs in this repo watched these same checks do. Printed in
      // the banner rather than anywhere later because a check that was red
      // before any task started parks the whole run, and this is the last
      // moment the operator can act on that for free.
      banner.push(...checkMemoryBanner(store, config.deterministicChecks));
      dash.connect(controller);
      const url = await dash.start();
      if (url) {
        banner.push(`dashboard  ${url}   (the fragment is your auth token)`);
      } else {
        banner.push("dashboard  off — the plan gate will be resolved in this terminal");
      }
      banner.push("           type 'budget run <usd>' any time to raise the cap before it's hit");
      const mail = mailTarget();
      banner.push(...mailBanner(mail));
      process.stdout.write(`\n${banner.map((l) => `  ${l}`).join("\n")}\n`);

      // With a decider named and nothing on the other end of stdin, the terminal
      // transport blocks forever on the first question — a run that looks hung
      // and is actually waiting for a person who was never going to be there.
      // Handing intake no operator is what lets the decider answer alone, which
      // is the whole point of naming one.
      const unattended = config.intake.decidedBy !== "operator" && !process.stdin.isTTY;
      const chat = (wantChat || assignment === undefined) && !unattended ? new TerminalChat() : undefined;
      const seed = assignment ?? (await chat!.promptSeed(wantChat));
      const stopGateMail = watchGateMail(bus, { project: path.basename(repo), url: url ?? "", target: mail });
      const stopBudgetWatch = watchBudgetCommands(controller, liveRunId);
      // Read inside the `try`, so the throw path leaves it undefined and the
      // dashboard comes down: a run that ended in an exception is not a run
      // holding a question, whatever state the row happens to say.
      let finalState: RunState | undefined;
      try {
        const runId = await controller.startRun(seed, config, wantChat ? chat : undefined);
        await reportOutcome(controller, repo, runId);
        finalState = store.getRun(runId)?.state;
      } catch (e) {
        notifyDone(`${path.basename(repo)} — run stopped`, e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        stopGateMail();
        stopBudgetWatch();
        chat?.close();
        await settleDashboard(dash, url, finalState);
      }
    });

  program
    .command("resume")
    .description("continue the last run (or a given one); completed tasks never re-execute, parked tasks ask you")
    .argument("[runId]", "run to resume (default: the newest run with something left to do)")
    .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
    .option("--dashboard", "serve the monitoring dashboard and resolve gates there (default)")
    .option("--no-dashboard", "run headless; resolve gates in this terminal")
    .option("--port <n>", "pin the dashboard port (default: the first free port from 4777)")
    .option("-m, --model <role=model>", "re-route one role for the rest of the run, e.g. worker=gpt-5.6-terra; repeatable", collect, [])
    .option("--account <name>", "continue on a different Claude subscription, by the name it has in subscription.accounts")
    .action(async (runIdArg: string | undefined, opts: { repo: string; dashboard?: boolean; port?: string; model?: string[]; account?: string }, cmd: Command) => {
      const repo = resolveRepoRoot(opts.repo);
      if (await repoBlocked(repo)) return;
      const file = loadFileConfig(repo).config;
      const fromCli = (name: string) => cmd.getOptionValueSource(name) === "cli";
      const wantDashboard = fromCli("dashboard") ? opts.dashboard === true : file.dashboard ?? true;
      const dash = makeDashboardFactory(wantDashboard, fromCli("port") ? port(opts.port!) : file.dashboardPort, repo, true);
      const { controller, store, bus } = makeController(repo, dash.gateOverride);
      dash.connect(controller);
      // Resumable = interrupted mid-run, or finished with parked tasks, cancelled
      // tasks whose blockers have since merged, or merged work whose PRs never
      // opened. ABORTED runs stay closed, and so does a FAILED run that got as
      // far as producing tasks.
      // A run whose pull request is merged is resumable even with no task work
      // left: the deploy and the production check are what remain, and re-entering
      // verification is exactly how a fixed deploy gets noticed.
      // A run that failed *in planning* has built nothing to talk over and holds
      // an intake conversation worth more than the phase that failed, so it
      // resumes by planning again rather than being started from scratch.
      const resumable = (id: string, state: string) =>
        state === "FAILED"
          ? controller.replannable(id)
          : !["ABORTED", "DONE"].includes(state) &&
            (state !== "PR_REVIEW" || controller.hasRecoverableWork(id) || controller.awaitingVerification(id));
      let runId = runIdArg;
      if (!runId) {
        const pick = store.listRuns().find((r) => resumable(r.id, r.state));
        if (!pick) {
          process.stdout.write("No run to resume: every run in this repo either finished cleanly, was aborted, or failed with work already in flight.\n");
          return;
        }
        runId = pick.id;
        process.stdout.write(`Resuming run ${runId} [${pick.state}] — ${pick.assignment.slice(0, 80).replace(/\n.*/s, "")}\n`);
      }
      const existing = store.getRun(runId);
      if (existing && !resumable(runId, existing.state)) {
        process.stdout.write(`Run ${runId} already finished (${existing.state}); there is nothing to resume.\n`);
        await reportOutcome(controller, repo, runId, { notify: false });
        return;
      }
      // The run's checks are frozen in its config; the file is the operator's
      // current declaration. A run whose checks were the problem — `cd web && …`
      // for tasks living in mobile/ — resumes with the corrected ones.
      if (existing && file.deterministicChecks && JSON.stringify(file.deterministicChecks) !== JSON.stringify(existing.config.deterministicChecks)) {
        store.patchRunConfig(runId, { deterministicChecks: file.deterministicChecks });
        process.stdout.write(`Checks updated from ${CONFIG_FILENAME}:\n${file.deterministicChecks.map((c) => `  $ ${c}`).join("\n")}\n`);
      }
      // A run whose checks are honestly slower than the ceiling can never be
      // green: run bc691359 killed a 21-minute `cargo test` at 10 for six hours
      // and charged every kill to whichever task was in flight. Raising this is
      // the fix, and it has to reach a run already in progress to be one.
      if (existing && file.deterministicCheckTimeoutMinutes !== undefined && file.deterministicCheckTimeoutMinutes !== existing.config.deterministicCheckTimeoutMinutes) {
        store.patchRunConfig(runId, { deterministicCheckTimeoutMinutes: file.deterministicCheckTimeoutMinutes });
        process.stdout.write(`Check timeout updated from ${CONFIG_FILENAME}: ${existing.config.deterministicCheckTimeoutMinutes} → ${file.deterministicCheckTimeoutMinutes} minute(s)\n`);
      }
      if (existing && file.prMode && file.prMode !== existing.config.prMode) {
        store.patchRunConfig(runId, { prMode: file.prMode });
        process.stdout.write(`PR mode updated from ${CONFIG_FILENAME}: ${file.prMode}\n`);
      }
      // Runs started before parallel dispatch existed carry a cap of 1 forever.
      // The scheduler reads the cap when it starts executing, so patching here —
      // before resume() — is what lets an old run finish with parallel workers.
      if (existing && file.maxParallelWorkers && file.maxParallelWorkers !== existing.config.maxParallelWorkers) {
        store.patchRunConfig(runId, { maxParallelWorkers: file.maxParallelWorkers });
        process.stdout.write(`Parallel workers updated from ${CONFIG_FILENAME}: ${existing.config.maxParallelWorkers} → ${file.maxParallelWorkers}\n`);
      }
      // Runs started before the CI wait existed default to true on resume, which
      // is the safe direction: they end by asking the repo instead of assuming.
      if (existing && file.waitForChecks !== undefined && file.waitForChecks !== existing.config.waitForChecks) {
        store.patchRunConfig(runId, { waitForChecks: file.waitForChecks });
        process.stdout.write(`Wait for CI updated from ${CONFIG_FILENAME}: ${file.waitForChecks}\n`);
      }
      // A run that parked tasks because QA kept running out of turns is the run
      // most likely to be resumed with a bigger ceiling — that has to reach it.
      if (existing && file.qaMaxTurns && file.qaMaxTurns !== existing.config.qaMaxTurns) {
        store.patchRunConfig(runId, { qaMaxTurns: file.qaMaxTurns });
        process.stdout.write(`QA turn ceiling updated from ${CONFIG_FILENAME}: ${existing.config.qaMaxTurns} → ${file.qaMaxTurns}\n`);
      }
      // Same reason again, for the worker: the ceiling is what a long task dies at.
      if (existing && file.workerMaxTurns && file.workerMaxTurns !== existing.config.workerMaxTurns) {
        store.patchRunConfig(runId, { workerMaxTurns: file.workerMaxTurns });
        process.stdout.write(`Worker turn ceiling updated from ${CONFIG_FILENAME}: ${existing.config.workerMaxTurns} → ${file.workerMaxTurns}\n`);
      }
      // Who the remaining tasks get to consult. A run's routing table is frozen at
      // the moment it started, which means a run half finished when the operator
      // decided its UI work needs a designer would never see that decision — and
      // the tasks that would benefit are exactly the ones still queued.
      for (const key of ["skillRouting", "roleSkills"] as const) {
        if (!existing || !file[key] || JSON.stringify(file[key]) === JSON.stringify(existing.config[key])) continue;
        store.patchRunConfig(runId, { [key]: file[key] } as Partial<RunConfig>);
        process.stdout.write(`${key} updated from ${CONFIG_FILENAME} for the remaining tasks\n`);
      }
      // Which model answers for each role, for the rest of the run.
      //
      // This is the knob an operator reaches for mid-run, and usually for one
      // reason: the budget is going faster than the work is. The remaining
      // tasks are exactly the ones that can still be made cheaper, so a routing
      // table frozen at run start is frozen at the least useful moment. The
      // flag wins over the file, because `--model worker=gpt-5.6-terra` on the
      // resume line is the whole point — nobody wants to edit JSON to stop a
      // run from spending.
      //
      // The pinned roles hold here too: `patchRunConfig` re-parses the whole
      // config, so a judge cannot be moved off Anthropic by the back door.
      if (existing) {
        const wanted = { ...file.models, ...modelOverrides(opts.model) };
        const changed = Object.entries(wanted).filter(([role, model]) => model !== existing.config.models[role as keyof typeof existing.config.models]);
        if (changed.length) {
          const models = { ...existing.config.models, ...Object.fromEntries(changed) };
          const missing = missingKeys(models);
          if (missing.length) {
            throw new Error(`${missing.join(" ")} Export the key, or route that role somewhere else.`);
          }
          // `patchRunConfig` is the enforcement — it re-parses the whole config
          // and a rejected routing never reaches the database. This is the same
          // check run a moment earlier only so the operator gets the sentence
          // instead of the ZodError the store would throw.
          parseRunConfig({ ...existing.config, models });
          store.patchRunConfig(runId, { models });
          for (const [role, model] of changed) {
            process.stdout.write(`${role} re-routed for the rest of the run: ${existing.config.models[role as keyof typeof existing.config.models]} → ${model}\n`);
          }
        }
      }
      // Which subscription the rest of the run spends.
      //
      // The accounts come from the file and the choice from the command line,
      // because a run parked at 95% of its weekly window is precisely the run
      // whose operator has since gone and set up a second subscription — a
      // config frozen at creation would never see it, and the run would resume
      // straight back into the wall that stopped it.
      if (existing) {
        // Parsed rather than read: a run frozen before subscriptions existed has
        // no such field, and the defaults are exactly what it has been behaving
        // as all along.
        const frozen = SubscriptionConfig.parse(existing.config.subscription ?? {});
        const merged = { ...frozen, ...(file.subscription ?? {}) };
        const subscription = { ...merged, active: opts.account ?? merged.active };
        if (JSON.stringify(subscription) !== JSON.stringify(frozen)) {
          // Resolved before it is stored, so a name that is not configured — or
          // a `$TOKEN` that is not exported — is a sentence here rather than a
          // run that starts and authenticates as nobody.
          accountEnv(subscription, subscription.active);
          store.patchRunConfig(runId, { subscription });
          if (subscription.active !== frozen.active) {
            process.stdout.write(`Subscription for the rest of the run: ${subscription.active || "(the account you are logged into)"}\n`);
          }
        }
      }
      // Setting prodUrl on a run that already finished is what extends it past the
      // pull request: the next resume follows the deploy and checks production.
      if (existing && file.prodUrl !== undefined && file.prodUrl !== existing.config.prodUrl) {
        store.patchRunConfig(runId, { prodUrl: file.prodUrl });
        process.stdout.write(`Production URL updated from ${CONFIG_FILENAME}: ${file.prodUrl || "(none)"}\n`);
      }
      // Every vendor the *resumed* table needs a key for, not only the roles
      // this command line moved.
      //
      // The check above fires only when `--model` changed something, which was
      // right while a run's routing could not change any other way: a resume
      // that touched nothing inherited a table `harness run` had already
      // cleared. Pinning `reviewer` to Google ended that. `freezeReviewer`
      // rewrites every pre-pin run at open, so a run planned and half-executed
      // when everything was Anthropic acquires a Google dependency between one
      // command and the next, having been asked nothing — and a plain `harness
      // resume` would carry on without ever looking for the key.
      //
      // What that costs is the thing `missingKeys` exists to prevent, twice
      // over: `reviewer` first runs at a pit stop, so the epic is already paid
      // for, and a reviewer session that cannot start is not reported as a
      // failure — `runLens` degrades it to `verdict: "on-track"`. The operator
      // would buy the workers and get a rubber stamp.
      const resumed = store.getRun(runId);
      if (resumed) {
        const missingNow = missingKeys(resumed.config.models);
        if (missingNow.length) {
          throw new Error(`${missingNow.join(" ")} Export the key, or — for a role that is not pinned — route it to a vendor you have one for.`);
        }
      }

      // Read after the patches above, so a resume that corrected its checks is
      // told about the corrected ones rather than the ones it is abandoning.
      const remembered = checkMemoryBanner(store, store.getRun(runId)?.config.deterministicChecks ?? []);
      if (remembered.length) process.stdout.write(`${remembered.join("\n")}\n`);
      const url = await dash.start();
      if (url) process.stdout.write(`Dashboard: ${url}\n(keep the fragment — it is your auth token)\n`);
      process.stdout.write("Type 'budget run <usd>' any time to raise the cap before it's hit.\n");
      // Only a run interrupted mid-conversation needs the terminal back: opening
      // readline for any other resume would hold stdin for a question never asked.
      const chat = existing?.state === "INTAKE" ? new TerminalChat() : undefined;
      if (chat) process.stdout.write("This run stopped mid-conversation — picking it up where it left off.\n");
      const mail = mailTarget();
      mailBanner(mail).forEach((l) => process.stdout.write(`${l}\n`));
      const stopGateMail = watchGateMail(bus, { project: path.basename(repo), url: url ?? "", target: mail });
      const stopBudgetWatch = watchBudgetCommands(controller, () => runId);
      // See `run`: undefined on the throw path is what brings the dashboard
      // down after an exception rather than holding it open on one.
      let finalState: RunState | undefined;
      try {
        await controller.resume(runId, chat);
        await reportOutcome(controller, repo, runId);
        finalState = store.getRun(runId)?.state;
      } catch (e) {
        notifyDone(`${path.basename(repo)} — run stopped`, e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        stopGateMail();
        stopBudgetWatch();
        chat?.close();
        await settleDashboard(dash, url, finalState);
      }
    });

  program
    .command("regroup")
    .description("replace a run's per-task pull requests with one rollup PR carrying the whole diff")
    .argument("[runId]", "run to regroup (default: the newest run with pull requests)")
    .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
    .action(async (runIdArg: string | undefined, opts: { repo: string }) => {
      const repo = resolveRepoRoot(opts.repo);
      const { controller, store } = makeController(repo);
      const runId = runIdArg ?? store.listRuns().find((r) => store.listTasks(r.id).some((t) => t.prNumber !== null))?.id;
      if (!runId) {
        process.stdout.write("No run with pull requests to regroup.\n");
        return;
      }
      const res = await controller.regroupPrs(runId);
      if (!res) {
        process.stdout.write(`Run ${runId} has nothing to roll up: no merged work, or no commits the base branch does not already have.\n`);
        return;
      }
      process.stdout.write(`Rollup PR: ${res.pr.url}\n`);
      process.stdout.write(
        res.closed.length
          ? `Closed ${res.closed.length} superseded pull request${res.closed.length === 1 ? "" : "s"}: ${res.closed.map((n) => `#${n}`).join(", ")}\n`
          : "No per-task pull requests needed closing.\n"
      );
    });

  program
    .command("probe")
    .description("rewrite the completion probe a task is stuck on — the operator's half of the escalation gate")
    .argument("<taskId>", "the task whose definition of done is wrong")
    .argument("[command]", "the probe to hold it to instead; omit with --clear to drop it")
    .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
    .option("--run <runId>", "which run (default: the newest one with this task)")
    .option("--clear", "withdraw the probe instead of replacing it, leaving QA to judge the task", false)
    .option("--why <words>", "one line for the record: what was wrong with the old one", "")
    .action(async (taskId: string, command: string | undefined, opts: { repo: string; run?: string; clear: boolean; why: string }) => {
      const repo = resolveRepoRoot(opts.repo);
      const { store } = makeController(repo);
      const runId = opts.run ?? store.listRuns().find((r) => store.getTask(r.id, taskId))?.id;
      const task = runId ? store.getTask(runId, taskId) : undefined;
      if (!task || !runId) {
        process.stdout.write(opts.run ? `No task ${taskId} in run ${opts.run}.\n` : `No run in this repo has a task called ${taskId}.\n`);
        process.exitCode = 1;
        return;
      }
      // A probe is a shell command, so "no argument" and "the empty probe" are
      // easy to confuse and expensive to confuse silently — withdrawing a task's
      // definition of done has to be something you asked for.
      if (!command && !opts.clear) {
        process.stdout.write(`Give the new probe, or --clear to withdraw it. ${taskId} is currently held to:\n  ${task.completionProbe || "(no probe)"}\n`);
        process.exitCode = 1;
        return;
      }
      const next = opts.clear ? "" : command!.trim();
      // The store treats this as a no-op, so saying "now: <the same thing>" would
      // read as a change that did not happen.
      if (next === task.completionProbe) {
        process.stdout.write(`${runId}/${taskId} is already held to exactly that. Nothing changed.\n`);
        return;
      }
      store.amendProbe(runId, taskId, next, "operator", opts.why);
      process.stdout.write(`${runId}/${taskId} [${task.state}]\n  was  ${task.completionProbe || "(no probe)"}\n  now  ${next || "(no probe — QA alone decides this task)"}\n`);
      // The loop re-reads the task at the top of every iteration, so this lands
      // on a run in flight without stopping it — which is the whole point of it
      // being a separate command rather than a config field.
      process.stdout.write("A run in flight picks this up on the task's next iteration; you do not need to resume it.\n");
    });

  program
    .command("criteria")
    .description("rewrite the acceptance criteria a task is judged against — for a bar no agent in this harness can clear")
    .argument("<taskId>", "the task whose bar is wrong")
    .argument("<criteria...>", "the criteria to judge it by instead, one argument each")
    .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
    .option("--run <runId>", "which run (default: the newest one with this task)")
    .option("--why <words>", "one line for the record: what was wrong with the old ones", "")
    .action(async (taskId: string, criteria: string[], opts: { repo: string; run?: string; why: string }) => {
      const repo = resolveRepoRoot(opts.repo);
      const { store } = makeController(repo);
      const runId = opts.run ?? store.listRuns().find((r) => store.getTask(r.id, taskId))?.id;
      const task = runId ? store.getTask(runId, taskId) : undefined;
      if (!task || !runId) {
        process.stdout.write(opts.run ? `No task ${taskId} in run ${opts.run}.\n` : `No run in this repo has a task called ${taskId}.\n`);
        process.exitCode = 1;
        return;
      }
      const next = criteria.map((c) => c.trim()).filter(Boolean);
      // There is no --clear here on purpose. A probe can be withdrawn because QA
      // still judges the task afterwards; withdrawing the criteria would leave
      // QA nothing to judge it by at all.
      if (!next.length) {
        process.stdout.write(`Give at least one criterion. ${taskId} is currently judged by:\n${task.acceptanceCriteria.map((c) => `  - ${c}`).join("\n")}\n`);
        process.exitCode = 1;
        return;
      }
      if (JSON.stringify(next) === JSON.stringify(task.acceptanceCriteria)) {
        process.stdout.write(`${runId}/${taskId} is already judged by exactly those. Nothing changed.\n`);
        return;
      }
      store.amendCriteria(runId, taskId, next, "operator", opts.why);
      process.stdout.write(
        `${runId}/${taskId} [${task.state}]\n  was\n${task.acceptanceCriteria.map((c) => `    - ${c}`).join("\n")}\n  now\n${next.map((c) => `    - ${c}`).join("\n")}\n`
      );
      // Same as `probe`: QA reads the criteria off the task at the top of every
      // iteration, so the next pass is judged by these without a restart. This
      // is the part `probe` could not do — a probe stands in front of the bar,
      // and QA reads the bar itself.
      process.stdout.write("A run in flight picks these up on the task's next QA pass; you do not need to resume it.\n");
    });

  program
    .command("postmortem")
    .argument("[runId]", "the run to explain (default: the most recent)")
    .description("why a run produced what it produced — unanswered questions, verdicts, and where the money went")
    .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
    .action(async (runIdArg: string | undefined, opts: { repo: string }) => {
      const repo = resolveRepoRoot(opts.repo);
      const store = readOnlyStore(repo);
      const runId = store ? (runIdArg ?? store.listRuns()[0]?.id) : undefined;
      if (!store || !runId || !store.getRun(runId)) {
        process.stdout.write(runIdArg ? `No run ${runIdArg} in this repo.\n` : "No runs yet.\n");
        // Naming a run that does not exist is a failure to do what was asked,
        // and `probe` and `regroup` already exit 1 on it. Reporting it as
        // success is what lets `harness postmortem $ID && rm -rf $WORKTREE`
        // reach the second half after a typo. Asking with no id at all is not
        // the same thing: nothing specific was requested and "No runs yet" is
        // a true and complete answer to it.
        if (runIdArg) process.exitCode = 1;
        return;
      }
      process.stdout.write(`${renderPostmortem(postmortem(store, runId))}\n`);
    });

  program
    .command("report")
    .argument("[runId]", "the run to report on (default: the most recent)")
    .description("what the run delivered, which of it is live, and what turns on the rest — written as one HTML page")
    .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
    .option("-o, --out <path>", "where to write it (default: .harness/reports/<runId>.html)")
    .action(async (runIdArg: string | undefined, opts: { repo: string; out?: string }) => {
      const repo = resolveRepoRoot(opts.repo);
      const store = readOnlyStore(repo);
      const runId = store ? (runIdArg ?? store.listRuns()[0]?.id) : undefined;
      const run = store && runId ? store.getRun(runId) : undefined;
      if (!store || !runId || !run) {
        process.stdout.write(runIdArg ? `No run ${runIdArg} in this repo.\n` : "No runs yet.\n");
        if (runIdArg) process.exitCode = 1;
        return;
      }
      const slug = (await originSlug(repo).catch(() => null)) ?? loadFileConfig(repo).config.githubRepo;
      // Ask GitHub whether the pull request actually merged, rather than
      // repeating the run's last memory of itself. A run that stopped at
      // PR_REVIEW and was merged by a human afterwards recorded nothing about
      // it, and the report's headline is the strongest claim on the page.
      const gh = resolveGitHub(repo, slug);
      const adapter = new GitHubAdapter(gh.token, gh.slug);
      const merged = await wasMerged(store, runId, adapter.enabled ? (pr) => adapter.mergedSha(pr) : undefined);
      const report = await assembleReport({ store, repoPath: repo, runId, merged, slug, origin: "cli", now: Date.now() });
      const out = opts.out ?? reportPath(repo, runId);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, standaloneReport(report));
      const { counts } = report.ledger;
      process.stdout.write(
        `${report.ledger.headline}\n\n` +
          `  live ${counts.live}   dark ${counts.dark}   unproven ${counts.unproven}   not delivered ${counts["not-delivered"]}\n` +
          `  ${report.ledger.switches.length} switch${report.ledger.switches.length === 1 ? "" : "es"} the run could not throw\n\n` +
          `  ${out}\n`
      );
    });

  program
    .command("status")
    .description("show runs, task states, pull requests and spend")
    .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
    .option("--all", "include finished runs (default: the open ones plus the last finished)", false)
    .action(async (opts: { repo: string; all: boolean }) => {
      const repo = resolveRepoRoot(opts.repo);
      const store = readOnlyStore(repo);
      if (!store) {
        process.stdout.write("No runs yet.\n");
        return;
      }
      const all = store.listRuns();
      // VERIFYING counts as open: the pull request is merged but the cycle has not
      // closed, and that is precisely the run the operator needs to see.
      const open = all.filter((r) => !["PR_REVIEW", "DONE", "FAILED", "ABORTED"].includes(r.state));
      // A finished run still holds the answer to "what did it actually produce?", so
      // the most recent one is shown even without --all. Nothing at all is printed
      // only when the repo has genuinely never been run.
      const runs = opts.all ? all : open.length ? open : all.slice(0, 1);
      if (runs.length === 0) {
        process.stdout.write("No runs yet.\n");
        return;
      }
      const slug = (await originSlug(repo).catch(() => null)) ?? loadFileConfig(repo).config.githubRepo;
      for (const run of runs) {
        process.stdout.write(`run ${run.id} [${run.state}] $${store.spentUsd(run.id).toFixed(2)} — ${run.assignment.slice(0, 60)}\n`);
        // Which process is driving it, if any. An EXECUTING run says nothing
        // about whether anything is actually working it — run bc691359 spent
        // days in EXECUTING with no harness alive, and then spent an afternoon
        // in EXECUTING with two.
        const holder = runLockHolder(path.join(repo, ".harness"), run.id);
        if (holder) process.stdout.write(`  driven by harness pid ${holder.pid} since ${new Date(holder.startedAt).toISOString()}\n`);
        const dep = store.deployStatus(run.id);
        if (dep && dep.state !== "none") process.stdout.write(`  deploy ${dep.sha.slice(0, 7)}: ${dep.state}${dep.failing.length ? ` — ${dep.failing.join(", ")}` : ""}\n`);
        const prod = store.prodVerdict(run.id);
        if (prod) process.stdout.write(`  production ${prod.url}: ${prod.verdict}${prod.findings.length ? ` — ${prod.findings.length} finding(s)` : ""}\n`);
        const tasks = store.listTasks(run.id);
        for (const t of tasks) {
          process.stdout.write(`  ${t.id} [${t.state}] qa=${t.qaIterations}${t.prNumber ? ` PR#${t.prNumber}` : ""}\n`);
        }
        // A rollup PR is shared by every merged task; list it once, not per task.
        const byPr = new Map<number, string[]>();
        for (const t of tasks) {
          if (t.prNumber !== null) byPr.set(t.prNumber, [...(byPr.get(t.prNumber) ?? []), t.title]);
        }
        if (byPr.size) {
          process.stdout.write("  pull requests:\n");
          for (const [n, titles] of byPr) {
            const url = slug ? `https://github.com/${slug}/pull/${n}` : `PR #${n}`;
            process.stdout.write(`    ${url}  ${titles.length === 1 ? titles[0] : `${titles.length} tasks (rollup)`}\n`);
          }
        } else if (["INTEGRATING", "PR_REVIEW"].includes(run.state)) {
          process.stdout.write("  pull requests: none — no task got far enough to open one.\n");
        }
      }
      // Last, under everything it refers to. A live server is linked; otherwise
      // the command that starts one, because "there is no dashboard" is not
      // what the operator wants to know — they want the dashboard.
      const live = await liveDashboardUrl(repo);
      process.stdout.write(
        live
          ? `\ndashboard  ${live}   (the fragment is your auth token)\n`
          : `\ndashboard  none running — \`harness dashboard\` serves this repo's runs\n`
      );
    });

  program
    .command("pause")
    .description("stop the running run at the next agent message, and leave it resumable")
    .argument("[runId]", "run to pause (default: the one this repo is running)")
    .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
    .action(async (runIdArg: string | undefined, opts: { repo: string }) => {
      const repo = resolveRepoRoot(opts.repo);
      // The run lives in another process — the one holding the worktrees and the
      // agent sessions — so pausing is a request sent to it, not something this
      // command can do itself. Its dashboard is the door that is already open:
      // 127.0.0.1, bearer-authenticated, and recorded in .harness/ by whoever
      // started it. No dashboard means no reachable run.
      const url = await liveDashboardUrl(repo);
      if (!url) {
        process.stdout.write("nothing to pause — no run is serving a dashboard for this repo.\n");
        return;
      }
      const base = url.slice(0, url.indexOf("#"));
      const token = url.slice(url.indexOf("#") + 1);
      // No content-type: neither of these requests has a body, and declaring one
      // is what a server with a JSON body parser answers 400 to.
      const headers = { authorization: `Bearer ${token}` };
      const runId = runIdArg ?? (await runningRunId(base, headers));
      if (!runId) {
        process.stdout.write("nothing to pause — that dashboard has no run still working.\n");
        return;
      }
      const res = await fetch(`${base}api/runs/${runId}/pause`, { method: "POST", headers });
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      process.stdout.write(
        res.ok
          ? `${body.message ?? "pausing"}\n\nPick it up with: harness resume ${runId}\nIt comes back on this same dashboard: ${url}\n`
          : `could not pause: ${body.error ?? res.status}\n`
      );
    });

  program
    .command("dashboard")
    .description("browse this repo's runs in the dashboard, without starting or resuming anything")
    .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
    .option("--port <n>", "pin the port (default: the first free port from 4777)")
    .action(async (opts: { repo: string; port?: string }) => {
      // The dashboard was only ever reachable for the length of the run that
      // served it, so the record of a $939 run became unbrowsable the moment it
      // finished — every question about it answered by `harness status` and a
      // SQLite file. Nothing about the page needs a run in flight: it reads the
      // same store, and the event log outlives the process that wrote it.
      const repo = resolveRepoRoot(opts.repo);
      const { store, bus } = makeController(repo);
      const dash = new Dashboard(store, bus, { port: opts.port === undefined ? undefined : port(opts.port), includeFinished: true });
      const url = await dash.start();
      recordDashboard(repo, url);
      process.stdout.write(`\ndashboard  ${url}   (the fragment is your auth token)\n\nRead-only: no run is executing, so gates and feedback have nothing to reach.\nCtrl-C to stop.\n`);
      // Nothing else to do — the server is the command. Hold the process until
      // the operator ends it, and take the link record with us. Both handlers
      // come off together: whichever signal arrives, the other must not be left
      // behind holding a reference to a resolved promise.
      await new Promise<void>((resolve) => {
        const signals = ["SIGINT", "SIGTERM"] as const;
        const done = () => {
          for (const s of signals) process.off(s, done);
          resolve();
        };
        for (const s of signals) process.on(s, done);
      });
      await dash.stop();
      clearDashboard(repo);
      process.stdout.write("dashboard stopped.\n");
    });

  program
    .command("init")
    .description(`write ${CONFIG_FILENAME} with the settings this repo would run with`)
    .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
    .option("-f, --force", "overwrite an existing config file", false)
    .option("--no-verify", "write the detected checks without running them first")
    .option(
      "--check-timeout <minutes>",
      `how long any one check may run, here and in the run this writes (default: the value already in the file, else ${DEFAULT_CHECK_TIMEOUT_MINUTES})`
    )
    .option("--run-cap <usd>", `run budget cap in USD (default: the cap already in the file, else ${DEFAULT_RUN_CAP})`)
    .action((opts: { repo: string; force: boolean; verify: boolean; checkTimeout?: string; runCap?: string }) => {
      const repo = resolveRepoRoot(opts.repo);
      const target = path.join(repo, CONFIG_FILENAME);
      if (existsSync(target) && !opts.force) {
        throw new Error(`${target} already exists. Pass --force to overwrite.`);
      }
      // One number for both jobs on purpose. It is the ceiling each candidate
      // is proved under *and* the ceiling written into the config for QA to use
      // later, so "it passed when I proved it" and "QA gives it that long"
      // cannot come apart. Proving at a stricter ceiling than the run will use
      // drops checks the run could have afforded; proving at a looser one
      // adopts checks QA is going to kill on every task.
      const existing = existingConfig(repo);
      let checkTimeout: number;
      if (opts.checkTimeout === undefined) {
        const kept = existing.deterministicCheckTimeoutMinutes;
        checkTimeout = typeof kept === "number" && kept > 0 ? kept : DEFAULT_CHECK_TIMEOUT_MINUTES;
      } else {
        checkTimeout = Number(opts.checkTimeout);
        if (!Number.isFinite(checkTimeout) || checkTimeout <= 0) {
          throw new Error(`--check-timeout wants a positive number of minutes, not ${opts.checkTimeout}.`);
        }
      }
      // A repo inits more than once — its CI changes, and this is the command
      // that catches the config up. The cap in the file is not a detected
      // value like the checks are; it is a number somebody chose, sometimes
      // mid-run through the budget gate, and overwriting it with the default
      // is silent in the worst way. The file still looks right afterwards, and
      // the next run stops at thirty dollars for a reason nothing on screen
      // explains. waf's cap had been raised to 2000 and a re-init put it back.
      const existingBudget = (existing.budget ?? {}) as Record<string, unknown>;
      const existingCap = existingBudget.runCapUsd;
      const runCapUsd =
        opts.runCap === undefined
          ? typeof existingCap === "number"
            ? existingCap
            : DEFAULT_RUN_CAP
          : positive(opts.runCap, "--run-cap");
      const detected = detectChecks(repo);
      const out = (line: string) => process.stdout.write(`${line}\n`);
      out(`Checks from ${detected.source}:`);
      for (const c of detected.checks) out(`  $ ${c}`);
      if (!detected.checks.length) out("  none");

      // Run them before writing them down. A candidate that cannot pass on this
      // machine is not a weaker check — it is red in every worktree, which
      // blames every task for something none of them can fix and parks the run.
      // Skippable, because a repo whose suite takes an hour should not have to
      // sit through it to get a config file.
      let checks = detected.checks;
      if (opts.verify && checks.length) {
        out(`\nRunning each one here first, ${checkTimeout} minute(s) each — a check that cannot pass in a fresh worktree parks every task in a run.`);
        // A check can take many minutes, so a terminal is shown the one in
        // flight and then has that line replaced by the verdict. Redirected to
        // a file there is no cursor to move, so only the verdict is written —
        // a log full of escape codes is worse than a log with no progress in it.
        const live = process.stdout.isTTY === true;
        const verified = verifyChecks(repo, checks, {
          timeoutMs: checkTimeout * 60 * 1000,
          onStart: (c) => live && process.stdout.write(`  …    ${c}`),
          // Without this a retried check looks hung: the same line sits there
          // for twice as long and nothing says a second run is under way. It
          // is also the only place the first failure is ever shown, and a
          // check that passes on the retry is worth knowing about — it is
          // flaky, and it will be flaky during the run too.
          onRetry: (c, reason) =>
            process.stdout.write(`${live ? "\r\u001b[2K" : ""}  retry ${c}  (first attempt: ${reason})\n${live ? `  …    ${c}` : ""}`),
          onResult: (c, ms, reason) =>
            process.stdout.write(`${live ? "\r\u001b[2K" : ""}  ${reason === null ? "ok  " : "drop"} ${c}  (${Math.round(ms / 1000)}s)\n`),
        });
        checks = verified.kept;
        if (verified.dropped.length) {
          out(`\nDropped ${verified.dropped.length} of ${detected.checks.length}:`);
          for (const d of verified.dropped) out(`  $ ${d.command}\n      ${d.reason}`);
          out(`Add any of them back by hand if the failure is something you can fix.`);
        }
      }

      // Everything already in the file survives, and only what `init` actually
      // detects is written over it. A re-init is meant to catch the *checks* up
      // to changed CI; every other field in there is a decision somebody made,
      // and rewriting the file wholesale unmade all of them at once.
      // Dropped from the spread and re-added deliberately below: `checkTimeout`
      // has already absorbed the file's value when the flag was not given, so
      // letting the old key through the spread would make an explicit
      // `--check-timeout 45` lose to a stored 90.
      const { deterministicCheckTimeoutMinutes: _storedTimeout, ...keptFields } = existing;
      const contents = {
        ...keptFields,
        budget: { ...existingBudget, runCapUsd },
        deterministicChecks: checks,
        // Written whenever it is not the default, so the ceiling the checks
        // were proved under is the one QA gives them. Left out when it is the
        // default, because a config file restating a default teaches the reader
        // nothing and invites them to treat it as a decision somebody made.
        ...(checkTimeout === DEFAULT_CHECK_TIMEOUT_MINUTES ? {} : { deterministicCheckTimeoutMinutes: checkTimeout }),
        dashboard: keptFields.dashboard ?? true,
        skillsDirs: keptFields.skillsDirs ?? DEFAULT_SKILLS_DIRS,
      };
      writeFileSync(target, `${JSON.stringify(contents, null, 2)}\n`);
      out(`\nWrote ${target} with ${checks.length} check(s).`);
      // What the pipeline does that this does not. Silence here reads as full
      // coverage, and a repo whose CI is mostly shell scripts gets very little.
      if (detected.skipped.length) {
        const SHOWN = 12;
        out(`\n${detected.skipped.length} CI step(s) were read and not lifted — this run will not cover them:`);
        for (const s of detected.skipped.slice(0, SHOWN)) out(`  ${s.source}\n      ${s.reason}`);
        if (detected.skipped.length > SHOWN) out(`  … and ${detected.skipped.length - SHOWN} more`);
      }
      out(`\nEdit it and re-run \`harness run "<assignment>"\` — no flags needed.`);
    });

  return program;
}
