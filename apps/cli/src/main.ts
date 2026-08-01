#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { RunConfig } from "@harness/shared";
import { AgentPool, Bus, GateHandler, GitHubAdapter, RunController, Store } from "@harness/core";

function makeController(repoPath: string): { controller: RunController; store: Store } {
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
  const gates: GateHandler = {
    async resolvePlanGate(prd, summary) {
      process.stdout.write(`\n===== GENERATED PRD =====\n${prd}\n\n===== TASK BREAKDOWN =====\n${summary}\n\n`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question("Approve plan? [y = approve / anything else = rejection feedback] ")).trim();
      rl.close();
      if (answer.toLowerCase() === "y") return { approved: true, feedback: "" };
      return { approved: false, feedback: answer || "rejected without feedback" };
    },
  };
  return { controller: new RunController(store, bus, pool, github, gates, repoPath), store };
}

function defaultConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return RunConfig.parse({
    skillsDirs: [path.join(os.homedir(), ".claude", "skills"), path.join(os.homedir(), "skills")],
    ...overrides,
  });
}

const program = new Command();
program.name("harness").description("Multi-agent development harness: assignment in, reviewed PRs out");

program
  .command("run")
  .argument("<assignment>", "what to build")
  .option("-r, --repo <path>", "target repo", process.cwd())
  .option("--run-cap <usd>", "run budget cap in USD", "30")
  .option("--task-cap <usd>", "task budget cap in USD", "10")
  .option("--check <cmd...>", "deterministic check commands run before QA")
  .action(async (assignment: string, opts: { repo: string; runCap: string; taskCap: string; check?: string[] }) => {
    const { controller } = makeController(path.resolve(opts.repo));
    const runId = await controller.startRun(
      assignment,
      defaultConfig({
        budget: { runCapUsd: Number(opts.runCap), taskCapUsd: Number(opts.taskCap) },
        deterministicChecks: opts.check ?? [],
      })
    );
    process.stdout.write(`\nRun ${runId} complete. Review PRs on GitHub (the harness never merges).\n`);
  });

program
  .command("resume")
  .argument("<runId>")
  .option("-r, --repo <path>", "target repo", process.cwd())
  .action(async (runId: string, opts: { repo: string }) => {
    const { controller } = makeController(path.resolve(opts.repo));
    await controller.resume(runId);
  });

program
  .command("status")
  .option("-r, --repo <path>", "target repo", process.cwd())
  .action((opts: { repo: string }) => {
    const { store } = makeController(path.resolve(opts.repo));
    for (const run of store.listOpenRuns()) {
      process.stdout.write(`run ${run.id} [${run.state}] $${store.spentUsd(run.id).toFixed(2)} — ${run.assignment.slice(0, 60)}\n`);
      for (const t of store.listTasks(run.id)) {
        process.stdout.write(`  ${t.id} [${t.state}] qa=${t.qaIterations}${t.prNumber ? ` PR#${t.prNumber}` : ""}\n`);
      }
    }
  });

program.parseAsync().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
