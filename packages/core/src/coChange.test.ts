import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coChangeIndex, coChangeNote, emptyCoChange } from "./coChange.js";

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-cochange-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  return dir;
}

/** One commit touching exactly these files. The body is what makes each commit distinct. */
function commit(dir: string, files: string[], body = String(Math.random())): void {
  for (const f of files) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), body);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "c"], { cwd: dir, stdio: "ignore" });
}

/** `times` commits that each ship the same set together. */
function habit(dir: string, files: string[], times: number): void {
  for (let i = 0; i < times; i++) commit(dir, files, `${files.join()}-${i}`);
}

describe("reading what a repository ships together", () => {
  it("names the file a declared one has always arrived with", async () => {
    const dir = repo();
    habit(dir, ["src/api.ts", "src/api.test.ts"], 3);
    const index = await coChangeIndex(dir);
    expect(index.widen(["src/api.ts"])).toEqual(["src/api.test.ts"]);
  });

  it("does not name a file seen alongside only once, which is a coincidence", async () => {
    const dir = repo();
    commit(dir, ["src/api.ts", "src/unrelated.ts"]);
    commit(dir, ["src/api.ts"], "b");
    expect((await coChangeIndex(dir)).widen(["src/api.ts"])).toEqual([]);
  });

  it("never repeats a path that was already declared", async () => {
    const dir = repo();
    habit(dir, ["src/api.ts", "src/api.test.ts"], 3);
    expect((await coChangeIndex(dir)).widen(["src/api.ts", "src/api.test.ts"])).toEqual([]);
  });

  it("puts the stronger habit first", async () => {
    const dir = repo();
    habit(dir, ["src/api.ts", "src/rare.ts"], 2);
    habit(dir, ["src/api.ts", "src/constant.ts"], 6);
    expect((await coChangeIndex(dir)).widen(["src/api.ts"])).toEqual(["src/constant.ts", "src/rare.ts"]);
  });

  it("adds at most three files, however many the task named", async () => {
    // The bound is on the task, not on each path: a task naming six files must
    // not drag in eighteen.
    const dir = repo();
    for (const n of ["a", "b", "c", "d", "e", "f"]) habit(dir, [`src/${n}.ts`, `src/${n}-helper.ts`], 3);
    const widened = (await coChangeIndex(dir)).widen(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"]);
    expect(widened).toHaveLength(3);
  });

  it("ignores a sweeping commit, because a formatter did not mean those files belong together", async () => {
    // 60 files in one commit is a rename or a reformat. Counted, it would link
    // every file it touched to every other — the exact shape that makes every
    // task collide with every other task.
    const dir = repo();
    const sweep = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`);
    habit(dir, sweep, 3);
    expect((await coChangeIndex(dir)).widen(["src/f0.ts"])).toEqual([]);
  });

  it("refuses to suggest the files that ship with everything", async () => {
    // A lockfile carries no information about what a particular change touches,
    // and letting one in links every task to every other.
    const dir = repo();
    for (let i = 0; i < 30; i++) habit(dir, [`src/f${i}.ts`, "pnpm-lock.yaml"], 2);
    const index = await coChangeIndex(dir);
    expect(index.hubs).toEqual(["pnpm-lock.yaml"]);
    expect(index.widen(["src/f0.ts"])).not.toContain("pnpm-lock.yaml");
  });

  it("reads a hub as a share of the tree, so a small repo is judged like a large one", async () => {
    // 31 files, one of which ships with 14 of them. A rank-based rule would have
    // called the single most-connected file in *any* repository a hub; this one
    // asks how much of the tree it actually reaches.
    const dir = repo();
    for (let i = 0; i < 14; i++) habit(dir, [`src/f${i}.ts`, "docs/OPERATIONS.md"], 2);
    for (let i = 0; i < 8; i++) habit(dir, [`lib/g${i}.ts`, `lib/g${i}.test.ts`], 2);
    const index = await coChangeIndex(dir);
    expect(index.hubs).toEqual(["docs/OPERATIONS.md"]);
    expect(index.widen(["src/f0.ts"])).toEqual([]);
    expect(index.widen(["lib/g0.ts"])).toEqual(["lib/g0.test.ts"]);
  });

  it("does not call the best answer a hub just because the repository is small", async () => {
    // In a two-file index everything reaches all of it. Left alone, the hub rule
    // would delete the only answer such a repository has.
    const dir = repo();
    habit(dir, ["src/api.ts", "src/api.test.ts"], 3);
    const index = await coChangeIndex(dir);
    expect(index.hubs).toEqual([]);
    expect(index.widen(["src/api.ts"])).toEqual(["src/api.test.ts"]);
  });

  it("reads a path the way the collision test spells it", async () => {
    // `./src/api.ts` and `src/api.ts` are one file. If the index disagreed with
    // `pathsCollide` about that, a widened path would never match anything.
    const dir = repo();
    habit(dir, ["src/api.ts", "src/api.test.ts"], 3);
    expect((await coChangeIndex(dir)).widen(["./src/api.ts"])).toEqual(["src/api.test.ts"]);
  });

  it("has nothing to say about a file that does not exist yet", async () => {
    // The ordinary case for a greenfield task: the planner names a path the
    // repository has never had. It must widen from the paths it does know
    // rather than going silent on the whole task.
    const dir = repo();
    habit(dir, ["src/api.ts", "src/api.test.ts"], 3);
    const index = await coChangeIndex(dir);
    expect(index.widen(["src/brand-new.ts"])).toEqual([]);
    expect(index.widen(["src/brand-new.ts", "src/api.ts"])).toEqual(["src/api.test.ts"]);
  });

  it("says how much history it read, so the operator can judge it", async () => {
    const dir = repo();
    habit(dir, ["src/api.ts", "src/api.test.ts"], 3);
    const index = await coChangeIndex(dir);
    expect(index.commits).toBe(3);
    expect(index.files).toBe(2);
  });
});

describe("a repository it cannot learn anything from", () => {
  it("widens nothing when there are no commits", async () => {
    const index = await coChangeIndex(repo());
    expect(index.commits).toBe(0);
    expect(index.widen(["src/api.ts"])).toEqual([]);
  });

  it("widens nothing when every commit touched one file", async () => {
    // Nothing has ever shipped *with* anything, so there is no habit to read.
    const dir = repo();
    commit(dir, ["a.ts"]);
    commit(dir, ["b.ts"]);
    expect((await coChangeIndex(dir)).widen(["a.ts"])).toEqual([]);
  });

  it("widens nothing when the history cannot tell files apart", async () => {
    // A young project where every commit is a whole vertical slice really has
    // shipped most of its files with most of its others, so "what does this one
    // usually arrive with" has no answer. Measured, the harness's own repository
    // is on this side of the line and every suggestion it produced was noise.
    const dir = repo();
    const everything = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
    for (let i = 0; i < 6; i++) commit(dir, everything, `slice-${i}`);
    const index = await coChangeIndex(dir);
    expect(index.informative).toBe(false);
    expect(index.widen(["src/f0.ts"])).toEqual([]);
  });

  it("does not throw on a directory that is not a repository", async () => {
    // A run must never die because history was unreadable — it falls back to
    // exactly the behaviour it had before this existed.
    const index = await coChangeIndex(mkdtempSync(path.join(tmpdir(), "harness-norepo-")));
    expect(index.commits).toBe(0);
    expect(index.widen(["a.ts"])).toEqual([]);
  });

  it("widens nothing when the task declared no paths", async () => {
    const dir = repo();
    habit(dir, ["src/api.ts", "src/api.test.ts"], 3);
    expect((await coChangeIndex(dir)).widen([])).toEqual([]);
    expect((await coChangeIndex(dir)).widen(["  "])).toEqual([]);
  });

  it("has an empty index for callers with no repository at all", () => {
    const index = emptyCoChange();
    expect(index).toMatchObject({ commits: 0, files: 0, hubs: [], informative: false });
    expect(index.widen(["a.ts"])).toEqual([]);
  });
});

describe("telling the operator what the scheduler will do differently", () => {
  it("says what it read and what it will hold paths against", async () => {
    const dir = repo();
    habit(dir, ["src/api.ts", "src/api.test.ts"], 3);
    const note = coChangeNote(await coChangeIndex(dir));
    expect(note).toContain("2 files across 3 commits");
    expect(note).toContain("up to 3 files");
  });

  it("says so plainly when the history cannot tell files apart", async () => {
    const dir = repo();
    const everything = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
    for (let i = 0; i < 6; i++) commit(dir, everything, `slice-${i}`);
    const note = coChangeNote(await coChangeIndex(dir));
    expect(note).toContain("too much of the tree at once");
    expect(note).toContain("as before");
  });

  it("says there was no history rather than staying silent about it", () => {
    // A run whose throughput changed for a reason nobody announced is a run
    // whose throughput has no explanation. So is one whose throughput did not.
    expect(coChangeNote(emptyCoChange())).toContain("no usable history");
    expect(coChangeNote(emptyCoChange())).toContain("as before");
  });
});
