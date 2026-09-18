/**
 * The operator's half of an escalation, written as steps rather than prose.
 *
 * Every gate that reaches a person today hands them a paragraph. The paragraph
 * is usually right — the advisor verified it — and it is still the wrong shape
 * for the job it is doing, because what the operator needs at 2am is not an
 * explanation, it is the command to type and the output to paste back. Run
 * 7ef8fb4d parked `api-deploy-and-live-endpoint-proof` on "this needs a real
 * deploy and a real magic-link token"; true, complete, and it left the operator
 * to work out for themselves which repository, which workflow, which account,
 * and what evidence would count as an answer.
 *
 * So an escalation that is genuinely the operator's carries a runbook: why they
 * are being asked, numbered steps with literal commands, and one sentence
 * naming what to send back. That last field is the one that closes the loop —
 * a gate answered with "done" teaches the worker nothing, and a gate answered
 * with the deploy's output lets it finish.
 *
 * Pure, and deliberately: the advisor writes the JSON, the controller renders
 * it, and whatever carries it to a person — the dashboard, a terminal, an email
 * — reads a string this file produced. Nothing here does I/O or knows about a
 * mailbox.
 */

import type { Runbook } from "@charrette/shared";

export type { Runbook };
type RunbookStep = Runbook["steps"][number];

/** Bounds, so a model that decides to write an essay cannot fill the gate. */
const MAX_STEPS = 12;
const MAX_DO = 300;
const MAX_COMMAND = 600;
const MAX_SENTENCE = 300;

const text = (v: unknown, limit: number): string => (typeof v === "string" ? v.trim().slice(0, limit) : "");

/**
 * Read the advisor's `runbook` field, tolerantly.
 *
 * Tolerantly because the alternative is dropping the whole runbook over a shape
 * detail, and the runbook is the part the operator actually needed. A step may
 * arrive as a bare string ("run the deploy workflow"), as `{do, command}`, or
 * as `{step, cmd}` — the field names models reach for when they have not read
 * the schema closely. All three mean the same thing.
 *
 * Null when there is no step worth showing. An empty runbook is worse than
 * none: it occupies the space where the prose recommendation would have gone
 * and says nothing.
 */
export function parseRunbook(value: unknown): Runbook | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { blocked?: unknown; steps?: unknown; sendBack?: unknown; send_back?: unknown };
  const steps: RunbookStep[] = [];
  for (const entry of Array.isArray(raw.steps) ? raw.steps : []) {
    if (steps.length === MAX_STEPS) break;
    if (typeof entry === "string") {
      const each = text(entry, MAX_DO);
      if (each) steps.push({ do: each });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const step = entry as { do?: unknown; step?: unknown; command?: unknown; cmd?: unknown };
    const what = text(step.do, MAX_DO) || text(step.step, MAX_DO);
    const command = text(step.command, MAX_COMMAND) || text(step.cmd, MAX_COMMAND);
    // A command with no prose is still a step — the command says what it does.
    if (!what && !command) continue;
    steps.push(command ? { do: what || command, command } : { do: what });
  }
  if (!steps.length) return null;
  return {
    blocked: text(raw.blocked, MAX_SENTENCE),
    steps,
    sendBack: text(raw.sendBack, MAX_SENTENCE) || text(raw.send_back, MAX_SENTENCE),
  };
}

/**
 * The runbook as the gate shows it, and as a terminal prints it.
 *
 * Indented commands rather than fenced ones: this string is read in a dashboard
 * panel, in a terminal prompt and in an email's plain-text part, and only one
 * of those three renders a fence. Indentation degrades to indentation
 * everywhere.
 */
export function renderRunbook(rb: Runbook | null): string {
  if (!rb) return "";
  const head = rb.blocked ? `This part is yours, not the agent's: ${rb.blocked}` : "This part is yours, not the agent's.";
  const body = rb.steps.map((s, i) => `${i + 1}. ${s.do}${s.command ? `\n\n       ${s.command}` : ""}`).join("\n");
  // Always says something. A runbook whose author forgot `sendBack` still needs
  // the operator to know the gate is waiting on a paste, not on a nod.
  const tail = rb.sendBack
    ? `Then answer this gate with: ${rb.sendBack}`
    : "Then answer this gate with what came back — the output, not just that it is done.";
  return `${head}\n\n${body}\n\n${tail}`;
}

/**
 * Fold the runbook into the answer the operator reads, above the advisor's
 * prose.
 *
 * Above, because the order is the whole point. The prose explains; the steps
 * are what gets done. An operator who reads the first paragraph and stops has
 * read the actionable half.
 */
export function withRunbook(recommendation: string, rb: Runbook | null): string {
  const block = renderRunbook(rb);
  if (!block) return recommendation;
  return recommendation ? `${block}\n\n---\n\n${recommendation}` : block;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type RunbookEmail = { subject: string; html: string; text: string };

/**
 * The same runbook as mail, for an operator who is not in front of the
 * dashboard.
 *
 * A gate is a run holding still. The dashboard shows it immediately and to
 * nobody in particular; mail reaches the one person who can end it. The link
 * back is not decoration — it is the only way the reply gets into the run,
 * because this file has no way to accept one.
 *
 * `project` is required by the mailbox this feeds: mail that does not name the
 * project it concerns is mail the recipient has to place before they can read
 * it.
 */
export function runbookEmail(project: string, taskTitle: string, rb: Runbook | null, gateUrl: string, prose = ""): RunbookEmail {
  const body = renderRunbook(rb);
  const subject = `${project}: ${taskTitle} needs you`;
  const steps = rb?.steps.length
    ? `<ol>${rb.steps
        .map(
          (s) =>
            `<li><p>${escapeHtml(s.do)}</p>${
              s.command ? `<pre style="background:#f4f4f5;padding:.6em .8em;border-radius:6px;overflow-x:auto"><code>${escapeHtml(s.command)}</code></pre>` : ""
            }</li>`
        )
        .join("")}</ol>`
    : "";
  const link = gateUrl ? `<p><a href="${escapeHtml(gateUrl)}">Answer the gate in the dashboard</a></p>` : "";
  const html =
    `<h2>${escapeHtml(project)} — ${escapeHtml(taskTitle)}</h2>` +
    `<p>${escapeHtml(rb?.blocked || "This task stopped on something an agent cannot do.")}</p>` +
    steps +
    `<p><strong>Send back:</strong> ${escapeHtml(rb?.sendBack || "the output of the steps above, not just that they are done")}</p>` +
    link +
    // The prose goes last and only in mail: on the dashboard the operator can
    // scroll to it, and in mail the steps have to survive a phone screen.
    (prose ? `<hr><p style="white-space:pre-wrap">${escapeHtml(prose)}</p>` : "");
  const plain = [`${project} — ${taskTitle}`, "", body || "This task stopped on something an agent cannot do.", gateUrl ? `\nAnswer the gate: ${gateUrl}` : "", prose ? `\n---\n${prose}` : ""]
    .join("\n")
    .trim();
  return { subject, html, text: plain };
}
