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
 * every failure path means "run it as written". `CHARRETTE_RTK=off` disables
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
      //
      // Not covered, and deliberately not chased: firing this handler needs a
      // child that dies between `execFile` returning and the write landing,
      // which is a race no test can ask for without becoming one itself. The
      // handler exists so that race cannot become an unhandled 'error' event.
      /* v8 ignore start */
      child.stdin?.on("error", () => {});
      /* v8 ignore stop */
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
 * How to reach rtk, or undefined when it is switched off or not installed.
 * Both transports gate on this one answer so neither can be quietly rtk-less
 * while the other is not.
 */
function rtkRunner(env: NodeJS.ProcessEnv, run?: RtkRunner): RtkRunner | undefined {
  if (/^(off|0|false)$/i.test(env.CHARRETTE_RTK ?? "")) return undefined;
  if (run) return run;
  const rtkPath = onPath("rtk", env.PATH ?? "");
  return rtkPath ? execRtkHook(rtkPath) : undefined;
}

/**
 * The PreToolUse hooks an agent session should run with: the rtk rewriter
 * when rtk is on PATH and not switched off, otherwise nothing.
 */
export function rtkHooks(env: NodeJS.ProcessEnv = process.env, run?: RtkRunner): Options["hooks"] | undefined {
  const runner = rtkRunner(env, run);
  if (!runner) return undefined;
  return { PreToolUse: [{ matcher: "Bash", hooks: [rtkBashRewriter(runner)] }] };
}

/**
 * The same rewrite, for the transports that have no SDK hook to hang it on.
 *
 * Agents on OpenAI or Google run their tool loop inside the charrette (toolLoop.ts),
 * so there is no PreToolUse plumbing to register with — but there is no reason
 * they should pay full price for `git log` when Anthropic sessions do not. This
 * asks rtk exactly the same question through exactly the same rewriter, and
 * answers with the original command whenever rtk declines, fails, or is absent.
 */
export function rtkCommandRewriter(
  env: NodeJS.ProcessEnv = process.env,
  run?: RtkRunner
): ((command: string, signal?: AbortSignal) => Promise<string>) | undefined {
  const runner = rtkRunner(env, run);
  if (!runner) return undefined;
  const rewrite = rtkBashRewriter(runner);
  return async (command, signal) => {
    const out = await rewrite(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } } as unknown as HookInput,
      undefined,
      { signal: signal ?? new AbortController().signal }
    );
    const updated = (out as { hookSpecificOutput?: { updatedInput?: { command?: unknown } } })?.hookSpecificOutput?.updatedInput?.command;
    return typeof updated === "string" ? updated : command;
  };
}
