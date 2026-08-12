import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ModelRoutingShape, RunConfig } from "@harness/shared";
import { AgentPool, Bus, GateHandler, GitHubAdapter, RunController, Store, checkMemoryBanner, detectToolbelt, ensureIgnored, harnessBuild, missingKeys, originSlug, postmortem, renderPostmortem, repoUnusable } from "@harness/core";
import { Dashboard } from "@harness/dashboard";
import { promptForNewCap, watchBudgetCommands } from "./budget.js";
import {
  CONFIG_FILENAME,
  DEFAULT_SKILLS_DIRS,
  detectChecks,
  expandHome,
  loadFileConfig,
  resolveGitHub,
  resolveRepoRoot,
} from "./defaults.js";
import { TerminalChat } from "./chat.js";
import { armCrashLog } from "./crashlog.js";
import { clearDashboard, liveDashboardUrl, recordDashboard } from "./dashboardLink.js";
import { notifyDone } from "./notify.js";

/**
 * Start the dashboard for a run, or nothing when it is turned off. Kept in one
 * place so `run` and `resume` cannot drift apart on port handling.
 */
function makeDashboardFactory(want: boolean, port: number | undefined, repoPath: string): {
  gateOverride?: (bus: Bus, store: Store) => GateHandler;
  connect: (controller: RunController) => void;
  start: () => Promise<string | null>;
  stop: () => Promise<void>;
} {
  if (!want) return { connect: () => undefined, start: async () => null, stop: async () => undefined };
  let dash: Dashboard | undefined;
  return {
    gateOverride: (bus, store) => {
      dash = new Dashboard(store, bus, { port });
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
    stop: async () => {
      if (dash) {
        await dash.stop();
        clearDashboard(repoPath);
      }
    },
  };
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
    checksFrom = `auto-detected from ${detected.source}`;
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
  banner.push(
    chat
      ? `intake     conversation before planning   (${fromCli("chat") ? "--chat" : file.chat !== undefined ? via : "default"})`
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
    pitStop: file.pitStop,
    skillsDirs,
    skillRouting: file.skillRouting,
    roleSkills: file.roleSkills,
    // Persist the resolved slug so the dashboard can link issues and PRs on a resume.
    githubRepo: github.slug ?? file.githubRepo,
    prMode: file.prMode,
    deterministicChecks: checks,
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
    .option("-m, --model <role=model>", "route one role to a model, e.g. worker=gpt-5.6-terra; repeatable", collect, [])
    .action(async (assignment: string | undefined, opts: RunOpts, cmd: Command) => {
      if (await repoBlocked(resolveRepoRoot(opts.repo))) return;
      const { repo, config, dashboard: wantDashboard, dashboardPort, chat: wantChat, banner } = resolveRun(cmd, opts, assignment);
      const dash = makeDashboardFactory(wantDashboard, dashboardPort, repo);
      const { controller, store, liveRunId } = makeController(repo, dash.gateOverride);
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
      process.stdout.write(`\n${banner.map((l) => `  ${l}`).join("\n")}\n`);

      const chat = wantChat || assignment === undefined ? new TerminalChat() : undefined;
      const seed = assignment ?? (await chat!.promptSeed(wantChat));
      const stopBudgetWatch = watchBudgetCommands(controller, liveRunId);
      try {
        const runId = await controller.startRun(seed, config, wantChat ? chat : undefined);
        await reportOutcome(controller, repo, runId);
      } catch (e) {
        notifyDone(`${path.basename(repo)} — run stopped`, e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        stopBudgetWatch();
        chat?.close();
        await dash.stop();
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
    .action(async (runIdArg: string | undefined, opts: { repo: string; dashboard?: boolean; port?: string; model?: string[] }, cmd: Command) => {
      const repo = resolveRepoRoot(opts.repo);
      if (await repoBlocked(repo)) return;
      const file = loadFileConfig(repo).config;
      const fromCli = (name: string) => cmd.getOptionValueSource(name) === "cli";
      const wantDashboard = fromCli("dashboard") ? opts.dashboard === true : file.dashboard ?? true;
      const dash = makeDashboardFactory(wantDashboard, fromCli("port") ? port(opts.port!) : file.dashboardPort, repo);
      const { controller, store } = makeController(repo, dash.gateOverride);
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
      const stopBudgetWatch = watchBudgetCommands(controller, () => runId);
      try {
        await controller.resume(runId, chat);
        await reportOutcome(controller, repo, runId);
      } catch (e) {
        notifyDone(`${path.basename(repo)} — run stopped`, e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        stopBudgetWatch();
        chat?.close();
        await dash.stop();
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
    .command("postmortem")
    .argument("[runId]", "the run to explain (default: the most recent)")
    .description("why a run produced what it produced — unanswered questions, verdicts, and where the money went")
    .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
    .action(async (runIdArg: string | undefined, opts: { repo: string }) => {
      const repo = resolveRepoRoot(opts.repo);
      const { store } = makeController(repo);
      const runId = runIdArg ?? store.listRuns()[0]?.id;
      if (!runId || !store.getRun(runId)) {
        process.stdout.write(runIdArg ? `No run ${runIdArg} in this repo.\n` : "No runs yet.\n");
        return;
      }
      process.stdout.write(`${renderPostmortem(postmortem(store, runId))}\n`);
    });

  program
    .command("status")
    .description("show runs, task states, pull requests and spend")
    .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
    .option("--all", "include finished runs (default: the open ones plus the last finished)", false)
    .action(async (opts: { repo: string; all: boolean }) => {
      const repo = resolveRepoRoot(opts.repo);
      const { store } = makeController(repo);
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
    .action((opts: { repo: string; force: boolean }) => {
      const repo = resolveRepoRoot(opts.repo);
      const target = path.join(repo, CONFIG_FILENAME);
      if (existsSync(target) && !opts.force) {
        throw new Error(`${target} already exists. Pass --force to overwrite.`);
      }
      const detected = detectChecks(repo);
      const contents = {
        budget: { runCapUsd: DEFAULT_RUN_CAP },
        deterministicChecks: detected.checks,
        dashboard: true,
        skillsDirs: DEFAULT_SKILLS_DIRS,
      };
      writeFileSync(target, `${JSON.stringify(contents, null, 2)}\n`);
      process.stdout.write(
        `Wrote ${target}\n  checks: ${detected.checks.join(", ") || `none (${detected.source})`}\n` +
          `Edit it and re-run \`harness run "<assignment>"\` — no flags needed.\n`
      );
    });

  return program;
}
