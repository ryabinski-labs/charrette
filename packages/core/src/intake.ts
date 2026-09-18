import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { Brief, IntakeQuestion, RunConfig } from "@charrette/shared";
import { Bus } from "./bus.js";
import type { IssueRead } from "./github.js";
import { AgentPool } from "./pool.js";
import { extractJson, intakeSystemPrompt, resumedIntakeBlock } from "./prompts.js";

/**
 * An answer to an intake question, and who gave it.
 *
 * A bare string is the operator: that is what the terminal has always returned
 * and what every reader assumed. Anything that is not a person says so, so the
 * transcript can distinguish a decision a human made from one a model made —
 * and from a question that reached nobody at all, which is the case that has
 * historically been indistinguishable from an answer and cost the most.
 */
export type IntakeAnswer = string | { answer: string; decidedBy?: string };

/** The words, whoever said them. */
export function answerText(answer: IntakeAnswer): string {
  return typeof answer === "string" ? answer : answer.answer;
}

/** Who said them. A transport that does not say is the operator, as it always was. */
export function answerBy(answer: IntakeAnswer): string {
  return typeof answer === "string" ? "operator" : answer.decidedBy || "operator";
}

/**
 * Transport for the intake conversation. The terminal implements this with
 * readline; the same interface is what a dashboard chat panel would implement.
 */
export interface IntakeUi {
  /**
   * Put one question to the operator and resolve with their answer as free text.
   *
   * The object form exists so a transport that is not a person can say so. A
   * terminal returns a bare string and means "the operator said this"; an
   * agent-backed transport returns who decided, and the difference is recorded
   * on `intake.answered` rather than being flattened away. Both forms are
   * accepted forever — a transport outside this repo does not have to change.
   *
   * `signal` aborts the wait. It is how a transport that has more than one way
   * in — a terminal and a control-plane route, say — releases the reader that
   * lost the race. A transport with a single reader may ignore it; one that
   * blocks on a shared `readline` must honour it, or the abandoned read
   * consumes the answer to the *next* question.
   */
  ask(question: IntakeQuestion, signal?: AbortSignal): Promise<IntakeAnswer>;
  /** Prose the agent emits between questions. */
  say(text: string): void;
  /**
   * One line per tool call, so the survey phase is not a blank screen. Optional
   * — a transport that has nowhere to put it (a browser panel, a test) omits it.
   */
  activity?(text: string): void;
  /**
   * Whether the operator is waiting on the agent. The intake agent's first move
   * is to read a repository, which is a long silence to sit through with no
   * sign that anything is happening.
   */
  working?(on: boolean): void;
}

export interface IntakeRequest {
  runId: string;
  seed: string;
  repoPath: string;
  config: RunConfig;
  ui: IntakeUi;
  budgetCheck: () => void | Promise<void>;
  /**
   * Skills for the intake conversation, already selected and rendered by the
   * controller (which owns matching). Intake is where scope, edges and what is
   * explicitly *not* wanted get decided, so an operator who binds a product
   * skill to this role is binding it to the earliest decision in the run.
   */
  skillsBlock?: string;
  /**
   * The conversation this one is continuing, when the process died mid-intake.
   * Answered entries are handed back as settled; unanswered ones are what the
   * agent has to ask again before it asks anything new.
   */
  prior?: { question: string; answer: string | null }[];
  /**
   * Reads an issue or pull request off GitHub for the agent. Omitted when GitHub
   * is not configured — and then the tool is not offered and the prompt does not
   * mention it, because a tool that can only ever fail is worse than no tool.
   */
  readIssue?: (number: number, slug?: string) => Promise<IssueRead | null>;
}

const ASK_TOOL = "mcp__charrette_intake__ask_user";
const READ_ISSUE_TOOL = "mcp__charrette_intake__read_issue";

/**
 * Pull an issue number, and the repo it belongs to, out of however the operator
 * happened to write it: a URL pasted from the browser, `owner/repo#480` copied
 * from a cross-repo reference, or a bare `#480` meaning this run's repo.
 *
 * Anything else is `null` — an unparseable reference has to be reported as such,
 * because the alternative is fetching some other issue and presenting it as the
 * one that was asked for.
 */
export function parseIssueRef(reference: string): { number: number; slug?: string } | null {
  const text = reference.trim();
  const url = /github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/(\d+)/.exec(text);
  if (url) return { slug: url[1]!, number: Number(url[2]) };
  const qualified = /^([^\s/]+\/[^\s/#]+)#(\d+)$/.exec(text);
  if (qualified) return { slug: qualified[1]!, number: Number(qualified[2]) };
  const bare = /^#?(\d+)$/.exec(text);
  if (bare) return { number: Number(bare[1]) };
  return null;
}

/**
 * A miss is reported as a miss. The agent's next move — ask the operator to
 * paste it — is the right one, and it can only make it if it is told plainly
 * that nothing came back rather than handed an empty issue.
 */
function renderOrExplain(issue: IssueRead | null, ref: { number: number; slug?: string }): string {
  if (issue) return renderIssue(issue);
  const where = ref.slug ? `${ref.slug}#${ref.number}` : `#${ref.number}`;
  return `${where} could not be read — it does not exist, or this run's GitHub token cannot see it. Ask the operator to paste the contents instead.`;
}

/** The issue as prose, because that is the shape the agent reasons about. */
function renderIssue(issue: IssueRead): string {
  const head =
    `${issue.slug}#${issue.number} — ${issue.title}\n` +
    `state: ${issue.state}   opened by: ${issue.author}` +
    (issue.labels.length ? `   labels: ${issue.labels.join(", ")}` : "") +
    `\n${issue.url}\n\n${issue.body || "(no description)"}`;
  // What was left behind is said out loud. An agent that thinks it has read the
  // whole thread will write a brief as though the last word on it was the one
  // it happened to stop at.
  const more = issue.omittedComments ? ` (${issue.omittedComments} more not shown — read them at the URL above)` : "";
  if (!issue.comments.length) return more ? `${head}\n\n--- thread not shown${more} ---` : head;
  return `${head}\n\n--- ${issue.comments.length} comment(s)${more} ---\n${issue.comments
    .map((c) => `@${c.author}:\n${c.body}`)
    .join("\n\n")}`;
}

/**
 * Run the intake conversation and return the brief the planner will receive.
 *
 * The agent drives: it surveys the repo, then calls `ask_user` whenever it needs
 * a human decision, and each call blocks on the operator. One SDK session for the
 * whole conversation, so the repo survey stays in the prompt cache across questions.
 */
export async function runIntake(pool: AgentPool, bus: Bus, req: IntakeRequest): Promise<Brief> {
  const sessionId = randomUUID();
  // Seeded with what the interrupted conversation already settled, so the
  // degraded-brief fallback keeps answers the operator has given once.
  const transcript: { question: string; answer: string; rationale: string }[] = (req.prior ?? [])
    .filter((p): p is { question: string; answer: string } => p.answer !== null)
    .map((p) => ({ question: p.question, answer: p.answer, rationale: "" }));

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
      const given = await req.ui.ask(question);
      const answer = answerText(given);
      // Their answer goes back to the agent, so from here they are waiting again.
      req.ui.working?.(true);
      transcript.push({ question: question.question, answer, rationale: "" });
      bus.publish({
        type: "intake.answered",
        runId: req.runId,
        sessionId,
        question: question.question,
        answer: answer.slice(0, 500),
        decidedBy: answerBy(given),
        ts: Date.now(),
      });
      return { content: [{ type: "text" as const, text: answer }] };
    }
  );

  // Built only when there is something behind it, so the tool list the agent
  // sees is the truth about what this run can reach.
  const readIssue = !req.readIssue ? null : tool(
    "read_issue",
    "Read a GitHub issue or pull request — title, description, labels and comments. Use this whenever the operator refers to one, rather than asking them to paste it.",
    {
      reference: z
        .string()
        .describe('The issue, however the operator wrote it: "480", "#480", "owner/repo#480", or its github.com URL.'),
    },
    async (args) => {
      const ref = parseIssueRef(args.reference);
      const text = !ref
        ? `Could not read an issue number out of "${args.reference}". Use a number, owner/repo#number, or the issue URL.`
        : renderOrExplain(await req.readIssue!(ref.number, ref.slug), ref);
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // Forward the agent's prose and its tool calls to the chat transport instead
  // of the generic event printer.
  const unsubscribe = bus.subscribe(({ event }) => {
    if (!("sessionId" in event) || event.sessionId !== sessionId) return;
    if (event.type === "agent.log") req.ui.say(event.text);
    if (event.type === "agent.tool_use") req.ui.activity?.(`${event.tool} ${event.summary}`);
  });

  let resultText = "";
  req.ui.working?.(true);
  try {
    const result = await pool.run({
      runId: req.runId,
      sessionId,
      role: "intake",
      model: req.config.models.intake,
      systemPrompt: intakeSystemPrompt(req.skillsBlock ?? "", Boolean(req.readIssue)),
      prompt:
        `The operator wants:\n\n${req.seed}\n\n` +
        `Survey the repository at your working directory, then ask what you need to. ` +
        `Finish with the brief JSON once they approve it.` +
        resumedIntakeBlock(req.prior ?? []),
      cwd: req.repoPath,
      // The intake agent talks to a human about a repo it may only read.
      tools: ["Read", "Glob", "Grep"],
      allowedTools: ["Read", "Glob", "Grep", ASK_TOOL, ...(readIssue ? [READ_ISSUE_TOOL] : [])],
      mcpServers: {
        charrette_intake: createSdkMcpServer({
          name: "charrette_intake",
          tools: readIssue ? [askUser, readIssue] : [askUser],
        }),
      },
      maxTurns: 60,
      budgetCheck: req.budgetCheck,
    });
    resultText = result.resultText;
  } finally {
    req.ui.working?.(false);
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
