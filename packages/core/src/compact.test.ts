import { describe, expect, it } from "vitest";
import { BUDGETS, budgetFor, compact, messageChars, protectedFrom, transcriptChars } from "./compact.js";
import type { LoopMessage } from "./providerClients.js";

const user = (text: string): LoopMessage => ({ role: "user", text });
const assistant = (text: string, toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = []): LoopMessage => ({
  role: "assistant",
  text,
  toolCalls,
});
const tool = (name: string, text: string, callId = "c1"): LoopMessage => ({ role: "tool", callId, name, text });

/** An exchange: the agent says something, calls a tool, gets a big result back. */
const exchange = (n: number, size: number): LoopMessage[] => [
  assistant(`step ${n}`, [{ id: `c${n}`, name: "Bash", input: { command: "ls" } }]),
  tool("Bash", "x".repeat(size), `c${n}`),
];

describe("messageChars", () => {
  it("counts a user message by its text", () => {
    expect(messageChars(user("hello"))).toBe(5);
  });

  it("counts an assistant message's tool calls, not just its prose", () => {
    const bare = messageChars(assistant("hi"));
    const calling = messageChars(assistant("hi", [{ id: "c1", name: "Bash", input: { command: "ls" } }]));
    expect(calling).toBeGreaterThan(bare);
  });

  it("counts an empty tool input as the two characters it serialises to", () => {
    expect(messageChars(assistant("", [{ id: "c1", name: "Bash", input: {} }]))).toBe("Bash".length + 2);
  });

  it("counts a tool result by its text", () => {
    expect(messageChars(tool("Bash", "abcd"))).toBe(4);
  });
});

describe("transcriptChars", () => {
  it("sums the whole transcript", () => {
    expect(transcriptChars([user("ab"), tool("Bash", "cde")])).toBe(5);
  });

  it("is zero for an empty transcript", () => {
    expect(transcriptChars([])).toBe(0);
  });
});

describe("protectedFrom", () => {
  it("protects everything while there are fewer exchanges than the floor", () => {
    expect(protectedFrom([user("a"), ...exchange(1, 10)], 3)).toBe(0);
  });

  it("protects from the start of the nth-from-last exchange", () => {
    const messages = [user("a"), ...exchange(1, 10), ...exchange(2, 10), ...exchange(3, 10), ...exchange(4, 10)];
    // Assistants sit at 1, 3, 5, 7; keeping the last two protects from index 5.
    expect(protectedFrom(messages, 2)).toBe(5);
  });
});

describe("compact", () => {
  it("leaves a transcript that fits completely alone", () => {
    const messages = [user("a"), ...exchange(1, 10)];
    const result = compact(messages, 10_000);
    expect(result.saved).toBe(0);
    expect(result.exhausted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("shortens old tool output when the transcript is over budget", () => {
    // The shape a real session has: broad, expensive exploration early, focused
    // work late. The early dumps are what compaction is for.
    const messages = [
      user("build it"),
      ...exchange(1, 100_000),
      ...exchange(2, 100_000),
      ...exchange(3, 100_000),
      ...exchange(4, 500),
      ...exchange(5, 500),
      ...exchange(6, 500),
    ];
    const before = transcriptChars(messages);
    const result = compact(messages, 150_000);

    expect(result.saved).toBeGreaterThan(0);
    expect(result.exhausted).toBe(false);
    expect(transcriptChars(result.messages)).toBeLessThan(before);
    expect(transcriptChars(result.messages)).toBeLessThanOrEqual(150_000);
  });

  it("never touches what the operator wrote, at any pressure", () => {
    const instruction = "use the existing retry helper, do not add a new one";
    const messages = [
      user(instruction),
      ...exchange(1, 200_000),
      ...exchange(2, 200_000),
      ...exchange(3, 200_000),
      user("also keep the public API stable"),
      ...exchange(4, 200_000),
      ...exchange(5, 200_000),
    ];
    const result = compact(messages, 1_000);

    const users = result.messages.filter((m) => m.role === "user").map((m) => m.text);
    expect(users).toEqual([instruction, "also keep the public API stable"]);
  });

  it("keeps the agent's account of what it did, dropping only the output", () => {
    const messages = [user("go"), ...exchange(1, 200_000), ...exchange(2, 200_000), ...exchange(3, 200_000), ...exchange(4, 200_000), ...exchange(5, 200_000)];
    const result = compact(messages, 1_000);

    const narration = result.messages.filter((m) => m.role === "assistant").map((m) => m.text);
    expect(narration).toEqual(["step 1", "step 2", "step 3", "step 4", "step 5"]);
  });

  it("leaves the most recent exchanges verbatim, where the agent is still working", () => {
    const messages = [user("go"), ...exchange(1, 100_000), ...exchange(2, 100_000), ...exchange(3, 100_000), ...exchange(4, 100_000)];
    const result = compact(messages, 60_000, 3);

    // Exchange 1 is compactable; 2, 3 and 4 are the protected tail.
    expect((result.messages[2] as { text: string }).text.length).toBeLessThan(100_000);
    expect((result.messages[4] as { text: string }).text).toHaveLength(100_000);
    expect((result.messages[8] as { text: string }).text).toHaveLength(100_000);
  });

  it("says so in place of what it removed, rather than dropping it silently", () => {
    const messages = [user("go"), ...exchange(1, 100_000), ...exchange(2, 20), ...exchange(3, 20), ...exchange(4, 20)];
    const result = compact(messages, 5_000);
    expect((result.messages[2] as { text: string }).text).toMatch(/characters elided to stay inside the context window/);
  });

  it("elides outright when shortening was not enough", () => {
    const messages = [
      user("go"),
      ...exchange(1, 100_000),
      ...exchange(2, 100_000),
      ...exchange(3, 20),
      ...exchange(4, 20),
      ...exchange(5, 20),
    ];
    const result = compact(messages, 1_500);
    // A digest keeps a head and a tail; a full elision names the tool and the size.
    expect((result.messages[2] as { text: string }).text).toBe("[Bash output — 100000 characters elided to stay inside the context window]");
  });

  it("leaves a tool result alone when compacting it would not make it smaller", () => {
    const messages = [user("go"), assistant("s", [{ id: "c", name: "Bash", input: {} }]), tool("Bash", "tiny"), ...exchange(2, 90_000), ...exchange(3, 20), ...exchange(4, 20)];
    const result = compact(messages, 2_000);
    expect((result.messages[2] as { text: string }).text).toBe("tiny");
  });

  it("reports exhaustion when the protected material alone is over budget", () => {
    const messages = [user("go"), ...exchange(1, 50_000), ...exchange(2, 50_000), ...exchange(3, 50_000)];
    const result = compact(messages, 1_000, 3);
    expect(result.exhausted).toBe(true);
  });

  it("does not mutate the transcript it was handed", () => {
    const messages = [user("go"), ...exchange(1, 100_000), ...exchange(2, 20), ...exchange(3, 20), ...exchange(4, 20)];
    const copy = JSON.parse(JSON.stringify(messages));
    compact(messages, 1_000);
    expect(messages).toEqual(copy);
  });
});

describe("budgetFor", () => {
  it("reads the budget from the model's provider", () => {
    expect(budgetFor("gpt-5.6-terra")).toBe(BUDGETS.openai);
    expect(budgetFor("gemini-3.5-flash-lite")).toBe(BUDGETS.google);
  });

  it("prefers an explicit override", () => {
    expect(budgetFor("gpt-5.6-terra", 42)).toBe(42);
  });
});
