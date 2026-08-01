import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { Brief, IntakeQuestion, RunConfig } from "@harness/shared";
import { Bus } from "./bus.js";
import { AgentPool } from "./pool.js";
import { extractJson, intakeSystemPrompt } from "./prompts.js";

/**
 * Transport for the intake conversation. The terminal implements this with
 * readline; the same interface is what a dashboard chat panel would implement.
 */
export interface IntakeUi {
  /** Put one question to the operator and resolve with their answer as free text. */
  ask(question: IntakeQuestion): Promise<string>;
  /** Prose the agent emits between questions. */
  say(text: string): void;
}

export interface IntakeRequest {
  runId: string;
  seed: string;
  repoPath: string;
  config: RunConfig;
  ui: IntakeUi;
  budgetCheck: () => void | Promise<void>;
}

const ASK_TOOL = "mcp__harness_intake__ask_user";

/**
 * Run the intake conversation and return the brief the planner will receive.
 *
 * The agent drives: it surveys the repo, then calls `ask_user` whenever it needs
 * a human decision, and each call blocks on the operator. One SDK session for the
 * whole conversation, so the repo survey stays in the prompt cache across questions.
 */
export async function runIntake(pool: AgentPool, bus: Bus, req: IntakeRequest): Promise<Brief> {
  const sessionId = randomUUID();
  const transcript: { question: string; answer: string; rationale: string }[] = [];

  const askUser = tool(
    "ask_user",
    "Ask the operator exactly one question and wait for their answer. Offer concrete options and mark one as recommended. The operator may answer in free text instead of choosing.",
    {
      question: z.string().describe("The question, in one sentence."),
      detail: z
        .string()
        .optional()
        .describe("What you found in the repo that makes this worth asking. One or two sentences."),
      options: z
        .array(
          z.object({
            label: z.string().describe("The choice, 1-6 words."),
            description: z.string().optional().describe("What it means or costs. One clause."),
            recommended: z.boolean().optional().describe("Set on exactly one option."),
          })
        )
        .optional()
        .describe("Omit for an open question; otherwise 2-4 options."),
    },
    async (args) => {
      const question = IntakeQuestion.parse({
        question: args.question,
        detail: args.detail ?? "",
        options: (args.options ?? []).map((o) => ({
          label: o.label,
          description: o.description ?? "",
          recommended: o.recommended ?? false,
        })),
      });
      bus.publish({
        type: "intake.question",
        runId: req.runId,
        sessionId,
        question: question.question,
        options: question.options.map((o) => o.label),
        ts: Date.now(),
      });
      const answer = await req.ui.ask(question);
      transcript.push({ question: question.question, answer, rationale: "" });
      bus.publish({
        type: "intake.answered",
        runId: req.runId,
        sessionId,
        question: question.question,
        answer: answer.slice(0, 500),
        ts: Date.now(),
      });
      return { content: [{ type: "text" as const, text: answer }] };
    }
  );

  // Forward the agent's prose to the chat transport instead of the generic event printer.
  const unsubscribe = bus.subscribe(({ event }) => {
    if (event.type === "agent.log" && event.sessionId === sessionId) req.ui.say(event.text);
  });

  let resultText = "";
  try {
    const result = await pool.run({
      runId: req.runId,
      sessionId,
      role: "intake",
      model: req.config.models.intake,
      systemPrompt: intakeSystemPrompt(),
      prompt:
        `The operator wants:\n\n${req.seed}\n\n` +
        `Survey the repository at your working directory, then ask what you need to. ` +
        `Finish with the brief JSON once they approve it.`,
      cwd: req.repoPath,
      // The intake agent talks to a human about a repo it may only read.
      tools: ["Read", "Glob", "Grep"],
      allowedTools: ["Read", "Glob", "Grep", ASK_TOOL],
      mcpServers: { harness_intake: createSdkMcpServer({ name: "harness_intake", tools: [askUser] }) },
      maxTurns: 60,
      budgetCheck: req.budgetCheck,
    });
    resultText = result.resultText;
  } finally {
    unsubscribe();
  }

  const brief = parseBrief(resultText, req.seed, transcript);
  bus.publish({
    type: "intake.brief_ready",
    runId: req.runId,
    goal: brief.goal,
    decisions: brief.decisions.length,
    ts: Date.now(),
  });
  return brief;
}

/**
 * Never make the operator answer everything twice: if the agent's final JSON is
 * unusable, fall back to a brief assembled from the seed and the answers they
 * already gave. A degraded brief still beats discarding the conversation.
 */
function parseBrief(
  resultText: string,
  seed: string,
  transcript: { question: string; answer: string; rationale: string }[]
): Brief {
  try {
    return Brief.parse(extractJson(resultText));
  } catch {
    return Brief.parse({ goal: seed, context: "", decisions: transcript });
  }
}
