/**
 * Read `.env` from the working directory into `process.env`, if there is one.
 *
 * The harness reads three vendor keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 * `GEMINI_API_KEY`) straight off `process.env`, and until this existed the only
 * way to supply one was to export it in the shell that ran the command. That
 * was survivable while the whole default routing table was Anthropic and most
 * operators had that one key exported in a profile. Pinning `models.reviewer`
 * to Google ended it: a second key is now mandatory for every run, and the
 * obvious place to put a project's keys — the `.env` file already sitting in the
 * repository — was silently ignored. The failure was not subtle (`harness run`
 * refuses on `missingKeys` before spending anything) but the advice it gives is
 * "export the key", which is the wrong answer for someone who just wrote it
 * down in the file that every other tool they own would have read.
 *
 * Three deliberate properties:
 *
 *   - An exported variable wins over the file. That is `process.loadEnvFile`'s
 *     own precedence, and it is the one that keeps `GEMINI_API_KEY=… harness
 *     run` working as a one-off override of a committed default.
 *   - The working directory, not `--repo`. The repository the harness is
 *     *building* is untrusted input — a task spec can write to it — and reading
 *     secrets out of it would let a run choose which credentials the next run
 *     uses. This is the operator's own directory, chosen by where they stood
 *     when they typed the command.
 *   - Absent or unreadable is not an error. Most invocations have no `.env`,
 *     and a CLI that refuses to start over a missing optional file is worse
 *     than one that quietly does without it.
 */

/** Injected in tests. `process.loadEnvFile` in production. */
export type EnvFileLoader = (path: string) => void;

/**
 * Loads `<cwd>/.env`. Returns the path it read, or null when there was nothing
 * to read — which is also what a malformed or unreadable file returns, on
 * purpose: the keys that matter are checked by name a moment later, by
 * `missingKeys`, which can say which one is missing and which role wanted it.
 * A parser error here could only say "something is wrong with .env".
 */
export function loadDotEnv(cwd: string = process.cwd(), load: EnvFileLoader = process.loadEnvFile): string | null {
  const path = `${cwd}/.env`;
  try {
    load(path);
    return path;
  } catch {
    return null;
  }
}
