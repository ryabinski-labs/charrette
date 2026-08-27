import { describe, expect, it } from "vitest";
import { IntakeQuestion, RunConfig, type IntakeQuestion as Q } from "@harness/shared";
import { Bus } from "./bus.js";
import { AgentIntake, NOBODY_ANSWERED } from "./intakeDecider.js";
import { answerBy, answerText, type IntakeUi } from "./intake.js";
import { intakeDeciderPrompt, intakeDeciderSystemPrompt } from "./prompts.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { Store } from "./store.js";

/**
 * The decider that answers intake when nobody is at the terminal.
 *
 * Every case here is about the same thing from a different side: what it does
 * when it will not answer. That is the whole safety story — a decider that must
 * produce an answer produces an invented one, and intake's questions are
 * precisely the ones where an invented answer survives into the brief, the
 * specification and every task cut from them.
 */
function ask(text = "Real vendor accounts, or fakes?"): Q {
  return IntakeQuestion.parse({ question: text });
}

function bus(): { bus: Bus; store: Store; logs: string[] } {
  const store = new Store(":memory:");
  store.createRun({
    id: "run1",
    repoPath: "/tmp/repo",
    assignment: "seed",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: "harness/run1/main",
    config: RunConfig.parse({}),
  });
  const b = new Bus(store);
  const logs: string[] = [];
  b.subscribe(({ event }) => {
    if (event.type === "agent.log") logs.push(event.text);
  });
  return { bus: b, store, logs };
}

function pool(replies: string[] | (() => never)): { pool: AgentPool; specs: AgentSpec[] } {
  const specs: AgentSpec[] = [];
  const p = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      if (typeof replies === "function") replies();
      const list: string[] = typeof replies === "function" ? [] : replies;
      const text = list[Math.min(specs.length - 1, list.length - 1)] ?? "";
      return { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: text, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: p as unknown as AgentPool, specs };
}

function req(over: Partial<ConstructorParameters<typeof AgentIntake>[2]> = {}) {
  return {
    runId: "run1",
    seed: "add rate limiting",
    repoPath: "/tmp/repo",
    decidedBy: "product-manager",
    rounds: 12,
    model: "claude-opus-5",
    skillsBlock: "",
    skills: [],
    ...over,
  };
}

/** A person at the terminal, recording what reached them. */
function operator(answer = "the operator says so"): IntakeUi & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async ask(q: Q) {
      asked.push(q.question);
      return answer;
    },
    say() {},
  };
}

describe("answering intake without a person there", () => {
  it("answers, and says whose answer it is", async () => {
    const { bus: b, logs } = bus();
    const { pool: p, specs } = pool([JSON.stringify({ answer: "Fakes only for now.", needsOperator: false, why: "no vendor creds in the repo" })]);
    const intake = new AgentIntake(p, b, req());

    expect(await intake.ask(ask())).toEqual({ answer: "Fakes only for now.", decidedBy: "product-manager" });
    expect(intake.answered).toBe(1);
    // The seed and the question both reach the session; without the seed it is
    // answering a question with no idea what the run is for.
    expect(specs[0]!.prompt).toContain("add rate limiting");
    expect(specs[0]!.prompt).toContain("Real vendor accounts, or fakes?");
    // It may read the repository to answer. It may not start building it.
    expect(specs[0]!.disallowedTools).toContain("Write");
    expect(specs[0]!.disallowedTools).toContain("Edit");
    expect(logs.join("\n")).toContain("product-manager answered: Fakes only for now.");
    expect(logs.join("\n")).toContain("no vendor creds in the repo");
  });

  it("hands a question back to the operator when it refuses to decide it", async () => {
    const { bus: b } = bus();
    const { pool: p } = pool([JSON.stringify({ answer: "", needsOperator: true, why: "this one costs money" })]);
    const person = operator("Use the sandbox account.");
    const intake = new AgentIntake(p, b, req({ operator: person }));

    // The operator's answer is a bare string, so it reads back as theirs.
    expect(await intake.ask(ask())).toBe("Use the sandbox account.");
    expect(person.asked).toEqual(["Real vendor accounts, or fakes?"]);
    // A refusal is not an answer, so it does not spend a round.
    expect(intake.answered).toBe(0);
  });

  it("refuses even when it has an answer it likes, because that is the shape a careful model returns", async () => {
    // The two refusals above both come back with no answer at all, so the
    // empty-answer guard catches them and `needsOperator` is never the thing
    // doing the work. This is the case that actually needs the check: a model
    // that has a plausible answer AND knows a person should be the one to give
    // it. Removing the `needsOperator` line leaves every other test in this
    // file green and lets this answer through.
    const { bus: b } = bus();
    const { pool: p } = pool([
      JSON.stringify({
        answer: "Use the Stripe sandbox with the test keys in .env.example.",
        needsOperator: true,
        why: "this commits the run to an account I cannot see, so it is the operator's to confirm",
      }),
    ]);
    const person = operator("Real vendor accounts — the sandbox is already wired.");
    const intake = new AgentIntake(p, b, req({ operator: person }));

    expect(await intake.ask(ask())).toBe("Real vendor accounts — the sandbox is already wired.");
    expect(person.asked).toEqual(["Real vendor accounts, or fakes?"]);
    expect(intake.answered).toBe(0);
  });

  it("records a refused question as unanswered when there is nobody behind it", async () => {
    const { bus: b, logs } = bus();
    const { pool: p } = pool([JSON.stringify({ needsOperator: true })]);
    const intake = new AgentIntake(p, b, req());

    // Not an empty string: an intake agent handed "" reads it as a shrug and
    // proceeds as though the point were settled. This says what to do instead.
    expect(await intake.ask(ask())).toEqual({ answer: NOBODY_ANSWERED, decidedBy: "nobody" });
    expect(NOBODY_ANSWERED).toContain("Record it in the brief as an open question");
    expect(logs.join("\n")).toContain("nobody answered: Real vendor accounts, or fakes?");
  });

  it("treats an answer that came back the wrong shape as no answer at all", async () => {
    const { bus: b } = bus();
    const person = operator();
    // No JSON, an answer that is not a string, and an answer that is only
    // whitespace. None of the three is a decision.
    for (const reply of ["I think probably fakes", JSON.stringify({ answer: 42 }), JSON.stringify({ answer: "   " })]) {
      const { pool: p } = pool([reply]);
      const intake = new AgentIntake(p, b, req({ operator: person }));
      expect(await intake.ask(ask())).toBe("the operator says so");
      expect(intake.answered).toBe(0);
    }
  });

  it("treats a session that died as no answer, not as permission to carry on", async () => {
    const { bus: b } = bus();
    const person = operator();
    const { pool: p } = pool(() => {
      throw new Error("the SDK fell over");
    });
    const intake = new AgentIntake(p, b, req({ operator: person }));

    expect(await intake.ask(ask())).toBe("the operator says so");
    expect(person.asked).toHaveLength(1);
  });

  it("stops answering once it has spent its rounds", async () => {
    const { bus: b, logs } = bus();
    const { pool: p, specs } = pool([JSON.stringify({ answer: "Yes." })]);
    const person = operator();
    const intake = new AgentIntake(p, b, req({ rounds: 1, operator: person }));

    expect(await intake.ask(ask("first?"))).toEqual({ answer: "Yes.", decidedBy: "product-manager" });
    expect(await intake.ask(ask("second?"))).toBe("the operator says so");
    // The second question never reached a session: the bound is checked before
    // the money is spent, not after.
    expect(specs).toHaveLength(1);
    expect(person.asked).toEqual(["second?"]);
    expect(logs.join("\n")).toContain("has answered its 1 question(s) for this run; the rest are yours");
  });

  it("refuses every question when it is allowed no rounds", async () => {
    const { bus: b } = bus();
    const { pool: p, specs } = pool([JSON.stringify({ answer: "Yes." })]);
    const intake = new AgentIntake(p, b, req({ rounds: 0 }));

    expect(await intake.ask(ask())).toEqual({ answer: NOBODY_ANSWERED, decidedBy: "nobody" });
    expect(specs).toHaveLength(0);
  });

  it("carries what it already decided into the next question", async () => {
    const { bus: b } = bus();
    const { pool: p, specs } = pool([JSON.stringify({ answer: "Postgres." }), JSON.stringify({ answer: "Yes, migrations." })]);
    const intake = new AgentIntake(p, b, req());

    await intake.ask(ask("Which database?"));
    await intake.ask(ask("Does it need migrations?"));

    // A fresh session per question, so without this it can contradict itself in
    // a brief where both answers end up side by side.
    expect(specs[1]!.prompt).toContain("Which database?");
    expect(specs[1]!.prompt).toContain("Postgres.");
    expect(specs[0]!.prompt).not.toContain("Postgres.");
  });

  it("omits the rationale from the log when the decider gave none", async () => {
    const { bus: b, logs } = bus();
    const { pool: p } = pool([JSON.stringify({ answer: "Yes.", why: 7 })]);
    const intake = new AgentIntake(p, b, req());

    await intake.ask(ask());
    expect(logs.join("\n")).toContain("product-manager answered: Yes.");
    expect(logs.join("\n")).not.toContain(" — 7");
  });
});

describe("the decider as a transport for everything else intake says", () => {
  it("passes prose, activity and the waiting flag through to the person when there is one", async () => {
    const { bus: b } = bus();
    const said: string[] = [];
    const did: string[] = [];
    const waiting: boolean[] = [];
    const person: IntakeUi = {
      async ask() {
        return "";
      },
      say: (t) => said.push(t),
      activity: (t) => did.push(t),
      working: (on) => waiting.push(on),
    };
    const intake = new AgentIntake(pool([]).pool, b, req({ operator: person }));

    intake.say("here is what I found");
    intake.activity("reading src/");
    intake.working(true);

    expect(said).toEqual(["here is what I found"]);
    expect(did).toEqual(["reading src/"]);
    expect(waiting).toEqual([true]);
  });

  it("puts the agent's prose on the run log when there is nobody to show it to", async () => {
    const { bus: b, logs } = bus();
    const intake = new AgentIntake(pool([]).pool, b, req());

    intake.say("surveying the repository");
    // Neither of these has anywhere to go, and neither may throw for it.
    intake.activity("reading src/");
    intake.working(true);

    expect(logs).toContain("surveying the repository");
  });

  it("does not fall over on a transport that implements only what it must", async () => {
    const { bus: b } = bus();
    // `activity` and `working` are optional on IntakeUi. A browser panel or a
    // test double that omits them is a valid transport.
    const bare: IntakeUi = { async ask() { return "x"; }, say() {} };
    const intake = new AgentIntake(pool([]).pool, b, req({ operator: bare }));

    expect(() => intake.activity("reading")).not.toThrow();
    expect(() => intake.working(false)).not.toThrow();
  });
});

describe("who gave the answer, read back off it", () => {
  it("reads a bare string as the operator, which is what it has always been", () => {
    expect(answerText("use postgres")).toBe("use postgres");
    expect(answerBy("use postgres")).toBe("operator");
  });

  it("reads the decider's name off the object form", () => {
    expect(answerText({ answer: "use postgres", decidedBy: "product-manager" })).toBe("use postgres");
    expect(answerBy({ answer: "use postgres", decidedBy: "product-manager" })).toBe("product-manager");
  });

  it("falls back to the operator for a transport that returns an object without saying who", () => {
    // A transport outside this repo implementing the object form and omitting
    // the field is describing a person, because that is what every transport
    // that predates the field was.
    expect(answerBy({ answer: "yes" })).toBe("operator");
    expect(answerBy({ answer: "yes", decidedBy: "" })).toBe("operator");
  });
});

describe("what the decider is told", () => {
  it("spells out that refusing is cheap and being wrong is not", () => {
    const p = intakeDeciderSystemPrompt("product-manager");
    expect(p).toContain("product-manager");
    expect(p).toContain("needsOperator");
    // The four refusal classes have to be in the prompt, not just in the docs.
    expect(p).toContain("credentials");
    expect(p).toContain("real vendor");
    expect(p).toContain("reversible");
    expect(p).not.toContain("undefined");
  });

  it("carries the decider's own skill when it has one, and says nothing when it does not", () => {
    expect(intakeDeciderSystemPrompt("product-manager", "## product-manager\nweigh scope")).toContain("weigh scope");
    expect(intakeDeciderSystemPrompt("product-manager")).not.toContain("##");
  });

  it("puts the options in front of it, and marks the one intake recommends", () => {
    const q = IntakeQuestion.parse({
      question: "Which store?",
      detail: "there is no migration tool in the repo",
      options: [
        { label: "Postgres", description: "needs a migration story", recommended: true },
        { label: "SQLite" },
      ],
    });
    const p = intakeDeciderPrompt("add rate limiting", q, []);
    expect(p).toContain("add rate limiting");
    expect(p).toContain("there is no migration tool in the repo");
    expect(p).toContain("Postgres (it recommends this one) — needs a migration story");
    expect(p).toContain("- SQLite");
    expect(p).not.toContain("Already settled");
  });

  it("says nothing about options or detail on a bare open question", () => {
    const p = intakeDeciderPrompt("seed", IntakeQuestion.parse({ question: "What is the limit keyed on?" }), []);
    expect(p).not.toContain("offers these options");
    expect(p).not.toContain("What it found");
  });

  it("shows what it already decided, so it cannot contradict itself one question later", () => {
    const p = intakeDeciderPrompt("seed", IntakeQuestion.parse({ question: "Migrations?" }), [
      { question: "Which store?", answer: "Postgres." },
    ]);
    expect(p).toContain("Already settled in this conversation, by you. Do not contradict these:");
    expect(p).toContain("Q: Which store?");
    expect(p).toContain("A: Postgres.");
  });
});
