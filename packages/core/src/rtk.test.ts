import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { rtkBashRewriter, rtkCommandRewriter, rtkHooks } from "./rtk.js";

const bash = (command: string): HookInput =>
  ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "list files", timeout: 9000 },
    tool_use_id: "t1",
    session_id: "s",
    transcript_path: "/tmp/t",
    cwd: "/tmp",
  }) as HookInput;

const opts = { signal: new AbortController().signal };

/** What `rtk hook claude` actually prints for a command it rewrites. */
const rtkSays = (command: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecisionReason: "RTK auto-rewrite", updatedInput: { command } } });

describe("rtkBashRewriter", () => {
  it("applies rtk's rewrite while keeping the rest of the tool input", async () => {
    const sent: string[] = [];
    const hook = rtkBashRewriter(async (json) => {
      sent.push(json);
      return rtkSays("rtk git status");
    });
    const out = await hook(bash("git status"), "t1", opts);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecisionReason: "rtk rewrite",
        updatedInput: { command: "rtk git status", description: "list files", timeout: 9000 },
      },
    });
    // rtk received the same hook-input contract Claude Code sends it.
    expect((JSON.parse(sent[0]!) as { tool_input: { command: string } }).tool_input.command).toBe("git status");
  });

  it("never touches anything that is not a Bash command", async () => {
    const hook = rtkBashRewriter(async () => {
      throw new Error("must not be consulted");
    });
    expect(await hook({ ...bash("x"), tool_name: "Read" } as HookInput, "t1", opts)).toEqual({});
    expect(await hook({ ...bash("x"), hook_event_name: "PostToolUse" } as unknown as HookInput, "t1", opts)).toEqual({});
    expect(await hook(bash("   "), "t1", opts)).toEqual({});
  });

  it("a broken rtk means the command runs as written", async () => {
    const dead = rtkBashRewriter(async () => {
      throw new Error("rtk exploded");
    });
    expect(await dead(bash("git status"), "t1", opts)).toEqual({});
    const garbled = rtkBashRewriter(async () => "not json at all");
    expect(await garbled(bash("git status"), "t1", opts)).toEqual({});
  });

  it("a no-op answer from rtk produces no rewrite", async () => {
    const same = rtkBashRewriter(async () => rtkSays("git status"));
    expect(await same(bash("git status"), "t1", opts)).toEqual({});
    const silent = rtkBashRewriter(async () => "{}");
    expect(await silent(bash("git status"), "t1", opts)).toEqual({});
  });
});

describe("rtkHooks", () => {
  it("is off without an rtk on PATH, and off on demand", () => {
    expect(rtkHooks({ PATH: "/definitely/not/a/dir" })).toBeUndefined();
    expect(rtkHooks({ CHARRETTE_RTK: "off" }, async () => "{}")).toBeUndefined();
  });

  it("hooks Bash when a runner exists", () => {
    const hooks = rtkHooks({}, async () => "{}");
    expect(hooks?.PreToolUse).toEqual([{ matcher: "Bash", hooks: [expect.any(Function)] }]);
  });
});

describe("rtkCommandRewriter — the same deal for transports with no SDK hook", () => {
  it("is off under exactly the same conditions as the hook", () => {
    // Agents on OpenAI or Gemini must not end up quietly rtk-less, or quietly
    // rtk-ful when the operator switched it off, just because they take a
    // different code path to the same shell.
    expect(rtkCommandRewriter({ PATH: "/definitely/not/a/dir" })).toBeUndefined();
    expect(rtkCommandRewriter({ CHARRETTE_RTK: "off" }, async () => "{}")).toBeUndefined();
  });

  it("returns rtk's rewrite for a command it knows", async () => {
    const rewrite = rtkCommandRewriter({}, async () => rtkSays("rtk git status"))!;
    expect(await rewrite("git status")).toBe("rtk git status");
  });

  it("returns the original when rtk declines to rewrite it", async () => {
    const rewrite = rtkCommandRewriter({}, async () => "{}")!;
    expect(await rewrite("npm test")).toBe("npm test");
  });

  it("returns the original when rtk fails, because a broken rtk must not cost a command", async () => {
    const rewrite = rtkCommandRewriter({}, async () => {
      throw new Error("rtk is not installed after all");
    })!;
    expect(await rewrite("npm test")).toBe("npm test");
  });

  it("passes the caller's abort signal through", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const rewrite = rtkCommandRewriter({}, async (_json, signal) => {
      signals.push(signal);
      return "{}";
    })!;
    const controller = new AbortController();
    await rewrite("git log", controller.signal);
    expect(signals[0]).toBe(controller.signal);
    // And works without one.
    await rewrite("git log");
    expect(signals[1]).toBeInstanceOf(AbortSignal);
  });
});
