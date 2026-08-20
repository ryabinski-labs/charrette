import { appendFileSync } from "node:fs";
import path from "node:path";

/**
 * Why a harness process stopped.
 *
 * Until this existed, it stopped without saying: the only error handling was
 * `program.parseAsync().catch(...)`, which prints one line to the terminal and
 * exits. A run that died overnight, or in a terminal since scrolled or closed,
 * left nothing behind — and `resume` could only report the consequence ("the
 * previous harness process died mid-task") while the cause was unrecoverable.
 * One run lost 1,300 agent turns across 11 such deaths with no record of a
 * single one.
 *
 * A Ctrl-C and a crash produce identical evidence in the database, so the
 * distinction has to be written down at the moment it happens. That is the
 * whole job here: append one line, then get out of the way.
 */

/** Set once the repo is known; until then there is nowhere to write but stderr. */
let logPath: string | null = null;
/** A fatal path can be reached twice (throw inside an exit handler); log once. */
let done = false;

/** Point the log at `<stateDir>/harness.log`. Safe to call more than once. */
export function armCrashLog(stateDir: string): void {
  logPath = path.join(stateDir, "harness.log");
}

/**
 * `detail` goes to the log, `human` to the terminal.
 *
 * They were the same string, printed as `detail.split("\n")[0]` — which is the
 * right rule for the thing it was written against (an Error whose `detail` is
 * its message *plus its stack*, and an operator who should not be shown a
 * stack) and the wrong one for an error whose message is deliberately several
 * lines. A config rejection listing three bad fields arrived as its own
 * heading and nothing else: "harness: fatal — that run configuration cannot be
 * used:" with the reasons cut off underneath.
 *
 * So the split is now by *what the text is* rather than by line count: the
 * whole message reaches the terminal, the stack only reaches the log, and the
 * log line itself is unchanged — `harness.log` is parsed elsewhere.
 */
function record(kind: string, detail: string, human = detail.split("\n")[0]!): void {
  const line = `${new Date().toISOString()} pid=${process.pid} ${kind} ${detail.replace(/\s+$/, "")}\n`;
  process.stderr.write(`\nharness: ${kind} — ${human}\n`);
  if (!logPath) return;
  try {
    appendFileSync(logPath, line);
  } catch {
    // A process on its way out has nothing better to try.
  }
}

/** The reason, as one line plus a stack when there is one. */
function describe(e: unknown): string {
  if (e instanceof Error) return `${e.message}\n${e.stack ?? ""}`;
  return String(e);
}

/**
 * Log `e` as the reason this process is exiting. Exported for the top-level
 * `.catch()`, which already had a reason in hand and only lacked somewhere to
 * put it.
 */
export function recordFatal(e: unknown): void {
  if (done) return;
  done = true;
  record("fatal", describe(e), e instanceof Error ? e.message : String(e));
}

/**
 * Log `e` as a refusal rather than a crash.
 *
 * `harness: fatal — run bc691359 is already being driven by harness pid 47427`
 * is the wrong word for the one case it describes. Nothing failed: a second
 * harness was told the run was taken and stopped, which is the whole feature.
 * The message is several lines and every one of them is addressed to the
 * operator, so it goes to the terminal whole and to the log without a stack —
 * there is no stack worth keeping for a decision the process made on purpose.
 */
export function recordRefusal(e: Error): void {
  if (done) return;
  done = true;
  record("refused", e.message, e.message);
}

/**
 * Install the handlers. Called at startup, before any command runs, so a
 * failure while resolving the repo is recorded too (on stderr — the log path
 * is not known yet).
 *
 * Signals exit with the conventional 128+n rather than 0: a Ctrl-C'd run did
 * not succeed, and anything supervising the process should be able to tell.
 */
export function installCrashLog(): void {
  process.on("uncaughtException", (e) => {
    recordFatal(e);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    if (!done) {
      done = true;
      record("unhandledRejection", describe(reason));
    }
    process.exit(1);
  });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.on(signal, () => {
      if (!done) {
        done = true;
        record("signal", `${signal} — stopped by the operator or the terminal, not a crash. In-flight agents were killed mid-task; \`harness resume\` requeues them.`);
      }
      process.exit(code);
    });
  }
}
