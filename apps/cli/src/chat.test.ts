import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalChat, type Prompter } from "./chat.js";

/** Captures everything the chat printed, with the ANSI styling stripped. */
function capture(): () => string {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  // eslint-disable-next-line no-control-regex
  return () => chunks.join("").replace(/\[\d+m/g, "");
}

/** Replays a fixed script of operator keystrokes. */
function scripted(lines: string[]): Prompter {
  let i = 0;
  return {
    async question() {
      if (i >= lines.length) throw new Error("prompted more times than the script allows");
      return lines[i++]!;
    },
    close() {},
  };
}

const question = (options: { label: string; description: string; recommended: boolean }[]) => ({
  question: "Where should the limit be enforced?",
  detail: "package.json pins fastify 5 and there is no middleware directory.",
  options,
});

const OPTIONS = [
  { label: "Fastify plugin, in-process", description: "no new infra", recommended: true },
  { label: "Redis-backed", description: "survives multiple instances", recommended: false },
  { label: "Reverse proxy", description: "", recommended: false },
];

describe("TerminalChat.ask", () => {
  it("resolves a numbered choice to that option's label", async () => {
    const chat = new TerminalChat(scripted(["2"]));
    expect(await chat.ask(question(OPTIONS))).toBe("Redis-backed");
  });

  it("treats a bare enter as taking the recommendation", async () => {
    const chat = new TerminalChat(scripted([""]));
    expect(await chat.ask(question(OPTIONS))).toBe("Fastify plugin, in-process");
  });

  it("passes anything else through as a free-text answer", async () => {
    const chat = new TerminalChat(scripted(["use the CDN's rate limiter instead"]));
    expect(await chat.ask(question(OPTIONS))).toBe("use the CDN's rate limiter instead");
  });

  it("treats an out-of-range number as free text, not a silent mispick", async () => {
    const chat = new TerminalChat(scripted(["9"]));
    expect(await chat.ask(question(OPTIONS))).toBe("9");
  });

  it("re-prompts on an empty answer when no option is recommended", async () => {
    const none = OPTIONS.map((o) => ({ ...o, recommended: false }));
    const chat = new TerminalChat(scripted(["", "  ", "3"]));
    expect(await chat.ask(question(none))).toBe("Reverse proxy");
  });

  it("requires an answer to an open question with no options", async () => {
    const chat = new TerminalChat(scripted(["", "per API key"]));
    expect(await chat.ask({ question: "What is the limit keyed on?", detail: "", options: [] })).toBe("per API key");
  });
});

describe("TerminalChat.promptSeed", () => {
  it("joins lines until a blank one ends the paragraph", async () => {
    const chat = new TerminalChat(scripted(["add rate limiting", "keep it in-process", ""]));
    expect(await chat.promptSeed()).toBe("add rate limiting\nkeep it in-process");
  });

  it("ignores leading blank lines instead of returning nothing", async () => {
    const chat = new TerminalChat(scripted(["", "", "add rate limiting", ""]));
    expect(await chat.promptSeed()).toBe("add rate limiting");
  });
});

describe("what the chat puts on the screen", () => {
  let shown: () => string;

  beforeEach(() => {
    shown = capture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("promises the intake agent will ask for the rest", async () => {
    await new TerminalChat(scripted(["a", ""])).promptSeed();

    expect(shown()).toContain("A sentence is enough — the intake agent will ask about the rest.");
  });

  it("warns that nothing else will ask when the conversation is off", async () => {
    await new TerminalChat(scripted(["a", ""])).promptSeed(false);

    // Without an intake agent this text is the only chance to say the
    // constraints, so the prompt has to say so.
    expect(shown()).toContain("This goes straight to the planner, so include the constraints that matter.");
  });

  it("prints what the agent said", () => {
    new TerminalChat(scripted([])).say("  Two ways to do this.  ");

    expect(shown()).toContain("● Two ways to do this.");
  });

  it("says nothing at all for an empty message", () => {
    new TerminalChat(scripted([])).say("   \n  ");

    expect(shown()).toBe("");
  });

  it("wraps a long message to the terminal width instead of one endless line", () => {
    const sentence = "the harness never merges its own work and that part is left to you ".repeat(4);

    new TerminalChat(scripted([])).say(sentence);

    const lines = shown().trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(92);
  });

  it("marks the recommended option and says enter will take it", async () => {
    await new TerminalChat(scripted(["1"])).ask(question(OPTIONS));

    const text = shown();
    expect(text).toContain("1. Fastify plugin, in-process (recommended) — no new infra");
    expect(text).toContain("[1-3, enter = 1, or type your own answer]");
    expect(text).toContain("package.json pins fastify 5");
  });

  it("does not offer an enter shortcut when nothing is recommended", async () => {
    await new TerminalChat(scripted(["2"])).ask(
      question(OPTIONS.map((o) => ({ ...o, recommended: false })))
    );

    expect(shown()).toContain("[1-3, or type your own answer]");
  });

  it("keeps a blank line between paragraphs instead of running them together", () => {
    new TerminalChat(scripted([])).say("First paragraph.\n\nSecond paragraph.");

    // The blank line survives as its own (indented) line rather than being
    // dropped, so two paragraphs do not run together.
    expect(shown()).toContain("First paragraph.\n  \n  Second paragraph.");
  });

  it("closes the readline interface it was given", () => {
    const close = vi.fn();
    new TerminalChat({ question: async () => "", close }).close();

    expect(close).toHaveBeenCalledOnce();
  });
});

describe("multi-line answers", () => {
  it("joins lines a trailing backslash continues", async () => {
    const chat = new TerminalChat(scripted(["give me back JSON: \\", "  {id, name} \\", "  and nothing else"]));

    // A single-line reader silently truncates a pasted answer at the first
    // newline, keeping the operator's first clause and dropping the rest.
    expect(await chat.ask({ question: "What shape?", detail: "", options: [] })).toBe(
      "give me back JSON: \n  {id, name} \n  and nothing else"
    );
  });

  it("switches the prompt on the continuation lines", async () => {
    capture();
    const question = vi.fn(async (p: string) => (p.includes("·") ? "second" : "first \\"));

    await new TerminalChat({ question, close: () => {} }).ask({ question: "?", detail: "", options: [] });

    expect(question.mock.calls.map((c) => c[0])).toEqual(["> ", "· "]);
    vi.restoreAllMocks();
  });
});

describe("showing that the agent is still working", () => {
  const realIsTty = process.stdout.isTTY;

  afterEach(() => {
    process.stdout.isTTY = realIsTty;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("counts the seconds while the operator waits", () => {
    vi.useFakeTimers();
    process.stdout.isTTY = true;
    const shown = capture();
    const chat = new TerminalChat(scripted([]));

    chat.working(true);
    vi.advanceTimersByTime(2_400);
    chat.working(false);

    // The intake agent's first move is to read a repository; a terminal that
    // shows nothing for that long reads as a hang.
    expect(shown()).toContain("thinking… 2s");
  });

  it("cycles the spinner rather than redrawing one frame", () => {
    vi.useFakeTimers();
    process.stdout.isTTY = true;
    const shown = capture();
    const chat = new TerminalChat(scripted([]));

    chat.working(true);
    vi.advanceTimersByTime(360);
    chat.working(false);

    expect(new Set(shown().match(/[\u2800-\u28ff]/g)).size).toBeGreaterThan(1);
  });

  it("stops the old spinner before starting a new one", () => {
    vi.useFakeTimers();
    process.stdout.isTTY = true;
    capture();
    const chat = new TerminalChat(scripted([]));

    chat.working(true);
    chat.working(true);
    vi.advanceTimersByTime(200);
    chat.working(false);

    // Two intervals writing over each other would double the frame rate and
    // leave one of them running for the rest of the process.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes nothing at all when nobody is watching a terminal", () => {
    vi.useFakeTimers();
    process.stdout.isTTY = false;
    const shown = capture();

    new TerminalChat(scripted([])).working(true);
    vi.advanceTimersByTime(1_000);

    expect(shown()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the spinner's line before the agent speaks over it", () => {
    vi.useFakeTimers();
    process.stdout.isTTY = true;
    const shown = capture();
    const chat = new TerminalChat(scripted([]));

    chat.working(true);
    vi.advanceTimersByTime(200);
    chat.say("Two ways to do this.");

    expect(shown()).toContain("\r\u001b[K");
    expect(shown()).toContain("Two ways to do this.");
  });

  it("stops spinning when it becomes the operator's turn", async () => {
    vi.useFakeTimers();
    process.stdout.isTTY = true;
    capture();
    const chat = new TerminalChat(scripted(["an answer"]));

    chat.working(true);
    await chat.ask({ question: "?", detail: "", options: [] });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("what the agent is doing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints one dimmed line per tool call", () => {
    const shown = capture();

    new TerminalChat(scripted([])).activity("Read package.json");

    expect(shown()).toContain("· Read package.json");
  });

  it("keeps it to one line, however much the tool had to say", () => {
    const shown = capture();

    new TerminalChat(scripted([])).activity("Grep fastify\nline two\nline three");

    expect(shown().trimEnd().split("\n").length).toBe(1);
    expect(shown()).not.toContain("line two");
  });

  it("says nothing for an empty tool summary", () => {
    const shown = capture();

    new TerminalChat(scripted([])).activity("   ");

    expect(shown()).toBe("");
  });
});

describe("colour", () => {
  const realIsTty = process.stdout.isTTY;
  const realNoColor = process.env.NO_COLOR;

  afterEach(() => {
    process.stdout.isTTY = realIsTty;
    if (realNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = realNoColor;
    vi.restoreAllMocks();
  });

  /**
   * `useColor` is decided once, when the module is first loaded, so the styled
   * path only exists for a module imported under a real terminal. Every other
   * test in this file runs with vitest's non-TTY stdout and therefore only ever
   * sees the plain-text side.
   */
  it("emits ANSI codes on a terminal that has not asked for plain text", async () => {
    process.stdout.isTTY = true;
    delete process.env.NO_COLOR;
    vi.resetModules();
    const { TerminalChat: Styled } = await import("./chat.js");
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    new Styled({ question: async () => "", close: () => {} }).say("styled");

    expect(chunks.join("")).toContain("[32m●[0m");
  });

  it("stays plain when NO_COLOR is set, even on a terminal", async () => {
    process.stdout.isTTY = true;
    process.env.NO_COLOR = "1";
    vi.resetModules();
    const { TerminalChat: Plain } = await import("./chat.js");
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    new Plain({ question: async () => "", close: () => {} }).say("plain");

    expect(chunks.join("")).not.toContain("[");
  });
});

describe("TerminalChat.ask, when something else answers first", () => {
  let restore: (() => string) | null = null;
  beforeEach(() => {
    restore = capture();
  });
  afterEach(() => {
    restore = null;
    vi.restoreAllMocks();
  });

  /** A reader that records the signal it was handed and never returns. */
  function watching(): { prompter: Prompter; signals: (AbortSignal | undefined)[] } {
    const signals: (AbortSignal | undefined)[] = [];
    return {
      signals,
      prompter: {
        question(_prompt: string, options?: { signal?: AbortSignal }) {
          signals.push(options?.signal);
          return new Promise<string>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
          });
        },
        close() {},
      },
    };
  }

  it("hands the signal down to the reader it is blocking on", async () => {
    const { prompter, signals } = watching();
    const chat = new TerminalChat(prompter);
    const controller = new AbortController();
    const asking = chat.ask(question(OPTIONS), controller.signal);
    // Without this the readline stays queued on a question that has already been
    // answered elsewhere, and takes the operator's next line as the answer to
    // this prompt — every answer after it one question behind.
    expect(signals).toEqual([controller.signal]);
    controller.abort();
    await expect(asking).rejects.toThrow("The operation was aborted");
  });

  it("carries the signal onto every line of a continued answer", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    let asked = 0;
    const prompter: Prompter = {
      async question(_prompt: string, options?: { signal?: AbortSignal }) {
        signals.push(options?.signal);
        // A trailing backslash continues onto the next line, so one answer can
        // be several reads and every one of them has to be cancellable.
        return asked++ === 0 ? "first line\\" : "second line";
      },
      close() {},
    };
    const controller = new AbortController();
    expect(await new TerminalChat(prompter).ask(question([]), controller.signal)).toBe("first line\nsecond line");
    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  it("still works for a caller with no signal to give", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const prompter: Prompter = {
      async question(_prompt: string, options?: { signal?: AbortSignal }) {
        signals.push(options?.signal);
        return "Redis-backed";
      },
      close() {},
    };
    expect(await new TerminalChat(prompter).ask(question(OPTIONS))).toBe("Redis-backed");
    expect(signals).toEqual([undefined]);
  });
});
