/**
 * Bounds shared by every transport.
 *
 * Split out of pool.ts so the tools the harness runs itself (agentTools.ts) can
 * hold the same line without importing the pool that imports them.
 */

/**
 * How long a Bash command may run before the CLI backgrounds it — and, because
 * being backgrounded is fatal there, effectively how long a command may run at
 * all. The stock 120s is under what `npm test` takes in a mid-sized repo. 30
 * minutes covers test suites, installs and builds; a command that outruns even
 * that is hung, and stalling one worker until its turn cap is the cheap failure
 * next to killing the session outright.
 *
 * The harness-run tool loop backgrounds nothing, so the fatal half does not
 * apply there — but the same suites still need the same time, so the bound is
 * shared rather than guessed at twice.
 */
export const BASH_TIMEOUT_MS = 30 * 60 * 1000;
