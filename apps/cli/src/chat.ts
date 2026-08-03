import { createInterface } from "node:readline/promises";
import type { IntakeUi } from "@harness/core";
import type { IntakeQuestion } from "@harness/shared";

/** The slice of readline this needs — narrowed so tests can supply a script. */
export interface Prompter {
  question(prompt: string): Promise<string>;
  close(): void;
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = c("1");
const dim = c("2");
const cyan = c("36");
const green = c("32");

const WIDTH = Math.min(process.stdout.columns || 80, 92);

/** Wrap to the terminal width, indenting every line including the first. */
function wrap(text: string, indent = "  "): string {
  const limit = Math.max(WIDTH - indent.length, 40);
  return text
    .split("\n")
    .map((para) => {
      if (!para.trim()) return "";
      const out: string[] = [];
      let line = "";
      for (const word of para.split(/\s+/)) {
        if (line && line.length + word.length + 1 > limit) {
          out.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) out.push(line);
      return out.join(`\n${indent}`);
    })
    .join(`\n${indent}`);
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Terminal transport for the intake conversation (the `IntakeUi` core expects).
 * Questions render as a numbered list with the recommendation marked; the
 * operator may pick a number, press enter to take the recommendation, or type
 * anything else as a free-text answer.
 */
export class TerminalChat implements IntakeUi {
  constructor(private rl: Prompter = createInterface({ input: process.stdin, output: process.stdout })) {}

  /** Spinner state. Null whenever nothing is being waited on. */
  private spinner: NodeJS.Timeout | null = null;
  private since = 0;
  private frame = 0;

  /**
   * The agent is thinking, or it is the operator's turn.
   *
   * A conversation where one side goes silent for ninety seconds with no sign
   * of life reads as a hang, and the intake agent's first move is to survey a
   * repository — which is exactly that long. The elapsed counter is the point:
   * it says "still working", and it says how long you have been waiting.
   */
  working(on: boolean): void {
    if (this.spinner) {
      this.erase();
      clearInterval(this.spinner);
      this.spinner = null;
    }
    if (!on || !process.stdout.isTTY) return;
    this.since = Date.now();
    this.frame = 0;
    this.spinner = setInterval(() => this.tick(), 120);
    // Never the reason a finished process stays alive.
    this.spinner.unref?.();
  }

  private tick(): void {
    const seconds = Math.floor((Date.now() - this.since) / 1000);
    const mark = SPINNER[this.frame++ % SPINNER.length]!;
    process.stdout.write(`\r${dim(`${mark} thinking… ${seconds}s`)}\u001b[K`);
  }

  /**
   * Wipe the spinner's line before anything else is written over it. Only when
   * something is actually spinning: a terminal told NO_COLOR should not be sent
   * control sequences it never needed either.
   */
  private erase(): void {
    if (this.spinner) process.stdout.write("\r\u001b[K");
  }

  /**
   * What the agent is doing, one dimmed line per tool call. Without it the
   * survey phase is a blank screen; with it the operator can see it reading
   * their README and knows the questions are about to be grounded in it.
   */
  activity(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.erase();
    process.stdout.write(`  ${dim(`· ${trimmed.split("\n")[0]!.slice(0, WIDTH - 6)}`)}\n`);
  }

  /** Read the opening assignment. Blank line ends a multi-line paragraph. */
  async promptSeed(withIntake = true): Promise<string> {
    process.stdout.write(`\n${bold("What should the harness build?")}\n`);
    process.stdout.write(
      dim(
        withIntake
          ? "  A sentence is enough — the intake agent will ask about the rest.\n"
          : "  This goes straight to the planner, so include the constraints that matter.\n"
      )
    );
    process.stdout.write(dim("  Finish with a blank line.\n\n"));
    const lines: string[] = [];
    for (;;) {
      const line = await this.rl.question(lines.length === 0 ? cyan("> ") : cyan("· "));
      if (line.trim() === "") {
        if (lines.length > 0) break;
        continue;
      }
      lines.push(line);
    }
    return lines.join("\n").trim();
  }

  /**
   * One answer, which may run to several lines.
   *
   * A trailing backslash continues onto the next line, the way a shell does.
   * The reason it exists: the answers that matter most here are the long ones —
   * "here is the shape of the JSON I want back", a pasted error, three
   * constraints — and a single-line reader silently truncates a paste at the
   * first newline, taking the operator's first clause and discarding the rest.
   */
  private async readAnswer(): Promise<string> {
    const parts: string[] = [];
    for (;;) {
      const line = await this.rl.question(cyan(parts.length ? "· " : "> "));
      if (!line.endsWith("\\")) {
        parts.push(line);
        return parts.join("\n");
      }
      parts.push(line.slice(0, -1));
    }
  }

  say(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.erase();
    process.stdout.write(`\n${green("●")} ${wrap(trimmed, "  ")}\n`);
  }

  async ask(q: IntakeQuestion): Promise<string> {
    // The agent has stopped thinking and it is the operator's turn; nothing
    // should be spinning under the prompt they are typing into.
    this.working(false);
    process.stdout.write("\n");
    if (q.detail) process.stdout.write(`${dim(wrap(q.detail, "  "))}\n\n`);
    process.stdout.write(`  ${bold(wrap(q.question, "  "))}\n`);

    const recommended = q.options.findIndex((o) => o.recommended);
    q.options.forEach((o, i) => {
      const mark = o.recommended ? green(" (recommended)") : "";
      const detail = o.description ? dim(` — ${o.description}`) : "";
      process.stdout.write(`  ${dim(`${i + 1}.`)} ${o.label}${mark}${detail}\n`);
    });
    if (q.options.length) {
      const hint = recommended >= 0 ? `enter = ${recommended + 1}, or type your own answer` : "or type your own answer";
      process.stdout.write(`${dim(`  [1-${q.options.length}, ${hint}]`)}\n`);
    }

    for (;;) {
      const answer = (await this.readAnswer()).trim();
      if (answer === "") {
        if (recommended >= 0) return q.options[recommended]!.label;
        continue; // an open question needs an actual answer
      }
      const picked = Number(answer);
      if (Number.isInteger(picked) && picked >= 1 && picked <= q.options.length) {
        return q.options[picked - 1]!.label;
      }
      return answer;
    }
  }

  close(): void {
    this.rl.close();
  }
}
