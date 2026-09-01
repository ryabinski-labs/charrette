import { randomUUID } from "node:crypto";
import type { IntakeQuestion } from "@harness/shared";
import type { IntakeAnswer, IntakeUi } from "./intake.js";

/**
 * The intake question waiting right now, as the control plane sees it.
 *
 * A copy rather than the live question, and it carries `askedAt` so a caller can
 * tell a question that has just opened from one a person has been sitting on.
 */
export interface OpenQuestion {
  /**
   * Identifies this asking of this question, and nothing else.
   *
   * Minted per `ask`, so the same words asked twice are two ids. The question
   * text is not an identity: a specification that re-asks after a failed fold
   * puts the identical sentence up again, and an answer written for the first
   * one would pass a string comparison against the second. Answering carries the
   * id back, which is what makes "answer the question I read" enforceable
   * rather than merely requested.
   */
  id: string;
  question: string;
  detail: string;
  options: string[];
  askedAt: number;
}

/** What the dashboard needs from the transport to put an answer into a run. */
export interface IntakeBridge {
  pending(): OpenQuestion | null;
  answer(id: string, text: string, decidedBy: string): boolean;
}

/**
 * An intake transport that a second process can answer through.
 *
 * Intake is the last conversation in a run that only a keyboard can reach.
 * Every other decision a run stops on — the plan gate, the budget gate, a task
 * escalation, a pit stop — has a control-plane route, which is what lets a
 * watching skill act on a run instead of writing paste-ready text at somebody.
 * Intake had none: `TerminalChat` resolves against a readline on the run's own
 * TTY, and there is no endpoint that reaches it. A watcher could decide an
 * intake question perfectly well and still had no way to type it.
 *
 * The cost of that gap is not the typing. Run beb799c5's operator was put
 * through eight open questions in ninety seconds and answered four of them
 * "yes" to an either/or; the fifth they answered with Ctrl+C, which took the
 * run's whole specification with it. A question that only a tired human at a
 * terminal can answer is a question that gets answered badly.
 *
 * So this wraps the operator's transport rather than replacing it. Both sides
 * are live at once and the first answer wins:
 *
 * **The operator is never locked out.** Someone at the keyboard answers exactly
 * as they always did, and the control plane simply never gets there first.
 *
 * **A control-plane answer releases the reader.** The terminal's `ask` is
 * cancelled through its `AbortSignal`, because a `readline` left waiting on a
 * question that has already been answered would take the operator's *next*
 * keystroke and satisfy the *previous* prompt with it — every answer from then
 * on landing one question late.
 *
 * **A reader that fails on its own still fails.** Only an abort this class
 * raised is swallowed. Ctrl+C at the terminal propagates exactly as it did
 * before, because a transport that quietly turns an interrupt into a wait is a
 * run that hangs where it used to stop.
 */
export class BridgedIntake implements IntakeUi, IntakeBridge {
  private open: {
    question: OpenQuestion;
    resolve: (answer: IntakeAnswer) => void;
    abort: AbortController;
  } | null = null;

  /**
   * `operator` is optional on purpose: a run started with no terminal — the
   * case `intake.decidedBy` exists for — still has one place its questions can
   * be answered from, instead of every refusal going to nobody.
   */
  constructor(private readonly operator?: IntakeUi) {}

  pending(): OpenQuestion | null {
    if (!this.open) return null;
    // `options` is copied too. A spread alone shares the array, so a caller that
    // read the open question and appended to its options would be editing the
    // question the run is still waiting on.
    return { ...this.open.question, options: [...this.open.question.options] };
  }

  /**
   * Settle the open question from outside the process. False when there is
   * nothing open, the id names a different asking, or the answer is blank —
   * all three are things the caller must be told about rather than have
   * swallowed, because the run is still waiting either way.
   *
   * `decidedBy` is required and is not defaulted. An answer that cannot say who
   * decided it is indistinguishable from the operator's own, which is exactly
   * what made run beb799c5's transcript unreadable: every line said "operator",
   * including the four that were a tired person clearing a prompt.
   */
  answer(id: string, text: string, decidedBy: string): boolean {
    const open = this.open;
    const answer = text.trim();
    const by = decidedBy.trim();
    if (!open || !answer || !by || open.question.id !== id) return false;
    this.open = null;
    // Before resolving, not after: the reader has to be released while the
    // question it belongs to is still the one being settled.
    open.abort.abort();
    open.resolve({ answer, decidedBy: by });
    return true;
  }

  async ask(question: IntakeQuestion): Promise<IntakeAnswer> {
    const abort = new AbortController();
    return new Promise<IntakeAnswer>((resolve, reject) => {
      this.open = {
        question: {
          id: randomUUID(),
          question: question.question,
          detail: question.detail,
          options: question.options.map((o) => o.label),
          askedAt: Date.now(),
        },
        resolve,
        abort,
      };
      this.operator?.ask(question, abort.signal).then(
        (given) => {
          // Not `this.open = null` unconditionally: by the time a slow reader
          // returns, the control plane may have answered this question and the
          // agent may already be asking the next one. Clearing then would
          // discard a question nobody has answered yet.
          if (this.open?.abort !== abort) return;
          this.open = null;
          resolve(given);
        },
        (e) => {
          if (abort.signal.aborted) return;
          if (this.open?.abort === abort) this.open = null;
          reject(e);
        }
      );
    });
  }

  say(text: string): void {
    this.operator?.say(text);
  }

  activity(text: string): void {
    this.operator?.activity?.(text);
  }

  working(on: boolean): void {
    this.operator?.working?.(on);
  }
}
