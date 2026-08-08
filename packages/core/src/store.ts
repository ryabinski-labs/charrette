import { DatabaseSync } from "node:sqlite";
import { HarnessEvent, RunConfig, RunState, TaskState, RUN_TRANSITIONS, TASK_TRANSITIONS } from "@harness/shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  repoPath TEXT NOT NULL,
  assignment TEXT NOT NULL,
  state TEXT NOT NULL,
  prdPath TEXT,
  planHash TEXT,
  integrationBranch TEXT NOT NULL,
  config TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS epics (
  id TEXT NOT NULL, runId TEXT NOT NULL, title TEXT NOT NULL,
  githubIssueNumber INTEGER, ord INTEGER NOT NULL,
  PRIMARY KEY (runId, id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT NOT NULL, runId TEXT NOT NULL, epicId TEXT NOT NULL,
  title TEXT NOT NULL, spec TEXT NOT NULL, acceptanceCriteria TEXT NOT NULL,
  dependsOn TEXT NOT NULL, state TEXT NOT NULL, branch TEXT,
  worktreePath TEXT, githubIssueNumber INTEGER, prNumber INTEGER,
  qaIterations INTEGER NOT NULL DEFAULT 0, respawns INTEGER NOT NULL DEFAULT 0,
  assignedSkills TEXT NOT NULL DEFAULT '[]', errorSummary TEXT,
  touchedPaths TEXT NOT NULL DEFAULT '[]', estimatedSize TEXT NOT NULL DEFAULT 'M',
  completionProbe TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (runId, id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, runId TEXT NOT NULL, taskId TEXT, role TEXT NOT NULL,
  model TEXT NOT NULL, state TEXT NOT NULL,
  startedAt INTEGER NOT NULL, endedAt INTEGER, turns INTEGER NOT NULL DEFAULT 0,
  inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0,
  cacheReadTokens INTEGER NOT NULL DEFAULT 0, cacheWriteTokens INTEGER NOT NULL DEFAULT 0,
  costUsd REAL NOT NULL DEFAULT 0, lastHeartbeatAt INTEGER,
  build TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  runId TEXT NOT NULL, taskId TEXT, sessionId TEXT,
  type TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(runId, seq);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runId TEXT NOT NULL, taskId TEXT, sessionId TEXT NOT NULL, model TEXT NOT NULL,
  inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL,
  cacheReadTokens INTEGER NOT NULL, cacheWriteTokens INTEGER NOT NULL,
  costUsd REAL NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gates (
  id TEXT PRIMARY KEY, runId TEXT NOT NULL, kind TEXT NOT NULL,
  state TEXT NOT NULL, payload TEXT NOT NULL, resolvedAt INTEGER, feedback TEXT
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runId TEXT NOT NULL, taskId TEXT NOT NULL,
  source TEXT NOT NULL, sourceId TEXT,
  text TEXT NOT NULL, ts INTEGER NOT NULL, deliveredAt INTEGER
);
-- SQLite treats NULLs as distinct in a unique index, so operator notes (no
-- sourceId) never collide with each other while a GitHub comment can only ever
-- be queued once, however many times the issue is polled.
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_source ON feedback(runId, taskId, source, sourceId);
CREATE INDEX IF NOT EXISTS idx_feedback_pending ON feedback(runId, taskId, deliveredAt);
-- What runs in this repository have been observed to do (memory.ts). The only
-- table here that outlives the run that wrote it: rows carry a runId for
-- provenance but are not scoped by it, because the point is the next run.
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, subject TEXT NOT NULL, verdict TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', runId TEXT NOT NULL,
  observedAt INTEGER NOT NULL, observations INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_fact ON memory(kind, subject, verdict);
`;

export interface RunRow {
  id: string;
  repoPath: string;
  assignment: string;
  state: RunState;
  prdPath: string | null;
  planHash: string | null;
  integrationBranch: string;
  config: RunConfig;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRow {
  id: string;
  runId: string;
  epicId: string;
  title: string;
  spec: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  state: TaskState;
  branch: string | null;
  worktreePath: string | null;
  githubIssueNumber: number | null;
  prNumber: number | null;
  qaIterations: number;
  respawns: number;
  assignedSkills: { name: string; sha256: string; mode: "full" | "reference"; role?: "worker" | "qa" }[];
  errorSummary: string | null;
  /**
   * The files the planner expects this task to touch. Persisted because the
   * scheduler reads it: two tasks editing the same file concurrently produce a
   * merge conflict that costs more than the parallelism saved.
   */
  touchedPaths: string[];
  /**
   * One shell command that exits zero exactly when this task is done, run in
   * the worktree before QA is paid. Empty for the tasks — most of them — whose
   * criteria are settled by reading the diff rather than by a search coming
   * back empty. See `PlannedTask.completionProbe`.
   */
  completionProbe: string;
  /** The planner's size guess, and the only input a pre-run cost estimate has. */
  estimatedSize: "S" | "M" | "L";
}

export interface SessionRow {
  id: string;
  taskId: string | null;
  role: string;
  model: string;
  state: string;
  startedAt: number;
  endedAt: number | null;
  turns: number;
  costUsd: number;
  /** The harness build this session was spawned under; "" before it was recorded. */
  build: string;
}

export class InvalidTransition extends Error {}

/**
 * Event-sourced store: every state mutation goes through appendEvent(), which writes
 * the event row and the materialized-state update in one transaction (PRD §11.1).
 */
export class Store {
  readonly db: DatabaseSync;
  private appendListeners = new Set<(e: { seq: number; event: HarnessEvent }) => void>();

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
      // A live run holds this database open for hours, and `status`, `regroup`
      // and the dashboard all write to it from their own processes. WAL lets
      // them read concurrently but still serializes writers, and without a
      // timeout the loser gets SQLITE_BUSY immediately rather than waiting the
      // few milliseconds the other writer needs — which, in `regroup`, can mean
      // a pull request that exists on GitHub and not in the run's history.
      this.db.exec("PRAGMA busy_timeout = 5000");
    }
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Bring a database written by an older harness up to the current schema.
   *
   * `CREATE TABLE IF NOT EXISTS` creates the current shape for a fresh run and
   * silently leaves an existing table at whatever shape it already had, so a
   * column added after a run started is missing for exactly the runs that most
   * want to be resumable. Every entry here is additive and has a default, which
   * is what lets this be a plain idempotent sweep rather than a version ladder.
   */
  private migrate(): void {
    const added: Record<string, Record<string, string>> = {
      tasks: {
        touchedPaths: "TEXT NOT NULL DEFAULT '[]'",
        estimatedSize: "TEXT NOT NULL DEFAULT 'M'",
        // Empty is the honest default for a run planned before probes existed:
        // no command, so nothing is checked and nothing is claimed to be.
        completionProbe: "TEXT NOT NULL DEFAULT ''",
      },
      // Empty rather than 'unknown': the sessions of a run that predates this
      // column are not a build the postmortem should name, and the report says
      // so in its own words.
      sessions: { build: "TEXT NOT NULL DEFAULT ''" },
      // What a dollar was spent ON, not just how many were spent.
      //
      // The ledger could always answer "what did this run cost" and "what did
      // this task cost". It could not answer the question that decides whether
      // a cheaper worker model is worth having — what did a *merged* task cost,
      // counting every attempt, retry and escalation on it, split by the role
      // that spent it. Without the role, a task's worker bill and its QA bill
      // are one number, and a cheap worker that doubles the QA it needs looks
      // like a saving.
      //
      // Empty defaults are honest for rows written before this: those runs did
      // not have tiers, and the role of a session recorded then is recoverable
      // from `sessions` if anyone needs it.
      ledger: { role: "TEXT NOT NULL DEFAULT ''", tier: "TEXT NOT NULL DEFAULT ''" },
    };
    for (const [table, columns] of Object.entries(added)) {
      const have = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      for (const [name, decl] of Object.entries(columns)) {
        if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      }
    }
    this.freezeLightTier();
  }

  /**
   * Give a run created before `models.workerLight` existed the model it was
   * actually planned on.
   *
   * `getRun` re-parses the stored config on every read, so an absent key takes
   * whatever today's default is — which is how a new field is *supposed* to
   * work, and is wrong exactly once. `workerLight` decides which model writes
   * the code. Without this, a run that was planned, priced and half-executed on
   * Sonnet and then parked over a release would come back and finish on Haiku,
   * having agreed to nothing; `patchRunConfig` writes the whole config back, so
   * raising that run's budget was enough to make it permanent.
   *
   * Written into the row rather than defaulted at read time so the config keeps
   * saying what the run is doing. Idempotent by construction: it only touches
   * rows where the key is absent, and it puts the key there.
   */
  private freezeLightTier(): void {
    const fallback = RunConfig.parse({}).models.worker;
    const rows = this.db.prepare("SELECT id, config FROM runs").all() as { id: string; config: string }[];
    const patch = this.db.prepare("UPDATE runs SET config = ? WHERE id = ?");
    for (const row of rows) {
      let config: { models?: Record<string, unknown> };
      // A row this cannot read is one row. Throwing here happens in the
      // constructor, which would take every other run in the database with it.
      try {
        config = JSON.parse(row.config) as { models?: Record<string, unknown> };
      } catch {
        continue;
      }
      const models = config?.models;
      if (!models || typeof models !== "object" || "workerLight" in models) continue;
      // That run's own worker, not the schema default: a run pointed at another
      // vendor would otherwise have its light tier moved to Anthropic too.
      models.workerLight = typeof models.worker === "string" ? models.worker : fallback;
      patch.run(JSON.stringify(config), row.id);
    }
  }

  /** Run fn inside a transaction (node:sqlite has no transaction helper). */
  private txn<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Notified after an event is durably committed. The Bus registers here so that
   * transitions written straight through the store — every run and task state
   * change — reach live subscribers too, not only the events table.
   */
  onAppend(fn: (e: { seq: number; event: HarnessEvent }) => void): () => void {
    this.appendListeners.add(fn);
    return () => void this.appendListeners.delete(fn);
  }

  appendEvent(ev: HarnessEvent, materialize?: () => void): number {
    const parsed = HarnessEvent.parse(ev);
    const insert = this.db.prepare(
      "INSERT INTO events (runId, taskId, sessionId, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const seq = this.txn(() => {
      const anyEv = parsed as Record<string, unknown>;
      const info = insert.run(
        parsed.runId,
        (anyEv.taskId as string) ?? null,
        (anyEv.sessionId as string) ?? null,
        parsed.type,
        JSON.stringify(parsed),
        parsed.ts
      );
      materialize?.();
      return Number(info.lastInsertRowid);
    });
    // After the commit: a subscriber that reads the store must not see stale state,
    // and a throwing subscriber must not roll back a transition that happened.
    for (const fn of this.appendListeners) {
      try {
        fn({ seq, event: parsed });
      } catch {
        /* a broken subscriber is not the writer's problem */
      }
    }
    return seq;
  }

  createRun(row: Omit<RunRow, "createdAt" | "updatedAt">): void {
    const now = Date.now();
    this.appendEvent(
      { type: "run.created", runId: row.id, assignment: row.assignment, repoPath: row.repoPath, ts: now },
      () => {
        this.db
          .prepare(
            "INSERT INTO runs (id, repoPath, assignment, state, prdPath, planHash, integrationBranch, config, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)"
          )
          .run(row.id, row.repoPath, row.assignment, row.state, row.prdPath, row.planHash, row.integrationBranch, JSON.stringify(row.config), now, now);
      }
    );
  }

  getRun(id: string): RunRow | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return { ...(r as object), config: RunConfig.parse(JSON.parse(r.config as string)) } as RunRow;
  }

  /**
   * Why a task last entered the state it is in.
   *
   * The reason is written into the transition event and nowhere else, so a task
   * that parked at the QA cap has the QA's own words on record while its row shows
   * nothing at all. Reading it back is what lets "3 tasks need you" be followed by
   * three sentences saying what each of them is waiting for.
   */
  taskStateReason(runId: string, taskId: string): string {
    const row = this.db
      .prepare(
        "SELECT payload FROM events WHERE runId = ? AND taskId = ? AND type = 'task.state_changed' ORDER BY seq DESC LIMIT 1"
      )
      .get(runId, taskId) as { payload: string } | undefined;
    if (!row) return "";
    const parsed = JSON.parse(row.payload) as { reason?: string };
    return parsed.reason ?? "";
  }

  /**
   * Queue a note for the next agent dispatched on a task.
   *
   * This lived in a Map on the controller, which meant a note queued for a task
   * nobody was working on died with the process. That is precisely the case
   * where queuing matters: a parked task is only revived on a later `resume`,
   * in a later process, and the operator's answer has to still be there when it
   * is. The row survives; `drainFeedback` consumes it exactly once.
   *
   * `sourceId` deduplicates notes the harness reads from somewhere else — a
   * GitHub issue comment is queued the first time it is seen and ignored on
   * every later poll. Returns whether a row was actually written.
   */
  queueFeedback(runId: string, taskId: string, text: string, source: "operator" | "issue" = "operator", sourceId?: string): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO feedback (runId, taskId, source, sourceId, text, ts) VALUES (?,?,?,?,?,?)")
      .run(runId, taskId, source, sourceId ?? null, text, Date.now());
    return info.changes > 0;
  }

  /** Take every undelivered note for a task, oldest first, and mark it delivered. */
  drainFeedback(runId: string, taskId: string): string {
    return this.txn(() => {
      const rows = this.db
        .prepare("SELECT id, text FROM feedback WHERE runId = ? AND taskId = ? AND deliveredAt IS NULL ORDER BY id")
        .all(runId, taskId) as { id: number; text: string }[];
      if (!rows.length) return "";
      const now = Date.now();
      const mark = this.db.prepare("UPDATE feedback SET deliveredAt = ? WHERE id = ?");
      for (const r of rows) mark.run(now, r.id);
      return rows.map((r) => r.text).join("\n\n");
    });
  }

  /** How many notes are waiting on a task — what the dashboard promises is coming. */
  pendingFeedbackCount(runId: string, taskId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM feedback WHERE runId = ? AND taskId = ? AND deliveredAt IS NULL")
      .get(runId, taskId) as { n: number };
    return row.n;
  }

  /** The validator's judgment of the run, or null when validation never completed. */
  intentVerdict(runId: string): { verdict: "PASS" | "FAIL"; gaps: string[]; summary: string } | null {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE runId = ? AND type = 'run.intent_verdict' ORDER BY seq DESC LIMIT 1")
      .get(runId) as { payload: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.payload) as { verdict: "PASS" | "FAIL"; gaps?: string[]; summary?: string };
    return { verdict: parsed.verdict, gaps: parsed.gaps ?? [], summary: parsed.summary ?? "" };
  }

  /**
   * The intake conversation as far as it got, in order, with `answer: null` for
   * a question the operator never came back to.
   *
   * Resume used to plan from the raw seed because the intake agent's session is
   * gone and its brief with it. But the conversation itself is on the event log,
   * and the unanswered tail is the expensive part: run 40da9337 was interrupted
   * one question into "do you want real vendor accounts wired up, or adapters
   * against sandboxes, or interfaces and fakes only?" — resumed straight past it,
   * planned mocks, and shipped six of seven integrations as fail-closed stubs.
   */
  intakeTranscript(runId: string): { question: string; answer: string | null }[] {
    const rows = this.db
      .prepare("SELECT type, payload FROM events WHERE runId = ? AND type IN ('intake.question','intake.answered') ORDER BY seq")
      .all(runId) as { type: string; payload: string }[];
    const order: string[] = [];
    const byQuestion = new Map<string, string | null>();
    for (const row of rows) {
      // `answer` is present on every intake.answered event by schema, and unread
      // on the question rows.
      const { question, answer } = JSON.parse(row.payload) as { question: string; answer: string };
      if (!byQuestion.has(question)) {
        order.push(question);
        byQuestion.set(question, null);
      }
      // Asking again — a re-ask, a replayed session — must never turn a settled
      // decision back into an open one.
      if (row.type === "intake.answered") byQuestion.set(question, answer);
    }
    return order.map((question) => ({ question, answer: byQuestion.get(question)! }));
  }

  /** Sequence number of the newest event of `type` for the run, or 0 if none. */
  /** The last thing the repo's CI said about this run's pull request. */
  ciStatus(runId: string): { prNumber: number; state: "passing" | "failing" | "pending" | "none"; failing: string[]; total: number } | null {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE runId = ? AND type = 'run.ci_status' ORDER BY seq DESC LIMIT 1")
      .get(runId) as { payload: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload) as { prNumber: number; state: "passing" | "failing" | "pending" | "none"; failing?: string[]; total?: number };
    return { prNumber: p.prNumber, state: p.state, failing: p.failing ?? [], total: p.total ?? 0 };
  }

  /** What the deploy triggered by the human's merge did. */
  deployStatus(runId: string): { sha: string; state: "passing" | "failing" | "pending" | "none"; failing: string[]; total: number } | null {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE runId = ? AND type = 'run.deploy_status' ORDER BY seq DESC LIMIT 1")
      .get(runId) as { payload: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload) as { sha: string; state: "passing" | "failing" | "pending" | "none"; failing?: string[]; total?: number };
    return { sha: p.sha, state: p.state, failing: p.failing ?? [], total: p.total ?? 0 };
  }

  /** What an agent found when it went and looked at production. */
  prodVerdict(runId: string): { url: string; verdict: "PASS" | "FAIL"; findings: string[]; summary: string } | null {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE runId = ? AND type = 'run.prod_verdict' ORDER BY seq DESC LIMIT 1")
      .get(runId) as { payload: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload) as { url: string; verdict: "PASS" | "FAIL"; findings?: string[]; summary?: string };
    return { url: p.url, verdict: p.verdict, findings: p.findings ?? [], summary: p.summary ?? "" };
  }

  /** The run's epics, in plan order. */
  listEpics(runId: string): { id: string; title: string }[] {
    return this.db.prepare("SELECT id, title FROM epics WHERE runId = ? ORDER BY ord").all(runId) as { id: string; title: string }[];
  }

  /** Tasks whose work reached the integration branch, in the order it landed. */
  mergedTaskIds(runId: string): string[] {
    const rows = this.db
      .prepare("SELECT taskId FROM events WHERE runId = ? AND type = 'git.merged' ORDER BY seq")
      .all(runId) as { taskId: string }[];
    return rows.map((r) => r.taskId);
  }

  /**
   * What this run's pit stops have already covered.
   *
   * Read back out of the event log rather than held on the controller, so a run
   * resumed in a new process keeps its cadence: the epics already demoed do not
   * get demoed again, and a `{usd: 100}` or `{minutes: 90}` interval measures
   * from the last stop rather than from process start. `startedAtMs` is the
   * baseline for a run that has not stopped yet.
   */
  pitStopHistory(runId: string, startedAtMs: number): { count: number; demoedEpics: string[]; mergedAt: number; spentAt: number; atMs: number } {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE runId = ? AND type = 'run.pitstop_opened' ORDER BY seq")
      .all(runId) as { payload: string }[];
    const demoedEpics: string[] = [];
    let mergedAt = 0;
    let spentAt = 0;
    let atMs = startedAtMs;
    for (const r of rows) {
      // Every field is present: the payload column holds the event exactly as
      // the schema parsed it, and `epicIds` carries a default.
      const p = JSON.parse(r.payload) as { epicIds: string[]; mergedCount: number; spentUsd: number; ts: number };
      demoedEpics.push(...p.epicIds);
      mergedAt = p.mergedCount;
      spentAt = p.spentUsd;
      atMs = p.ts;
    }
    return { count: rows.length, demoedEpics, mergedAt, spentAt, atMs };
  }

  /**
   * What every earlier pit stop in this run decided, oldest first.
   *
   * The decider is a fresh session each time and would otherwise arrive with no
   * memory of the run it is deciding about — free to give the same redirect a
   * third time and call it a new idea. This is the only record of what it has
   * already tried.
   */
  pitStopDecisions(runId: string): { action: string; decidedBy: string; why: string; feedback: string }[] {
    return (this.db.prepare("SELECT payload FROM events WHERE runId = ? AND type = 'run.pitstop_resolved' ORDER BY seq").all(runId) as { payload: string }[]).map(
      // Every field is present: the payload column holds the event exactly as
      // the schema parsed it, and all four carry defaults.
      (r) => JSON.parse(r.payload) as { action: string; decidedBy: string; why: string; feedback: string }
    );
  }

  /**
   * How many times a skill — rather than a person — has answered this task's
   * escalation gate.
   *
   * The bound on `taskGate.autoAnswerRounds` reads this. It counts answers, not
   * openings: an escalation the decider handed back to the operator is one the
   * decider did not spend, and a task whose gate a person answered is not any
   * closer to the round where the harness stops trusting an agent with it.
   */
  taskGateAutoAnswers(runId: string, taskId: string): number {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE runId = ? AND taskId = ? AND type = 'task.gate_resolved'")
      .all(runId, taskId) as { payload: string }[];
    return rows.filter((r) => {
      const p = JSON.parse(r.payload) as { decidedBy?: string; parked?: boolean };
      return !p.parked && Boolean(p.decidedBy) && p.decidedBy !== "operator";
    }).length;
  }

  /**
   * How many times a skill — rather than a person — has raised this run's
   * budget cap. The bound on `budget.autoRaiseRounds` reads this. Gate id
   * pairs the *opened* event (which kind it was) with the *resolved* one
   * (who decided it) rather than duplicating that into the schema.
   *
   * Declines are not counted. A decider that parked the run did not spend a
   * round of anyone's patience — it used the gate exactly as intended.
   */
  budgetAutoRaises(runId: string): number {
    const rows = this.db
      .prepare("SELECT type, payload FROM events WHERE runId = ? AND type IN ('run.gate_opened','run.gate_resolved') ORDER BY seq")
      .all(runId) as { type: string; payload: string }[];
    const mine = new Set<string>();
    let raises = 0;
    for (const row of rows) {
      const e = JSON.parse(row.payload) as {
        gateId: string;
        kind: string;
        resolution?: string;
        decidedBy?: string;
      };
      if (e.kind !== "budget") continue;
      if (row.type === "run.gate_opened") {
        mine.add(e.gateId);
      } else if (mine.has(e.gateId) && e.resolution === "approved" && e.decidedBy && e.decidedBy !== "operator") {
        raises++;
      }
    }
    return raises;
  }

  /**
   * How many times a skill — rather than a person — has sent this run's plan
   * back over the intent check's gaps.
   *
   * The bound on `planGate.replanRounds` reads this. A plan the operator
   * rejected themselves does not count against it: they are at the keyboard by
   * definition at the plan gate, and their rejection is the system working.
   */
  planGateAutoReplans(runId: string): number {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE runId = ? AND type = 'run.gate_resolved'")
      .all(runId) as { payload: string }[];
    return rows.filter((r) => {
      const p = JSON.parse(r.payload) as { kind?: string; resolution?: string; decidedBy?: string };
      return p.kind === "plan" && p.resolution === "rejected" && Boolean(p.decidedBy) && p.decidedBy !== "operator";
    }).length;
  }

  /** How many of this event a run has recorded — how many times round it has been. */
  eventCount(runId: string, type: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM events WHERE runId = ? AND type = ?").get(runId, type) as { c: number }).c;
  }

  lastEventSeq(runId: string, type: string): number {
    const row = this.db.prepare("SELECT MAX(seq) s FROM events WHERE runId = ? AND type = ?").get(runId, type) as { s: number | null };
    return row.s ?? 0;
  }

  /**
   * Every run, newest first — including the finished ones.
   *
   * `listOpenRuns` is what the dashboard drives itself from, so a run that ends
   * disappears from it by design. That left `harness status` printing "No open
   * runs" for a repo whose last run parked three tasks and opened no pull request,
   * which is the moment the operator most needs to be told what happened.
   */
  listRuns(): RunRow[] {
    const rows = this.db.prepare("SELECT id FROM runs ORDER BY createdAt DESC").all() as { id: string }[];
    return rows.map((r) => this.getRun(r.id)!);
  }

  listOpenRuns(): RunRow[] {
    const rows = this.db
      // VERIFYING is deliberately absent from this list: the merge is in, but a
      // red deploy or a production that disagrees is still the operator's move.
      .prepare("SELECT id FROM runs WHERE state NOT IN ('PR_REVIEW','DONE','FAILED','ABORTED')")
      .all() as { id: string }[];
    return rows.map((r) => this.getRun(r.id)!)
  }

  transitionRun(runId: string, to: RunState, reason = ""): void {
    const run = this.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (!RUN_TRANSITIONS[run.state].includes(to)) {
      throw new InvalidTransition(`run ${runId}: ${run.state} -> ${to}`);
    }
    this.appendEvent(
      { type: "run.state_changed", runId, from: run.state, to, reason, ts: Date.now() },
      () => {
        this.db.prepare("UPDATE runs SET state = ?, updatedAt = ? WHERE id = ?").run(to, Date.now(), runId);
      }
    );
  }

  /** Replace the assignment — used once, when intake turns a seed into a brief. */
  setRunAssignment(runId: string, assignment: string): void {
    this.db.prepare("UPDATE runs SET assignment = ?, updatedAt = ? WHERE id = ?").run(assignment, Date.now(), runId);
  }

  listSessions(runId: string): SessionRow[] {
    return this.db
      .prepare("SELECT id, taskId, role, model, state, startedAt, endedAt, turns, costUsd, build FROM sessions WHERE runId = ? ORDER BY startedAt")
      .all(runId) as unknown as SessionRow[];
  }

  /**
   * Replace the run's caps — from a resolved budget gate, or from an operator
   * raising a cap live before it was ever reached (`RunController.raiseBudget`).
   * Persisted rather than held in memory so `harness resume` continues under
   * the cap that was last agreed to instead of tripping again immediately.
   */
  setRunBudget(runId: string, budget: RunConfig["budget"]): void {
    const run = this.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    const config = { ...run.config, budget };
    this.db.prepare("UPDATE runs SET config = ?, updatedAt = ? WHERE id = ?").run(JSON.stringify(config), Date.now(), runId);
  }

  /**
   * Patch the run's frozen config — the escape hatch `resume` uses to repair a
   * run whose recorded environment was the problem: a base branch from before
   * capture existed (no PRs could ever open), or deterministic checks pointing
   * at the wrong package (no worker could ever pass them).
   */
  patchRunConfig(runId: string, patch: Partial<RunConfig>): void {
    const run = this.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    const config = RunConfig.parse({ ...run.config, ...patch });
    this.db.prepare("UPDATE runs SET config = ?, updatedAt = ? WHERE id = ?").run(JSON.stringify(config), Date.now(), runId);
  }

  setRunPlan(runId: string, prdPath: string, planHash: string): void {
    this.db.prepare("UPDATE runs SET prdPath = ?, planHash = ?, updatedAt = ? WHERE id = ?").run(prdPath, planHash, Date.now(), runId);
  }

  insertTasks(runId: string, epics: { id: string; title: string }[], tasks: Omit<TaskRow, "runId">[]): void {
    const insEpic = this.db.prepare("INSERT OR REPLACE INTO epics (id, runId, title, ord) VALUES (?,?,?,?)");
    const insTask = this.db.prepare(
      "INSERT OR REPLACE INTO tasks (id, runId, epicId, title, spec, acceptanceCriteria, dependsOn, state, branch, worktreePath, githubIssueNumber, prNumber, qaIterations, respawns, assignedSkills, errorSummary, touchedPaths, estimatedSize, completionProbe) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    );
    this.txn(() => {
      epics.forEach((e, i) => insEpic.run(e.id, runId, e.title, i));
      for (const t of tasks) {
        insTask.run(
          t.id, runId, t.epicId, t.title, t.spec,
          JSON.stringify(t.acceptanceCriteria), JSON.stringify(t.dependsOn), t.state,
          t.branch, t.worktreePath, t.githubIssueNumber, t.prNumber,
          t.qaIterations, t.respawns, JSON.stringify(t.assignedSkills), t.errorSummary,
          JSON.stringify(t.touchedPaths), t.estimatedSize, t.completionProbe ?? ""
        );
      }
    });
  }

  /**
   * What every other run in this database merged, and what it cost — the whole
   * input to a pre-run cost estimate.
   *
   * Scoped to the database, which is scoped to the repository, because the
   * repository is what actually decides the rate: the same harness costs an
   * order of magnitude more per task on a large brownfield service than on a
   * small greenfield one. The run being estimated is excluded so that a resumed
   * or re-planned run does not predict itself from its own spend so far.
   */
  runCosts(excludeRunId?: string): { weight: number; spentUsd: number }[] {
    const weights: Record<string, number> = { S: 1, M: 2, L: 4 };
    const byRun = new Map<string, { weight: number; spentUsd: number }>();
    const at = (id: string) => {
      if (!byRun.has(id)) byRun.set(id, { weight: 0, spentUsd: 0 });
      return byRun.get(id)!;
    };
    const merged = this.db
      .prepare("SELECT runId, estimatedSize, COUNT(*) AS n FROM tasks WHERE state = 'MERGED' GROUP BY runId, estimatedSize")
      .all() as { runId: string; estimatedSize: string; n: number }[];
    for (const row of merged) at(row.runId).weight += (weights[row.estimatedSize] ?? weights.M!) * row.n;
    const spent = this.db.prepare("SELECT runId, SUM(costUsd) AS usd FROM ledger GROUP BY runId").all() as { runId: string; usd: number }[];
    for (const row of spent) at(row.runId).spentUsd += row.usd;
    byRun.delete(excludeRunId ?? "");
    return [...byRun.values()];
  }

  getTask(runId: string, taskId: string): TaskRow | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE runId = ? AND id = ?").get(runId, taskId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      ...(r as object),
      acceptanceCriteria: JSON.parse(r.acceptanceCriteria as string),
      dependsOn: JSON.parse(r.dependsOn as string),
      assignedSkills: JSON.parse(r.assignedSkills as string),
      // `migrate` has already added the column to any database old enough to
      // lack it, so this is never reading an absence.
      touchedPaths: JSON.parse(r.touchedPaths as string),
    } as TaskRow;
  }

  listTasks(runId: string): TaskRow[] {
    const rows = this.db.prepare("SELECT id FROM tasks WHERE runId = ? ORDER BY rowid").all(runId) as { id: string }[];
    return rows.map((r) => this.getTask(runId, r.id)!)
  }

  transitionTask(runId: string, taskId: string, to: TaskState, reason = ""): void {
    const task = this.getTask(runId, taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (!TASK_TRANSITIONS[task.state].includes(to)) {
      throw new InvalidTransition(`task ${taskId}: ${task.state} -> ${to}`);
    }
    this.appendEvent(
      { type: "task.state_changed", runId, taskId, from: task.state, to, reason, ts: Date.now() },
      () => {
        this.db.prepare("UPDATE tasks SET state = ? WHERE runId = ? AND id = ?").run(to, runId, taskId);
      }
    );
  }

  /**
   * Rewrite the task's definition of done, and say on the record who did it and
   * why. Deliberately not part of `updateTask`: every other field there is
   * bookkeeping the harness owns, and this one is a judgment about the work that
   * has to survive in the event log for a postmortem to explain why a probe the
   * planner wrote is not the probe the task was held to.
   *
   * Safe against a live run: the task loop re-reads the task at the top of every
   * iteration, so an amendment written from another process lands on the next
   * pass rather than needing a restart.
   */
  amendProbe(runId: string, taskId: string, probe: string, by: string, why = ""): void {
    const from = this.getTask(runId, taskId)!.completionProbe;
    const to = probe.trim();
    if (to === from) return;
    this.appendEvent({ type: "task.probe_amended", runId, taskId, from, to, by, why: why.slice(0, 300), ts: Date.now() }, () => {
      // Empty, not null: a withdrawn probe reads back as the same "this task has
      // no probe" every task without one has always read back as.
      this.db.prepare("UPDATE tasks SET completionProbe = ? WHERE runId = ? AND id = ?").run(to, runId, taskId);
    });
  }

  /**
   * How many times an agent has rewritten this task's probe. Read off the event
   * log for the same reason the auto-answer count is: it is the only thing that
   * survives the process, and the bound exists precisely for the run that keeps
   * coming back to the same gate. The operator's own amendments do not count
   * against a skill's allowance — they are not the thing being bounded.
   */
  taskProbeAmendments(runId: string, taskId: string): number {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE runId = ? AND taskId = ? AND type = 'task.probe_amended'")
      .all(runId, taskId) as { payload: string }[];
    return rows.filter((r) => {
      const p = JSON.parse(r.payload) as { by?: string };
      return Boolean(p.by) && p.by !== "operator";
    }).length;
  }

  updateTask(runId: string, taskId: string, patch: Partial<Pick<TaskRow, "branch" | "worktreePath" | "githubIssueNumber" | "prNumber" | "qaIterations" | "respawns" | "errorSummary" | "assignedSkills">>): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      vals.push(k === "assignedSkills" ? JSON.stringify(v) : (v as string | number | null));
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE runId = ? AND id = ?`).run(...vals, runId, taskId);
  }

  /**
   * Mark every session still "running" as interrupted. Sessions live and die
   * with the single harness process, so at process start a "running" row can
   * only be the residue of a crash or a kill — and left alone it haunts the
   * dashboard as a live agent whose heartbeat froze hours ago.
   */
  sweepDeadSessions(): number {
    return Number(
      this.db
        .prepare(
          // Settle the bill from the ledger on the way out. A session the last
          // process left running never reached endSession, so without this its
          // row claims it cost nothing at all — and every one of these died
          // mid-flight, which is where the expensive sessions die.
          "UPDATE sessions SET state = 'interrupted', endedAt = ?, costUsd = MAX(costUsd, (SELECT COALESCE(SUM(costUsd),0) FROM ledger WHERE ledger.sessionId = sessions.id)) WHERE state = 'running'"
        )
        .run(Date.now()).changes
    );
  }

  recordUsage(row: { runId: string; taskId?: string; sessionId: string; model: string; role?: string; tier?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }): void {
    this.db
      .prepare(
        "INSERT INTO ledger (runId, taskId, sessionId, model, role, tier, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(row.runId, row.taskId ?? null, row.sessionId, row.model, row.role ?? "", row.tier ?? "", row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.costUsd, Date.now());
  }

  /**
   * What each finished task cost, by role, and which worker tier it ran on.
   *
   * The query the tiering experiment is settled by. `merged` is the only
   * outcome worth pricing — a cheap worker that halves the bill on tasks that
   * never land has not saved anything — and `escalated` marks the tasks that
   * started light and finished on the standard model, because those carry the
   * cost of both and are what the break-even actually turns on.
   *
   * Reported per task rather than summed, so a single catastrophic task cannot
   * hide inside an average that still looks like a saving.
   */
  taskSpend(runId: string): { taskId: string; state: string; tier: string; escalated: boolean; workerUsd: number; qaUsd: number; totalUsd: number }[] {
    const rows = this.db
      .prepare(
        `SELECT l.taskId AS taskId, t.state AS state,
                COALESCE(MIN(NULLIF(l.tier,'')),'') AS tier,
                COUNT(DISTINCT CASE WHEN l.role = 'worker' THEN l.model END) AS workerModels,
                COALESCE(SUM(CASE WHEN l.role = 'worker' THEN l.costUsd END),0) AS workerUsd,
                COALESCE(SUM(CASE WHEN l.role = 'qa' THEN l.costUsd END),0) AS qaUsd,
                COALESCE(SUM(l.costUsd),0) AS totalUsd
           FROM ledger l LEFT JOIN tasks t ON t.runId = l.runId AND t.id = l.taskId
          WHERE l.runId = ? AND l.taskId IS NOT NULL
          GROUP BY l.taskId, t.state
          ORDER BY totalUsd DESC`
      )
      .all(runId) as { taskId: string; state: string | null; tier: string; workerModels: number; workerUsd: number; qaUsd: number; totalUsd: number }[];
    return rows.map((r) => ({
      taskId: r.taskId,
      state: r.state ?? "",
      tier: r.tier,
      // More than one worker model on one task is exactly what an escalation
      // looks like from here, and it needs no extra column to record it.
      escalated: r.workerModels > 1,
      workerUsd: r.workerUsd,
      qaUsd: r.qaUsd,
      totalUsd: r.totalUsd,
    }));
  }

  spentUsd(runId: string, taskId?: string): number {
    const q = taskId
      ? this.db.prepare("SELECT COALESCE(SUM(costUsd),0) s FROM ledger WHERE runId = ? AND taskId = ?").get(runId, taskId)
      : this.db.prepare("SELECT COALESCE(SUM(costUsd),0) s FROM ledger WHERE runId = ?").get(runId);
    return (q as { s: number }).s;
  }

  eventsSince(runId: string, afterSeq: number, limit = 500): { seq: number; event: HarnessEvent }[] {
    const rows = this.db
      .prepare("SELECT seq, payload FROM events WHERE runId = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(runId, afterSeq, limit) as { seq: number; payload: string }[];
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload) as HarnessEvent }));
  }
}
