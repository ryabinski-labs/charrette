import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";

const { queryMock, reapUnderMock } = vi.hoisted(() => ({ queryMock: vi.fn(), reapUnderMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("./reaper.js", () => ({ reapUnder: reapUnderMock }));

import { Bus } from "./bus.js";
import { Store } from "./store.js";
import { AgentPool, type AgentSpec } from "./pool.js";

/**
 * The pool watching the account's plan, and moving a run onto another one.
 *
 * The wait in poolLimit.test.ts is what happens *after* the wall: every session
 * dies at once and the pool sleeps until the window reopens, which for a weekly
 * window is days. These cases are about the approach to it — the readings the
 * plan volunteers on the way up, and what a session does when the operator
 * answers "carry on somewhere else".
 *
 * The restart is the part worth pinning. A running session cannot change the
 * credentials it was spawned with, so continuing on another subscription means
 * the same session row, the same ledger and — where the login allows it — the
 * same conversation, started again under a new environment.
 */

type Message = Record<string, unknown>;

const result = (over: Partial<{ result: string; session_id: string }> = {}): Message => ({
  type: "result",
  session_id: over.session_id ?? "sdk-session-1",
  subtype: "success",
  result: over.result ?? "the answer",
  usage: { input_tokens: 100, output_tokens: 50 },
  total_cost_usd: 0.25,
});

const rateLimit = (over: Record<string, unknown> = {}): Message => ({
  type: "rate_limit_event",
  session_id: "sdk-session-1",
  rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.96, resetsAt: 1787054400, ...over },
});

/** Each call to query() plays the next script. */
function scripts(...runs: Message[][]): void {
  let nth = 0;
  queryMock.mockImplementation(() => {
    const messages = runs[Math.min(nth++, runs.length - 1)]!;
    return (async function* () {
      for (const m of messages) yield m;
    })();
  });
}

let store: Store;
let bus: Bus;
let events: HarnessEvent[];
let pool: AgentPool;

const SPEC: AgentSpec = {
  runId: "run1",
  role: "worker",
  model: "claude-opus-5",
  systemPrompt: "you are a worker",
  prompt: "build the thing",
  cwd: "/tmp/worktree",
};

const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({ ...SPEC, ...over });

const envs = () => queryMock.mock.calls.map((c) => (c[0] as { options: { env?: Record<string, string> } }).options.env ?? {});
const resumes = () => queryMock.mock.calls.map((c) => (c[0] as { options: { resume?: string } }).options.resume);
const logs = () => events.filter((e) => e.type === "agent.log").map((e) => (e as { text: string }).text);
const sessionRows = () => store.db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];

beforeEach(() => {
  queryMock.mockReset();
  reapUnderMock.mockReset().mockResolvedValue([]);
  store = new Store(":memory:");
  store.createRun({
    id: "run1",
    repoPath: "/tmp/repo",
    assignment: "build a thing",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: "harness/run1/main",
    config: RunConfig.parse({}),
  });
  bus = new Bus(store);
  events = [];
  bus.subscribe(({ event }) => void events.push(event));
  pool = new AgentPool(store, bus, async () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the account this run spends", () => {
  it("spawns every session under the configured subscription", async () => {
    pool.configureSubscription({ name: "work", env: { CLAUDE_CODE_OAUTH_TOKEN: "oat-work" } });
    scripts([result()]);

    await pool.run(spec());

    expect(envs()[0]).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "oat-work" });
  });

  it("beats the shell the harness was started from", async () => {
    // The whole point of a switch: the operator's own login is what the run is
    // getting away from, and an overlay that lost to the inherited environment
    // would keep spending the exhausted account while the log said otherwise.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oat-ambient";
    try {
      pool.configureSubscription({ name: "work", env: { CLAUDE_CODE_OAUTH_TOKEN: "oat-work" } });
      scripts([result()]);
      await pool.run(spec());
      expect(envs()[0]!.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-work");
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });

  it("keeps the ambient login when nothing is configured", async () => {
    // Every run before this feature, and every run that never names an account.
    pool.configureSubscription(undefined);
    scripts([result()]);
    await pool.run(spec());
    expect(envs()[0]).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("takes a watch with no account attached, which is most runs", async () => {
    // A run that watches its plan but has no second subscription configured:
    // the gate can still stop it before the wall, which is the larger half of
    // the value and needs no credentials at all.
    const seen: string[] = [];
    pool.configureSubscription({
      watch: async (_runId, _reading, spawnedAs) => {
        seen.push(spawnedAs);
        return null;
      },
    });
    scripts([rateLimit(), result()]);

    await pool.run(spec());

    expect(seen).toEqual([""]);
    expect(envs()[0]).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

describe("a reading the plan volunteers mid-session", () => {
  it("hands the watch what the account said, normalised", async () => {
    const seen: unknown[] = [];
    pool.configureSubscription({
      name: "personal",
      watch: async (runId, reading, spawnedAs) => {
        seen.push({ runId, reading, spawnedAs });
        return null;
      },
    });
    scripts([rateLimit(), result()]);

    const res = await pool.run(spec());

    expect(res.outcome).toBe("done");
    expect(seen).toEqual([
      { runId: "run1", reading: { window: "seven_day", percent: 96, resetsAt: 1787054400_000 }, spawnedAs: "personal" },
    ]);
  });

  it("costs a run with no watch nothing at all", async () => {
    // No watch means the message is not even parsed: this is on the hot path of
    // every message of every session in the run.
    scripts([rateLimit(), result()]);
    await expect(pool.run(spec())).resolves.toMatchObject({ outcome: "done" });
  });

  it("carries on untouched when the watch says nothing needs to change", async () => {
    pool.configureSubscription({ name: "personal", watch: async () => null });
    scripts([rateLimit(), result()]);

    await pool.run(spec());

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(logs().some((l) => /subscription/.test(l))).toBe(false);
  });

  it("carries on when the watch answers with the account it already has", async () => {
    pool.configureSubscription({ name: "personal", env: { A: "1" }, watch: async () => ({ name: "personal", env: { A: "2" } }) });
    scripts([rateLimit(), result()]);

    await pool.run(spec());

    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe("moving a live session onto another subscription", () => {
  const switchTo = (name: string, env: Record<string, string>) => ({
    name: "personal",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "oat-personal" },
    watch: vi.fn(async () => ({ name, env })),
  });

  it("restarts the interrupted attempt under the new credentials", async () => {
    pool.configureSubscription(switchTo("work", { CLAUDE_CODE_OAUTH_TOKEN: "oat-work" }));
    scripts([rateLimit()], [result({ result: "finished on the other account" })]);

    const res = await pool.run(spec());

    expect(res).toMatchObject({ outcome: "done", resultText: "finished on the other account" });
    expect(envs()[0]!.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-personal");
    expect(envs()[1]!.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-work");
  });

  it("continues the same conversation when the switch keeps the same transcript", async () => {
    pool.configureSubscription(switchTo("work", { CLAUDE_CODE_OAUTH_TOKEN: "oat-work" }));
    scripts([rateLimit()], [result()]);

    await pool.run(spec());

    // A token swap leaves the session's transcript exactly where it was, so the
    // work the agent had already done is still in front of it.
    expect(resumes()).toEqual([undefined, "sdk-session-1"]);
  });

  it("tells the continued session what happened, and that its stack is gone", async () => {
    const said: string[] = [];
    let nth = 0;
    queryMock.mockImplementation((arg: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
      const attempt = nth++;
      return (async function* () {
        for await (const m of arg.prompt) {
          said.push(m.message.content);
          break;
        }
        yield attempt === 0 ? rateLimit() : result();
      })();
    });
    pool.configureSubscription(switchTo("work", { CLAUDE_CODE_OAUTH_TOKEN: "oat-work" }));

    await pool.run(spec());

    expect(said[0]).toBe("build the thing");
    // Not the usage-limit sentence: nothing reset and no time passed, and an
    // agent told otherwise re-checks ground it covered a second ago.
    expect(said[1]).toMatch(/moved this run onto a different Claude subscription/);
    expect(said[1]).not.toMatch(/usage limit/);
    expect(said[1]).toMatch(/left running in the background .* was stopped/);
  });

  it("starts over when the new account cannot see the old conversation", async () => {
    // A different config directory is a different login: the session id is
    // unfindable there, and resuming it would fail with the attempt spent.
    pool.configureSubscription(switchTo("work", { CLAUDE_CONFIG_DIR: "/home/me/.claude-work" }));
    scripts([rateLimit()], [result()]);

    await pool.run(spec());

    expect(resumes()).toEqual([undefined, undefined]);
    expect(logs().some((l) => /different login, so the conversation cannot be resumed/.test(l))).toBe(true);
  });

  it("keeps one session row and one bill across the switch", async () => {
    pool.configureSubscription(switchTo("work", { CLAUDE_CODE_OAUTH_TOKEN: "oat-work" }));
    scripts([rateLimit()], [result()]);

    await pool.run(spec());

    // A second row would split the session's ledger in two and cost the caller
    // that pre-allocated the id its handle on the session.
    expect(sessionRows()).toHaveLength(1);
    expect(sessionRows()[0]).toMatchObject({ state: "done" });
  });

  it("does not throw away a session that has already answered", async () => {
    // The switch reaches every session dispatched after this one anyway, so
    // killing a finished one would discard work that is paid for and done.
    pool.configureSubscription(switchTo("work", { CLAUDE_CODE_OAUTH_TOKEN: "oat-work" }));
    scripts([result({ result: "already answered" }), rateLimit()]);

    const res = await pool.run(spec());

    expect(res).toMatchObject({ outcome: "done", resultText: "already answered" });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(logs().some((l) => /keeps its answer and the change applies to the next one/.test(l))).toBe(true);
  });

  it("spawns the next session on the account the switch chose", async () => {
    pool.configureSubscription(switchTo("work", { CLAUDE_CODE_OAUTH_TOKEN: "oat-work" }));
    scripts([result(), rateLimit()], [result()]);

    await pool.run(spec());
    await pool.run(spec({ sessionId: "second" }));

    expect(envs()[1]!.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-work");
  });
});

describe("an operator who declines to carry on at all", () => {
  it("ends the session with the reason, and hands the caller the refusal", async () => {
    const paused = new Error("paused on subscription usage: 96% of the weekly limit");
    pool.configureSubscription({
      name: "personal",
      watch: async () => {
        throw paused;
      },
    });
    scripts([rateLimit(), result()]);

    await expect(pool.run(spec())).rejects.toThrow(/paused on subscription usage/);
    // Killed rather than crashed: the session's ending says what stopped it,
    // and the error reaches the caller unwrapped so the run parks instead of
    // being retried against a wall that is still there.
    expect(sessionRows()[0]).toMatchObject({ state: "killed" });
    const ended = events.find((e) => e.type === "agent.ended") as { outcome: string; detail: string };
    expect(ended).toMatchObject({ outcome: "killed" });
    expect(ended.detail).toMatch(/96% of the weekly limit/);
  });

  it("does not restart the session it just stopped", async () => {
    pool.configureSubscription({
      name: "personal",
      watch: async () => {
        throw new Error("paused on subscription usage");
      },
    });
    scripts([rateLimit(), result()]);

    await expect(pool.run(spec())).rejects.toThrow();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe("reading the plan before the run spends anything", () => {
  /** A query whose only job is to answer the control request. */
  const probe = (usage: unknown, over: { throws?: boolean } = {}) => {
    const iterator = { async next() { return { done: true, value: undefined }; }, async return() { return { done: true, value: undefined }; } };
    queryMock.mockReturnValue({
      ...iterator,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: over.throws
        ? async () => { throw new Error("no such control request"); }
        : async () => usage,
    });
  };

  it("asks the control channel and normalises what comes back", async () => {
    probe({ rate_limits: { seven_day: { utilization: 82, resets_at: "2026-08-18T11:59:59+00:00" } } });

    await expect(pool.readSubscription("claude-opus-5")).resolves.toEqual([
      { window: "seven_day", percent: 82, resetsAt: Date.parse("2026-08-18T11:59:59+00:00") },
    ]);
  });

  it("never sends the session a prompt, so the check costs no tokens", async () => {
    probe({ rate_limits: {} });
    await pool.readSubscription("claude-opus-5");
    const arg = queryMock.mock.calls[0]![0] as { prompt: AsyncIterable<unknown>; options: { abortController: AbortController } };
    // The prompt stream is held open and silent, and closed by the abort the
    // probe fires on its way out — so nothing is ever yielded to the model.
    const first = await arg.prompt[Symbol.asyncIterator]().next();
    expect(first.done).toBe(true);
  });

  it("spawns the probe under the run's own subscription", async () => {
    pool.configureSubscription({ name: "work", env: { CLAUDE_CODE_OAUTH_TOKEN: "oat-work" } });
    probe({ rate_limits: {} });

    await pool.readSubscription("claude-opus-5");

    expect(envs()[0]).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "oat-work" });
  });

  it("reports nothing rather than failing the run it was about to start", async () => {
    // An SDK without the control request, an account whose plan does not meter,
    // a subprocess that will not start. None of those is a reason a run cannot
    // begin — they are reasons it begins without the check.
    probe(null, { throws: true });
    await expect(pool.readSubscription("claude-opus-5")).resolves.toEqual([]);
  });

  it("closes the probe even when closing it is what fails", async () => {
    // The session is a subprocess. A probe that answered and then would not
    // shut down cleanly must still hand back what it answered — the alternative
    // is a run that cannot start because the check that protects it could not
    // tidy up after itself.
    queryMock.mockReturnValue({
      async next() { return { done: true, value: undefined }; },
      async return() { throw new Error("the subprocess was already gone"); },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits: { seven_day: { utilization: 12, resets_at: null } } }),
    });

    await expect(pool.readSubscription("claude-opus-5")).resolves.toEqual([{ window: "seven_day", percent: 12, resetsAt: null }]);
  });

  it("gives up rather than hanging the start of the run", async () => {
    // `sleep` is the pool's injectable clock, so the timeout is proven without
    // anyone waiting twenty seconds for it.
    const iterator = { async next() { return { done: true, value: undefined }; }, async return() { return { done: true, value: undefined }; } };
    queryMock.mockReturnValue({ ...iterator, usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => undefined) });

    await expect(pool.readSubscription("claude-opus-5")).resolves.toEqual([]);
  });
});
