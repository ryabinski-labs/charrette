/**
 * Reading a Bash command well enough to guard it.
 *
 * Split out of infraGuard because there are now two guards that have to agree
 * about what a command actually runs, and a shell lexer is the wrong thing to
 * have two copies of: every bug in it is a quoting bug, and a quoting bug in
 * one copy is a guard that can be talked past while its twin holds.
 *
 * What lives here is lexing only — where the commands are, what the tokens are,
 * which binary is really being invoked. What each guard makes of that stays in
 * the guard, because they read different parts: the infra guard reads verbs and
 * can throw quoted spans away, while the worktree guard reads paths and cannot.
 */

/** Shell separators that start a fresh command, when they are not inside quotes. */
const SEPARATOR = /^(?:\|\||&&|;|\||&|\n)/;

/** Remove quoted spans so prose about a command never reads as the command. */
export function stripQuoted(segment: string): string {
  return segment.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
}

/**
 * Drop the bodies of any heredocs, keeping the lines that are actually commands.
 *
 * An infra task writes deployment runbooks, and a runbook lists `terraform apply`
 * on a line of its own because that is what a human runs. Read as a script, that
 * document is an apply; blocking it would stop the harness documenting the very
 * work it is allowed to do.
 */
export function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    kept.push(line);
    i++;
    // Each heredoc opened on this line consumes a body, in the order opened.
    for (const m of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) {
      while (i < lines.length && lines[i]!.trim() !== m[2]!) i++;
      i++; // and the terminator line itself
    }
  }
  return kept.join("\n");
}

/**
 * The commands one Bash invocation actually runs.
 *
 * Quote-aware, because a naive split is wrong in the direction that matters for
 * ordinary work: `echo "kubectl delete && kubectl apply -f x" >> notes.md` is
 * one command that runs neither of them.
 */
export function segments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  const flush = () => {
    if (current.trim()) out.push(current);
    current = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const sep = SEPARATOR.exec(command.slice(i));
    if (sep) {
      flush();
      i += sep[0].length - 1;
      continue;
    }
    current += ch;
  }
  flush();
  return out;
}

/** Whitespace-separated tokens, with quoted spans held together. */
export function rawTokens(segment: string): string[] {
  // `segments()` only yields segments with non-whitespace in them, so the match
  // cannot come back null — the fallback is for the type, not for a real input.
  /* v8 ignore next */
  return segment.match(/(?:[^\s'"]|'[^']*'|"[^"]*")+/g) ?? [];
}

export const unquote = (token: string): string => (/^(['"]).*\1$/s.test(token) ? token.slice(1, -1) : token);

/** Binaries that only prefix another command; the interesting one is behind them. */
export const WRAPPERS = new Set(["sudo", "doas", "env", "timeout", "nohup", "nice", "ionice", "stdbuf", "command", "xargs", "time"]);
export const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** A short-option bundle taking an argument must end in the option letter: `-c`, `-lc`. */
export const DASH_C = /^-{1,2}[a-zA-Z]*c$/;

/** How far a guard follows `bash -c "bash -c …"` before it stops. Nobody's idiom; the recursion needs a floor. */
export const MAX_NESTING = 3;

/** An environment assignment prefixing a command: `FOO=bar cmd`. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The wrapper's own arguments, skipped so the wrapped command is what gets read. */
function skipWrapperArgs(tokens: string[], from: number): number {
  let i = from;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^-{1,2}(u|user|n|adjustment)$/.test(t)) i += 2;
    else if (t.startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(t)) i++;
    else break;
  }
  return i;
}

/** A segment's real invocation: the binary's base name and its untouched arguments. */
export type Invocation = { bin: string; args: string[] } | { inline: string };

/**
 * What a segment actually invokes, seeing past environment assignments, wrapper
 * binaries and an inline `-c` script.
 *
 * `args` are returned as lexed — still quoted, nothing stripped — because a
 * guard that reads paths needs the path. Callers that only care about verbs
 * can run them through `stripQuoted` themselves.
 */
export function invocation(segment: string): Invocation | null {
  const tokens = rawTokens(segment);
  let i = 0;
  for (;;) {
    while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i]!)) i++;
    const token = tokens[i];
    if (!token) return null;
    // `split` always yields at least one element, so `pop` cannot be undefined.
    /* v8 ignore next */
    const bin = unquote(token).split("/").pop() ?? "";
    if (WRAPPERS.has(bin)) {
      i = skipWrapperArgs(tokens, i + 1);
      continue;
    }
    const rest = tokens.slice(i + 1);
    if (SHELLS.has(bin)) {
      const c = rest.findIndex((t) => DASH_C.test(t));
      if (c !== -1) {
        const script = rest.slice(c + 1).find((t) => !t.startsWith("-"));
        if (script) return { inline: unquote(script) };
      }
    }
    return { bin, args: rest };
  }
}
