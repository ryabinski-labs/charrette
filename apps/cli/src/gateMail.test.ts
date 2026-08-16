import { describe, expect, it, vi } from "vitest";
import type { Bus } from "@harness/core";
import { agentdraftScript, mailBanner, mailTarget, watchGateMail, type MailTarget, type Send } from "./gateMail.js";

const env = { HOME: "/Users/someone" };
const AGENTDRAFT = "/Users/someone/.claude/skills/agentdraft-email/scripts/agentdraft_email.py";

describe("where gate mail goes", () => {
  it("finds the agentdraft skill under HOME, and tolerates having none", () => {
    expect(agentdraftScript(env)).toBe(AGENTDRAFT);
    expect(agentdraftScript({})).toBe(".claude/skills/agentdraft-email/scripts/agentdraft_email.py");
  });

  it("goes nowhere until an address is named", () => {
    expect(mailTarget(env, () => true)).toBeNull();
    expect(mailTarget({ ...env, HARNESS_GATE_EMAIL: "   " }, () => true)).toBeNull();
  });

  it("uses the agentdraft skill when it is installed", () => {
    expect(mailTarget({ ...env, HARNESS_GATE_EMAIL: " you@example.com " }, (p) => p === AGENTDRAFT)).toEqual({
      to: "you@example.com",
      cmd: "python3",
      args: [AGENTDRAFT],
    });
  });

  it("announces itself in the banner only when it is on", () => {
    expect(mailBanner(null)).toEqual([]);
    expect(mailBanner({ to: "you@example.com", cmd: "x", args: [] })).toEqual([
      "gate mail  you@example.com   (gates only you can answer; HARNESS_GATE_EMAIL)",
    ]);
  });

  /**
   * Silently, not loudly: an operator who named an address and has no sender
   * has switched on a feature that cannot work, and a warning on every run of
   * a feature nobody uses is worse than the missing mail.
   */
  it("goes nowhere when no sender is installed", () => {
    expect(mailTarget({ ...env, HARNESS_GATE_EMAIL: "you@example.com" }, () => false)).toBeNull();
  });

  it("splits an explicit command so an interpreter and its script both fit in one variable", () => {
    expect(mailTarget({ ...env, HARNESS_GATE_EMAIL: "you@example.com", HARNESS_GATE_MAIL_CMD: "  python3   /opt/send.py --quiet " }, () => false)).toEqual({
      to: "you@example.com",
      cmd: "python3",
      args: ["/opt/send.py", "--quiet"],
    });
  });
});

/** A bus that is only its subscribe half, which is all this watcher touches. */
function fakeBus(): { bus: Bus; emit: (event: unknown) => void; unsubscribed: () => boolean } {
  const listeners: ((e: { seq: number; event: never }) => void)[] = [];
  let off = false;
  const bus = {
    subscribe(fn: (e: { seq: number; event: never }) => void) {
      listeners.push(fn);
      return () => {
        off = true;
      };
    },
  } as unknown as Bus;
  return { bus, emit: (event) => listeners.forEach((l) => l({ seq: 1, event: event as never })), unsubscribed: () => off };
}

const gate = (runbook: unknown) => ({
  type: "task.gate_opened",
  runId: "r1",
  taskId: "api-deploy-and-live-endpoint-proof",
  why: "QA cannot reach a deployed host",
  iterations: 3,
  recommendation: "…",
  runbook,
  ts: 1,
});

const RUNBOOK = { blocked: "it needs a real deploy", steps: [{ do: "merge it", command: "gh pr merge 1631" }], sendBack: "the status code" };

describe("mailing the operator when a run stops on them", () => {
  it("sends the runbook, the project and the link back to the gate", () => {
    const send = vi.fn<Send>();
    const { bus, emit } = fakeBus();
    const target: MailTarget = { to: "you@example.com", cmd: "python3", args: ["/s.py"] };
    watchGateMail(bus, { project: "api-service-new-api", url: "http://127.0.0.1:4781/#tok", target, send });
    emit(gate(RUNBOOK));
    expect(send).toHaveBeenCalledTimes(1);
    const [sentTo, mail] = send.mock.calls[0]!;
    expect(sentTo).toBe(target);
    expect(mail.subject).toBe("api-service-new-api: api-deploy-and-live-endpoint-proof needs you");
    expect(mail.html).toContain("gh pr merge 1631");
    expect(mail.html).toContain("http://127.0.0.1:4781/#tok");
    // The escalation's own text rides along, because the steps are an answer to
    // a question the operator has not been told yet.
    expect(mail.html).toContain("QA cannot reach a deployed host");
  });

  /**
   * The reason this channel is worth having switched on. Most escalations are
   * ordinary ones a worker acts on alone, and a channel that fires on all of
   * them is one the operator turns off.
   */
  it("says nothing about a gate that carries no runbook", () => {
    const send = vi.fn<Send>();
    const { bus, emit } = fakeBus();
    watchGateMail(bus, { project: "p", url: "", target: { to: "a@b.c", cmd: "x", args: [] }, send });
    emit(gate(null));
    emit(gate(undefined));
    emit({ type: "task.state_changed", runId: "r1", taskId: "t", from: "WORKING", to: "MERGED", reason: "", ts: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it("subscribes to nothing when there is nowhere to send", () => {
    const send = vi.fn<Send>();
    const { bus, emit, unsubscribed } = fakeBus();
    const stop = watchGateMail(bus, { project: "p", url: "", target: null, send });
    emit(gate(RUNBOOK));
    expect(send).not.toHaveBeenCalled();
    stop();
    expect(unsubscribed()).toBe(false);
  });

  it("hands back the unsubscribe, so a finished run stops watching", () => {
    const { bus, unsubscribed } = fakeBus();
    const stop = watchGateMail(bus, { project: "p", url: "", target: { to: "a@b.c", cmd: "x", args: [] }, send: vi.fn() });
    expect(unsubscribed()).toBe(false);
    stop();
    expect(unsubscribed()).toBe(true);
  });
});

describe("the default sender", () => {
  it("calls the configured command with the agentdraft send contract, and is what a caller gets by default", async () => {
    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile }));
    vi.resetModules();
    const mod = await import("./gateMail.js");
    mod.sendMail({ to: "you@example.com", cmd: "python3", args: ["/s.py"] }, { subject: "s", html: "<p>h</p>", text: "t" });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFile.mock.calls[0]!;
    expect(cmd).toBe("python3");
    expect(args.slice(0, 5)).toEqual(["/s.py", "send", "--to", "you@example.com", "--subject"]);
    expect(JSON.parse(args[args.length - 1])).toEqual({ body_html: "<p>h</p>", body_text: "t" });

    // Omitting `send` reaches that same sender rather than nothing — the wiring
    // the CLI actually uses.
    const { bus, emit } = fakeBus();
    mod.watchGateMail(bus, { project: "p", url: "", target: { to: "a@b.c", cmd: "echo", args: [] } });
    emit(gate(RUNBOOK));
    expect(execFile).toHaveBeenCalledTimes(2);
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });
});
