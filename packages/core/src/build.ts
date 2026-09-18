import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Which charrette this process is.
 *
 * Answering "did fix X reach run Y?" cost an hour of cross-referencing
 * `git log` against process-start times in `.charrette/charrette.log`, and the
 * answer for run 40da9337 was no: the per-worktree isolation fix landed at
 * 14:33 while the process carrying the run had started at 11:47. Node loads its
 * build at process start, so the 189 sessions that began after the commit had
 * no more of the fix than the 275 before it — and nothing in the run's own
 * record said so.
 *
 * Stamping this on each session at spawn makes that a lookup instead of an
 * excavation, and makes the failure mode visible at all: a run whose sessions
 * carry two different builds did not run one charrette.
 */

/**
 * `version@sha`, `version@sha+` for a modified checkout, or the bare version
 * when the source is not a git checkout at all.
 *
 * The `+` matters more than it looks: an uncommitted edit means the sha names
 * a tree that is not the one that ran, so a session stamped `+` cannot be
 * attributed to a commit at all.
 */
export function formatBuild(version: string, git: (args: string[]) => string): string {
  let sha: string;
  try {
    sha = git(["rev-parse", "--short=7", "HEAD"]);
    if (git(["status", "--porcelain"]) !== "") sha += "+";
  } catch {
    // Installed from a tarball, or the checkout is gone. The version is all
    // there is, and saying only that beats inventing a commit.
    return version;
  }
  return `${version}@${sha}`;
}

let cached: string | undefined;

/**
 * The build identity of the running process. Resolved once: the answer cannot
 * change while the process lives, which is the whole reason it is worth
 * recording per session.
 */
export function charretteBuild(): string {
  if (cached === undefined) {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
    cached = formatBuild(version, (args) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    );
  }
  return cached;
}
