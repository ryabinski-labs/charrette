import { execFile } from "node:child_process";
import type { HookInput, HookJSONOutput, Options } from "@anthropic-ai/claude-agent-sdk";
import { onPath } from "./toolbelt.js";

/**
 * rtk — a token-compressing CLI proxy some operators run (`rtk git status`
 * returns the same facts as `git status` in a fraction of the tokens). The
 * operator's own Claude Code sessions route every Bash command through it via
 * a `rtk hook claude` PreToolUse hook and pay 60–90% less for git, grep and
 * test-runner output. Agents get none of that: they run with
 * `settingSources: []` precisely so operator settings don't leak into their
 * context, which also strips this hook — so their tool output ships raw.
 *
 * This module gives agents the same deal without giving them the settings.
 * When an rtk binary is on PATH, each agent Bash command is offered to
 * `rtk hook claude` — the exact stdin/stdout contract Claude Code itself
 * uses — and whatever rewrite it answers is applied. rtk owns the decision
 * of what it can compress; commands it doesn't know come back untouched.
 *
 * rtk being absent, slow or broken must never cost an agent its command:
 * every failure path means "run it as written". `HARNESS_RTK=off` disables
 * the whole thing.
 */

/** Runs `rtk hook claude` (or a stand-in) over one hook-input JSON payload. */
export type RtkRunner = (hookInputJson: string, signal?: AbortSignal) => Promise<string>;

/** rtk answers in milliseconds; a hang this long means it's broken — skip it. */
const RTK_TIMEOUT_MS = 5000;

function execRtkHook(rtkPath: string): RtkRunner {
  return (json, signal) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        rtkPath,
        ["hook", "claude"],
        { timeout: RTK_TIMEOUT_MS, signal, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      );
      // A dead child EPIPEs the write; the exec callback already reports it.
      child.stdin?.on("error", () => {});
      child.stdin?.end(json);
    });
}

/** The hook callback: ask rtk, apply its rewrite, swallow its failures. */
export function rtkBashRewriter(run: RtkRunner) {
  return async (input: HookInput, _toolUseID: string | undefined, opts: { signal: AbortSignal }): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
    const original = input.tool_input as { command?: unknown };
    if (typeof original?.command !== "string" || original.command.trim() === "") return {};
    try {
      const raw = await run(JSON.stringify(input), opts?.signal);
      const out = JSON.parse(raw) as { hookSpecificOutput?: { hookEventName?: string; updatedInput?: { command?: unknown } } };
      if (out?.hookSpecificOutput?.hookEventName !== "PreToolUse") return {};
      const rewritten = out.hookSpecificOutput.updatedInput?.command;
      if (typeof rewritten !== "string" || rewritten === "" || rewritten === original.command) return {};
      // rtk's updatedInput carries only `command`; merging over the original
      // keeps the agent's description/timeout instead of dropping them.
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecisionReason: "rtk rewrite",
          updatedInput: { ...(input.tool_input as Record<string, unknown>), command: rewritten },
        },
      };
    } catch {
      return {};
    }
  };
}

/**
 * The PreToolUse hooks an agent session should run with: the rtk rewriter
 * when rtk is on PATH and not switched off, otherwise nothing.
 */
export function rtkHooks(env: NodeJS.ProcessEnv = process.env, run?: RtkRunner): Options["hooks"] | undefined {
  if (/^(off|0|false)$/i.test(env.HARNESS_RTK ?? "")) return undefined;
  const rtkPath = run ? null : onPath("rtk", env.PATH ?? "");
  if (!rtkPath && !run) return undefined;
  return { PreToolUse: [{ matcher: "Bash", hooks: [rtkBashRewriter(run ?? execRtkHook(rtkPath!))] }] };
}
