import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import { resumedIntakeBlock } from "./prompts.js";
import { Store } from "./store.js";

/**
 * Run 40da9337 is the case this exists for. Its intake agent asked:
 *
 *   "For 'all the integrations' — do you want real vendor accounts wired up, or
 *    production-shaped adapters running against sandboxes with no real money
 *    movement?"
 *
 * No `intake.answered` event ever followed. The process was interrupted, and
 * `resume` transitioned INTAKE → PLANNING with reason "resumed mid-intake" and
 * planned from the one-line seed. The planner, told nothing, wrote acceptance
 * criteria requiring mocks; six of seven vendors shipped as fail-closed stubs;
 * every task passed QA. The question that decided the product was asked, dropped
 * on the floor, and never mentioned again.
 */
function conversation(): Store {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  store.createRun({
    id: "run-1",
    repoPath: "/tmp/repo",
    assignment: "fully implement this product, including all the integrations",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: "harness/run-1/main",
    config: RunConfig.parse({}),
  });
  const ask = (question: string) => bus.publish({ type: "intake.question", runId: "run-1", sessionId: "s1", question, options: [], ts: 1 });
  const answer = (question: string, text: string) =>
    bus.publish({ type: "intake.answered", runId: "run-1", sessionId: "s1", question, answer: text, ts: 2 });

  ask("What should be the authoritative backlog for this build?");
  answer("What should be the authoritative backlog for this build?", "use gh cli");
  ask("For \"all the integrations\" — real vendor accounts, or adapters against sandboxes?");
  return store;
}

describe("the conversation an interrupted run left behind", () => {
  it("reads back in order, with the unanswered question marked", () => {
    const prior = conversation().intakeTranscript("run-1");

    expect(prior).toEqual([
      { question: "What should be the authoritative backlog for this build?", answer: "use gh cli" },
      { question: 'For "all the integrations" — real vendor accounts, or adapters against sandboxes?', answer: null },
    ]);
  });

  it("is empty for a run that never started one", () => {
    expect(new Store(":memory:").intakeTranscript("nope")).toEqual([]);
  });

  it("does not let a repeated question overwrite the answer already given", () => {
    // The agent re-asking (or a resumed session replaying) must not turn a
    // settled decision back into an open one — that is how an operator ends up
    // answering the same thing twice and the second answer winning.
    const store = conversation();
    const bus = new Bus(store);
    bus.publish({ type: "intake.question", runId: "run-1", sessionId: "s2", question: "What should be the authoritative backlog for this build?", options: [], ts: 3 });

    const prior = store.intakeTranscript("run-1");
    expect(prior[0]!.answer).toBe("use gh cli");
    expect(prior).toHaveLength(2); // and it does not appear twice
  });
});

describe("what the resuming agent is told", () => {
  it("hands back the settled answers and puts the open question first", () => {
    const text = resumedIntakeBlock([
      { question: "Which backlog?", answer: "use gh cli" },
      { question: "Real vendor accounts, or sandboxes?", answer: null },
    ]);

    expect(text).toContain("interrupted and you are resuming it");
    expect(text).toContain("never ask them again");
    expect(text).toContain("Which backlog?");
    expect(text).toContain("→ use gh cli");
    expect(text).toContain("Put it to the operator first");
    expect(text).toContain("Real vendor accounts, or sandboxes?");
    // The reason it matters, stated, because the failure mode is an agent
    // deciding a dropped question was a declined one.
    expect(text).toContain("Do not answer it on their behalf");
  });

  it("pluralises when more than one went unanswered", () => {
    const text = resumedIntakeBlock([
      { question: "A?", answer: null },
      { question: "B?", answer: null },
    ]);

    expect(text).toContain("Put them to the operator first");
    expect(text).toContain("Nothing was settled before the interruption");
  });

  it("says nothing is open when every question was answered", () => {
    const text = resumedIntakeBlock([{ question: "A?", answer: "yes" }]);

    expect(text).toContain("Already settled");
    expect(text).not.toContain("never answered");
  });

  it("is empty for a run with no conversation, so the prompt is unchanged", () => {
    expect(resumedIntakeBlock([])).toBe("");
  });
});
