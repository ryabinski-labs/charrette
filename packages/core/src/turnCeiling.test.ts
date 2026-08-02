import { describe, expect, it } from "vitest";
import { PromptStream } from "./pool.js";
import { Store } from "./store.js";

/**
 * The turn ceiling was the most expensive thing in two production runs: QA
 * sessions died clustered at 91-112 turns against a cap of 90, workers at up to
 * 195 against 100, and each death threw away the whole session — no verdict, no
 * summary, and a re-dispatch that started over. The sessions that hit it are the
 * expensive ones precisely because they die having done the most work.
 *
 * These cover the two halves of not losing that work: the stream stays open long
 * enough to deliver a wrap-up message pushed mid-session, and a session that dies
 * without reaching endSession still books what it spent.
 */
describe("wrap-up before the ceiling", () => {
  const tick = () => new Promise<void>((r) => setImmediate(r));

  it("delivers a message pushed mid-session, and the agent gets its last exchange", async () => {
    // The wrap-up is pushed from inside the message loop, between an assistant
    // message and the result that follows it. `settle()` must not close the
    // stream out from under it — otherwise the agent is cut off exactly where
    // it was about to answer.
    const stream = new PromptStream("verify this task");
    const seen: string[] = [];
    const consumed = (async () => {
      for await (const m of stream.stream()) seen.push(m.message.content as string);
    })();

    await tick();
    expect(seen).toEqual(["verify this task"]);

    expect(stream.push("[HARNESS] You are near this session's turn limit")).toBe(true);
    stream.settle(); // the result for the turn that triggered the push
    await tick();
    expect(seen[1]).toContain("near this session's turn limit");

    stream.settle(); // the answer to the wrap-up — nothing left, so it ends
    await consumed;
  });
});

describe("what a dead session cost", () => {
  function session(store: Store, id: string, state: string): void {
    store.db
      .prepare("INSERT INTO sessions (id, runId, taskId, role, model, state, startedAt) VALUES (?,?,?,?,?,?,?)")
      .run(id, "run-1", "task-a", "qa", "claude-sonnet-5", state, 1);
  }
  const bill = (store: Store, sessionId: string, costUsd: number) =>
    store.recordUsage({ runId: "run-1", taskId: "task-a", sessionId, model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });

  it("bills a session the previous process left running, from the ledger", () => {
    // sweepDeadSessions used to flip these to 'interrupted' and nothing else,
    // so the row claimed the session cost nothing. One run's sessions table
    // came out $49.08 against a ledger of $80.34 that way.
    const store = new Store(":memory:");
    session(store, "s-dead", "running");
    bill(store, "s-dead", 1.25);
    bill(store, "s-dead", 0.75);

    expect(store.sweepDeadSessions()).toBe(1);
    const row = store.db.prepare("SELECT state, costUsd FROM sessions WHERE id = 's-dead'").get() as { state: string; costUsd: number };
    expect(row.state).toBe("interrupted");
    expect(row.costUsd).toBeCloseTo(2.0);
  });

  it("leaves a finished session's own figure alone when it is the larger one", () => {
    // The ledger settles the bill; it does not get to revise a number the
    // session already reported for itself.
    const store = new Store(":memory:");
    session(store, "s-done", "running");
    store.db.prepare("UPDATE sessions SET costUsd = 5 WHERE id = 's-done'").run();
    bill(store, "s-done", 1.0);

    store.sweepDeadSessions();
    const row = store.db.prepare("SELECT costUsd FROM sessions WHERE id = 's-done'").get() as { costUsd: number };
    expect(row.costUsd).toBe(5);
  });

  it("costs nothing when nothing was spent", () => {
    const store = new Store(":memory:");
    session(store, "s-empty", "running");
    store.sweepDeadSessions();
    const row = store.db.prepare("SELECT costUsd FROM sessions WHERE id = 's-empty'").get() as { costUsd: number };
    expect(row.costUsd).toBe(0);
  });
});
