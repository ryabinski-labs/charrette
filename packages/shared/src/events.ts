import { z } from "zod";
import { AgentRole, GateKind, GateState, RunState, TaskState } from "./states.js";

const base = { runId: z.string(), ts: z.number().int() };

export const HarnessEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("run.created"), assignment: z.string(), repoPath: z.string() }),
  z.object({ ...base, type: z.literal("run.state_changed"), from: RunState, to: RunState, reason: z.string().default("") }),
  z.object({ ...base, type: z.literal("run.gate_opened"), gateId: z.string(), kind: GateKind, payload: z.unknown() }),
  z.object({ ...base, type: z.literal("run.gate_resolved"), gateId: z.string(), kind: GateKind, resolution: GateState, feedback: z.string().default("") }),
  z.object({ ...base, type: z.literal("run.budget_updated"), spentUsd: z.number(), capUsd: z.number() }),
  z.object({ ...base, type: z.literal("task.state_changed"), taskId: z.string(), from: TaskState, to: TaskState, reason: z.string().default("") }),
  z.object({ ...base, type: z.literal("task.qa_verdict"), taskId: z.string(), verdict: z.enum(["PASS", "FAIL"]), iteration: z.number().int(), detail: z.unknown() }),
  z.object({ ...base, type: z.literal("agent.spawned"), sessionId: z.string(), taskId: z.string().optional(), role: AgentRole, model: z.string() }),
  z.object({ ...base, type: z.literal("agent.log"), sessionId: z.string(), taskId: z.string().optional(), text: z.string() }),
  z.object({ ...base, type: z.literal("agent.tool_use"), sessionId: z.string(), taskId: z.string().optional(), tool: z.string(), summary: z.string() }),
  z.object({ ...base, type: z.literal("agent.usage"), sessionId: z.string(), taskId: z.string().optional(), model: z.string(), inputTokens: z.number().int(), outputTokens: z.number().int(), cacheReadTokens: z.number().int(), cacheWriteTokens: z.number().int(), costUsd: z.number() }),
  z.object({ ...base, type: z.literal("agent.ended"), sessionId: z.string(), taskId: z.string().optional(), outcome: z.enum(["done", "interrupted", "killed", "error"]), detail: z.string().default("") }),
  z.object({ ...base, type: z.literal("git.worktree_created"), taskId: z.string(), path: z.string(), branch: z.string() }),
  z.object({ ...base, type: z.literal("git.merged"), taskId: z.string(), branch: z.string(), sha: z.string() }),
  z.object({ ...base, type: z.literal("git.merge_conflict"), taskId: z.string(), branch: z.string(), files: z.array(z.string()) }),
  z.object({ ...base, type: z.literal("github.issue_created"), taskId: z.string().optional(), epicId: z.string().optional(), issueNumber: z.number().int(), url: z.string() }),
  z.object({ ...base, type: z.literal("github.pr_opened"), taskId: z.string(), prNumber: z.number().int(), url: z.string() }),
  z.object({ ...base, type: z.literal("skills.injected"), taskId: z.string(), skills: z.array(z.object({ name: z.string(), sha256: z.string(), mode: z.enum(["full", "reference"]) })) }),
]);
export type HarnessEvent = z.infer<typeof HarnessEvent>;
export type HarnessEventType = HarnessEvent["type"];
