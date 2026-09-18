import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLS, exitCode, globToRegExp, runBash, toolsFor, unsupportedTools, type ExecFn, type ToolContext } from "./agentTools.js";

// The skip-on-error branches used to be exercised by chmod'ing files
// unreadable — which is a no-op for root, and CI's self-hosted runners run as
// root. Poisoning the one path here fails the same calls on any uid.
// Per-operation, because Grep stats every file before reading it: poisoning
// both calls for one path would drop the file during the walk and leave the
// read-failure branch unexercised.
const poison = vi.hoisted(() => ({ stat: null as string | null, read: null as string | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const denied = () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }));
  return {
    ...real,
    stat: (p: Parameters<typeof real.stat>[0], ...rest: unknown[]) =>
      poison.stat !== null && String(p).endsWith(poison.stat) ? denied() : (real.stat as Function)(p, ...rest),
    readFile: (p: Parameters<typeof real.readFile>[0], ...rest: unknown[]) =>
      poison.read !== null && String(p).endsWith(poison.read) ? denied() : (real.readFile as Function)(p, ...rest),
  };
});

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

let dir: string;
let ctx: ToolContext;
let ran: string[];

/** A shell that records what it was asked to run instead of running it. */
const recordingExec = (log: string[], stdout = "ok"): ExecFn => {
  return async (command) => {
    log.push(command);
    return { stdout, stderr: "", code: 0 };
  };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "charrette-tools-"));
  ran = [];
  ctx = { cwd: dir, env: {}, signal: new AbortController().signal, exec: recordingExec(ran) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the infrastructure guard on the non-Anthropic path", () => {
  // This is the reason agentTools.ts exists. The guard used to be a Claude
  // Agent SDK PreToolUse hook, and agents run under bypassPermissions — so an
  // OpenAI or Gemini agent reaching a shell through a thinner adapter would
  // have had no guard at all, and nothing would have said so.
  it("refuses an apply and never reaches the shell", async () => {
    const out = await runBash("terraform apply -auto-approve", ctx);
    expect(out).toContain("changes real infrastructure");
    expect(out).toContain("terraform validate");
    expect(ran).toEqual([]);
  });

  it("refuses the same command however it is wrapped, exactly as the hook does", async () => {
    for (const command of [
      "cd infra && terraform apply",
      'bash -c "terraform destroy"',
      "timeout 600 terraform apply",
      "kubectl delete deployment api",
      "aws s3 rm s3://prod-bucket/data",
    ]) {
      ran.length = 0;
      expect(await runBash(command, ctx)).toContain("Blocked:");
      expect(ran).toEqual([]);
    }
  });

  it("lets the verifying commands through, because they are how the work gets checked", async () => {
    for (const command of ["terraform plan", "cdk synth", "helm template ./chart", "kubectl apply --dry-run=server -f x.yaml"]) {
      ran.length = 0;
      await runBash(command, ctx);
      expect(ran).toEqual([command]);
    }
  });

  it("tells the caller what was refused, so a denial can reach the operator", async () => {
    const onDenied = vi.fn();
    await runBash("pulumi up", { ...ctx, onDenied });
    expect(onDenied).toHaveBeenCalledWith("Bash", expect.stringContaining("pulumi preview"));
  });

  it("judges the command the agent wrote, before rtk rewrites it", async () => {
    // rtk rewrites a command into a form the matcher would no longer recognise.
    // If the guard ran second, the rewrite would be its input — so it runs first.
    const rewrite = vi.fn(async () => "rtk terraform apply");
    const out = await runBash("terraform apply", { ...ctx, rewrite });
    expect(out).toContain("Blocked:");
    expect(rewrite).not.toHaveBeenCalled();
    expect(ran).toEqual([]);
  });
});

describe("running a shell command", () => {
  it("passes an allowed command through rtk when it is installed", async () => {
    await runBash("git status", { ...ctx, rewrite: async () => "rtk git status" });
    expect(ran).toEqual(["rtk git status"]);
  });

  it("runs the original when rtk fails, because a broken rtk must not cost a command", async () => {
    await runBash("git status", {
      ...ctx,
      rewrite: async () => {
        throw new Error("rtk exploded");
      },
    });
    expect(ran).toEqual(["git status"]);
  });

  it("reports stderr and a non-zero exit, which is how an agent learns a build failed", async () => {
    const out = await runBash("npm test", {
      ...ctx,
      exec: async () => ({ stdout: "1 passing", stderr: "1 failing", code: 1 }),
    });
    expect(out).toContain("1 passing");
    expect(out).toContain("[stderr]\n1 failing");
    expect(out).toContain("[exit 1]");
  });

  it("says so rather than returning nothing when a command is silent", async () => {
    expect(await runBash("true", { ...ctx, exec: async () => ({ stdout: "", stderr: "", code: 0 }) })).toBe("(no output)");
  });

  it("refuses an empty command instead of invoking a shell with nothing", async () => {
    expect(await runBash("   ", ctx)).toBe("error: no command given");
    expect(await runBash(undefined as unknown as string, ctx)).toBe("error: no command given");
    expect(ran).toEqual([]);
  });

  it("truncates a runaway result rather than letting it eat the context window", async () => {
    const out = await runBash("cat huge.log", { ...ctx, exec: async () => ({ stdout: "x".repeat(40_000), stderr: "", code: 0 }) });
    expect(out.length).toBeLessThan(31_000);
    expect(out).toContain("truncated");
  });

  it("uses a real shell when no exec is injected", async () => {
    const out = await runBash("echo hello-from-a-real-shell", { cwd: dir, env: { PATH: process.env.PATH ?? "" }, signal: new AbortController().signal });
    expect(out).toContain("hello-from-a-real-shell");
  });

  it("surfaces a real failing command's exit code", async () => {
    const out = await runBash("exit 3", { cwd: dir, env: { PATH: process.env.PATH ?? "" }, signal: new AbortController().signal });
    expect(out).toContain("[exit 3]");
  });

  it("does not report a killed command as a success", async () => {
    // A command killed by a signal has no numeric exit code. Calling that 0
    // would tell an agent its test suite passed when the runner was killed.
    expect(exitCode(undefined)).toBe(0);
    expect(exitCode(null)).toBe(0);
    expect(exitCode({ code: 137 })).toBe(137);
    expect(exitCode({ signal: "SIGKILL" })).toBe(1);
    expect(exitCode({ code: "ENOENT" })).toBe(1);
  });

  it("is reachable as a tool, not only as a function", async () => {
    await tool("Bash").run({ command: "ls" }, ctx);
    expect(ran).toEqual(["ls"]);
    // And the tool refuses what the function refuses.
    expect(await tool("Bash").run({ command: "terraform apply" }, ctx)).toContain("Blocked:");
  });
});

describe("reading and writing files", () => {
  it("reads a file back with line numbers", async () => {
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree");
    const out = await tool("Read").run({ file_path: "a.txt" }, ctx);
    expect(out).toContain("1\tone");
    expect(out).toContain("3\tthree");
  });

  it("reads a window of a large file", async () => {
    writeFileSync(join(dir, "a.txt"), Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
    const out = await tool("Read").run({ file_path: "a.txt", offset: 10, limit: 2 }, ctx);
    expect(out).toContain("line 10");
    expect(out).toContain("line 11");
    expect(out).not.toContain("line 12");
  });

  it("says the offset is past the end rather than returning an empty result", async () => {
    writeFileSync(join(dir, "a.txt"), "only one line");
    expect(await tool("Read").run({ file_path: "a.txt", offset: 99 }, ctx)).toContain("the file has 1");
  });

  it("truncates an enormous file", async () => {
    writeFileSync(join(dir, "big.txt"), "y".repeat(60_000));
    expect(await tool("Read").run({ file_path: "big.txt" }, ctx)).toContain("truncated");
  });

  it("writes a file and creates the directories above it", async () => {
    expect(await tool("Write").run({ file_path: "src/deep/new.ts", content: "export const x = 1;" }, ctx)).toContain("wrote");
    expect(readFileSync(join(dir, "src/deep/new.ts"), "utf8")).toBe("export const x = 1;");
  });

  it("refuses to touch anything outside the session's directory", async () => {
    await expect(tool("Read").run({ file_path: "../../../etc/passwd" }, ctx)).rejects.toThrow("escapes the session directory");
    await expect(tool("Write").run({ file_path: "/etc/nope", content: "x" }, ctx)).rejects.toThrow("escapes the session directory");
  });
});

describe("editing a file", () => {
  beforeEach(() => {
    writeFileSync(join(dir, "code.ts"), "const a = 1;\nconst b = 1;\n");
  });

  it("replaces a unique string", async () => {
    const out = await tool("Edit").run({ file_path: "code.ts", old_string: "const a = 1;", new_string: "const a = 2;" }, ctx);
    expect(out).toContain("1 replacement");
    expect(readFileSync(join(dir, "code.ts"), "utf8")).toContain("const a = 2;");
  });

  it("refuses an ambiguous edit rather than landing it in the wrong place", async () => {
    const out = await tool("Edit").run({ file_path: "code.ts", old_string: "= 1;", new_string: "= 2;" }, ctx);
    expect(out).toContain("appears 2 times");
    // Nothing was written.
    expect(readFileSync(join(dir, "code.ts"), "utf8")).toBe("const a = 1;\nconst b = 1;\n");
  });

  it("replaces every occurrence when asked explicitly", async () => {
    await tool("Edit").run({ file_path: "code.ts", old_string: "= 1;", new_string: "= 2;", replace_all: true }, ctx);
    expect(readFileSync(join(dir, "code.ts"), "utf8")).toBe("const a = 2;\nconst b = 2;\n");
  });

  it("says the string was not found instead of writing the file unchanged", async () => {
    const out = await tool("Edit").run({ file_path: "code.ts", old_string: "not here", new_string: "x" }, ctx);
    expect(out).toContain("not found");
  });

  it("points an empty old_string at Write", async () => {
    expect(await tool("Edit").run({ file_path: "code.ts", old_string: "", new_string: "x" }, ctx)).toContain("Use Write");
  });
});

describe("finding files", () => {
  beforeEach(() => {
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(dir, "src/index.ts"), "export const hello = 1;");
    writeFileSync(join(dir, "src/lib/util.ts"), "export const world = 2;");
    writeFileSync(join(dir, "src/notes.md"), "hello there");
    writeFileSync(join(dir, "node_modules/pkg/index.ts"), "export const hello = 3;");
  });

  it("matches across directories with ** and skips generated trees", async () => {
    const out = await tool("Glob").run({ pattern: "**/*.ts" }, ctx);
    expect(out).toContain("src/index.ts");
    expect(out).toContain("src/lib/util.ts");
    expect(out).not.toContain("node_modules");
  });

  it("lets **/ match zero directories, which is how agents write it", () => {
    expect(globToRegExp("**/*.ts").test("index.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a/b/index.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a/index.ts")).toBe(false);
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("file?.ts").test("file1.ts")).toBe(true);
    expect(globToRegExp("*.{ts,md}").test("a.md")).toBe(true);
    // A dot is a literal, not "any character".
    expect(globToRegExp("*.ts").test("axts")).toBe(false);
  });

  it("searches under a subdirectory when asked", async () => {
    expect(await tool("Glob").run({ pattern: "*.ts", path: "src/lib" }, ctx)).toBe("util.ts");
  });

  it("says nothing matched rather than returning an empty string", async () => {
    expect(await tool("Glob").run({ pattern: "*.rs" }, ctx)).toContain("no files match");
  });

  it("caps a huge result and says how much it left out", async () => {
    mkdirSync(join(dir, "many"), { recursive: true });
    for (let i = 0; i < 520; i++) writeFileSync(join(dir, "many", `f${i}.txt`), "x");
    const out = await tool("Glob").run({ pattern: "**/*.txt", path: "many" }, ctx);
    expect(out).toContain("[20 more]");
  });

  it("returns nothing rather than throwing when the search root is not a directory", async () => {
    writeFileSync(join(dir, "afile.txt"), "x");
    expect(await tool("Glob").run({ pattern: "*", path: "afile.txt" }, ctx)).toContain("no files match");
  });

  it("skips a file it is not allowed to stat instead of failing the whole search", async () => {
    // readdir lists it, stat refuses it — a worktree mid-build genuinely
    // produces files that come and go between the two calls.
    mkdirSync(join(dir, "locked"));
    writeFileSync(join(dir, "locked", "hidden.ts"), "x");
    poison.stat = join("locked", "hidden.ts");
    try {
      const out = await tool("Glob").run({ pattern: "**/*.ts" }, ctx);
      expect(out).toContain("src/index.ts");
      expect(out).not.toContain("hidden.ts");
    } finally {
      poison.stat = null;
    }
  });
});

describe("searching file contents", () => {
  beforeEach(() => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "const hello = 1;\nconst other = 2;");
    writeFileSync(join(dir, "src/b.md"), "HELLO in markdown");
    writeFileSync(join(dir, "src/bin.dat"), `binary\u0000hello`);
  });

  it("returns path, line number and the matching line", async () => {
    const out = await tool("Grep").run({ pattern: "hello" }, ctx);
    expect(out).toContain("src/a.ts:1: const hello = 1;");
  });

  it("honours case-insensitive search", async () => {
    expect(await tool("Grep").run({ pattern: "hello", "-i": true }, ctx)).toContain("src/b.md");
  });

  it("filters by glob, matching a bare *.ts at any depth", async () => {
    const out = await tool("Grep").run({ pattern: "hello", glob: "*.ts" }, ctx);
    expect(out).toContain("src/a.ts");
    expect(out).not.toContain("src/b.md");
  });

  it("skips binary files, which produce noise rather than matches", async () => {
    expect(await tool("Grep").run({ pattern: "hello", "-i": true }, ctx)).not.toContain("bin.dat");
  });

  it("reports an invalid regular expression instead of throwing", async () => {
    expect(await tool("Grep").run({ pattern: "(unclosed" }, ctx)).toContain("invalid regular expression");
  });

  it("says nothing matched rather than returning an empty string", async () => {
    expect(await tool("Grep").run({ pattern: "zzzznotthere" }, ctx)).toContain("no matches");
  });

  it("skips a file it cannot read instead of failing the whole search", async () => {
    writeFileSync(join(dir, "src/secret.ts"), "hello secret");
    poison.read = join("src", "secret.ts");
    try {
      const out = await tool("Grep").run({ pattern: "hello" }, ctx);
      expect(out).toContain("src/a.ts");
      expect(out).not.toContain("secret.ts");
    } finally {
      poison.read = null;
    }
  });

  it("stops at a bounded number of matches", async () => {
    writeFileSync(join(dir, "src/many.ts"), Array.from({ length: 500 }, () => "hello").join("\n"));
    const out = await tool("Grep").run({ pattern: "hello" }, ctx);
    expect(out.split("\n").length).toBeLessThanOrEqual(300);
  });
});

describe("which tools a role is offered", () => {
  it("gives a role everything when it names nothing", () => {
    expect(toolsFor({}).map((t) => t.name)).toEqual(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
  });

  it("keeps a read-only role away from a shell", () => {
    // The planner passes exactly this; a planner with Bash is a planner that
    // can change the repo it is supposed to be reading.
    const names = toolsFor({ tools: ["Read", "Glob", "Grep"] }).map((t) => t.name);
    expect(names).toEqual(["Read", "Glob", "Grep"]);
    expect(names).not.toContain("Bash");
  });

  it("subtracts the disallowed ones", () => {
    expect(toolsFor({ disallowedTools: ["Write", "Edit"] }).map((t) => t.name)).toEqual(["Bash", "Read", "Glob", "Grep"]);
  });

  it("names the tools it cannot implement, so the mismatch is caught at the gate", () => {
    expect(unsupportedTools({ tools: ["Read", "WebSearch", "WebFetch"] })).toEqual(["WebSearch", "WebFetch"]);
    expect(unsupportedTools({ tools: ["Read", "Bash"] })).toEqual([]);
    expect(unsupportedTools({})).toEqual([]);
  });
});
