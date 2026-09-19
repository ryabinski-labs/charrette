import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig } from "@charrette/shared";
import type { CharretteEvent } from "@charrette/shared";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec, SubscriptionPolicy } from "./pool.js";
import { RunController, type GateHandler, type SubscriptionChoice, type SubscriptionGate } from "./runController.js";
import type { SubscriptionReading } from "./subscription.js";
import { Store } from "./store.js";

/**
 * The subscription gate: the run stopping because the *account* is nearly out
 * of plan, rather than because this run is out of dollars.
 *
 * The two are genuinely different ceilings and the difference is the whole
 * feature. A cap is money the operator controls and can raise by typing a
 * number. A weekly window is quota that comes back on a date nobody controls —
 * so the answers are another subscription, spending the rest of it on purpose,
 * or stopping while stopping is still cheap.
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-sub-"));
  made.push(dir, `${dir}-wt`);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  return dir;
}

function commitInWorktree(cwd: string, file: string): void {
  writeFileSync(path.join(cwd, file), "done\n");
  execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=w@x.invalid", "-c", "user.name=W", "commit", "-m", `add ${file}`], { cwd, stdio: "ignore" });
}

const DOCS = "<prd>\n# PRD — Build the thing\n</prd>\n<conventions>\nuse vitest\n</conventions>";
const QA_PASS = '```json\n{"verdict":"PASS","notes":"ok"}\n```';

const dagJson = (ids: string[] = ["task-a"]) =>
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: ids.map((id) => ({
      id, epicId: "epic-e", title: id.toUpperCase(), spec: "s", acceptanceCriteria: ["x"],
      dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" as const,
    })),
  }) +
  "\n```";

const weekly = (percent: number, over: Partial<SubscriptionReading> = {}): SubscriptionReading => ({
  window: "seven_day",
  percent,
  // Relative to now, never a fixed date. An absolute reset time is in the past
  // the moment the calendar passes it, `untilReset` clamps to zero and starts
  // answering "under an hour", and the suite fails on a date rather than on a
  // change — which is exactly what it did from 2026-08-18 onwards.
  resetsAt: Date.now() + 3 * 3_600_000,
  ...over,
});

/**
 * A pool that stands in for the two things the real one does here: it reports
 * whatever the account is supposed to have said before the run starts, and it
 * lets a named role report a reading mid-session, which is the moment a live
 * session hands the controller a question.
 */
function watchingPool(
  answers: Partial<Record<string, string | ((spec: AgentSpec, nth: number) => string)>>,
  opts: { preflight?: SubscriptionReading[]; reportOn?: string; readings?: SubscriptionReading[] } = {}
) {
  const policies: SubscriptionPolicy[] = [];
  const told: ({ name: string; env: Record<string, string> } | null)[] = [];
  const counts: Record<string, number> = {};
  const queued = [...(opts.readings ?? [])];
  const pool = {
    configureSubscription(policy: SubscriptionPolicy) {
      policies.push(policy);
    },
    async readSubscription(): Promise<SubscriptionReading[]> {
      return opts.preflight ?? [];
    },
    async run(spec: AgentSpec): Promise<AgentResult> {
      counts[spec.role] = (counts[spec.role] ?? 0) + 1;
      await spec.budgetCheck?.();
      // The session reporting what the plan told it, mid-turn — the pool's own
      // `rate_limit_event` branch, without an SDK to stream one. Reported by
      // whichever sessions the case names, one reading apiece, because that is
      // how the real thing arrives: every session in flight meets the same
      // window and each one asks.
      if ((!opts.reportOn || spec.role === opts.reportOn) && queued.length) {
        const policy = policies[policies.length - 1]!;
        told.push(await policy.watch!(spec.runId, queued.shift()!, policy.name ?? ""));
      }
      const answer = answers[spec.role];
      const text = typeof answer === "function" ? answer(spec, counts[spec.role]!) : (answer ?? "");
      return { sessionId: `s-${spec.role}-${counts[spec.role]}`, sdkSessionId: "sdk1", resultText: text, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, policies, told };
}

function build(opts: { repoPath: string; pool: AgentPool; gates?: Partial<GateHandler> }) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: CharretteEvent[] = [];
  bus.subscribe(({ event }) => void events.push(event));
  const gates: GateHandler = {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
    ...opts.gates,
  };
  const controller = new RunController(store, bus, opts.pool, new GitHubAdapter(undefined, undefined), gates, opts.repoPath);
  return { controller, store, events, bus };
}

const worker = (spec: AgentSpec, nth: number) => (commitInWorktree(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`), "did the work");

const ROLES = {
  planner: (s: AgentSpec) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
  worker,
  qa: () => QA_PASS,
  validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
};

const ACCOUNTS = [
  { name: "personal", env: { CLAUDE_CODE_OAUTH_TOKEN: "$PERSONAL_TOKEN" }, note: "" },
  { name: "work", env: { CLAUDE_CONFIG_DIR: "/home/me/.claude-work" }, note: "" },
];

const config = (over: Record<string, unknown> = {}) =>
  RunConfig.parse({ deterministicChecks: [], subscription: { accounts: ACCOUNTS, active: "work", preflight: false, ...(over.subscription as object) }, ...over });

const stateChanges = (events: CharretteEvent[]) =>
  events.filter((e): e is CharretteEvent & { type: "run.state_changed"; to: string } => e.type === "run.state_changed").map((e) => e.to);

describe("what the run is spending", () => {
  it("hands the pool the account's credentials, resolved from the shell", async () => {
    process.env.PERSONAL_TOKEN = "oat-personal";
    try {
      const { pool, policies } = watchingPool(ROLES);
      const { controller } = build({ repoPath: repo(), pool });

      await controller.startRun("build a thing", config({ subscription: { accounts: ACCOUNTS, active: "personal", preflight: false } }));

      expect(policies[0]).toMatchObject({ name: "personal", env: { CLAUDE_CODE_OAUTH_TOKEN: "oat-personal" } });
    } finally {
      delete process.env.PERSONAL_TOKEN;
    }
  });

  it("refuses to start rather than authenticating as nobody", async () => {
    // A `$TOKEN` nobody exported would otherwise fall back to the ambient
    // login — the account the operator was trying not to spend — and the run
    // would look like it had switched.
    const { pool } = watchingPool(ROLES);
    const { controller } = build({ repoPath: repo(), pool });

    await expect(
      controller.startRun("build a thing", config({ subscription: { accounts: ACCOUNTS, active: "personal", preflight: false } }))
    ).rejects.toThrow(/PERSONAL_TOKEN is not set in this shell/);
  });

  it("uses the login the operator already has when no account is named", async () => {
    const { pool, policies } = watchingPool(ROLES);
    const { controller } = build({ repoPath: repo(), pool });

    await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], subscription: { preflight: false } }));

    expect(policies[0]).toMatchObject({ name: "", env: {} });
  });
});

describe("reading the plan before the run spends anything", () => {
  it("records where the account stood, whether or not it stops anything", async () => {
    const { pool } = watchingPool(ROLES, { preflight: [weekly(40), { window: "five_hour", percent: 4, resetsAt: null }] });
    const { controller, events } = build({ repoPath: repo(), pool });

    await controller.startRun("build a thing", config({ subscription: { accounts: ACCOUNTS, active: "work", preflight: true } }));

    const readings = events.filter((e) => e.type === "run.subscription_reading");
    expect(readings).toHaveLength(2);
    // The account is on the record too: a reading is about a subscription, and
    // a run that switched has readings from two of them.
    expect(readings[0]).toMatchObject({ window: "seven_day", percent: 40, account: "work" });
  });

  it("stops before the first session when the account is already past the line", async () => {
    // The failure this exists for: a run started at 97% of its weekly window
    // learns it from the planner it just paid for.
    const asked: SubscriptionGate[] = [];
    const { pool } = watchingPool(ROLES, { preflight: [weekly(97)] });
    const { controller } = build({
      repoPath: repo(),
      pool,
      gates: {
        async resolveSubscriptionGate(gate) {
          asked.push(gate);
          return { action: "park" };
        },
      },
    });

    await expect(controller.startRun("build a thing", config({ subscription: { accounts: ACCOUNTS, active: "work", preflight: true } }))).rejects.toThrow(
      /paused on subscription usage: 97% of the weekly limit/
    );
    expect(asked[0]).toMatchObject({ window: "seven_day", percent: 97, pauseAtPercent: 95, account: "work", alternatives: ["personal"] });
    expect(asked[0]!.untilReset).toMatch(/\d/);
  });

  it("starts on the account the operator picked when they pick one here", async () => {
    process.env.PERSONAL_TOKEN = "oat-personal";
    try {
      const { pool, policies } = watchingPool(ROLES, { preflight: [weekly(97)] });
      const { controller, store, events } = build({
        repoPath: repo(),
        pool,
        gates: { async resolveSubscriptionGate() { return { action: "switch", account: "personal" }; } },
      });

      const runId = await controller.startRun("build a thing", config({ subscription: { accounts: ACCOUNTS, active: "work", preflight: true } }));

      expect(store.getRun(runId)!.config.subscription.active).toBe("personal");
      expect(policies[policies.length - 1]).toMatchObject({ name: "personal", env: { CLAUDE_CODE_OAUTH_TOKEN: "oat-personal" } });
      expect(events.some((e) => e.type === "run.subscription_switched" && e.from === "work" && e.to === "personal")).toBe(true);
    } finally {
      delete process.env.PERSONAL_TOKEN;
    }
  });

  it("starts on the account it asked with when the operator says carry on", async () => {
    // The third answer the gate can give, and the only one that leaves the run
    // where it was: not parked, not switched. Nothing is applied to the pool,
    // because there is nothing to apply.
    const { pool, policies } = watchingPool(ROLES, { preflight: [weekly(97)] });
    const { controller, store, events } = build({
      repoPath: repo(),
      pool,
      gates: { async resolveSubscriptionGate() { return { action: "continue" }; } },
    });

    const runId = await controller.startRun("build a thing", config({ subscription: { accounts: ACCOUNTS, active: "work", preflight: true } }));

    expect(store.getRun(runId)!.config.subscription.active).toBe("work");
    expect(events.some((e) => e.type === "run.subscription_switched")).toBe(false);
    // The run keeps the account it started with: no second policy was pushed
    // at the pool, only the one every run applies for itself.
    expect(policies.every((p) => p.name === "work")).toBe(true);
  });

  it("does not ask the account anything when the operator turned the check off", async () => {
    const { pool } = watchingPool(ROLES, { preflight: [weekly(99)] });
    const { controller } = build({ repoPath: repo(), pool, gates: { async resolveSubscriptionGate() { return { action: "park" }; } } });

    // preflight:false in `config()` — the run starts without asking, and the
    // gate is left to whatever a live session reports.
    await expect(controller.startRun("build a thing", config())).resolves.toBeTruthy();
  });

  it("does not ask when the operator has turned the gate off entirely", async () => {
    const { pool } = watchingPool(ROLES, { preflight: [weekly(100)] });
    const { controller } = build({ repoPath: repo(), pool, gates: { async resolveSubscriptionGate() { return { action: "park" }; } } });

    await expect(
      controller.startRun("build a thing", config({ subscription: { accounts: ACCOUNTS, active: "work", preflight: true, pauseAtPercent: 100 } }))
    ).resolves.toBeTruthy();
  });
});

describe("a live session reporting the window running out", () => {
  it("parks the run in LIMIT_HOLD when the operator stops there", async () => {
    const { pool } = watchingPool(ROLES, { reportOn: "worker", readings: [weekly(96)] });
    const { controller, store, events } = build({
      repoPath: repo(),
      pool,
      gates: { async resolveSubscriptionGate() { return { action: "park" }; } },
    });

    const runId = await controller.startRun("build a thing", config()).catch(() => "");

    // The run is parked on quota, and says so in its own state rather than in
    // BUDGET_HOLD's — the two are un-parked by completely different things.
    const last = store.listRuns()[0]!;
    expect(last.state).toBe("LIMIT_HOLD");
    expect(runId).toBe("");
    expect(stateChanges(events)).toContain("LIMIT_HOLD");
    const resolved = events.find((e) => e.type === "run.gate_resolved" && e.kind === "subscription") as { resolution: string; feedback: string };
    expect(resolved).toMatchObject({ resolution: "rejected" });
    expect(resolved.feedback).toMatch(/parked at 96% of the weekly limit/);
  });

  it("puts the run back to work when the operator decides to spend the rest", async () => {
    const { pool, told } = watchingPool(ROLES, { reportOn: "worker", readings: [weekly(96)] });
    const { controller, store, events } = build({
      repoPath: repo(),
      pool,
      gates: { async resolveSubscriptionGate() { return { action: "continue" }; } },
    });

    const runId = await controller.startRun("build a thing", config());

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    // Held and released: the session was idle while the operator decided, and
    // the run carried on from exactly where it was.
    expect(stateChanges(events)).toContain("LIMIT_HOLD");
    expect(told).toEqual([null]);
  });

  it("moves the run — and the session holding the question — onto the other subscription", async () => {
    const { pool, told } = watchingPool(ROLES, { reportOn: "worker", readings: [weekly(96, { resetsAt: null })] });
    const { controller, store, events } = build({
      repoPath: repo(),
      pool,
      gates: { async resolveSubscriptionGate() { return { action: "switch", account: "work" }; } },
    });

    const runId = await controller.startRun(
      "build a thing",
      config({ subscription: { accounts: ACCOUNTS, active: "", preflight: false } })
    );

    expect(store.getRun(runId)!.config.subscription.active).toBe("work");
    expect(told).toEqual([{ name: "work", env: { CLAUDE_CONFIG_DIR: "/home/me/.claude-work" } }]);
    const switched = events.find((e) => e.type === "run.subscription_switched") as { from: string; to: string; percent: number };
    expect(switched).toMatchObject({ from: "", to: "work", percent: 96 });
  });

  it("keeps watching after a switch, on the account it switched to", async () => {
    // The new subscription has its own windows, and a run that changed account
    // at 96% and then stopped watching would walk into the second wall with no
    // warning at all — having been given the feature precisely to avoid the
    // first one.
    const asked: string[] = [];
    const { pool, told } = watchingPool(ROLES, { readings: [weekly(96), weekly(97)] });
    const { controller, store } = build({
      repoPath: repo(),
      pool,
      gates: {
        async resolveSubscriptionGate(gate) {
          asked.push(gate.account);
          return gate.account === "" ? { action: "switch", account: "work" } : { action: "continue" };
        },
      },
    });

    const runId = await controller.startRun("build a thing", config({ subscription: { accounts: ACCOUNTS, active: "", preflight: false } }));

    // Asked first as the ambient login, then — a window later — as "work".
    expect(asked).toEqual(["", "work"]);
    expect(store.getRun(runId)!.config.subscription.active).toBe("work");
    // The second session is already on "work", so it is told nothing.
    expect(told[1]).toBeNull();
  });

  it("asks once for a window, however many sessions meet it", async () => {
    // A weekly window trips every session in the pool inside the same second,
    // each arriving with its own copy of the same question. Asking the operator
    // eight times is how a good gate becomes an ignored one.
    let asks = 0;
    // One `resetsAt` for all three, read from the clock once. `weekly()` stamps
    // `Date.now()` per call, so three calls that straddle a millisecond boundary
    // describe three *different* windows — which is a correct re-ask, and a test
    // that fails perhaps one CI run in fifty. The scenario is three sessions
    // meeting one window, so the fixture has to say one window.
    const resetsAt = Date.now() + 3 * 3_600_000;
    const { pool } = watchingPool(ROLES, {
      readings: [weekly(96, { resetsAt }), weekly(97, { resetsAt }), weekly(98, { resetsAt })],
    });
    const { controller } = build({
      repoPath: repo(),
      pool,
      gates: {
        async resolveSubscriptionGate() {
          asks++;
          return { action: "continue" };
        },
      },
    });

    await controller.startRun("build a thing", config({ subscription: { accounts: ACCOUNTS, active: "work", preflight: false } }));

    expect(asks).toBe(1);
  });

  it("asks again when the next window is the one running out", async () => {
    // Not the same question: that is quota which did not exist when the last
    // one was answered.
    let asks = 0;
    const { pool } = watchingPool(ROLES, {
      readings: [weekly(96), weekly(96, { resetsAt: Date.now() + 10 * 24 * 3_600_000 })],
    });
    const { controller } = build({
      repoPath: repo(),
      pool,
      gates: {
        async resolveSubscriptionGate() {
          asks++;
          return { action: "continue" };
        },
      },
    });

    await controller.startRun("build a thing", config());

    expect(asks).toBe(2);
  });

  it("keeps going, loudly, when there is nobody to ask", async () => {
    // A charrette embedded with no gate handler. Parking a run nobody can resume
    // would turn a warning into an outage, so the alert stands on the record
    // and the run carries on.
    const { pool } = watchingPool(ROLES, { reportOn: "worker", readings: [weekly(99)] });
    const { controller, store, events } = build({ repoPath: repo(), pool, gates: { resolveSubscriptionGate: undefined } });

    const runId = await controller.startRun("build a thing", config());

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(events.some((e) => e.type === "run.gate_opened" && e.kind === "subscription")).toBe(true);
  });

  it("ignores a window the operator did not ask to be stopped for", async () => {
    let asks = 0;
    const { pool } = watchingPool(ROLES, { reportOn: "worker", readings: [{ window: "five_hour", percent: 99, resetsAt: null }] });
    const { controller, events } = build({
      repoPath: repo(),
      pool,
      gates: { async resolveSubscriptionGate() { asks++; return { action: "park" }; } },
    });

    await controller.startRun("build a thing", config());

    expect(asks).toBe(0);
    // Still recorded: what the short window was doing is part of diagnosing a
    // run that later walked into the weekly one.
    expect(events.some((e) => e.type === "run.subscription_reading" && e.window === "five_hour")).toBe(true);
  });

  it("parks rather than switching to an account it cannot authenticate as", async () => {
    const { pool } = watchingPool(ROLES, { reportOn: "worker", readings: [weekly(96)] });
    const { controller } = build({
      repoPath: repo(),
      pool,
      gates: { async resolveSubscriptionGate() { return { action: "switch", account: "personal" } as SubscriptionChoice; } },
    });

    // `$PERSONAL_TOKEN` is not exported here, so the switch cannot be made —
    // and a run that carried on would be spending the exhausted account under
    // a log line that says it moved.
    await expect(controller.startRun("build a thing", config())).rejects.toThrow(/PERSONAL_TOKEN is not set in this shell/);
  });
});

describe("picking a parked run back up", () => {
  it("puts a run held on quota back to work", async () => {
    const { pool } = watchingPool(ROLES, { reportOn: "worker", readings: [weekly(96)] });
    const parked = build({
      repoPath: repo(),
      pool,
      gates: { async resolveSubscriptionGate() { return { action: "park" }; } },
    });
    await parked.controller.startRun("build a thing", config()).catch(() => undefined);
    const runId = parked.store.listRuns()[0]!.id;
    expect(parked.store.getRun(runId)!.state).toBe("LIMIT_HOLD");

    // The operator either pointed it at another subscription or waited out the
    // window; either way it goes back to executing, and the gate opens again if
    // the plan is still spent.
    await parked.controller.resume(runId);

    // Straight back to work, and on to the pull request the run was heading
    // for: nothing about the hold cancelled anything.
    expect(parked.store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(parked.store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(parked.events.some((e) => e.type === "run.state_changed" && e.from === "LIMIT_HOLD" && e.to === "EXECUTING")).toBe(true);
  });

  it("closes the gate the dead process was holding when it was killed", async () => {
    // A gate and its hold are two records of one fact, written by the same
    // call: `askSubscription` parks the run, then awaits the answer. Kill the
    // process while it waits and only the parking survives — the promise that
    // would have written `run.gate_resolved` dies with it. A handler that
    // throws reaches the same place by the same route.
    //
    // Run bc691359, 2026-08-24: seq 66181 opened a subscription gate at 100% of
    // the weekly window, seq 66180 parked the run, the operator exported a
    // different token and resumed, and seq 66204 took the run back to EXECUTING
    // at 20:35:56 without ever closing the gate. Two hours later the run was
    // healthy and its own record still said it was waiting on an answer — and
    // so did every reader computing open gates from the event store.
    const { pool } = watchingPool(ROLES, { reportOn: "worker", readings: [weekly(96)] });
    const parked = build({
      repoPath: repo(),
      pool,
      gates: { async resolveSubscriptionGate() { return { action: "park" }; } },
    });
    await parked.controller.startRun("build a thing", config()).catch(() => undefined);
    const runId = parked.store.listRuns()[0]!.id;
    expect(parked.store.getRun(runId)!.state).toBe("LIMIT_HOLD");

    // The state a killed process leaves behind, written straight to the store
    // because that is the only thing that survives it: the gate is opened, the
    // run is parked, and the answer never arrives.
    parked.bus.publish({
      type: "run.gate_opened",
      runId,
      gateId: "1546f6e3",
      kind: "subscription",
      payload: { summary: "100% of the weekly limit" },
      ts: Date.now(),
    });
    // A second gate, of a different kind, open at the same moment. A resume out
    // of a subscription hold says the operator fixed the token; it says nothing
    // whatever about whether they approved the plan. Closing this one too would
    // trade a stale record for a false one — and record it as `approved`.
    parked.bus.publish({
      type: "run.gate_opened",
      runId,
      gateId: "9c40b1a2",
      kind: "plan",
      payload: { summary: "the plan needs an answer" },
      ts: Date.now(),
    });

    const abandoned = parked.store.openRunGates(runId).filter((g) => g.kind === "subscription");
    expect(abandoned.map((g) => g.gateId)).toEqual(["1546f6e3"]);

    await parked.controller.resume(runId).catch(() => undefined);

    // Resuming is the answer — the operator is demonstrably at the keyboard —
    // so the gate they settled must not still be asking.
    expect(parked.store.openRunGates(runId).map((g) => g.gateId)).not.toContain(abandoned[0]!.gateId);
    // Attributed to the resume, never to a decider: `budgetAutoRaises` counts
    // non-human approvals, and a resume must not spend an auto-raise round.
    //
    // `resume` rather than `operator` because `postmortem` reads every gate
    // closed by `operator` as time the run spent waiting on a person — and the
    // span this closes is the one the process spent dead, which nobody waited
    // through.
    const closed = parked.events.find(
      (e) => e.type === "run.gate_resolved" && (e as { gateId?: string }).gateId === abandoned[0]!.gateId
    ) as { decidedBy?: string; feedback?: string } | undefined;
    expect(closed?.decidedBy).toBe("resume");
    expect(closed?.feedback).toBe("resumed from subscription hold");
    // And the plan gate is untouched: still open, and never resolved by anyone.
    expect(parked.store.openRunGates(runId).map((g) => g.gateId)).toContain("9c40b1a2");
    expect(parked.events.some((e) => e.type === "run.gate_resolved" && (e as { gateId?: string }).gateId === "9c40b1a2")).toBe(false);
  });
});
