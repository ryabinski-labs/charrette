#!/usr/bin/env node
/**
 * The binary. Everything it does that is worth testing lives in `./cli.js`;
 * what is left here is the part that can only happen once per process —
 * installing the crash handlers and handing `process.argv` to commander.
 *
 * That split is the point. While this file also held the command tree, none of
 * it could be imported: line one installed signal handlers on the importing
 * process and the last line parsed the importing process's argv. So the whole
 * CLI — every flag, every banner line, every gate prompt — went untested, and
 * the only way to find out whether `harness resume` still worked was to run it.
 */
import { buildProgram } from "./cli.js";
import { installCrashLog, recordFatal } from "./crashlog.js";

installCrashLog();

buildProgram()
  .parseAsync()
  .catch((e: unknown) => {
    recordFatal(e);
    process.exit(1);
  });
