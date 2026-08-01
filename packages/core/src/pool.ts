import { randomUUID } from "node:crypto";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { AgentRole } from "@harness/shared";
import { Bus } from "./bus.js";
import { Store } from "./store.js";
import { costUsd } from "./budget.js";

export interface AgentSpec {
  runId: string;
  taskId?: string;
  role: AgentRole;
  model: string;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  /** Called before/while streaming; throw BudgetExceeded to abort the session. */
  budgetCheck?: () => void;
}

export interface AgentResult {
  sessionId: string;
  resultText: string;
  costUsd: number;
  turns: number;
  outcome: "done" | "error" | "killed";
}

/**
 * Thin wrapper over the Claude Agent SDK: one query() session per agent,
 * streams messages onto the bus, books usage into the ledger (PRD §11.1 Agent Pool).
 */
export class AgentPool {
  constructor(private store: Store, private bus: Bus) {}

  async run(spec: AgentSpec): Promise<AgentResult> {
    const sessionId = randomUUID();
    const abort = new AbortController();
    const now = Date.now();
    this.store.db
      .prepare("INSERT INTO sessions (id, runId, taskId, role, model, state, startedAt) VALUES (?,?,?,?,?,?,?)")
      .run(sessionId, spec.runId, spec.taskId ?? null, spec.role, spec.model, "running", now);
    this.bus.publish({ type: "agent.spawned", runId: spec.runId, taskId: spec.taskId, sessionId, role: spec.role, model: spec.model, ts: now });

    const options: Options = {
      model: spec.model,
      cwd: spec.cwd,
      systemPrompt: spec.systemPrompt,
      maxTurns: spec.maxTurns ?? 100,
      permissionMode: "bypassPermissions",
      allowedTools: spec.allowedTools,
      disallowedTools: spec.disallowedTools,
      abortController: abort,
      // Do not inherit the operator's filesystem settings/skills into worker context.
      settingSources: [],
    };

    let resultText = "";
    let turns = 0;
    let cost = 0;
    let killedByBudget = false;
    try {
      for await (const message of query({ prompt: spec.prompt, options })) {
        try {
          spec.budgetCheck?.();
        } catch (e) {
          abort.abort();
          killedByBudget = true;
          this.endSession(spec, sessionId, turns, cost, "killed", String(e));
          throw e;
        }
        if (message.type === "assistant") {
          turns++;
          const content = (message as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === "text" && typeof block.text === "string") {
                this.bus.publish({ type: "agent.log", runId: spec.runId, taskId: spec.taskId, sessionId, text: block.text.slice(0, 2000), ts: Date.now() });
              } else if (block?.type === "tool_use") {
                this.bus.publish({ type: "agent.tool_use", runId: spec.runId, taskId: spec.taskId, sessionId, tool: String(block.name ?? "?"), summary: JSON.stringify(block.input ?? {}).slice(0, 300), ts: Date.now() });
              }
            }
          }
          this.store.db.prepare("UPDATE sessions SET turns = ?, lastHeartbeatAt = ? WHERE id = ?").run(turns, Date.now(), sessionId);
        } else if (message.type === "result") {
          const m = message as {
            result?: string;
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
          };
          resultText = m.result ?? "";
          const usage = {
            inputTokens: m.usage?.input_tokens ?? 0,
            outputTokens: m.usage?.output_tokens ?? 0,
            cacheReadTokens: m.usage?.cache_read_input_tokens ?? 0,
            cacheWriteTokens: m.usage?.cache_creation_input_tokens ?? 0,
          };
          cost = m.total_cost_usd ?? costUsd(spec.model, usage);
          this.store.recordUsage({ runId: spec.runId, taskId: spec.taskId, sessionId, model: spec.model, ...usage, costUsd: cost });
          this.bus.publish({ type: "agent.usage", runId: spec.runId, taskId: spec.taskId, sessionId, model: spec.model, ...usage, costUsd: cost, ts: Date.now() });
        }
      }
    } catch (e) {
      if (!killedByBudget) {
        this.endSession(spec, sessionId, turns, cost, "interrupted", String(e));
      }
      throw e;
    }
    this.endSession(spec, sessionId, turns, cost, "done", "");
    return { sessionId, resultText, costUsd: cost, turns, outcome: "done" };
  }

  private endSession(spec: AgentSpec, sessionId: string, turns: number, cost: number, state: string, detail: string): void {
    this.store.db
      .prepare("UPDATE sessions SET state = ?, endedAt = ?, turns = ?, costUsd = ? WHERE id = ?")
      .run(state, Date.now(), turns, cost, sessionId);
    this.bus.publish({
      type: "agent.ended",
      runId: spec.runId,
      taskId: spec.taskId,
      sessionId,
      outcome: state === "done" ? "done" : state === "killed" ? "killed" : "error",
      detail: detail.slice(0, 500),
      ts: Date.now(),
    });
  }
}
