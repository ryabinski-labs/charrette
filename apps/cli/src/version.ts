import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * What this binary is, and whether it is the thing the source says it is.
 *
 * `charretteBuild()` in core answers the first half — `version@sha`, with a `+`
 * when the checkout is dirty — and stamps it on every agent session so a run
 * can be attributed to a commit. The half a sha cannot answer is that Node
 * loads `dist/`, not `src/`: a fix that is committed but never compiled leaves
 * a *clean* sha standing in front of an old build, and the sha then names a
 * tree that is not the one running.
 *
 * That is `build.ts`'s failure one step earlier in the chain. There, run
 * 40da9337 never got the isolation fix because the process carrying it had
 * started before the commit; here a process started after the commit gets the
 * same nothing, because `pnpm build` had not run in between. Both end with an
 * operator reading `git log` and concluding a fix is live when it is not, and
 * neither used to leave a trace — a stale build is invisible from inside the
 * process it produced.
 *
 * So `charrette version` prints the sha to say which tree, and the build times
 * below to say whether that tree is the one executing.
 */

/** One workspace package as it sits on disk: what it claims, and what is compiled. */
export type PackageBuild = {
  name: string;
  /** Absent on a private workspace package, which npm does not require to carry one. */
  version: string | null;
  /** Newest mtime under `dist/`, or null when the package has never been built. */
  builtAt: number | null;
  /** Newest mtime among its shipped sources, or null when none are present. */
  sourceAt: number | null;
  /** Sources with no compiled output, or one older than they are. */
  stale: number;
};

/** Whether the Claude Code binary every agent session is spawned from is installed and whole. */
export type AgentBinary = { ok: true; version: string; path: string } | { ok: false; why: string };

export type VersionInfo = {
  /** `charretteBuild()`: `version@sha`, `+` for a dirty checkout, bare version off a tarball. */
  build: string;
  node: string;
  platform: string;
  /** The checkout this binary runs out of, or null when it was installed rather than built. */
  root: string | null;
  packages: PackageBuild[];
  agent: AgentBinary;
};

/** Compiled output, including the built tests: `tsc` writes them in the same pass. */
const isBuilt = (name: string): boolean => name.endsWith(".js");

/** What `tsc` reads. Tests and ambient declarations are not shipped behaviour. */
const isSource = (name: string): boolean =>
  name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts");

/**
 * Every matching file under `dir`, keyed by its path relative to `dir`.
 *
 * Recursive even though every `src/` in this repo is flat today, because the
 * cost of the alternative is silent: a check that stops at the top level of a
 * package that has since grown a subdirectory reports "current" while ignoring
 * the files that changed, which is worse than not checking at all.
 *
 * Each entry is `stat`ed rather than read off the `Dirent`, which costs a
 * syscall and buys two things. A symlinked *directory* is followed — `Dirent`
 * reports it as neither file nor directory, so it would otherwise be skipped
 * in silence, which is the same false all-clear this recursion exists to
 * prevent. And a *dangling* symlink resolves to nothing and is passed over
 * instead of throwing ENOENT out of the whole command: this is the diagnostic
 * an operator reaches for when they already suspect the tree is wrong, and it
 * has to survive a wrong tree to be worth having.
 */
function walk(dir: string, keep: (name: string) => boolean): Map<string, number> {
  const found = new Map<string, number>();
  // Real paths, because following symlinked directories makes a cycle
  // reachable, and `src/here -> ..` should not recurse until the stack ends.
  const seen = new Set<string>();
  const visit = (at: string, prefix: string): void => {
    let entries: Dirent[];
    let real: string;
    try {
      real = realpathSync(at);
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      // Never built, sources not shipped, or a directory this process cannot
      // read. All are answers this command reports, not failures to abort on.
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      const stat = statSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) visit(full, `${prefix}${entry.name}/`);
      else if (keep(entry.name)) found.set(`${prefix}${entry.name}`, stat.mtimeMs);
    }
  };
  visit(dir, "");
  return found;
}

const newest = (times: Map<string, number>): number | null =>
  times.size ? Math.max(...times.values()) : null;

/** The package in `dir`, or null when it is not one — a stray file or directory. */
export function scanPackage(dir: string): PackageBuild | null {
  let manifest: { name?: string; version?: string };
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as typeof manifest;
  } catch {
    return null;
  }
  const { name, version } = manifest;
  // Only the name is required. `version` is optional on a private workspace
  // package, and dropping such a package would take it out of the count as
  // well as the check — a silent omission from the one command whose whole
  // job is to notice what is missing.
  if (!name) return null;
  const source = walk(path.join(dir, "src"), isSource);
  const compiled = walk(path.join(dir, "dist"), isBuilt);
  let stale = 0;
  for (const [rel, at] of source) {
    // Each source against *its own* output, not against the package's newest.
    // A build that emits some files and then fails leaves the newest `dist`
    // mtime ahead of every source, and a whole-package comparison reports that
    // tree as built — the exact false all-clear this command exists to catch.
    const out = compiled.get(rel.replace(/\.ts$/, ".js"));
    if (out === undefined || out < at) stale += 1;
  }
  return { name, version: version ?? null, builtAt: newest(compiled), sourceAt: newest(source), stale };
}

/**
 * Every workspace package.
 *
 * The two parents are the `packages:` globs in `pnpm-workspace.yaml`, copied
 * rather than read — there is no YAML parser in this package and a hand-rolled
 * one is a worse bet than a list that changes about once a year. A third root
 * added there has to be added here too, or it goes unchecked.
 */
export function scanWorkspace(root: string): PackageBuild[] {
  const found: PackageBuild[] = [];
  for (const parent of ["packages", "apps"]) {
    let children: string[];
    try {
      children = readdirSync(path.join(root, parent));
    } catch {
      continue;
    }
    for (const child of children.sort()) {
      const pkg = scanPackage(path.join(root, parent, child));
      if (pkg) found.push(pkg);
    }
  }
  return found;
}

/**
 * What the SDK's manifest says its binary should be, or null when the manifest
 * cannot be read or does not describe this platform.
 *
 * Every shape check is the `catch`: a manifest missing `platforms`, missing
 * this platform's entry, or missing `size` throws on the way through, and the
 * answer to all three is the same one — nothing to compare against.
 */
function declared(file: string): { version: string; size: number } | null {
  try {
    const { version, platforms } = JSON.parse(readFileSync(file, "utf8")) as {
      version: string;
      platforms: Record<string, { size: number }>;
    };
    // Destructured rather than checked: a manifest with no entry for this
    // platform throws here and lands in the same `catch` as an unreadable one.
    const { size } = platforms[`${process.platform}-${process.arch}`] as { size: number };
    return { version, size };
  } catch {
    return null;
  }
}

/**
 * Whether the agent SDK can actually start a session.
 *
 * The platform package carrying the Claude Code binary is an optional
 * dependency, so a fetch that never happened is not an install failure: the
 * symlink is written, `.modules.yaml` records the install as complete, and the
 * 190MB payload is simply absent. Nothing reports it until an agent is spawned
 * — which, for a charrette, means finding out by restarting a run.
 *
 * Size is checked as well as presence because the failure that produced this
 * check was a package that existed and was empty, and a half-written 190MB
 * download is the same class of thing.
 */
export function agentBinary(files: () => { binary: string; manifest: string }): AgentBinary {
  let binary: string;
  let manifest: string;
  try {
    ({ binary, manifest } = files());
  } catch {
    return {
      ok: false,
      why: `no @anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch} package — the SDK's platform dependency is optional, and one that never downloaded still records as installed`,
    };
  }
  const bytes = statSync(binary, { throwIfNoEntry: false })?.size ?? 0;
  const want = declared(manifest);
  if (bytes === 0) return { ok: false, why: `the platform package holds no ${path.basename(binary)} — it unpacked as an empty directory` };
  if (want !== null && want.size !== bytes)
    return { ok: false, why: `${path.basename(binary)} is ${bytes} bytes, not the ${want.size} its manifest declares — the download was truncated` };
  return { ok: true, version: want === null ? "unknown" : want.version, path: binary };
}

/**
 * The checkout `from` lives in, or null when there is none.
 *
 * `from` is this module's own directory, which is three levels down from the
 * root whether it is `apps/cli/dist/` in a build or `apps/cli/src/` under
 * vitest — so the same walk answers for both, and the workspace file is what
 * proves the guess landed somewhere real rather than in a parent of wherever
 * npm unpacked the tarball.
 */
export function sourceRoot(from: string): string | null {
  const root = path.resolve(from, "..", "..", "..");
  return existsSync(path.join(root, "pnpm-workspace.yaml")) ? root : null;
}

export function collectVersion(build: string, from: string, sdk: () => { binary: string; manifest: string }): VersionInfo {
  const root = sourceRoot(from);
  return {
    build,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    root,
    agent: agentBinary(sdk),
    // No checkout, no `src/` for a build to be behind: the question the
    // package list exists to answer cannot be asked, so it is not answered.
    packages: root === null ? [] : scanWorkspace(root),
  };
}

/** UTC to the second — the same shape `.charrette/charrette.log` stamps process starts with. */
const stamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export function formatVersion(info: VersionInfo): string {
  // A build string with no `@sha` means `formatBuild` could not run git.
  // Off a tarball that is the whole truth. Out of a checkout it is a failure,
  // and printing a bare `0.0.1` above the path it was read from states two
  // things that contradict each other — while hiding that the `+` marking a
  // dirty tree is absent too, so a modified checkout and a clean one stamp
  // their sessions identically. That is the unattributable build this whole
  // command was written to end, so it is named rather than left to be read.
  const noCommit = info.root !== null && !info.build.includes("@");
  const lines = [
    `charrette    ${info.build}${noCommit ? "   (no commit — git did not answer here)" : ""}`,
    `node       ${info.node} (${info.platform})`,
  ];
  lines.push(
    info.agent.ok
      ? `agent sdk  claude ${info.agent.version}`
      : `agent sdk  BROKEN — ${info.agent.why}\n           no agent session can start; reinstall @anthropic-ai/claude-agent-sdk`
  );
  if (info.root === null) {
    lines.push("source     installed, not a checkout — nothing to be out of date with");
    return `${lines.join("\n")}\n`;
  }
  lines.push(`source     ${info.root}`);

  const builds = info.packages.map((p) => p.builtAt).filter((at): at is number => at !== null);
  lines.push(builds.length ? `built      ${stamp(Math.max(...builds))}` : "built      never");

  const behind = info.packages.filter((p) => p.stale > 0);
  if (!behind.length) {
    lines.push("", `Every package is built from the source that is on disk (${info.packages.length} checked).`);
    return `${lines.join("\n")}\n`;
  }
  const width = Math.max(...behind.map((p) => p.name.length));
  lines.push("", `${behind.length} of ${info.packages.length} package(s) are behind their source:`);
  for (const p of behind)
    lines.push(
      `  ${p.name.padEnd(width)}  ${p.stale} file(s) newer${p.builtAt === null ? ", never built" : ` than the build of ${stamp(p.builtAt)}`}`
    );
  // The point of the whole command. An operator who reads a clean sha above
  // and stops there has been told the fix is live by a line that only knows
  // which commit is checked out.
  lines.push("", "Node loads `dist/`, not `src/` — run `pnpm build` before trusting a fix is live.");
  return `${lines.join("\n")}\n`;
}
