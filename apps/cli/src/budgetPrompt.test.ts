import { afterEach, describe, expect, it, vi } from "vitest";

const { createInterfaceMock } = vi.hoisted(() => ({ createInterfaceMock: vi.fn() }));
vi.mock("node:readline/promises", () => ({ createInterface: createInterfaceMock }));

import { promptForNewCap, watchBudgetCommands } from "./budget.js";
import type { RunController } from "@harness/core";

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

describe("watchBudgetCommands", () => {
  /** Fakes a TTY stdin and gives back the function watchBudgetCommands registered on "data". */
  function fakeTty(): { emit: (text: string) => void; stop: () => void } {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    let handler: ((chunk: Buffer | string) => void) | undefined;
    vi.spyOn(process.stdin, "on").mockImplementation((event: string, fn: unknown) => {
      if (event === "data") handler = fn as (chunk: Buffer | string) => void;
      return process.stdin;
    });
    vi.spyOn(process.stdin, "off").mockReturnValue(process.stdin);
    return { emit: (text: string) => handler?.(text), stop: () => vi.restoreAllMocks() };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
  });

  it("does nothing outside a real terminal", () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const onSpy = vi.spyOn(process.stdin, "on");
    const controller = { raiseBudget: vi.fn() } as unknown as RunController;

    watchBudgetCommands(controller, () => "run1");

    expect(onSpy).not.toHaveBeenCalled();
  });

  it("raises the cap for a well-formed command and writes back what happened", () => {
    const tty = fakeTty();
    const controller = { raiseBudget: vi.fn(() => "run cap raised to $50.00") } as unknown as RunController;
    const written: string[] = [];

    watchBudgetCommands(controller, () => "run1", (s) => void written.push(s));
    tty.emit("budget run 50\n");

    expect(controller.raiseBudget).toHaveBeenCalledWith("run1", "run", 50);
    expect(written.join("")).toContain("run cap raised to $50.00");
  });

  it("ignores lines that are not a budget command, without touching the controller", () => {
    const tty = fakeTty();
    const controller = { raiseBudget: vi.fn() } as unknown as RunController;

    watchBudgetCommands(controller, () => "run1");
    tty.emit("y\n");
    tty.emit("hello there\n");

    expect(controller.raiseBudget).not.toHaveBeenCalled();
  });

  it("hints at the syntax for a mistyped budget command, but stays silent on everything else", () => {
    const tty = fakeTty();
    const controller = { raiseBudget: vi.fn() } as unknown as RunController;
    const written: string[] = [];

    watchBudgetCommands(controller, () => "run1", (s) => void written.push(s));
    tty.emit("budget run -5\n");
    tty.emit("budget xyz\n");
    tty.emit("y\n");
    tty.emit("hello there\n");

    expect(controller.raiseBudget).not.toHaveBeenCalled();
    expect(written).toEqual([
      '  not a budget command: "budget run -5" — try \'budget run <usd>\' or \'budget task <usd>\'\n',
      '  not a budget command: "budget xyz" — try \'budget run <usd>\' or \'budget task <usd>\'\n',
    ]);
  });

  it("reassembles a command split across chunks and handles multiple lines in one chunk", () => {
    const tty = fakeTty();
    const controller = { raiseBudget: vi.fn(() => "ok") } as unknown as RunController;

    watchBudgetCommands(controller, () => "run1");
    tty.emit("budget ta");
    tty.emit("sk 12.5\nbudget run 99\n");

    expect(controller.raiseBudget).toHaveBeenNthCalledWith(1, "run1", "task", 12.5);
    expect(controller.raiseBudget).toHaveBeenNthCalledWith(2, "run1", "run", 99);
  });

  it("says there is no run yet when the id getter has nothing", () => {
    const tty = fakeTty();
    const controller = { raiseBudget: vi.fn() } as unknown as RunController;
    const written: string[] = [];

    watchBudgetCommands(controller, () => undefined, (s) => void written.push(s));
    tty.emit("budget run 50\n");

    expect(controller.raiseBudget).not.toHaveBeenCalled();
    expect(written.join("")).toMatch(/no run yet/);
  });

  it("stops listening once the returned function is called", () => {
    fakeTty();
    const offSpy = vi.spyOn(process.stdin, "off");
    const controller = { raiseBudget: vi.fn() } as unknown as RunController;

    const stop = watchBudgetCommands(controller, () => "run1");
    stop();

    expect(offSpy).toHaveBeenCalledWith("data", expect.any(Function));
  });
});
