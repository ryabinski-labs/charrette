import { describe, expect, it } from "vitest";
import { TerminalChat, type Prompter } from "./chat.js";

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
