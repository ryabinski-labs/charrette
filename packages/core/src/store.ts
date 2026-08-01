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
  PRIMARY KEY (runId, id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, runId TEXT NOT NULL, taskId TEXT, role TEXT NOT NULL,
  model TEXT NOT NULL, state TEXT NOT NULL,
  startedAt INTEGER NOT NULL, endedAt INTEGER, turns INTEGER NOT NULL DEFAULT 0,
  inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0,
  cacheReadTokens INTEGER NOT NULL DEFAULT 0, cacheWriteTokens INTEGER NOT NULL DEFAULT 0,
  costUsd REAL NOT NULL DEFAULT 0, lastHeartbeatAt INTEGER
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
  assignedSkills: { name: string; sha256: string; mode: "full" | "reference" }[];
  errorSummary: string | null;
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
}

export class InvalidTransition extends Error {}

/**
 * Event-sourced store: every state mutation goes through appendEvent(), which writes
 * the event row and the materialized-state update in one transaction (PRD §11.1).
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
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

  appendEvent(ev: HarnessEvent, materialize?: () => void): number {
    const parsed = HarnessEvent.parse(ev);
    const insert = this.db.prepare(
      "INSERT INTO events (runId, taskId, sessionId, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)"
    );
    return this.txn(() => {
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

  listOpenRuns(): RunRow[] {
    const rows = this.db
      .prepare("SELECT id FROM runs WHERE state NOT IN ('PR_REVIEW','FAILED','ABORTED')")
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
      .prepare("SELECT id, taskId, role, model, state, startedAt, endedAt, turns, costUsd FROM sessions WHERE runId = ? ORDER BY startedAt")
      .all(runId) as unknown as SessionRow[];
  }

  setRunPlan(runId: string, prdPath: string, planHash: string): void {
    this.db.prepare("UPDATE runs SET prdPath = ?, planHash = ?, updatedAt = ? WHERE id = ?").run(prdPath, planHash, Date.now(), runId);
  }

  insertTasks(runId: string, epics: { id: string; title: string }[], tasks: Omit<TaskRow, "runId">[]): void {
    const insEpic = this.db.prepare("INSERT OR REPLACE INTO epics (id, runId, title, ord) VALUES (?,?,?,?)");
    const insTask = this.db.prepare(
      "INSERT OR REPLACE INTO tasks (id, runId, epicId, title, spec, acceptanceCriteria, dependsOn, state, branch, worktreePath, githubIssueNumber, prNumber, qaIterations, respawns, assignedSkills, errorSummary) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    );
    this.txn(() => {
      epics.forEach((e, i) => insEpic.run(e.id, runId, e.title, i));
      for (const t of tasks) {
        insTask.run(
          t.id, runId, t.epicId, t.title, t.spec,
          JSON.stringify(t.acceptanceCriteria), JSON.stringify(t.dependsOn), t.state,
          t.branch, t.worktreePath, t.githubIssueNumber, t.prNumber,
          t.qaIterations, t.respawns, JSON.stringify(t.assignedSkills), t.errorSummary
        );
      }
    });
  }

  getTask(runId: string, taskId: string): TaskRow | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE runId = ? AND id = ?").get(runId, taskId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      ...(r as object),
      acceptanceCriteria: JSON.parse(r.acceptanceCriteria as string),
      dependsOn: JSON.parse(r.dependsOn as string),
      assignedSkills: JSON.parse(r.assignedSkills as string),
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

  recordUsage(row: { runId: string; taskId?: string; sessionId: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }): void {
    this.db
      .prepare(
        "INSERT INTO ledger (runId, taskId, sessionId, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, ts) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run(row.runId, row.taskId ?? null, row.sessionId, row.model, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.costUsd, Date.now());
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
