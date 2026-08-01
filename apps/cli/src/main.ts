#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { AgentPool, Bus, GateHandler, GitHubAdapter, RunController, Store } from "@harness/core";
import { Dashboard } from "@harness/dashboard";
import {
  CONFIG_FILENAME,
  DEFAULT_SKILLS_DIRS,
  detectChecks,
  expandHome,
  loadFileConfig,
  resolveRepoRoot,
} from "./defaults.js";

function makeController(repoPath: string, gateOverride?: (bus: Bus, store: Store) => GateHandler): { controller: RunController; store: Store; bus: Bus } {
  const stateDir = path.join(repoPath, ".harness");
  mkdirSync(stateDir, { recursive: true });
  const store = new Store(path.join(stateDir, "harness.db"));
  const bus = new Bus(store);
  bus.subscribe(({ event }) => {
    if (event.type === "agent.log") {
      process.stdout.write(`  [${event.taskId ?? "run"}] ${event.text.split("\n")[0]!.slice(0, 120)}\n`);
    } else if (event.type === "run.state_changed" || event.type === "task.state_changed") {
      const scope = "taskId" in event && event.taskId ? `task ${event.taskId}` : "run";
      process.stdout.write(`▶ ${scope}: ${event.from} → ${event.to}${event.reason ? ` (${event.reason})` : ""}\n`);
    } else if (event.type === "agent.usage") {
      process.stdout.write(`  $ ${event.costUsd.toFixed(3)} (${event.model})\n`);
    } else if (event.type === "task.qa_verdict") {
      process.stdout.write(`  QA[${event.taskId}] iteration ${event.iteration}: ${event.verdict}\n`);
    }
  });
  const pool = new AgentPool(store, bus);
  const github = new GitHubAdapter(process.env.GITHUB_TOKEN, process.env.HARNESS_GITHUB_REPO);
  const terminalGates: GateHandler = {
    async resolvePlanGate(prd, summary) {
      process.stdout.write(`\n===== GENERATED PRD =====\n${prd}\n\n===== TASK BREAKDOWN =====\n${summary}\n\n`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question("Approve plan? [y = approve / anything else = rejection feedback] ")).trim();
      rl.close();
      if (answer.toLowerCase() === "y") return { approved: true, feedback: "" };
      return { approved: false, feedback: answer || "rejected without feedback" };
    },
  };
  const gates = gateOverride ? gateOverride(bus, store) : terminalGates;
  return { controller: new RunController(store, bus, pool, github, gates, repoPath), store, bus };
}

const DEFAULT_RUN_CAP = 30;
const DEFAULT_TASK_CAP = 10;

interface RunOpts {
  repo: string;
  runCap: string;
  taskCap: string;
  check?: string[];
  checks: boolean;
  dashboard?: boolean;
}

interface Resolved {
  repo: string;
  config: RunConfig;
  dashboard: boolean;
  banner: string[];
}

function positive(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number, got "${value}"`);
  return n;
}

/**
 * Layer the run settings: CLI flag > harness.config.json > auto-detection >
 * built-in default. Every resolved value is reported in the banner so a bare
 * `harness run` is never silently doing something surprising.
 */
function resolveRun(cmd: Command, opts: RunOpts): Resolved {
  const repo = resolveRepoRoot(opts.repo);
  const { config: file, path: filePath } = loadFileConfig(repo);
  const fromCli = (name: string): boolean => cmd.getOptionValueSource(name) === "cli";
  const via = filePath ? CONFIG_FILENAME : "";
  const banner: string[] = [`repo       ${repo}`];

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
  const taskCapUsd = fromCli("taskCap")
    ? positive(opts.taskCap, "--task-cap")
    : file.budget?.taskCapUsd ?? DEFAULT_TASK_CAP;
  const budgetFrom = fromCli("runCap") || fromCli("taskCap") ? "flags" : file.budget ? via : "defaults";
  banner.push(`budget     run $${runCapUsd} · task $${taskCapUsd}   (${budgetFrom})`);

  const skillsDirs = (file.skillsDirs ?? DEFAULT_SKILLS_DIRS).map(expandHome);
  banner.push(`skills     ${skillsDirs.join(" · ")}   (${file.skillsDirs ? via : "defaults"})`);

  const dashboard = fromCli("dashboard") ? opts.dashboard === true : file.dashboard ?? true;

  const config = RunConfig.parse({
    maxParallelWorkers: file.maxParallelWorkers,
    qaIterationCap: file.qaIterationCap,
    workerRespawnCap: file.workerRespawnCap,
    taskWallClockMinutes: file.taskWallClockMinutes,
    models: file.models,
    budget: { runCapUsd, taskCapUsd },
    skillsDirs,
    githubRepo: file.githubRepo,
    deterministicChecks: checks,
  });
  if (filePath) banner.push(`config     ${CONFIG_FILENAME}`);
  return { repo, config, dashboard, banner };
}

const program = new Command();
program.name("harness").description("Multi-agent development harness: assignment in, reviewed PRs out");

program
  .command("run")
  .description("plan and build an assignment in the current repo")
  .argument("<assignment>", "what to build")
  .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
  .option("--run-cap <usd>", "run budget cap in USD", String(DEFAULT_RUN_CAP))
  .option("--task-cap <usd>", "task budget cap in USD", String(DEFAULT_TASK_CAP))
  .option("--check <cmd...>", "deterministic checks run before QA (default: auto-detected)")
  .option("--no-checks", "run no deterministic checks")
  .option("--dashboard", "serve the monitoring dashboard and resolve gates there (default)")
  .option("--no-dashboard", "run headless; resolve gates in this terminal")
  .action(async (assignment: string, opts: RunOpts, cmd: Command) => {
    const { repo, config, dashboard: wantDashboard, banner } = resolveRun(cmd, opts);
    let dash: Dashboard | undefined;
    const { controller } = makeController(repo, wantDashboard
      ? (bus, store) => {
          dash = new Dashboard(store, bus);
          return dash;
        }
      : undefined);
    if (dash) {
      const url = await dash.start();
      banner.push(`dashboard  ${url}   (the fragment is your auth token)`);
    } else {
      banner.push("dashboard  off — the plan gate will be resolved in this terminal");
    }
    process.stdout.write(`\n${banner.map((l) => `  ${l}`).join("\n")}\n\n`);
    const runId = await controller.startRun(assignment, config);
    process.stdout.write(`\nRun ${runId} complete. Review PRs on GitHub (the harness never merges).\n`);
    if (dash) await dash.stop();
  });

program
  .command("resume")
  .description("continue an interrupted run; completed tasks never re-execute")
  .argument("<runId>")
  .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
  .option("--dashboard", "serve the monitoring dashboard and resolve gates there (default)")
  .option("--no-dashboard", "run headless; resolve gates in this terminal")
  .action(async (runId: string, opts: { repo: string; dashboard?: boolean }, cmd: Command) => {
    const repo = resolveRepoRoot(opts.repo);
    const wantDashboard = cmd.getOptionValueSource("dashboard") === "cli"
      ? opts.dashboard === true
      : loadFileConfig(repo).config.dashboard ?? true;
    let dash: Dashboard | undefined;
    const { controller } = makeController(repo, wantDashboard
      ? (bus, store) => {
          dash = new Dashboard(store, bus);
          return dash;
        }
      : undefined);
    if (dash) {
      const url = await dash.start();
      process.stdout.write(`Dashboard: ${url}\n(keep the fragment — it is your auth token)\n`);
    }
    await controller.resume(runId);
    if (dash) await dash.stop();
  });

program
  .command("status")
  .description("show open runs, task states and spend")
  .option("-r, --repo <path>", "target repo (default: the git repo containing the cwd)", process.cwd())
  .action((opts: { repo: string }) => {
    const { store } = makeController(resolveRepoRoot(opts.repo));
    const runs = store.listOpenRuns();
    if (runs.length === 0) {
      process.stdout.write("No open runs.\n");
      return;
    }
    for (const run of runs) {
      process.stdout.write(`run ${run.id} [${run.state}] $${store.spentUsd(run.id).toFixed(2)} — ${run.assignment.slice(0, 60)}\n`);
      for (const t of store.listTasks(run.id)) {
        process.stdout.write(`  ${t.id} [${t.state}] qa=${t.qaIterations}${t.prNumber ? ` PR#${t.prNumber}` : ""}\n`);
      }
    }
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
      budget: { runCapUsd: DEFAULT_RUN_CAP, taskCapUsd: DEFAULT_TASK_CAP },
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

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
