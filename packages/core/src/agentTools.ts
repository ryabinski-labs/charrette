import { execFile } from "node:child_process";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { BASH_TIMEOUT_MS } from "./limits.js";
import { denialReason, infraMutation } from "./infraGuard.js";

/**
 * The tools an agent gets when the harness runs its tool loop itself.
 *
 * On the Anthropic transport the SDK supplies Bash/Read/Write/Edit/Glob/Grep
 * and the harness only inspects them through PreToolUse hooks. Off that
 * transport there is no SDK, so the tools are implemented here — and the guard
 * that stops an agent applying real infrastructure has to be implemented *with*
 * them, not around them.
 *
 * That is the whole reason this file exists rather than a thinner adapter. The
 * infra guard was a PreToolUse hook, and a PreToolUse hook is an Anthropic SDK
 * concept: an OpenAI or Gemini agent shelling out through a naive adapter would
 * have had no guard at all, and nothing would have said so — the run would look
 * identical right up until a `terraform destroy` succeeded. `runBash` below is
 * the only path from any non-Anthropic agent to a shell, and it calls the same
 * `infraMutation` the hook calls, on the command the agent actually wrote.
 */

/** Everything a tool needs from the session it is running inside. */
export interface ToolContext {
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  /** Rewrites a Bash command through rtk when the operator has it installed. */
  rewrite?: (command: string, signal?: AbortSignal) => Promise<string>;
  /** Notified when the guard refuses a command, so the refusal reaches the bus. */
  onDenied?: (tool: string, reason: string) => void;
  /** Swapped in tests; defaults to a real child process. */
  exec?: ExecFn;
}

export type ExecFn = (
  command: string,
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; signal: AbortSignal }
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export interface LocalTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as every provider's function-calling API wants. */
  parameters: Record<string, unknown>;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/**
 * Tool output ceiling. A `find /` or a runaway test log will otherwise push the
 * transcript past the context window in one call, and a truncated result the
 * agent can react to beats a session that dies holding the answer.
 */
const MAX_OUTPUT = 30_000;

function clamp(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated: ${text.length - limit} more characters. Narrow the command or read a specific range.]`;
}

/** Refuse to leave the session's directory. */
function within(cwd: string, path: string): string {
  const full = resolve(cwd, path);
  const rel = relative(cwd, full);
  if (rel.startsWith("..") || (rel !== "" && resolve(cwd, rel) !== full)) {
    throw new Error(`path escapes the session directory: ${path}`);
  }
  return full;
}

/**
 * What a finished command exited with.
 *
 * A command killed by a signal, or one whose shell could not be started, has
 * no numeric `code` — and reporting that as success would tell an agent its
 * test suite passed when the runner was killed.
 */
export function exitCode(err: unknown): number {
  if (!err) return 0;
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" ? code : 1;
}

const defaultExec: ExecFn = (command, { cwd, env, timeoutMs, signal }) =>
  new Promise((done) => {
    execFile(
      "bash",
      ["-lc", command],
      { cwd, env, timeout: timeoutMs, signal, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => done({ stdout: String(stdout), stderr: String(stderr), code: exitCode(err) })
    );
  });

/**
 * Run one shell command for an agent, with the infrastructure guard in front
 * of it.
 *
 * Exported on its own because it is the security seam: a test that wants to
 * prove a non-Anthropic agent cannot `terraform apply` should be able to call
 * exactly what that agent calls, with no provider or loop in the way.
 */
export async function runBash(command: string, ctx: ToolContext): Promise<string> {
  if (typeof command !== "string" || !command.trim()) return "error: no command given";

  // The guard reads the command the agent wrote, before rtk rewrites it into
  // something the matcher would no longer recognise — the same ordering, and
  // for the same reason, as bashHooks() on the SDK transport.
  const mutation = infraMutation(command);
  if (mutation) {
    const reason = denialReason(mutation);
    ctx.onDenied?.("Bash", reason);
    return reason;
  }

  let final = command;
  if (ctx.rewrite) {
    try {
      final = await ctx.rewrite(command, ctx.signal);
    } catch {
      // rtk being broken must never cost an agent its command.
      final = command;
    }
  }

  const exec = ctx.exec ?? defaultExec;
  const { stdout, stderr, code } = await exec(final, {
    cwd: ctx.cwd,
    env: ctx.env,
    // The SDK transport raises this ceiling because a backgrounded command kills
    // its session; here nothing is backgrounded, but a test suite still needs
    // longer than a default two minutes, so the same bound applies.
    timeoutMs: BASH_TIMEOUT_MS,
    signal: ctx.signal,
  });
  const parts = [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : "", code === 0 ? "" : `[exit ${code}]`].filter(Boolean);
  return clamp(parts.join("\n\n") || "(no output)");
}

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "");

/** Directories never worth walking; they are large, generated, and not the agent's work. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".venv", "__pycache__", ".turbo"]);

/** Convert a glob to a regex: `**` spans directories, `*` and `?` do not. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` should also match zero directories, so `**/x.ts` finds `x.ts`.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") out += "(?:";
    else if (c === "}") out += ")";
    else if (c === ",") out += "|";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Every file under `root`, newest first, skipping generated trees. */
async function walk(root: string, cap = 20_000): Promise<{ path: string; mtime: number }[]> {
  const found: { path: string; mtime: number }[] = [];
  const queue = [root];
  while (queue.length && found.length < cap) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory is not a reason to fail the whole search
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        try {
          found.push({ path: full, mtime: (await stat(full)).mtimeMs });
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/** Files whose bytes are not text; grepping them produces noise, not matches. */
function isBinary(buffer: string): boolean {
  return buffer.includes("\u0000");
}

export const TOOLS: LocalTool[] = [
  {
    name: "Bash",
    description:
      "Run a shell command in the session's working directory. Commands that would provision, mutate or destroy real infrastructure are refused — use plan/synth/template/--dry-run to verify that work instead. Do not background commands; run them in the foreground.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run." } },
      required: ["command"],
    },
    run: (input, ctx) => runBash(str(input, "command"), ctx),
  },
  {
    name: "Read",
    description: "Read a file from the session's working directory. Returns the contents with line numbers.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file, absolute or relative to the working directory." },
        offset: { type: "number", description: "First line to return (1-indexed)." },
        limit: { type: "number", description: "How many lines to return." },
      },
      required: ["file_path"],
    },
    run: async (input, ctx) => {
      const path = within(ctx.cwd, str(input, "file_path"));
      const text = await readFile(path, "utf8");
      const lines = text.split("\n");
      const start = Math.max(1, Number(input.offset) || 1);
      const count = Number(input.limit) || lines.length;
      const slice = lines.slice(start - 1, start - 1 + count);
      if (!slice.length) return `(no lines at offset ${start}; the file has ${lines.length})`;
      return clamp(slice.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join("\n"));
    },
  },
  {
    name: "Write",
    description: "Write a file, creating parent directories and overwriting any existing content.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file, absolute or relative to the working directory." },
        content: { type: "string", description: "The complete new contents of the file." },
      },
      required: ["file_path", "content"],
    },
    run: async (input, ctx) => {
      const path = within(ctx.cwd, str(input, "file_path"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, str(input, "content"), "utf8");
      return `wrote ${relative(ctx.cwd, path)}`;
    },
  },
  {
    name: "Edit",
    description:
      "Replace an exact string in a file. The old string must appear exactly once unless replace_all is set — this is what stops an edit landing in the wrong place.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file, absolute or relative to the working directory." },
        old_string: { type: "string", description: "The exact text to replace, including indentation." },
        new_string: { type: "string", description: "The replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
      },
      required: ["file_path", "old_string", "new_string"],
    },
    run: async (input, ctx) => {
      const path = within(ctx.cwd, str(input, "file_path"));
      const old = str(input, "old_string");
      const next = str(input, "new_string");
      if (old === "") return "error: old_string is empty. Use Write to create a file.";
      const text = await readFile(path, "utf8");
      const occurrences = text.split(old).length - 1;
      if (occurrences === 0) return `error: old_string not found in ${relative(ctx.cwd, path)}. Read the file and match its exact text, including indentation.`;
      if (occurrences > 1 && input.replace_all !== true) {
        return `error: old_string appears ${occurrences} times in ${relative(ctx.cwd, path)}. Include more surrounding context to make it unique, or set replace_all.`;
      }
      await writeFile(path, input.replace_all === true ? text.split(old).join(next) : text.replace(old, next), "utf8");
      return `edited ${relative(ctx.cwd, path)} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`;
    },
  },
  {
    name: "Glob",
    description: "Find files by glob pattern (for example `src/**/*.ts`), newest first. Generated directories such as node_modules and dist are skipped.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, relative to the working directory." },
        path: { type: "string", description: "Directory to search under. Defaults to the working directory." },
      },
      required: ["pattern"],
    },
    run: async (input, ctx) => {
      const root = within(ctx.cwd, str(input, "path") || ".");
      const re = globToRegExp(str(input, "pattern"));
      const hits = (await walk(root)).map((f) => relative(root, f.path)).filter((p) => re.test(p));
      if (!hits.length) return `no files match ${str(input, "pattern")}`;
      return clamp(hits.slice(0, 500).join("\n") + (hits.length > 500 ? `\n[${hits.length - 500} more]` : ""));
    },
  },
  {
    name: "Grep",
    description: "Search file contents with a regular expression. Returns `path:line: text` for each match.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Directory to search under. Defaults to the working directory." },
        glob: { type: "string", description: "Only search files matching this glob, for example `*.ts`." },
        "-i": { type: "boolean", description: "Case-insensitive search." },
      },
      required: ["pattern"],
    },
    run: async (input, ctx) => {
      const root = within(ctx.cwd, str(input, "path") || ".");
      let re: RegExp;
      try {
        re = new RegExp(str(input, "pattern"), input["-i"] === true ? "i" : "");
      } catch (e) {
        return `error: invalid regular expression: ${String(e)}`;
      }
      const only = str(input, "glob") ? globToRegExp(str(input, "glob")) : null;
      const out: string[] = [];
      for (const file of await walk(root)) {
        const rel = relative(root, file.path);
        // A bare `*.ts` should match at any depth — that is how agents write it.
        if (only && !only.test(rel) && !only.test(rel.split(sep).pop()!)) continue;
        let text: string;
        try {
          text = await readFile(file.path, "utf8");
        } catch {
          continue;
        }
        if (isBinary(text)) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) out.push(`${rel}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
          if (out.length >= 300) break;
        }
        if (out.length >= 300) break;
      }
      if (!out.length) return `no matches for ${str(input, "pattern")}`;
      return clamp(out.join("\n"));
    },
  },
];

/**
 * The tools this transport can offer for a spec, honouring the same
 * `tools`/`allowedTools`/`disallowedTools` narrowing the SDK applies.
 *
 * `tools` names what exists at all (read-only roles pass `["Read","Glob","Grep"]`
 * and must not get a shell); `disallowedTools` subtracts. A name the harness
 * asks for that this transport cannot implement — WebSearch, WebFetch, an MCP
 * tool — is simply not offered, which is why `unsupportedTools` exists to catch
 * that at the gate instead of leaving an agent quietly unable to do its job.
 */
export function toolsFor(spec: { tools?: unknown; allowedTools?: string[]; disallowedTools?: string[] }): LocalTool[] {
  const exists = Array.isArray(spec.tools) ? new Set(spec.tools.filter((t): t is string => typeof t === "string")) : null;
  const denied = new Set(spec.disallowedTools ?? []);
  return TOOLS.filter((t) => (exists ? exists.has(t.name) : true) && !denied.has(t.name));
}

/** Tool names a spec asks for that this transport has no implementation for. */
export function unsupportedTools(spec: { tools?: unknown }): string[] {
  if (!Array.isArray(spec.tools)) return [];
  const known = new Set(TOOLS.map((t) => t.name));
  return spec.tools.filter((t): t is string => typeof t === "string" && !known.has(t));
}
