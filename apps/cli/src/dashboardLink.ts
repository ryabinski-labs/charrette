import { rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { statePaths } from "@charrette/shared";

/**
 * Where a repo's live dashboard is, so a command that did not start it can
 * still point at it.
 *
 * `charrette status` prints what the run did; the dashboard shows it happening.
 * The URL was only ever printed in the banner of the `run`/`resume` that
 * started the server, so an operator in a second terminal — or one whose
 * scrollback has moved on, which after a multi-hour run is everyone — had no
 * way back to it short of guessing the port, and the port is not the hard part:
 * the auth token in the fragment is random per process.
 *
 * The file lives in `.charrette/`, which is gitignored (the run database is
 * already there) and holds this run's bearer token, so it is written 0600. It
 * is a cache, not state: a stale one is discovered by asking the port.
 *
 * One record, and it belongs to the process named in it. Run 614e06d5 lost its
 * record to a second `charrette resume` that was about to be refused: it wrote
 * over the live run's link, cleared it on the way out, and `charrette pause`
 * then said nothing was running. So nobody writes over or clears a record
 * whose writer is another process that is still alive.
 *
 * A process that stops cleanly leaves the record behind marked `stopped`. That
 * is what lets a paused run come back at the URL the operator has open.
 */
const FILE = "dashboard.json";

const linkPath = (repoPath: string): string => path.join(statePaths(repoPath).dir, FILE);

type LinkRecord = { url?: unknown; pid?: unknown; stopped?: unknown };

function readRecord(repoPath: string): LinkRecord | null {
  try {
    return JSON.parse(readFileSync(linkPath(repoPath), "utf8")) as LinkRecord;
  } catch {
    return null;
  }
}

/** Whether the record names a running process other than this one. */
function heldByAnother(record: LinkRecord | null): boolean {
  return !record?.stopped && typeof record?.pid === "number" && record.pid !== process.pid && processAlive(record.pid);
}

/** Record a dashboard this process is serving, unless another live process has the record. */
export function recordDashboard(repoPath: string, url: string): void {
  if (heldByAnother(readRecord(repoPath))) return;
  try {
    writeFileSync(linkPath(repoPath), `${JSON.stringify({ url, pid: process.pid })}\n`, { mode: 0o600 });
  } catch {
    // A repo whose .charrette/ is unwritable has bigger problems than a missing
    // convenience link, and none of them are this function's to report.
  }
}

/**
 * The port and token this repo's dashboard last served on, if any.
 *
 * Read by `resume` so a run picked up after a pause comes back at the URL the
 * operator already has open, rather than at a new port with a new credential.
 * Both halves matter: the port is where the tab is pointed and the fragment is
 * what gets it past the bearer check, so recovering one without the other still
 * leaves them looking at a dead page.
 *
 * A dashboard another process is serving right now is not on offer: its token
 * is that process's, and its port is taken.
 *
 * Best-effort by design — a missing, unreadable or malformed file simply means
 * "no opinion", and the caller takes a fresh port and a fresh token exactly as
 * it did before. Nothing here may stop a resume.
 */
export function recordedDashboard(repoPath: string): { port: number; token: string } | null {
  const record = readRecord(repoPath);
  if (heldByAnother(record)) return null;
  try {
    const url = new URL(String(record?.url ?? ""));
    const port = Number(url.port);
    const token = url.hash.slice(1);
    return port && token ? { port, token } : null;
  } catch {
    return null;
  }
}

/** Forget the record, unless it belongs to another process that is still alive. */
export function clearDashboard(repoPath: string): void {
  if (heldByAnother(readRecord(repoPath))) return;
  rmSync(linkPath(repoPath), { force: true });
}

/**
 * This process's dashboard has stopped. Keep the URL for the next `resume`, and
 * say that nothing is serving it. Someone else's record is left exactly as it is.
 */
export function retireDashboard(repoPath: string): void {
  const record = readRecord(repoPath);
  if (record?.pid !== process.pid) return;
  try {
    writeFileSync(linkPath(repoPath), `${JSON.stringify({ url: record.url, stopped: true })}\n`, { mode: 0o600 });
  } catch {
    // The file was readable a moment ago. If it cannot be rewritten, the pid in
    // it dies with this process and readers treat it as stale.
  }
}

/**
 * Whether the process that wrote the link is still running.
 *
 * Signal 0 checks for the process without touching it. `EPERM` means it exists
 * and belongs to somebody else, which is still "alive" — the only answer that
 * clears the file is `ESRCH`, nothing there.
 *
 * A pid is not a proof of identity: after enough churn the number belongs to
 * something else entirely, and this says "alive" about a dashboard that is
 * gone. That is the safe direction to be wrong in — the request below is what
 * settles it, and this only ever spares that request.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The dashboard serving this repo right now, or null.
 *
 * Asked rather than assumed: the recorded process may have exited without
 * clearing the file (killed, crashed, or the machine rebooted), and a link that
 * goes nowhere is worse than no link — it sends the operator to a browser tab
 * to find out. One authenticated request settles it, and a wrong answer here
 * costs a printed line, so the timeout is short and every failure means "no".
 *
 * The pid recorded beside the URL is checked first. A dead writer is the common
 * case for a stale file and it can be answered without opening a socket at all
 * — which matters because everything reading this file reads it to decide
 * whether a run can still be talked to. ledger-app's run beb799c5 left a
 * `dashboard.json` naming a pid that had exited, and every reader of it —
 * including the watcher supervising that run — took the file as evidence of a
 * live control plane and went to the port to find out otherwise.
 */
export async function liveDashboardUrl(repoPath: string): Promise<string | null> {
  const record = readRecord(repoPath);
  // Stopped on purpose: nothing is serving it, and the URL is kept for `resume`.
  if (!record || record.stopped) return null;
  const url = String(record.url ?? "");
  if (!url) return null;
  // Only when there is one to check: files written before the pid was
  // recorded are still perfectly good links, and the request settles those.
  if (typeof record.pid === "number" && !processAlive(record.pid)) {
    clearDashboard(repoPath);
    return null;
  }
  const token = url.slice(url.indexOf("#") + 1);
  try {
    const res = await fetch(`${url.slice(0, url.indexOf("#"))}api/state`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    // Drain it: an unread body holds the socket open, and this process is about
    // to print one line and exit.
    await res.arrayBuffer();
    return url;
  } catch (e) {
    // A slow answer is a busy run, not a dead one. Only a refused connection
    // says nothing is there.
    if ((e as Error).name !== "TimeoutError") rmSync(linkPath(repoPath), { force: true });
    return null;
  }
}
