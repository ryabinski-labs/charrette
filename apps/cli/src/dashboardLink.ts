import { rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Where a repo's live dashboard is, so a command that did not start it can
 * still point at it.
 *
 * `harness status` prints what the run did; the dashboard shows it happening.
 * The URL was only ever printed in the banner of the `run`/`resume` that
 * started the server, so an operator in a second terminal — or one whose
 * scrollback has moved on, which after a multi-hour run is everyone — had no
 * way back to it short of guessing the port, and the port is not the hard part:
 * the auth token in the fragment is random per process.
 *
 * The file lives in `.harness/`, which is gitignored (the run database is
 * already there) and holds this run's bearer token, so it is written 0600. It
 * is a cache, not state: a stale one is discovered by asking the port, and
 * nothing reads it but the line below.
 */
const FILE = "dashboard.json";

const linkPath = (repoPath: string): string => path.join(repoPath, ".harness", FILE);

/** Record a dashboard this process is serving. */
export function recordDashboard(repoPath: string, url: string): void {
  try {
    writeFileSync(linkPath(repoPath), `${JSON.stringify({ url, pid: process.pid })}\n`, { mode: 0o600 });
  } catch {
    // A repo whose .harness/ is unwritable has bigger problems than a missing
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
 * Best-effort by design — a missing, unreadable or malformed file simply means
 * "no opinion", and the caller takes a fresh port and a fresh token exactly as
 * it did before. Nothing here may stop a resume.
 */
export function recordedDashboard(repoPath: string): { port: number; token: string } | null {
  try {
    const url = new URL(String(JSON.parse(readFileSync(linkPath(repoPath), "utf8")).url ?? ""));
    const port = Number(url.port);
    const token = url.hash.slice(1);
    return port && token ? { port, token } : null;
  } catch {
    return null;
  }
}

/** Forget it, on the way out. */
export function clearDashboard(repoPath: string): void {
  rmSync(linkPath(repoPath), { force: true });
}

/**
 * The dashboard serving this repo right now, or null.
 *
 * Asked rather than assumed: the recorded process may have exited without
 * clearing the file (killed, crashed, or the machine rebooted), and a link that
 * goes nowhere is worse than no link — it sends the operator to a browser tab
 * to find out. One authenticated request settles it, and a wrong answer here
 * costs a printed line, so the timeout is short and every failure means "no".
 */
export async function liveDashboardUrl(repoPath: string): Promise<string | null> {
  let url: string;
  try {
    url = String(JSON.parse(readFileSync(linkPath(repoPath), "utf8")).url ?? "");
    if (!url) return null;
  } catch {
    return null; // never started one, or already cleared
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
  } catch {
    clearDashboard(repoPath); // it is gone; do not ask again
    return null;
  }
}
