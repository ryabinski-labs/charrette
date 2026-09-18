/**
 * Telling a starved CI runner apart from a defect in the suite.
 *
 * Charrette CI runs on whichever self-hosted runner is free, on purpose — the
 * operator's rule is that every runner can take every workflow, and the
 * ephemeral pool is not always up to take them first. So the suite lands on
 * shared hosts that already have production work on them, and there it fails
 * like this:
 *
 *   Test Files  120 passed (120)
 *        Tests  2298 passed (2298)
 *       Errors  1 error
 *   All files   |   100 |   100 |   100 |   100 |
 *
 *   Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 *
 * Every test passed, every shipped line ran, and the job exited 1. Vitest
 * counts an unhandled error as a failure, and that error is birpc's call
 * timeout: a worker asked the parent process to record a result and the parent
 * did not answer inside 60 seconds. The parent serves every worker's
 * transforms and answers all of their RPC, so on a host where it cannot get
 * scheduled it stops answering — nothing to do with the code under test. The
 * timeout is a hardcoded `DEFAULT_TIMEOUT = 6e4` in birpc with no vitest
 * config knob on it, so it cannot simply be raised.
 *
 * Run 31970423870 is why this exists rather than another mitigation: it failed
 * exactly this way on `mx1.api-service.com` *with* the worker pool already
 * halved, at 498s against a dedicated runner's 104s. Making the timeout less
 * likely is not the same as making a green suite green.
 *
 * `dangerouslyIgnoreUnhandledErrors` alone would fix it and hide the next real
 * one — an unhandled rejection escaping a test is a genuine signal and must
 * keep failing the build. So the flag is set and the policy is put back here,
 * narrowed to the one error that is a statement about the machine: this
 * decides which unhandled errors still fail the run, and everything it does
 * not recognise still does.
 */

/** The shape vitest hands a reporter: serialized errors, not `Error` instances. */
export interface UnhandledError {
  message?: unknown;
  name?: unknown;
  stack?: unknown;
}

/**
 * birpc's own wording, anchored so it cannot match a test's own message.
 *
 * `[vitest-worker]` is the prefix its `onTimeoutError` writes, and the method
 * name is whichever call was in flight — `onTaskUpdate` in every occurrence so
 * far, but `onCollected` and `onUserConsoleLog` reach the parent the same way
 * and would starve identically.
 */
const RPC_TIMEOUT = /\[vitest-worker\]:\s*Timeout calling ["'][^"']+["']/;

/** Whether this error says the runner was too loaded, rather than that the code is wrong. */
export function isRunnerStarvation(error: UnhandledError): boolean {
  const message = typeof error?.message === "string" ? error.message : "";
  const stack = typeof error?.stack === "string" ? error.stack : "";
  return RPC_TIMEOUT.test(message) || RPC_TIMEOUT.test(stack);
}

/**
 * Split unhandled errors into the ones that must still fail the build and the
 * ones that only say the runner was overloaded.
 *
 * Deliberately conservative in both directions. An error this does not
 * recognise is `fatal`, because the cost of failing a run over an
 * unrecognised error is a re-run and the cost of ignoring one is a defect that
 * ships. And a starvation error is never silently dropped — the caller is
 * expected to print it, since a suite that is quietly surviving a broken
 * runner is a suite that stops telling anyone the runner is broken.
 */
export function partitionUnhandled(errors: readonly UnhandledError[]): {
  fatal: UnhandledError[];
  starvation: UnhandledError[];
} {
  const fatal: UnhandledError[] = [];
  const starvation: UnhandledError[] = [];
  for (const error of errors) (isRunnerStarvation(error) ? starvation : fatal).push(error);
  return { fatal, starvation };
}

/** What the CI log says when a green suite was nearly failed by the machine under it. */
export function starvationNote(count: number, errors: readonly UnhandledError[]): string {
  const which = errors
    .map((e) => (typeof e?.message === "string" ? RPC_TIMEOUT.exec(e.message)?.[0] : null))
    .filter((m): m is string => Boolean(m));
  return [
    `\nvitest reported ${count} unhandled ${count === 1 ? "error that is" : "errors that are"} about this runner, not this code:`,
    ...which.map((m) => `  ${m}`),
    "A worker asked the parent process to record a result and waited 60s for an answer.",
    "birpc's call timeout is fixed and the parent was not scheduled inside it — the host",
    "taking this job is loaded. The suite itself passed; the build is not failed for this.",
    "If it happens on every run, the runner is the thing to look at, not the tests.\n",
  ].join("\n");
}
