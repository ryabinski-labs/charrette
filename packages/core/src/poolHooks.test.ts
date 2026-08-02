import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { BASH_TIMEOUT_MS, bashHooks } from "./pool.js";

const bash = (command: string, run_in_background?: boolean, timeout?: number) =>
  ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, ...(run_in_background === undefined ? {} : { run_in_background }), ...(timeout === undefined ? {} : { timeout }) },
  }) as unknown as HookInput;

const fire = async (index: number, input: HookInput) =>
  (await bashHooks()!.PreToolUse![0]!.hooks[index]!(input, undefined, { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> };
  };

/**
 * Agents run with `permissionMode: "bypassPermissions"`, so there is no prompt
 * between a command an agent writes and the machine running it. The infra guard
 * is the only thing in that gap, and a guard that is correct but unregistered
 * protects nothing — so this tests the wiring, not the matching.
 */
describe("the hooks every agent session runs with", () => {
  it("registers the infra guard on Bash, first", () => {
    const hooks = bashHooks()!;
    const pre = hooks.PreToolUse!;
    expect(pre.length).toBeGreaterThanOrEqual(1);
    expect(pre[0]!.matcher).toBe("Bash");
  });

  it("denies an apply through the registered hook, whether or not rtk is installed", async () => {
    // rtk is optional and absent on most machines. The guard is not: it is
    // prepended unconditionally rather than added to rtk's list, so it cannot
    // go missing on the machines where nobody is watching.
    expect((await fire(0, bash("terraform destroy -auto-approve"))).hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(await fire(0, bash("terraform plan"))).toEqual({});
  });

  /**
   * Run 40da9337: the CLI announces a finished background task by queueing it
   * as a `task-notification`, and the streaming-input loop the harness runs in —
   * held open so the operator can speak mid-flight — throws on any queued
   * command that is not a prompt. 8 of the 21 sessions that ended up with a
   * tracked background task died on it; 0 of the 138 without one. The kill
   * fires whenever the command exits, so it lands nowhere near the call that
   * armed it.
   */
  describe("the background-shell guard", () => {
    it("denies run_in_background and names a form that is safe", async () => {
      const denial = await fire(1, bash("npm test", true));
      expect(denial.hookSpecificOutput?.permissionDecision).toBe("deny");
      // The refusal has to be worth obeying: an agent told only "no" reaches for
      // the same tool again with a different command.
      expect(denial.hookSpecificOutput?.permissionDecisionReason).toContain("> /tmp/out.log 2>&1 &");
    });

    /**
     * The flag is the door nobody used. Across all 4357 Bash calls in 40da9337
     * not one set `run_in_background` — every death came through the timeout,
     * which the CLI resolves by backgrounding rather than killing. An explicit
     * `timeout` overrides the env default, so it has to be raised here too or
     * the agent re-opens the door by asking for a two-minute limit.
     */
    it("raises a short explicit timeout instead of letting it background the command", async () => {
      const raised = await fire(1, bash("npm test", undefined, 120_000));
      expect(raised.hookSpecificOutput?.permissionDecision).toBe("allow");
      expect(raised.hookSpecificOutput?.updatedInput).toMatchObject({ command: "npm test", timeout: BASH_TIMEOUT_MS });
    });

    it("leaves a generous timeout as the agent wrote it", async () => {
      expect(await fire(1, bash("npm test", undefined, BASH_TIMEOUT_MS))).toEqual({});
    });

    it("leaves foreground commands alone, including a plain shell background job", async () => {
      // `&` inside one Bash call returns immediately, so it neither times out
      // nor registers a task — the recommended escape hatch, and untouched.
      expect(await fire(1, bash("npm test"))).toEqual({});
      expect(await fire(1, bash("npx tsx --test src/**/*.test.ts > /tmp/suite.log 2>&1 &"))).toEqual({});
    });
  });
});
