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

function record(kind: string, detail: string): void {
  const line = `${new Date().toISOString()} pid=${process.pid} ${kind} ${detail.replace(/\s+$/, "")}\n`;
  process.stderr.write(`\nharness: ${kind} — ${detail.split("\n")[0]}\n`);
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
  record("fatal", describe(e));
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
