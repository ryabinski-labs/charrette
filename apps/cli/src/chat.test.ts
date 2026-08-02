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
