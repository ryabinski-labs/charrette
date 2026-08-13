import { describe, expect, it } from "vitest";
import { checkpointDue, checkpointPrompt, describeQuestions, isCheckpointOnly, parseCheckpoint, DEFAULT_EVERY } from "./checkpoint.js";
import { fold, transcriptChars } from "./compact.js";
import type { LoopMessage } from "./providerClients.js";

describe("checkpointDue", () => {
  it("fires on the cadence and nowhere else", () => {
    expect(checkpointDue(20, 20, 96)).toBe(true);
    expect(checkpointDue(40, 20, 96)).toBe(true);
    expect(checkpointDue(19, 20, 96)).toBe(false);
    expect(checkpointDue(21, 20, 96)).toBe(false);
  });

  it("never fires at or after the wrap-up turn", () => {
    // The wrap-up owns the session's last exchange: a checkpoint racing it would
    // spend the turn describing the work instead of reporting it.
    expect(checkpointDue(80, 20, 80)).toBe(false);
    expect(checkpointDue(100, 20, 80)).toBe(false);
    expect(checkpointDue(60, 20, 80)).toBe(true);
  });

  it("gives short-session roles no checkpoint at all", () => {
    // The repair role runs two turns and the evidence re-ask four. Neither is
    // named anywhere in checkpoint.ts — the arithmetic excludes them, which is
    // what stops this drifting the first time someone changes a maxTurns.
    for (const cap of [2, 4, 12, 20]) {
      const wrapUpAt = Math.max(1, Math.floor(cap * 0.8));
      const fired = [];
      for (let t = 1; t <= cap; t++) if (checkpointDue(t, DEFAULT_EVERY, wrapUpAt)) fired.push(t);
      expect(fired).toEqual([]);
    }
  });

  it("gives a worker four and QA three", () => {
    const fires = (cap: number) => {
      const wrapUpAt = Math.max(1, Math.floor(cap * 0.8));
      const out = [];
      for (let t = 1; t <= cap; t++) if (checkpointDue(t, DEFAULT_EVERY, wrapUpAt)) out.push(t);
      return out;
    };
    expect(fires(120)).toEqual([20, 40, 60, 80]);
    expect(fires(90)).toEqual([20, 40, 60]);
  });

  it("is off at zero, and never fires on a non-positive turn", () => {
    expect(checkpointDue(20, 0, 96)).toBe(false);
    expect(checkpointDue(0, 20, 96)).toBe(false);
    expect(checkpointDue(-5, 20, 96)).toBe(false);
  });
});

describe("checkpointPrompt", () => {
  it("tells the agent not to wait for an answer", () => {
    // The whole feature is non-blocking. An agent that reads this as "stop and
    // wait" turns a 4%-of-budget checkpoint into a dead session.
    const text = checkpointPrompt(20, 20);
    expect(text).toContain("Do NOT wait for an answer");
    expect(text).toContain("keep going");
    expect(text).toContain("not a change of assignment");
  });

  it("names the turn and the cadence", () => {
    expect(checkpointPrompt(40, 20)).toContain("turn 40");
    expect(checkpointPrompt(40, 20)).toContain("every 20 turns");
  });

  it("asks for the block the parser reads", () => {
    // Round-trip against the parser: a format the prompt asks for and the
    // parser cannot read is the failure mode this feature dies of quietly.
    const example = checkpointPrompt(20, 20);
    const block = example.slice(example.indexOf("<harness-checkpoint>\nSTATE:"));
    const parsed = parseCheckpoint(block);
    expect(parsed).not.toBeNull();
    expect(parsed!.questions).toHaveLength(1);
  });
});

describe("parseCheckpoint", () => {
  it("reads a digest and its questions", () => {
    const parsed = parseCheckpoint(
      [
        "Working on it.",
        "<harness-checkpoint>",
        "STATE: auth middleware lives in src/auth/mw.ts and already handles refresh.",
        "QUESTION: reuse the existing retry helper or add one?",
        "OPTIONS: reuse src/util/retry.ts | add a local helper | no retry",
        "RECOMMENDED: reuse src/util/retry.ts",
        "</harness-checkpoint>",
      ].join("\n")
    );
    expect(parsed!.digest).toBe("auth middleware lives in src/auth/mw.ts and already handles refresh.");
    expect(parsed!.questions).toEqual([
      {
        question: "reuse the existing retry helper or add one?",
        options: ["reuse src/util/retry.ts", "add a local helper", "no retry"],
        recommended: "reuse src/util/retry.ts",
      },
    ]);
  });

  it("keeps a multi-line digest whole", () => {
    // Agents wrap STATE far more often than they keep it to one line. Dropping
    // the continuation would record a first sentence as the whole account.
    const parsed = parseCheckpoint(
      ["<harness-checkpoint>", "STATE: first line.", "second line.", "third line.", "</harness-checkpoint>"].join("\n")
    );
    expect(parsed!.digest).toBe("first line.\nsecond line.\nthird line.");
  });

  it("reads several questions", () => {
    const parsed = parseCheckpoint(
      [
        "<harness-checkpoint>",
        "STATE: half done.",
        "QUESTION: first?",
        "OPTIONS: a | b",
        "RECOMMENDED: a",
        "QUESTION: second?",
        "OPTIONS: c | d",
        "RECOMMENDED: d",
        "</harness-checkpoint>",
      ].join("\n")
    );
    expect(parsed!.questions.map((q) => q.question)).toEqual(["first?", "second?"]);
    expect(parsed!.questions[1]!.recommended).toBe("d");
  });

  it("accepts a digest with no questions", () => {
    // "Nothing is genuinely open" is a valid answer and must not read as a
    // malformed one.
    const parsed = parseCheckpoint(["<harness-checkpoint>", "STATE: on track.", "</harness-checkpoint>"].join("\n"));
    expect(parsed!.questions).toEqual([]);
    expect(parsed!.digest).toBe("on track.");
  });

  it("keeps the digest from a truncated block", () => {
    // The normal shape of an answer cut off at the output ceiling. Discarding a
    // written digest over an unwritten closing tag is a pure loss.
    const parsed = parseCheckpoint(["<harness-checkpoint>", "STATE: got as far as the schema."].join("\n"));
    expect(parsed!.digest).toBe("got as far as the schema.");
  });

  it("is case-insensitive about the tag", () => {
    expect(parseCheckpoint("<HARNESS-CHECKPOINT>\nSTATE: x\n</HARNESS-CHECKPOINT>")!.digest).toBe("x");
  });

  it("returns null when there is no block, and never throws", () => {
    expect(parseCheckpoint("just an ordinary answer")).toBeNull();
    expect(parseCheckpoint("")).toBeNull();
    expect(parseCheckpoint("<harness-checkpoint></harness-checkpoint>")).toBeNull();
  });

  it("drops a question with no text but keeps the digest", () => {
    const parsed = parseCheckpoint(
      ["<harness-checkpoint>", "STATE: fine.", "QUESTION:", "OPTIONS: a | b", "</harness-checkpoint>"].join("\n")
    );
    expect(parsed!.digest).toBe("fine.");
    expect(parsed!.questions).toEqual([]);
  });

  it("tolerates a question with no options or recommendation", () => {
    const parsed = parseCheckpoint(
      ["<harness-checkpoint>", "STATE: fine.", "QUESTION: is the staging URL right?", "</harness-checkpoint>"].join("\n")
    );
    expect(parsed!.questions).toEqual([{ question: "is the staging URL right?", options: [], recommended: "" }]);
  });
});

describe("isCheckpointOnly", () => {
  const block = ["<harness-checkpoint>", "STATE: rewrote the retry helper", "</harness-checkpoint>"].join("\n");

  it("recognises a turn that was nothing but a checkpoint", () => {
    expect(isCheckpointOnly(block)).toBe(true);
    expect(isCheckpointOnly(`\n\n${block}\n`)).toBe(true);
  });

  it("recognises a truncated one", () => {
    // The block ran into the output ceiling. Still nothing but a checkpoint.
    expect(isCheckpointOnly("<harness-checkpoint>\nSTATE: half a dig")).toBe(true);
  });

  it("does not claim a real answer that happens to carry a digest", () => {
    // The agent wrote its digest and then answered properly. That answer is the
    // task's result and must not be treated as disposable.
    expect(isCheckpointOnly(`${block}\n\nDONE: opened PR #12`)).toBe(false);
    expect(isCheckpointOnly(`Here is where I am.\n${block}`)).toBe(false);
  });

  it("does not claim an ordinary answer", () => {
    expect(isCheckpointOnly("DONE: opened PR #12")).toBe(false);
    expect(isCheckpointOnly("")).toBe(false);
  });
});

describe("describeQuestions", () => {
  it("says what it is going to do when nobody answers", () => {
    expect(describeQuestions([{ question: "reuse or add?", options: ["reuse", "add"], recommended: "reuse" }])).toEqual([
      "reuse or add?  [reuse | add]  → proceeding with: reuse",
    ]);
  });

  it("omits the empty parts", () => {
    expect(describeQuestions([{ question: "which?", options: [], recommended: "" }])).toEqual(["which?"]);
  });
});

describe("fold", () => {
  const user = (text: string): LoopMessage => ({ role: "user", text });
  const assistant = (text: string): LoopMessage => ({ role: "assistant", text, toolCalls: [] });
  const tool = (text: string): LoopMessage => ({ role: "tool", callId: "c", name: "Read", text });

  const long = "x".repeat(5000);

  it("never folds away what the operator said", () => {
    // The rule compact.ts is built on: an agent's account of its own behaviour
    // cannot reconstruct the instruction it was derived from, and paraphrasing
    // "use the existing helper, do not add one" is how an agent confidently
    // does the opposite six turns later.
    const messages = [
      user("original assignment"),
      assistant(long),
      tool(long),
      user("operator: do not touch the migration"),
      assistant(long),
      tool(long),
      assistant("a"),
      assistant("b"),
      assistant("c"),
    ];
    const out = fold(messages, "digest of the work so far").messages;
    const users = out.filter((m) => m.role === "user").map((m) => m.text);
    expect(users).toEqual(["original assignment", "operator: do not touch the migration"]);
  });

  it("puts the digest immediately before the protected tail", () => {
    const messages = [user("assignment"), assistant(long), tool(long), assistant("a"), assistant("b"), assistant("c")];
    const out = fold(messages, "here is where I got to").messages;
    // assignment, digest, then the three protected assistants.
    expect(out).toHaveLength(5);
    expect(out[0]!.text).toBe("assignment");
    expect(out[1]!.text).toContain("here is where I got to");
    expect(out.slice(2).map((m) => m.text)).toEqual(["a", "b", "c"]);
  });

  it("actually reclaims the characters", () => {
    const messages = [user("assignment"), assistant(long), tool(long), assistant("a"), assistant("b"), assistant("c")];
    const before = transcriptChars(messages);
    const result = fold(messages, "short digest");
    expect(result.saved).toBeGreaterThan(9000);
    expect(transcriptChars(result.messages)).toBe(before - result.saved);
  });

  it("leaves no tool result whose assistant was folded away", () => {
    // OpenAI rejects a tool message that does not follow the assistant turn
    // that called for it, so an orphan here is a dead session rather than a
    // degraded one.
    const messages = [user("assignment"), assistant(long), tool(long), assistant("a"), assistant("b"), assistant("c")];
    const out = fold(messages, "digest").messages;
    expect(out.some((m) => m.role === "tool")).toBe(false);
  });

  it("does nothing when there is no protected tail to fold behind", () => {
    const messages = [user("assignment"), assistant("a"), assistant("b")];
    expect(fold(messages, "digest").saved).toBe(0);
    expect(fold(messages, "digest").messages).toBe(messages);
  });

  it("refuses to grow the transcript", () => {
    // A chatty agent on a short tail will write a digest longer than what it
    // replaces. Swapping detail for a longer paraphrase of it is a pure loss.
    const messages = [user("assignment"), assistant("tiny"), assistant("a"), assistant("b"), assistant("c")];
    const result = fold(messages, long);
    expect(result.saved).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("says how many messages it replaced", () => {
    const messages = [user("assignment"), assistant(long), tool(long), assistant("a"), assistant("b"), assistant("c")];
    const out = fold(messages, "digest").messages;
    expect(out[1]!.text).toContain("in place of 2 earlier messages");
  });
});
