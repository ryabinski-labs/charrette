import type { IntakeQuestion } from "@charrette/shared";
import { Bus } from "./bus.js";
import type { IntakeAnswer, IntakeUi } from "./intake.js";
import { AgentPool } from "./pool.js";
import { extractJson, intakeDeciderPrompt, intakeDeciderSystemPrompt } from "./prompts.js";

/**
 * Answering the intake agent's questions when the person who would have
 * answered them is not there.
 *
 * Intake is the one conversation in a run that is addressed to a human, and
 * that is exactly why it is the one place a run cannot start unattended. The
 * cost of the gap is not hypothetical: run 40da9337 spent 37 hours and $773
 * shipping six of seven integrations as fail-closed stubs because it planned
 * past "real vendor accounts, sandbox adapters, or fakes only?" — a question
 * nobody was at the keyboard to answer, and which the run therefore answered by
 * assuming.
 *
 * So this is a transport, not a new stage. `IntakeUi` already abstracts "put a
 * question somewhere and wait for the answer"; the terminal implements it with
 * readline, and this implements it with a skill agent. Everything downstream —
 * the intake conversation, the specification's open questions, a resumed
 * conversation replaying what it never got answers to — goes through the same
 * interface and needs no knowledge that a decider exists.
 *
 * Three properties are what make it safe to point at a real run:
 *
 * **It can refuse.** A decider that must produce an answer is a decider that
 * invents one, and the questions intake asks are precisely the ones where an
 * invented answer is worse than a missing one. `needsOperator` hands the
 * question back, and it is the documented right answer for anything turning on
 * money, credentials, a commitment to a third party, or a preference the repo
 * cannot evidence.
 *
 * **It is bounded.** `autoAnswerRounds` caps how many questions it may settle.
 * An intake agent that keeps asking is an intake agent that has not understood
 * the repo, and the bound turns that into a person's problem rather than an
 * unbounded bill.
 *
 * **It never silently becomes the operator.** Every answer is published with
 * the skill's name on it, so `intake.answered` distinguishes what a person
 * decided from what a model decided, and the postmortem can still say which
 * questions went to nobody.
 */
export interface IntakeDeciderRequest {
  runId: string;
  /** The one-line request the run was started from — all the context that exists this early. */
  seed: string;
  repoPath: string;
  /** The skill answering. Never `"operator"`; the controller does not build this at all for that. */
  decidedBy: string;
  /** How many questions this decider may settle before the rest go to a person. */
  rounds: number;
  model: string;
  /** The decider's own skill, rendered by the controller, which owns matching. */
  skillsBlock: string;
  skills: string[];
  /**
   * Where a question the decider will not answer goes. Absent when the run is
   * genuinely headless — and then a refused question is recorded as refused
   * rather than being quietly resolved by whoever asked last.
   */
  operator?: IntakeUi;
}

/**
 * What the run tells the intake agent when a question reached nobody at all.
 *
 * Deliberately an instruction rather than an empty string. An intake agent
 * handed `""` reads it as an operator who shrugged and proceeds as though the
 * point were settled; this says the thing it must actually do, which is carry
 * the question forward into the brief where the planner and the specification
 * will both see it.
 */
export const NOBODY_ANSWERED =
  "No answer is available: nobody is at the terminal for this run, and the decider would not settle this one for you. " +
  "Do not assume an answer. Record it in the brief as an open question, state plainly what you are proceeding on in the " +
  "meantime, and prefer the option that is cheapest to reverse.";

/**
 * An `IntakeUi` backed by a skill agent, with a person behind it when there is
 * one.
 */
export class AgentIntake implements IntakeUi {
  private spent = 0;
  private readonly settled: { question: string; answer: string }[] = [];

  constructor(
    private readonly pool: AgentPool,
    private readonly bus: Bus,
    private readonly req: IntakeDeciderRequest
  ) {}

  /** How many questions the decider actually answered. Read by the controller for its log line. */
  get answered(): number {
    return this.spent;
  }

  async ask(question: IntakeQuestion): Promise<IntakeAnswer> {
    if (this.spent >= this.req.rounds) {
      this.note(
        `${this.req.decidedBy} has answered its ${this.req.rounds} question(s) for this run; the rest are yours`
      );
      return this.escalate(question);
    }
    const decided = await this.decide(question);
    if (!decided) return this.escalate(question);
    this.spent++;
    this.settled.push({ question: question.question, answer: decided.answer });
    this.note(`${this.req.decidedBy} answered: ${decided.answer.slice(0, 160)}${decided.why ? ` — ${decided.why}` : ""}`);
    return { answer: decided.answer, decidedBy: this.req.decidedBy };
  }

  say(text: string): void {
    if (this.req.operator) this.req.operator.say(text);
    else this.note(text);
  }

  activity(text: string): void {
    this.req.operator?.activity?.(text);
  }

  working(on: boolean): void {
    this.req.operator?.working?.(on);
  }

  /**
   * Run the decider once. Null means "this one is not mine" — a refusal, an
   * answer that came back the wrong shape, or a session that died. All three
   * reach the same place, because all three are the absence of a decision and
   * none of them is a decision to proceed.
   */
  private async decide(question: IntakeQuestion): Promise<{ answer: string; why: string } | null> {
    try {
      const result = await this.pool.run({
        runId: this.req.runId,
        role: "intake",
        model: this.req.model,
        systemPrompt: intakeDeciderSystemPrompt(this.req.decidedBy, this.req.skillsBlock),
        skills: this.req.skills,
        prompt: intakeDeciderPrompt(this.req.seed, question, this.settled),
        cwd: this.req.repoPath,
        // It reads the repository to answer; it must not start building it.
        disallowedTools: ["Write", "Edit", "NotebookEdit"],
        maxTurns: 20,
      });
      const parsed = extractJson(result.resultText) as { answer?: unknown; needsOperator?: unknown; why?: unknown };
      if (parsed?.needsOperator === true) return null;
      if (typeof parsed?.answer !== "string" || !parsed.answer.trim()) return null;
      return {
        answer: parsed.answer.trim(),
        why: typeof parsed.why === "string" ? parsed.why.slice(0, 200) : "",
      };
    } catch {
      // A session that crashed decided nothing. That is not the same as
      // deciding the question does not matter.
      return null;
    }
  }

  /** A person when there is one, and an honest non-answer when there is not. */
  private async escalate(question: IntakeQuestion): Promise<IntakeAnswer> {
    if (this.req.operator) return this.req.operator.ask(question);
    this.note(`nobody answered: ${question.question}`);
    return { answer: NOBODY_ANSWERED, decidedBy: "nobody" };
  }

  private note(text: string): void {
    this.bus.publish({ type: "agent.log", runId: this.req.runId, sessionId: "intake-decider", text, ts: Date.now() });
  }
}
