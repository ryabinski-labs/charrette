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

/**
 * Terminal transport for the intake conversation (the `IntakeUi` core expects).
 * Questions render as a numbered list with the recommendation marked; the
 * operator may pick a number, press enter to take the recommendation, or type
 * anything else as a free-text answer.
 */
export class TerminalChat implements IntakeUi {
  constructor(private rl: Prompter = createInterface({ input: process.stdin, output: process.stdout })) {}

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

  say(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    process.stdout.write(`\n${green("●")} ${wrap(trimmed, "  ")}\n`);
  }

  async ask(q: IntakeQuestion): Promise<string> {
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
      const answer = (await this.rl.question(cyan("> "))).trim();
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
