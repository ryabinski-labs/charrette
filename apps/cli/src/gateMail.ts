import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { runbookEmail, type Bus, type RunbookEmail } from "@harness/core";

/**
 * Mail the operator when a run stops on something only they can do.
 *
 * The dashboard already shows an open gate, immediately and to nobody in
 * particular: it is a page that has to be open, on the machine the run is on,
 * with somebody looking at it. Runs escalate at 2am and on weekends, and the
 * gap between "the run is waiting" and "the person who can end it finds out"
 * has been measured in whole days.
 *
 * So a gate that carries a runbook — one an agent declared it cannot do itself
 * — is also sent as mail, with the steps laid out and a link back to the gate
 * the reply goes into. Gates without a runbook are not mailed: those are the
 * ordinary ones a worker can act on, they are the large majority, and a channel
 * that fires on all of them is a channel the operator turns off.
 *
 * Everything here is best-effort and off by default. It is configured by
 * environment rather than by run config on purpose: the recipient is a property
 * of the person running the harness, not of the run, and a run config is
 * recorded in the database and copied into pull requests.
 *
 *   HARNESS_GATE_EMAIL      where to send. Unset — the default — sends nothing.
 *   HARNESS_GATE_MAIL_CMD   the sender. Defaults to the agentdraft-email skill's
 *                           script when it is installed.
 *
 * The sender is invoked as `<cmd> send --to <addr> --subject <s> --raw-json <j>`
 * — the agentdraft contract — and its exit status is ignored. A missing
 * mailbox, an expired key or no network may not fail a run that is otherwise
 * fine; the gate is still open on the dashboard either way, which is the
 * channel this one is redundant with by design.
 */

export type MailTarget = { to: string; cmd: string; args: string[] };

/** Where the agentdraft-email skill puts its sender, for the operator who installed it. */
export function agentdraftScript(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME || "", ".claude/skills/agentdraft-email/scripts/agentdraft_email.py");
}

/**
 * Where gate mail goes, or null when it goes nowhere.
 *
 * Null is the normal answer. An operator who has not asked for mail gets none,
 * and an operator who named an address but has no sender installed gets none
 * either — silently, because the alternative is a warning on every run from a
 * feature nobody switched on.
 */
export function mailTarget(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): MailTarget | null {
  const to = (env.HARNESS_GATE_EMAIL ?? "").trim();
  if (!to) return null;
  const explicit = (env.HARNESS_GATE_MAIL_CMD ?? "").trim();
  if (explicit) {
    // Split on whitespace so an interpreter and its script both fit in one
    // variable — `python3 /path/to/sender.py` is the shape people reach for.
    const [cmd, ...args] = explicit.split(/\s+/);
    return { to, cmd: cmd!, args };
  }
  const script = agentdraftScript(env);
  return exists(script) ? { to, cmd: "python3", args: [script] } : null;
}

/**
 * The banner line, or nothing. A list rather than a string so the caller has no
 * branch of its own: a channel that reaches somebody has to be visible to the
 * person it reaches from, and silence reads identically whether the address is
 * set or not.
 */
export function mailBanner(target: MailTarget | null): string[] {
  return target ? [`gate mail  ${target.to}   (gates only you can answer; HARNESS_GATE_EMAIL)`] : [];
}

export type Send = (target: MailTarget, mail: RunbookEmail) => void;

/** The default sender: the agentdraft CLI, fired and forgotten. */
export const sendMail: Send = (target, mail) => {
  execFile(
    target.cmd,
    [...target.args, "send", "--to", target.to, "--subject", mail.subject, "--raw-json", JSON.stringify({ body_html: mail.html, body_text: mail.text })],
    () => undefined
  );
};

/**
 * Subscribe for the life of a run. Returns the unsubscribe.
 *
 * `url` is the dashboard's, token fragment and all, so the link in the mail
 * lands on the gate rather than on a login. That is the reply path: this
 * channel sends, it does not receive, and the operator's answer — the output
 * they were asked to paste — goes back through the gate the link opens.
 */
export function watchGateMail(bus: Bus, opts: { project: string; url: string; target: MailTarget | null; send?: Send }): () => void {
  const { target } = opts;
  if (!target) return () => undefined;
  const send: Send = opts.send ?? sendMail;
  return bus.subscribe(({ event }) => {
    if (event.type !== "task.gate_opened" || !event.runbook) return;
    send(target, runbookEmail(opts.project, event.taskId, event.runbook, opts.url, event.why));
  });
}
