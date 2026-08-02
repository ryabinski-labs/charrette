import { afterEach, describe, expect, it, vi } from "vitest";

const { createInterfaceMock } = vi.hoisted(() => ({ createInterfaceMock: vi.fn() }));
vi.mock("node:readline/promises", () => ({ createInterface: createInterfaceMock }));

import { promptForNewCap } from "./budget.js";

const GATE = { scope: "run" as const, spentUsd: 8.5, capUsd: 8, runSpentUsd: 8.5 };

/** Feeds scripted answers to the prompt and captures what the operator was shown. */
function scripted(answers: string[]) {
  const asked: string[] = [];
  const shown: string[] = [];
  let i = 0;
  return {
    asked,
    shown,
    ask: async (q: string) => {
      asked.push(q);
      return answers[i++] ?? "s";
    },
    write: (s: string) => void shown.push(s),
  };
}

describe("terminal budget prompt", () => {
  it("defaults to continuing, because the agent that tripped the cap is still waiting", async () => {
    const io = scripted([""]);
    // spent 8.50 + cap 8.00 = enough headroom to finish, not an open cheque.
    await expect(promptForNewCap(GATE, io.ask, io.write)).resolves.toBe(16.5);
    expect(io.asked[0]).toMatch(/enter = \$16\.5/);
  });

  it("takes an explicit amount", async () => {
    const io = scripted(["25"]);
    await expect(promptForNewCap(GATE, io.ask, io.write)).resolves.toBe(25);
  });

  it("stops on s", async () => {
    const io = scripted(["s"]);
    await expect(promptForNewCap(GATE, io.ask, io.write)).resolves.toBeNull();
  });

  it("re-asks rather than accepting a cap already spent through", async () => {
    const io = scripted(["8.50", "nonsense", "30"]);
    await expect(promptForNewCap(GATE, io.ask, io.write)).resolves.toBe(30);
    expect(io.asked).toHaveLength(3);
    expect(io.shown.join("")).toMatch(/must be a number above the \$8\.50 already spent/);
  });

  it("says the agent is paused, not cancelled — that is the whole point", async () => {
    const io = scripted(["s"]);
    await promptForNewCap(GATE, io.ask, io.write);
    expect(io.shown.join("")).toMatch(/paused, not cancelled/);
  });

  it("names the task and the whole-run spend when it is the task cap that tripped", async () => {
    const io = scripted(["s"]);
    await promptForNewCap({ scope: "task", taskId: "publisher-reindex", spentUsd: 10, capUsd: 10, runSpentUsd: 22.4 }, io.ask, io.write);
    const text = io.shown.join("");
    expect(text).toMatch(/on task publisher-reindex/);
    expect(text).toMatch(/\$22\.40 in total/);
  });

  /**
   * The tests above inject their own `ask`/`write`, which is what makes the
   * decision logic testable — but it also means the real terminal path they
   * stand in for had never once executed. These two cover the defaults.
   */
  describe("wired to a real terminal", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      createInterfaceMock.mockReset();
    });

    it("asks on stdin and closes the readline interface it opened", async () => {
      const close = vi.fn();
      const question = vi.fn(async () => "  42  ");
      createInterfaceMock.mockReturnValue({ question, close });
      vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await expect(promptForNewCap(GATE)).resolves.toBe(42);

      expect(createInterfaceMock).toHaveBeenCalledWith({ input: process.stdin, output: process.stdout });
      expect(question).toHaveBeenCalledOnce();
      // A prompt left open holds stdin and the process never exits.
      expect(close).toHaveBeenCalledOnce();
    });

    it("prints to stdout when given no writer", async () => {
      createInterfaceMock.mockReturnValue({ question: async () => "s", close: () => undefined });
      const written: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });

      await expect(promptForNewCap(GATE)).resolves.toBeNull();

      expect(written.join("")).toMatch(/===== BUDGET =====/);
    });
  });
});
