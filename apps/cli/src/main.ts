#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * The binary. Everything it does that is worth testing lives in `./cli.js`;
 * what is left here is the part that can only happen once per process —
 * installing the crash handlers and handing `process.argv` to commander.
 *
 * The shebang flag is about one warning:
 *
 *     (node:47456) ExperimentalWarning: SQLite is an experimental feature and
 *     might change at any time
 *
 * The store is `node:sqlite` deliberately — no native build step, no
 * better-sqlite3 — and Node says so on stderr before every command, addressed
 * to an operator who did not choose the storage engine and cannot act on it.
 * Two lines above every `harness status` teach people to skim past stderr,
 * which is where the messages that do matter go.
 *
 * It has to be a process flag rather than a `warning` listener installed here:
 * the warning fires when `node:sqlite` is loaded, and in a static ESM graph
 * every module is loaded before any module body runs, so no code in this file
 * can be early enough (verified — the same import behind `await import(...)`
 * is filterable, a static one is not).
 *
 * The cost is that it silences the whole ExperimentalWarning category, not
 * just this one; Node has no finer granularity than the warning's name. A new
 * experimental API in this process would go unannounced.
 *
 * That split is the point. While this file also held the command tree, none of
 * it could be imported: line one installed signal handlers on the importing
 * process and the last line parsed the importing process's argv. So the whole
 * CLI — every flag, every banner line, every gate prompt — went untested, and
 * the only way to find out whether `harness resume` still worked was to run it.
 */
import { buildProgram } from "./cli.js";
import { installCrashLog, recordFatal } from "./crashlog.js";
import { loadDotEnv } from "./env.js";

installCrashLog();

// Before the command tree runs, because `harness run` checks the vendor keys
// while it is resolving the config — see `missingKeys` in cli.ts — and a key
// loaded after that check is a key that was not there when it mattered.
loadDotEnv();

buildProgram()
  .parseAsync()
  .catch((e: unknown) => {
    recordFatal(e);
    process.exit(1);
  });
