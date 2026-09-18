import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  agentBinary,
  collectVersion,
  formatVersion,
  scanPackage,
  scanWorkspace,
  sourceRoot,
  type AgentBinary,
  type PackageBuild,
} from "./version.js";

/**
 * The build-freshness check, driven against real files.
 *
 * Mocked `fs` would prove nothing here: what is under test is whether mtimes
 * on disk answer "is `dist/` older than `src/`", and a fake that returns the
 * numbers the test chose has already assumed the answer. The symlink cases
 * matter for the same reason — a `Dirent` for a link is neither file nor
 * directory, and no fake would have told us that.
 */

const EARLY = new Date("2026-09-06T10:00:00Z");
const LATE = new Date("2026-09-06T11:00:00Z");

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), "charrette-version-"));

/** Creates each file and stamps it with the mtime given, parents included. */
function write(dir: string, files: Record<string, Date>): void {
  for (const [rel, at] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "");
    utimesSync(full, at, at);
  }
}

function manifest(dir: string, contents: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), typeof contents === "string" ? contents : JSON.stringify(contents));
}

/** A package whose one source is compiled and current, for cases that vary one thing. */
function pkg(files: Record<string, Date> = {}): string {
  const dir = tmp();
  manifest(dir, { name: "@charrette/x", version: "1.2.3" });
  write(dir, files);
  return dir;
}

const HERE = `${process.platform}-${process.arch}`;

/** An SDK install on disk: a binary of `bytes`, and whatever manifest is given. */
function sdk(bytes: number | null, manifest: unknown = { version: "2.1.257", platforms: { [HERE]: { size: bytes } } }): () => { binary: string; manifest: string } {
  const dir = tmp();
  const binary = path.join(dir, "claude");
  const file = path.join(dir, "manifest.json");
  if (bytes !== null) writeFileSync(binary, "x".repeat(bytes));
  if (manifest !== null) writeFileSync(file, typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  return () => ({ binary, manifest: file });
}

const OK: AgentBinary = { ok: true, version: "2.1.257", path: "/sdk/claude" };

const built = (over: Partial<PackageBuild> = {}): PackageBuild => ({
  name: "@charrette/x",
  version: "0.0.1",
  builtAt: EARLY.getTime(),
  sourceAt: EARLY.getTime(),
  stale: 0,
  ...over,
});

describe("scanPackage", () => {
  it("counts only shipped TypeScript against the build", () => {
    const dir = pkg({
      "src/index.ts": EARLY,
      // None of these three is compiled behaviour, so none of them can make a
      // build stale — a test edited after the last `pnpm build` is not a fix
      // waiting to be compiled.
      "src/index.test.ts": LATE,
      "src/types.d.ts": LATE,
      "src/notes.md": LATE,
      "dist/index.js": LATE,
      "dist/index.js.map": LATE,
    });

    expect(scanPackage(dir)).toEqual({
      name: "@charrette/x",
      version: "1.2.3",
      builtAt: LATE.getTime(),
      sourceAt: EARLY.getTime(),
      stale: 0,
    });
  });

  it("counts a source edited since its own output was written", () => {
    const dir = pkg({ "src/index.ts": LATE, "src/steady.ts": EARLY, "dist/index.js": EARLY, "dist/steady.js": EARLY });

    expect(scanPackage(dir)).toMatchObject({ builtAt: EARLY.getTime(), sourceAt: LATE.getTime(), stale: 1 });
  });

  it("counts a source that was never compiled at all", () => {
    const dir = pkg({ "src/index.ts": EARLY, "src/added.ts": EARLY, "dist/index.js": LATE });

    // `added.ts` is older than the build and still not in it. Comparing
    // timestamps alone would call this package current.
    expect(scanPackage(dir)).toMatchObject({ stale: 1 });
  });

  it("does not let one fresh file in dist/ vouch for the rest of the package", () => {
    // What a `pnpm build` that emits some outputs and then fails leaves behind:
    // the newest `dist` mtime is ahead of every source, while the source that
    // matters has no output of its own.
    const dir = pkg({ "src/index.ts": LATE, "dist/index.js": EARLY, "dist/vendor.bundle.js": LATE });

    expect(scanPackage(dir)).toMatchObject({ builtAt: LATE.getTime(), stale: 1 });
  });

  it("reaches a source in a subdirectory, and matches it to its own output", () => {
    const dir = pkg({
      "src/deep/nested.ts": LATE,
      "dist/deep/nested.js": EARLY,
      "src/deep/fine.ts": EARLY,
      "dist/deep/fine.js": LATE,
    });

    // Every `src/` in this repo is one level deep today, and a check that
    // assumed that would call this package current.
    expect(scanPackage(dir)).toMatchObject({ stale: 1 });
  });

  it("follows a symlinked source directory rather than skipping it in silence", () => {
    const dir = pkg({ "dist/index.js": EARLY });
    const elsewhere = tmp();
    write(elsewhere, { "linked.ts": LATE });
    mkdirSync(path.join(dir, "src"), { recursive: true });
    symlinkSync(elsewhere, path.join(dir, "src", "shared"));

    // A `Dirent` for a symlink reports neither file nor directory, so reading
    // the entry type alone would drop this whole tree and report the package
    // current — the false all-clear the recursion exists to prevent.
    expect(scanPackage(dir)).toMatchObject({ stale: 1, sourceAt: LATE.getTime() });
  });

  it("stops at a symlink that points back up its own tree", () => {
    const dir = pkg({ "src/index.ts": EARLY, "dist/index.js": LATE });
    symlinkSync(path.join(dir, "src"), path.join(dir, "src", "self"));

    expect(scanPackage(dir)).toMatchObject({ stale: 0 });
  });

  it("passes over a dangling symlink instead of dying on it", () => {
    const dir = pkg({ "src/index.ts": EARLY, "dist/index.js": LATE });
    symlinkSync(path.join(dir, "src", "gone.ts"), path.join(dir, "src", "ghost.ts"));
    symlinkSync(path.join(dir, "dist", "gone.js"), path.join(dir, "dist", "ghost.js"));

    // This is the command an operator reaches for when they already suspect
    // the tree is wrong. Throwing ENOENT out of it — printing nothing, not
    // even the sha it was holding — is the one answer it must not give.
    expect(scanPackage(dir)).toMatchObject({ stale: 0, builtAt: LATE.getTime() });
  });

  it("reports a build with no sources beside it", () => {
    expect(scanPackage(pkg({ "dist/index.js": EARLY }))).toMatchObject({ sourceAt: null, stale: 0 });
  });

  it("treats a package that was never built as entirely unbuilt", () => {
    const dir = pkg({ "src/a.ts": EARLY, "src/b.ts": EARLY });

    expect(scanPackage(dir)).toMatchObject({ builtAt: null, sourceAt: EARLY.getTime(), stale: 2 });
  });

  it("keeps a private package that carries no version", () => {
    const dir = tmp();
    manifest(dir, { name: "@charrette/private" });
    write(dir, { "src/a.ts": EARLY });

    // npm does not require a version on a private workspace package. Dropping
    // one would take it out of the count as well as the check — a silent
    // omission from the command whose job is to notice what is missing.
    expect(scanPackage(dir)).toMatchObject({ name: "@charrette/private", version: null, stale: 1 });
  });

  it("is not a package without a readable manifest", () => {
    const malformed = tmp();
    writeFileSync(path.join(malformed, "package.json"), "{ not json");

    expect(scanPackage(tmp())).toBeNull();
    expect(scanPackage(malformed)).toBeNull();
  });

  it("is not a package when the manifest names nothing", () => {
    const unnamed = tmp();
    manifest(unnamed, { version: "1.0.0" });

    expect(scanPackage(unnamed)).toBeNull();
  });
});

describe("scanWorkspace", () => {
  it("reads packages/ then apps/, each in name order, and skips what is not a package", () => {
    const root = tmp();
    manifest(path.join(root, "packages", "shared"), { name: "@charrette/shared", version: "0.0.1" });
    manifest(path.join(root, "packages", "core"), { name: "@charrette/core", version: "0.0.1" });
    manifest(path.join(root, "apps", "cli"), { name: "@charrette/cli", version: "0.0.1" });
    writeFileSync(path.join(root, "packages", "README.md"), "");

    expect(scanWorkspace(root).map((p) => p.name)).toEqual(["@charrette/core", "@charrette/shared", "@charrette/cli"]);
  });

  it("skips a parent directory that does not exist", () => {
    const root = tmp();
    manifest(path.join(root, "packages", "core"), { name: "@charrette/core", version: "0.0.1" });

    expect(scanWorkspace(root).map((p) => p.name)).toEqual(["@charrette/core"]);
  });
});

describe("sourceRoot", () => {
  it("finds the checkout three levels above this module", () => {
    const root = tmp();
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "");
    mkdirSync(path.join(root, "apps", "cli", "dist"), { recursive: true });

    expect(sourceRoot(path.join(root, "apps", "cli", "dist"))).toBe(root);
  });

  it("is null when what is three levels up is not a workspace", () => {
    const root = tmp();
    mkdirSync(path.join(root, "node_modules", "@charrette", "cli"), { recursive: true });

    expect(sourceRoot(path.join(root, "node_modules", "@charrette", "cli"))).toBeNull();
  });
});

describe("collectVersion", () => {
  it("carries the build string and scans the workspace it was run out of", () => {
    const root = tmp();
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "");
    manifest(path.join(root, "packages", "core"), { name: "@charrette/core", version: "0.0.1" });

    const info = collectVersion("0.0.1@7453d60", path.join(root, "apps", "cli", "dist"), sdk(64));

    expect(info).toMatchObject({ build: "0.0.1@7453d60", root, node: process.version });
    expect(info.platform).toBe(`${process.platform} ${process.arch}`);
    expect(info.packages.map((p) => p.name)).toEqual(["@charrette/core"]);
  });

  it("scans nothing when the binary is not running out of a checkout", () => {
    const info = collectVersion("0.0.1", path.join(tmp(), "node_modules", "@charrette", "cli"), sdk(64));

    expect(info.root).toBeNull();
    expect(info.packages).toEqual([]);
  });
});

describe("formatVersion", () => {
  it("says there is nothing to compare when there is no checkout", () => {
    const text = formatVersion({ build: "0.0.1", node: "v22.0.0", platform: "linux x64", root: null, packages: [], agent: OK });

    expect(text).toContain("charrette    0.0.1\n");
    expect(text).toContain("node       v22.0.0 (linux x64)");
    expect(text).toContain("installed, not a checkout");
    // Off a tarball a bare version is the whole truth, so nothing is flagged
    // and nothing may tell the operator to rebuild.
    expect(text).not.toContain("no commit");
    expect(text).not.toContain("pnpm build");
  });

  it("names a build that could not be attributed to a commit", () => {
    const text = formatVersion({ build: "0.0.1", node: "v22.0.0", platform: "linux x64", root: "/repo", packages: [], agent: OK });

    // A bare version printed above the checkout it was read from states two
    // things that contradict each other, and hides that the `+` for a dirty
    // tree is missing too — so a modified checkout and a clean one would stamp
    // their sessions identically.
    expect(text).toContain("charrette    0.0.1   (no commit — git did not answer here)");
  });

  it("says so loudly when no agent session could start", () => {
    const text = formatVersion({
      build: "0.0.1@7453d60",
      node: "v22.0.0",
      platform: "linux x64",
      root: "/repo",
      packages: [built()],
      agent: { ok: false, why: "the platform package holds no claude — it unpacked as an empty directory" },
    });

    // The build lines above can all be green while this one is not: run
    // de2cb7aa was resumed onto a current build and a compiled tree, and died
    // on the first agent it tried to spawn.
    expect(text).toContain("agent sdk  BROKEN — the platform package holds no claude");
    expect(text).toContain("no agent session can start; reinstall @anthropic-ai/claude-agent-sdk");
    expect(text).toContain("Every package is built from the source that is on disk (1 checked).");
  });

  it("reports every package current, with the newest build time", () => {
    const text = formatVersion({
      build: "0.0.1@7453d60",
      node: "v22.0.0",
      platform: "linux x64",
      root: "/repo",
      agent: OK,
      packages: [built(), built({ name: "@charrette/y", builtAt: LATE.getTime() })],
    });

    expect(text).toContain("source     /repo");
    expect(text).toContain("built      2026-09-06T11:00:00Z");
    expect(text).toContain("Every package is built from the source that is on disk (2 checked).");
    expect(text).not.toContain("behind their source");
    expect(text).not.toContain("no commit");
  });

  it("says `never` when nothing in the workspace has been built", () => {
    const text = formatVersion({
      build: "0.0.1@7453d60",
      node: "v22.0.0",
      platform: "linux x64",
      root: "/repo",
      agent: OK,
      packages: [built({ builtAt: null, sourceAt: null })],
    });

    expect(text).toContain("built      never");
  });

  it("names each package behind its source, and tells the operator to build", () => {
    const text = formatVersion({
      build: "0.0.1@7453d60",
      node: "v22.0.0",
      platform: "linux x64",
      root: "/repo",
      agent: OK,
      packages: [
        built({ name: "@charrette/core", stale: 2, sourceAt: LATE.getTime() }),
        built({ name: "@charrette/dashboard", builtAt: null, stale: 1, sourceAt: LATE.getTime() }),
        built({ name: "@charrette/shared" }),
      ],
    });

    expect(text).toContain("2 of 3 package(s) are behind their source:");
    // Padded to the longest name that is actually listed, so the counts line up.
    expect(text).toContain("  @charrette/core       2 file(s) newer than the build of 2026-09-06T10:00:00Z");
    expect(text).toContain("  @charrette/dashboard  1 file(s) newer, never built");
    expect(text).not.toContain("@charrette/shared");
    // The line the command exists for: a clean sha above says which commit is
    // checked out, not which one is compiled.
    expect(text).toContain("Node loads `dist/`, not `src/` — run `pnpm build` before trusting a fix is live.");
  });
});

describe("agentBinary", () => {
  it("reports the version the SDK's own manifest declares", () => {
    const found = agentBinary(sdk(64));

    expect(found).toMatchObject({ ok: true, version: "2.1.257" });
  });

  it("says the platform package is missing when it cannot be resolved", () => {
    const found = agentBinary(() => {
      throw new Error("Cannot find module '@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json'");
    });

    // The failure that produced this check: an optional dependency that never
    // downloaded, which npm and pnpm both record as installed.
    expect(found).toMatchObject({ ok: false });
    expect((found as { why: string }).why).toContain("optional");
  });

  it("says the package unpacked empty when the binary is not in it", () => {
    // Exactly what was on this machine: a valid symlink to a 0-byte directory.
    expect(agentBinary(sdk(null))).toEqual({ ok: false, why: "the platform package holds no claude — it unpacked as an empty directory" });
    expect(agentBinary(sdk(0))).toMatchObject({ ok: false });
  });

  it("catches a binary that is present but the wrong size", () => {
    const found = agentBinary(sdk(64, { version: "2.1.257", platforms: { [HERE]: { size: 199_011_264 } } }));

    // A half-written 190MB download is the same class of failure as an absent
    // one, and it resolves and stats perfectly well.
    expect(found).toMatchObject({ ok: false });
    expect((found as { why: string }).why).toContain("truncated");
  });

  it("accepts the binary when the manifest cannot say how big it should be", () => {
    // Unreadable, malformed, and describing other platforms only — one answer
    // to all three: nothing to compare against, so presence is what is known.
    for (const manifest of [null, "{ not json", { version: "2.1.257", platforms: { "sunos-sparc": { size: 1 } } }])
      expect(agentBinary(sdk(64, manifest))).toEqual({ ok: true, version: "unknown", path: expect.stringContaining("claude") });
  });
});
