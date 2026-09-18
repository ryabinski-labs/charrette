import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@charrette/shared";
import type { CharretteEvent } from "@charrette/shared";

const { queryMock, reapUnderMock } = vi.hoisted(() => ({ queryMock: vi.fn(), reapUnderMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("./reaper.js", () => ({ reapUnder: reapUnderMock }));

import { Bus } from "./bus.js";
import { Store } from "./store.js";
import { BudgetExceeded } from "./budget.js";
import { AgentPool, type AgentSpec } from "./pool.js";

/**
 * The account running out of quota, and the run surviving it.
 *
 * A limit kills every session in flight at the same instant, with a sentence
 * that has nothing to do with the work: run f338b5c8 spent all three planner
 * attempts on one inside a second, ended `charrette: fatal`, and took the
 * operator's intake conversation with it. Waiting it out belongs here — the one
 * place every role passes through — so no caller has to know a limit from a
 * failure. What these cases pin is that the wait continues the *same* session
 * rather than starting a new one: same row, one bill, and a conversation that
 * still remembers what it had already done.
 */

type Message = Record<string, unknown>;

const result = (over: Partial<{ result: string; is_error: boolean; session_id: string }> = {}): Message => ({
  type: "result",
  session_id: over.session_id ?? "sdk-session-1",
  subtype: "success",
  result: over.result ?? "the answer",
  ...(over.is_error ? { is_error: true } : {}),
  usage: { input_tokens: 100, output_tokens: 50 },
  total_cost_usd: 0.25,
});

const LIMIT = "You've hit your session limit · resets 8:20pm (America/New_York)";

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
let events: CharretteEvent[];
let slept: number[];
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

const promptsGiven = () => queryMock.mock.calls.map((c) => (c[0] as { options: { resume?: string } }).options.resume);

const logs = () => events.filter((e) => e.type === "agent.log").map((e) => (e as { text: string }).text);

const sessionRows = () => store.db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];

function build(config: Partial<Parameters<typeof RunConfig.parse>[0]> = {}): void {
  // A limit quotes a wall-clock reset, so the wait it produces depends on what
  // time it is where the account is metered. Frozen at 16:00 in New York, the
  // "8:20pm" below is always four hours and twenty minutes away — otherwise
  // these cases would pass or fail by the hour they were run at.
  vi.useFakeTimers({ now: Date.UTC(2026, 7, 5, 20, 0, 0), toFake: ["Date"] });
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
    integrationBranch: "charrette/run1/main",
    config: RunConfig.parse(config),
  });
  bus = new Bus(store);
  events = [];
  bus.subscribe(({ event }) => void events.push(event));
  slept = [];
  pool = new AgentPool(store, bus, async (ms) => void slept.push(ms));
}

beforeEach(() => build());

afterEach(() => {
  vi.useRealTimers();
});

describe("a session that dies because the account is out of quota", () => {
  it("waits for the reset and continues the same conversation", async () => {
    scripts([result({ result: LIMIT, is_error: true })], [result({ result: "done and dusted" })]);

    const res = await pool.run(spec());

    expect(res).toMatchObject({ outcome: "done", resultText: "done and dusted" });
    // 16:00 in New York to the 8:20pm the message quoted, and a minute past it.
    expect(slept).toEqual([4 * 3_600_000 + 21 * 60_000]);
    // Continued, not restarted: the second attempt resumes the first's session.
    expect(promptsGiven()).toEqual([undefined, "sdk-session-1"]);
  });

  it("tells the second attempt what happened rather than repeating the assignment", async () => {
    const said: string[] = [];
    queryMock.mockImplementation((arg: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
      const nth = said.length;
      return (async function* () {
        for await (const m of arg.prompt) {
          said.push(m.message.content);
          break;
        }
        yield nth === 0 ? result({ result: LIMIT, is_error: true }) : result();
      })();
    });

    await pool.run(spec());

    expect(said[0]).toBe("build the thing");
    expect(said[1]).toMatch(/hit its usage limit[\s\S]*check what you had already finished/i);
    expect(said[1]).not.toMatch(/build the thing/);
  });

  it("warns the second attempt that what it had running was swept", async () => {
    // The interrupted attempt's `finally` reaps the worktree, so the dev server
    // the agent brought up is gone while its transcript still says it works. A
    // continuation told only that its context stands spends its turns reading
    // connection refusals as product bugs.
    const said: string[] = [];
    queryMock.mockImplementation((arg: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
      const nth = said.length;
      return (async function* () {
        for await (const m of arg.prompt) {
          said.push(m.message.content);
          break;
        }
        yield nth === 0 ? result({ result: LIMIT, is_error: true }) : result();
      })();
    });

    await pool.run(spec({ reapOnEnd: true }));

    expect(said[1]).toMatch(/running in the background[\s\S]*was stopped/i);
    expect(said[1]).toMatch(/start what you need again/i);
  });

  it("keeps one session row and one bill across the wait", async () => {
    scripts([result({ result: LIMIT, is_error: true })], [result({ result: "done" })]);

    const res = await pool.run(spec());

    const rows = sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(res.sessionId);
    expect(rows[0]!.state).toBe("done");
    // Both attempts' tokens are on the one session, which is what the ledger
    // says too — a second row would split one session's spend in half.
    expect(rows[0]!.inputTokens).toBe(200);
    expect(store.db.prepare("SELECT COUNT(*) c FROM ledger").get()).toMatchObject({ c: 2 });
  });

  it("counts the replies from both sides of the wait", async () => {
    // Turns are counted per attempt, and the dashboard reads this column as
    // "N replies". Written flat rather than added, a worker forty turns into a
    // task when the quota window closed comes back reading as though it had
    // barely started.
    const reply = { type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 5 } } };
    scripts([reply, reply, result({ result: LIMIT, is_error: true })], [reply, result({ result: "done" })]);

    await pool.run(spec());

    expect(sessionRows()[0]!.turns).toBe(3);
  });

  it("says what it is waiting for, and that nothing was lost", async () => {
    scripts([result({ result: LIMIT, is_error: true })], [result()]);

    await pool.run(spec());

    expect(logs().join("\n")).toMatch(/out of quota[\s\S]*session limit[\s\S]*Waiting/);
    expect(logs().join("\n")).toMatch(/should have reset — continuing the worker session/);
  });

  it("keeps the session id its caller pre-allocated", async () => {
    scripts([result({ result: LIMIT, is_error: true })], [result()]);

    // Intake allocates the id before the session starts and follows its agent's
    // prose by filtering the bus on it. A retry under a new id would leave the
    // operator watching a conversation that had quietly moved elsewhere.
    const res = await pool.run(spec({ sessionId: "intake-1" }));

    expect(res.sessionId).toBe("intake-1");
    expect(sessionRows()).toHaveLength(1);
    expect(logs().every((_t, i) => events[i]!.type !== "agent.log" || (events[i] as { sessionId: string }).sessionId === "intake-1")).toBe(true);
  });
});

describe("a session that dies mid-thought because the account is out of quota", () => {
  it("waits, then starts the session over — there is nothing to resume from", async () => {
    let nth = 0;
    queryMock.mockImplementation(() =>
      (async function* () {
        if (nth++ === 0) throw new Error(`Claude Code process exited: ${LIMIT}`);
        yield result({ result: "second time lucky" });
      })()
    );

    const res = await pool.run(spec());

    expect(res.resultText).toBe("second time lucky");
    expect(slept).toHaveLength(1);
    expect(promptsGiven()).toEqual([undefined, undefined]);
  });

  it("still lets the operator's budget cap through", async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield result();
      })()
    );

    await expect(pool.run(spec({ budgetCheck: () => { throw new BudgetExceeded(41, 40, "run1"); } }))).rejects.toThrow(BudgetExceeded);
    expect(slept).toEqual([]);
  });

  it("discards the caller's old resume handle and refreshes guidance after a thrown limit", async () => {
    const said: string[] = [];
    let guidance = "original guidance";
    queryMock.mockImplementation((arg: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
      const nth = said.length;
      return (async function* () {
        for await (const m of arg.prompt) { said.push(m.message.content); break; }
        if (nth === 0) {
          guidance = "guidance delivered during the interrupted attempt";
          throw new Error(`Claude Code process exited: ${LIMIT}`);
        }
        yield result();
      })();
    });
    const restartPrompt = vi.fn(() => `Full assignment and ${guidance}`);

    await pool.run(spec({ resume: "previous-session", prompt: "Fix QA feedback", restartPrompt }));

    expect(promptsGiven()).toEqual(["previous-session", undefined]);
    expect(said).toEqual(["Fix QA feedback", "Full assignment and guidance delivered during the interrupted attempt"]);
    expect(restartPrompt).toHaveBeenCalledTimes(1);
  });

  it("gives the crash back when the wait is longer than the run allows", async () => {
    build({ usageLimitWaitMinutes: 0 });
    queryMock.mockImplementation(() =>
      (async function* () {
        throw new Error(`Claude Code process exited: ${LIMIT}`);
      })()
    );

    await expect(pool.run(spec())).rejects.toThrow(/session limit/);
    expect(slept).toEqual([]);
  });

  it("gives a crash that is not a limit straight back", async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        throw new Error("Claude Code process exited with code 1");
        // eslint-disable-next-line no-unreachable
        yield result();
      })()
    );

    await expect(pool.run(spec())).rejects.toThrow(/exited with code 1/);
    expect(slept).toEqual([]);
  });
});

describe("a limit that outlasts the run's patience", () => {
  it("reports the failure instead of waiting, when waiting is switched off", async () => {
    build({ usageLimitWaitMinutes: 0 });
    scripts([result({ result: LIMIT, is_error: true })]);

    const res = await pool.run(spec());

    expect(res.outcome).toBe("error");
    expect(res.errorDetail).toMatch(/session limit/);
    expect(slept).toEqual([]);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(logs().join("\n")).toMatch(/more than this run allows/);
  });

  it("waits for nothing on behalf of a run it cannot read", async () => {
    // No run row, no configured patience: a session the store knows nothing
    // about is not one this can decide to park for six hours.
    scripts([result({ result: LIMIT, is_error: true })]);
    store.db.prepare("DELETE FROM runs WHERE id = 'run1'").run();

    expect((await pool.run(spec())).outcome).toBe("error");
    expect(slept).toEqual([]);
  });

  it("spends its budget across successive waits rather than waiting forever", async () => {
    // Two hours of patience against a limit that says nothing about when it
    // lifts: probe, back off, back off, and then stop.
    build({ usageLimitWaitMinutes: 21 });
    scripts([result({ result: "You've hit your weekly limit", is_error: true })]);

    const res = await pool.run(spec());

    expect(res.outcome).toBe("error");
    expect(slept).toEqual([60_000, 5 * 60_000, 15 * 60_000]);
    expect(queryMock).toHaveBeenCalledTimes(4);
  });

  it("gives the caller back the last failure, not the first", async () => {
    build({ usageLimitWaitMinutes: 1 });
    let nth = 0;
    queryMock.mockImplementation(() =>
      (async function* () {
        yield result({ result: nth++ === 0 ? "You've hit your weekly limit" : LIMIT, is_error: true });
      })()
    );

    const res = await pool.run(spec());

    // One minute of patience buys the un-timed probe; the four-hour wait the
    // second failure asks for does not fit, so that is the one reported.
    expect(slept).toEqual([60_000]);
    expect(res.errorDetail).toMatch(/session limit/);
  });
});

describe("what the wait costs the caller's own clocks", () => {
  it("hands back the time it slept, so a wall clock can discount it", async () => {
    scripts([result({ result: LIMIT, is_error: true })], [result()]);
    const credited: number[] = [];

    await pool.run(spec({ onLimitWait: (ms) => void credited.push(ms) }));

    expect(credited).toEqual(slept);
  });
});
