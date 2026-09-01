import { describe, expect, it, vi } from "vitest";
import { IntakeQuestion } from "@harness/shared";
import { BridgedIntake } from "./bridgedIntake.js";
import type { IntakeAnswer, IntakeUi } from "./intake.js";

const q = (question: string, options: string[] = []) =>
  IntakeQuestion.parse({
    question,
    detail: "why it is being asked",
    options: options.map((label) => ({ label, description: "", recommended: false })),
  });

/**
 * A terminal that never answers on its own, so a test decides who wins the
 * race. `settle` is the operator typing; `fail` is their Ctrl+C.
 */
function operatorStub() {
  const asked: { question: string; signal?: AbortSignal }[] = [];
  let settle: ((answer: IntakeAnswer) => void) | null = null;
  let fail: ((e: unknown) => void) | null = null;
  const said: string[] = [];
  const activity: string[] = [];
  const working: boolean[] = [];
  const ui: IntakeUi = {
    ask(question, signal) {
      asked.push({ question: question.question, signal });
      return new Promise<IntakeAnswer>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
    },
    say: (t) => said.push(t),
    activity: (t) => activity.push(t),
    working: (on) => working.push(on),
  };
  return {
    ui,
    asked,
    said,
    activity,
    working,
    settle: (answer: IntakeAnswer) => settle!(answer),
    fail: (e: unknown) => fail!(e),
  };
}

describe("BridgedIntake", () => {
  it("has nothing to answer until a question is actually open", () => {
    const bridge = new BridgedIntake(operatorStub().ui);
    expect(bridge.pending()).toBeNull();
    // The run is not waiting on anything, so there is nothing to settle — and
    // saying so is the point: a caller that got `true` here would believe it
    // had unblocked a run it had not touched.
    expect(bridge.answer("any-id", "30 minutes", "pit-crew")).toBe(false);
  });

  it("answers the open question from the control plane, and says who decided", async () => {
    const op = operatorStub();
    const bridge = new BridgedIntake(op.ui);
    const asking = bridge.ask(q("How long does an import preview stay valid?"));

    const open = bridge.pending()!;
    expect(open.id).toBeTruthy();
    expect(open.question).toBe("How long does an import preview stay valid?");
    expect(open.detail).toBe("why it is being asked");
    expect(open.askedAt).toBeGreaterThan(0);

    expect(bridge.answer(open.id, "  30 minutes, then 409 STALE_PREVIEW  ", "pit-crew")).toBe(true);
    await expect(asking).resolves.toEqual({ answer: "30 minutes, then 409 STALE_PREVIEW", decidedBy: "pit-crew" });
    // Settled: a second answer has nothing to land on.
    expect(bridge.pending()).toBeNull();
    expect(bridge.answer(open.id, "again", "pit-crew")).toBe(false);
  });

  it("copies the open question, so a caller cannot reach into the live one", async () => {
    const bridge = new BridgedIntake(operatorStub().ui);
    void bridge.ask(q("Sandbox or real vendor accounts?", ["sandbox", "real"]));
    const first = bridge.pending()!;
    first.question = "something else entirely";
    first.options.push("a third option");
    expect(bridge.pending()!.question).toBe("Sandbox or real vendor accounts?");
    expect(bridge.pending()!.options).toEqual(["sandbox", "real"]);
  });

  it("refuses a blank answer — the agent would take it as settled and move on", async () => {
    const bridge = new BridgedIntake(operatorStub().ui);
    void bridge.ask(q("Which township?"));
    expect(bridge.answer(bridge.pending()!.id, "   ", "pit-crew")).toBe(false);
    // Still open, so the operator or a better answer can still have it.
    expect(bridge.pending()?.question).toBe("Which township?");
  });

  it("refuses an answer that will not say who decided it", async () => {
    const bridge = new BridgedIntake(operatorStub().ui);
    void bridge.ask(q("Which township?"));
    // An unattributed answer is indistinguishable from the operator's own, and
    // that is what made run beb799c5's transcript unreadable: every line said
    // "operator", including the four that were a person clearing a prompt.
    expect(bridge.answer(bridge.pending()!.id, "Upper Southampton", "   ")).toBe(false);
    expect(bridge.pending()?.question).toBe("Which township?");
  });

  it("refuses an answer aimed at a question that is no longer the one being asked", async () => {
    const op = operatorStub();
    const bridge = new BridgedIntake(op.ui);
    const first = bridge.ask(q("Real Stripe account, or sandbox?"));
    const staleId = bridge.pending()!.id;
    bridge.answer(staleId, "sandbox", "pit-crew");
    await first;

    // The specification re-asks after a failed fold, so the identical sentence
    // comes up again. Text is not an identity; the id is.
    void bridge.ask(q("Real Stripe account, or sandbox?"));
    const reasked = bridge.pending()!;
    expect(reasked.question).toBe("Real Stripe account, or sandbox?");
    expect(reasked.id).not.toBe(staleId);
    expect(bridge.answer(staleId, "sandbox", "pit-crew")).toBe(false);
    expect(bridge.pending()!.id).toBe(reasked.id);
  });

  it("releases the operator's reader when the control plane gets there first", async () => {
    const op = operatorStub();
    const bridge = new BridgedIntake(op.ui);
    const asking = bridge.ask(q("Which township?"));

    const signal = op.asked[0]!.signal!;
    expect(signal.aborted).toBe(false);
    bridge.answer(bridge.pending()!.id, "Upper Southampton", "pit-crew");
    // The readline waiting on this question has to be cancelled. Left queued it
    // takes the operator's next line and satisfies this prompt with it, and
    // every answer after that is one question behind.
    expect(signal.aborted).toBe(true);
    await expect(asking).resolves.toEqual({ answer: "Upper Southampton", decidedBy: "pit-crew" });
  });

  it("keeps the operator first when they are the one who answers", async () => {
    const op = operatorStub();
    const bridge = new BridgedIntake(op.ui);
    const asking = bridge.ask(q("Which township?"));
    op.settle("Lower Southampton");
    await expect(asking).resolves.toBe("Lower Southampton");
    // Cleared by the operator's own answer, so a control-plane call arriving a
    // moment later does not settle a question that is already answered.
    expect(bridge.pending()).toBeNull();
    expect(op.asked[0]!.signal!.aborted).toBe(false);
  });

  it("swallows the abort it raised itself, and nothing else", async () => {
    const op = operatorStub();
    const bridge = new BridgedIntake(op.ui);
    const asking = bridge.ask(q("Which township?"));
    bridge.answer(bridge.pending()!.id, "Upper Southampton", "pit-crew");
    // readline rejects the read it was told to abandon. That rejection is this
    // class's own doing and must not reach the run.
    op.fail(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    await expect(asking).resolves.toEqual({ answer: "Upper Southampton", decidedBy: "pit-crew" });
  });

  it("still lets a real Ctrl+C through", async () => {
    const op = operatorStub();
    const bridge = new BridgedIntake(op.ui);
    const asking = bridge.ask(q("Which township?"));
    op.fail(new Error("Aborted with Ctrl+C"));
    // Deliberately unchanged behaviour: a transport that turned an interrupt
    // into a wait would hang the run where it used to stop, and `specify` is
    // what makes stopping here survivable.
    await expect(asking).rejects.toThrow("Aborted with Ctrl+C");
    expect(bridge.pending()).toBeNull();
  });

  it("a reader that fails after its question moved on does not clear the next one", async () => {
    const op = operatorStub();
    const bridge = new BridgedIntake(op.ui);
    const first = bridge.ask(q("Which township?"));
    bridge.answer(bridge.pending()!.id, "Upper Southampton", "pit-crew");
    await first;

    const second = bridge.ask(q("Which school district?"));
    // The first reader is only now getting round to reporting the abort. It
    // belongs to a question that is over; clearing on it would strand the one
    // that is open.
    op.fail(Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect(bridge.pending()?.question).toBe("Which school district?");
    expect(bridge.answer(bridge.pending()!.id, "Centennial", "pit-crew")).toBe(true);
    await expect(second).resolves.toEqual({ answer: "Centennial", decidedBy: "pit-crew" });
  });

  it("a slow operator answering a question that already moved on is ignored", async () => {
    const op = operatorStub();
    const bridge = new BridgedIntake(op.ui);
    const first = bridge.ask(q("Which township?"));
    bridge.answer(bridge.pending()!.id, "Upper Southampton", "pit-crew");
    await first;
    const settleFirst = op.settle;

    void bridge.ask(q("Which school district?"));
    settleFirst("typed too late");
    // The late line belonged to a settled question. It must not resolve, and
    // must not clear, the one now open.
    expect(bridge.pending()?.question).toBe("Which school district?");
  });

  it("a slow operator answering the last question of the run resolves nothing", async () => {
    const op = operatorStub();
    const bridge = new BridgedIntake(op.ui);
    const first = bridge.ask(q("Which township?"));
    bridge.answer(bridge.pending()!.id, "Upper Southampton", "pit-crew");
    await first;

    // The conversation has moved past its last question, so nothing is open at
    // all. The operator's line arrives against a settled question and has
    // nowhere to go — which must not throw, and must leave `pending()` alone.
    expect(bridge.pending()).toBeNull();
    expect(() => op.settle("typed after the conversation ended")).not.toThrow();
    expect(bridge.pending()).toBeNull();
  });

  it("works with no operator at all — a headless run still has one way in", async () => {
    const bridge = new BridgedIntake();
    const asking = bridge.ask(q("Sandbox or real vendor accounts?"));
    expect(bridge.pending()?.question).toBe("Sandbox or real vendor accounts?");
    expect(bridge.answer(bridge.pending()!.id, "sandbox", "pit-crew")).toBe(true);
    await expect(asking).resolves.toEqual({ answer: "sandbox", decidedBy: "pit-crew" });
    // The prose side has nowhere to go and must not throw for it.
    expect(() => {
      bridge.say("hello");
      bridge.activity("Read README.md");
      bridge.working(true);
    }).not.toThrow();
  });

  it("passes the conversation's prose through to the operator", () => {
    const op = operatorStub();
    const bridge = new BridgedIntake(op.ui);
    bridge.say("surveying the repository");
    bridge.activity("Read docs/00-prd.md");
    bridge.working(true);
    bridge.working(false);
    expect(op.said).toEqual(["surveying the repository"]);
    expect(op.activity).toEqual(["Read docs/00-prd.md"]);
    expect(op.working).toEqual([true, false]);
  });

  it("tolerates a transport that implements only ask and say", () => {
    const minimal: IntakeUi = { ask: vi.fn(), say: vi.fn() };
    const bridge = new BridgedIntake(minimal);
    // `activity` and `working` are optional on the interface; a transport
    // without them is a supported transport, not a crash.
    expect(() => {
      bridge.activity("Read README.md");
      bridge.working(true);
    }).not.toThrow();
  });
});
