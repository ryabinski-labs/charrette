import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Store } from "./store.js";

/**
 * What a dollar was spent on, and whether the ledger can still be opened after
 * the columns that record it were added.
 *
 * The second half is the one that would hurt: a run parked before this change
 * and resumed after it opens a database whose ledger has no `role` column, and
 * `CREATE TABLE IF NOT EXISTS` would leave it that way. That run is exactly the
 * one that most needs to resume.
 */

const usage = (over: Partial<Parameters<Store["recordUsage"]>[0]>) => ({
  runId: "run1",
  sessionId: "s1",
  model: "claude-sonnet-5",
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 1,
  ...over,
});

describe("a ledger written before the attribution columns existed", () => {
  it("gains them on open, and keeps the rows that were already there", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-ledger-"));
    const dbPath = path.join(dir, "old.db");
    const old = new DatabaseSync(dbPath);
    old.exec(`CREATE TABLE ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId TEXT NOT NULL, taskId TEXT, sessionId TEXT NOT NULL, model TEXT NOT NULL,
      inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL,
      cacheReadTokens INTEGER NOT NULL, cacheWriteTokens INTEGER NOT NULL,
      costUsd REAL NOT NULL, ts INTEGER NOT NULL)`);
    old.exec("INSERT INTO ledger (runId, taskId, sessionId, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, ts) VALUES ('run1','t1','s0','claude-opus-5',1,1,0,0,9.5,1)");
    old.close();

    const store = new Store(dbPath);

    const columns = (store.db.prepare("PRAGMA table_info(ledger)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("role");
    expect(columns).toContain("tier");
    // The pre-existing spend is still counted — a migration that lost it would
    // hand the budget gate a run that looks $9.50 cheaper than it is.
    expect(store.spentUsd("run1")).toBe(9.5);
    // And it reads back as unattributed rather than as some role's spend: the
    // whole $9.50 is in the total and none of it is claimed by worker or QA.
    expect(store.taskSpend("run1")[0]).toMatchObject({ taskId: "t1", tier: "", totalUsd: 9.5, workerUsd: 0, qaUsd: 0 });

    // Opening it a second time must not try to add the columns again.
    expect(() => new Store(dbPath)).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("what a task cost, and on which tier", () => {
  it("splits a task's bill by the role that spent it", () => {
    const store = new Store(":memory:");
    store.recordUsage(usage({ taskId: "t1", role: "worker", tier: "light", costUsd: 2 }));
    store.recordUsage(usage({ taskId: "t1", role: "qa", costUsd: 5 }));

    // The split is the whole point: a cheap worker that doubles the QA it needs
    // is a saving on one line and a loss on the total, and one number hides it.
    expect(store.taskSpend("run1")[0]).toMatchObject({ workerUsd: 2, qaUsd: 5, totalUsd: 7, tier: "light" });
  });

  it("reads two worker models on one task as an escalation", () => {
    const store = new Store(":memory:");
    store.recordUsage(usage({ taskId: "t1", role: "worker", tier: "light", model: "claude-haiku-4-5-20251001", costUsd: 1 }));
    store.recordUsage(usage({ taskId: "t1", role: "worker", tier: "light", model: "claude-sonnet-5", costUsd: 3 }));

    const [row] = store.taskSpend("run1");
    expect(row).toMatchObject({ escalated: true, tier: "light", workerUsd: 4 });
  });

  it("does not call a task that never changed model an escalation", () => {
    const store = new Store(":memory:");
    store.recordUsage(usage({ taskId: "t1", role: "worker", tier: "standard", costUsd: 3 }));
    store.recordUsage(usage({ taskId: "t1", role: "worker", tier: "standard", costUsd: 2 }));

    expect(store.taskSpend("run1")[0]).toMatchObject({ escalated: false, workerUsd: 5 });
  });

  it("keeps the tier the rule decided, not the tier the escalation ended on", () => {
    // A light-tier task that escalated still cost what light-tier tasks cost —
    // including the standard-model session it escalated into. Re-labelling it
    // `standard` afterwards would quietly move that bill off the experiment.
    const store = new Store(":memory:");
    store.recordUsage(usage({ taskId: "t1", role: "worker", tier: "light", model: "claude-haiku-4-5-20251001", costUsd: 1 }));
    store.recordUsage(usage({ taskId: "t1", role: "worker", tier: "light", model: "claude-sonnet-5", costUsd: 6 }));

    expect(store.taskSpend("run1")[0]!.tier).toBe("light");
  });

  it("orders the most expensive task first, so one disaster cannot hide in an average", () => {
    const store = new Store(":memory:");
    store.recordUsage(usage({ taskId: "cheap", role: "worker", costUsd: 1 }));
    store.recordUsage(usage({ taskId: "ruinous", role: "worker", costUsd: 80 }));

    expect(store.taskSpend("run1").map((r) => r.taskId)).toEqual(["ruinous", "cheap"]);
  });

  it("books usage with no role at all, because the old call sites pass none", () => {
    const store = new Store(":memory:");
    store.recordUsage(usage({ taskId: "t1" }));

    expect(store.spentUsd("run1", "t1")).toBe(1);
  });
});
