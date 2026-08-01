import { z } from "zod";

/**
 * A question the intake agent puts to the operator. Options are advisory: the
 * operator may always answer in free text, and exactly one option should carry
 * `recommended` so a fast `enter` is a real choice rather than a coin flip.
 */
export const IntakeOption = z.object({
  label: z.string(),
  description: z.string().default(""),
  recommended: z.boolean().default(false),
});
export type IntakeOption = z.infer<typeof IntakeOption>;

export const IntakeQuestion = z.object({
  question: z.string(),
  /** What the agent found in the repo that makes this question worth asking. */
  detail: z.string().default(""),
  options: z.array(IntakeOption).default([]),
});
export type IntakeQuestion = z.infer<typeof IntakeQuestion>;

/**
 * The product of the intake conversation: the assignment the planner actually
 * receives. Every decision is recorded with the operator's answer so the plan
 * (and later, the PRs) can be traced back to a human choice.
 */
export const Brief = z.object({
  goal: z.string(),
  context: z.string().default(""),
  decisions: z
    .array(
      z.object({
        question: z.string(),
        answer: z.string(),
        rationale: z.string().default(""),
      })
    )
    .default([]),
  constraints: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
});
export type Brief = z.infer<typeof Brief>;

/** Render a brief as the markdown assignment handed to the planner. */
export function briefToAssignment(brief: Brief): string {
  const section = (title: string, items: string[]): string =>
    items.length ? `\n## ${title}\n${items.map((i) => `- ${i}`).join("\n")}\n` : "";
  return (
    `# ${brief.goal}\n` +
    (brief.context ? `\n${brief.context}\n` : "") +
    section(
      "Decisions already made with the operator (treat as settled)",
      brief.decisions.map((d) => `${d.question} → **${d.answer}**${d.rationale ? ` (${d.rationale})` : ""}`)
    ) +
    section("Constraints", brief.constraints) +
    section("Explicitly out of scope", brief.outOfScope) +
    section("Open questions (decide sensibly and note the choice in the PRD)", brief.openQuestions)
  ).trimEnd();
}
