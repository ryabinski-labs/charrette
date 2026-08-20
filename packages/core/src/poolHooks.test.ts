import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BASH_TIMEOUT_MS, bashHooks, sessionToolingMarkers } from "./pool.js";

const bash = (command: string, run_in_background?: boolean, timeout?: number) =>
  ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, ...(run_in_background === undefined ? {} : { run_in_background }), ...(timeout === undefined ? {} : { timeout }) },
  }) as unknown as HookInput;

const fireIn = async (worktree: string, index: number, input: HookInput) =>
  (await bashHooks(worktree)!.PreToolUse![0]!.hooks[index]!(input, undefined, { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> };
  };

const fire = (index: number, input: HookInput) => fireIn("", index, input);

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

  it("ignores a tool that is not Bash, and an event that is not PreToolUse", async () => {
    expect(await fire(2, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} } as unknown as HookInput)).toEqual({});
    expect(await fire(2, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {} } as unknown as HookInput)).toEqual({});
  });

  /**
   * Run da8325bd: a worker committed its whole deliverable into the primary
   * repository instead of its worktree. The branch the run merged and reported
   * on stayed empty, and nothing in the pipeline could see the difference.
   */
  describe("the worktree guard", () => {
    it("denies a git write aimed outside the session's worktree", async () => {
      const denial = await fireIn("/repo-wt/run1/task-a", 1, bash("git -C /repo commit -am wip"));
      expect(denial.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(denial.hookSpecificOutput?.permissionDecisionReason).toContain("/repo");
    });

    it("leaves reads and in-worktree writes alone", async () => {
      expect(await fireIn("/repo-wt/run1/task-a", 1, bash("git -C /repo log --oneline -20"))).toEqual({});
      expect(await fireIn("/repo-wt/run1/task-a", 1, bash("git commit -am 'real work'"))).toEqual({});
    });

    /**
     * Intake and planning run against the repository itself and commit nothing,
     * so they are given no boundary rather than one that would be wrong.
     */
    it("enforces nothing for a session with no worktree of its own", async () => {
      expect(await fire(1, bash("git -C /anywhere commit -am wip"))).toEqual({});
    });
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
      const denial = await fire(2, bash("npm test", true));
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
      const raised = await fire(2, bash("npm test", undefined, 120_000));
      expect(raised.hookSpecificOutput?.permissionDecision).toBe("allow");
      expect(raised.hookSpecificOutput?.updatedInput).toMatchObject({ command: "npm test", timeout: BASH_TIMEOUT_MS });
    });

    it("leaves a generous timeout as the agent wrote it", async () => {
      expect(await fire(2, bash("npm test", undefined, BASH_TIMEOUT_MS))).toEqual({});
    });

    it("leaves foreground commands alone, including a plain shell background job", async () => {
      // `&` inside one Bash call returns immediately, so it neither times out
      // nor registers a task — the recommended escape hatch, and untouched.
      expect(await fire(2, bash("npm test"))).toEqual({});
      expect(await fire(2, bash("npx tsx --test src/**/*.test.ts > /tmp/suite.log 2>&1 &"))).toEqual({});
    });
  });
});

/**
 * `settingSources: ["user"]` is what puts the operator's MCP servers inside
 * every agent session, and the teardown sweep is what kills them. These are the
 * two halves of run bc691359's false abandoned job: the sweep is right to kill
 * them, and wrong to call them the work the session left behind.
 */
describe("the tooling markers a session's sweep is given", () => {
  const home = () => realpathSync(mkdtempSync(path.join(tmpdir(), "harness-home-")));

  it("reads the servers the SDK will start from the config the SDK reads them from", () => {
    const dir = home();
    writeFileSync(
      path.join(dir, ".claude.json"),
      JSON.stringify({
        mcpServers: { "chrome-devtools": { type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] } },
        projects: { "/somewhere": { history: ["a"] } },
      })
    );

    expect(sessionToolingMarkers(undefined, dir)).toEqual(["chrome-devtools-mcp"]);
  });

  it("adds the servers the spec passed programmatically", () => {
    const dir = home();
    writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ mcpServers: {} }));

    expect(sessionToolingMarkers({ local: { command: "node", args: ["./tools/local-mcp.js"] } }, dir)).toEqual(["./tools/local-mcp.js"]);
  });

  it("treats a config with no servers in it as a config that declares nothing", () => {
    const dir = home();
    writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ projects: {} }));
    expect(sessionToolingMarkers(undefined, dir)).toEqual([]);
  });

  it("treats an unreadable config as a config that declares nothing", () => {
    // No file at all, and a file that is not JSON: both mean the sweep gets no
    // markers and reports everything it killed as work — the behaviour that
    // predates this, not a new failure mode.
    expect(sessionToolingMarkers(undefined, home())).toEqual([]);
    const broken = home();
    writeFileSync(path.join(broken, ".claude.json"), "{ not json");
    expect(sessionToolingMarkers(undefined, broken)).toEqual([]);
  });

  it("reads the config once per file", () => {
    const dir = home();
    writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ mcpServers: { a: { command: "npx", args: ["some-mcp-server"] } } }));
    expect(sessionToolingMarkers(undefined, dir)).toEqual(["some-mcp-server"]);

    // A third of a megabyte of project history sits in that file, and the sweep
    // runs at the end of every session; the second call must not re-read it.
    rmSync(path.join(dir, ".claude.json"));
    expect(sessionToolingMarkers(undefined, dir)).toEqual(["some-mcp-server"]);
  });
});
