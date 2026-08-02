import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexSkills, verifyHash } from "./indexer.js";

/**
 * A skills directory is the operator's own, not something the harness owns, so
 * it can contain anything: a broken symlink, a skill directory the harness
 * cannot read, a file where a directory was expected. None of them may stop the
 * other skills being indexed.
 */

const made: string[] = [];

function skillsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-skills-"));
  made.push(dir);
  return dir;
}

function writeSkill(dir: string, name: string, body = `---\nname: ${name}\ndescription: does ${name} things\n---\n\n# ${name}\n`): string {
  mkdirSync(path.join(dir, name), { recursive: true });
  const file = path.join(dir, name, "SKILL.md");
  writeFileSync(file, body);
  return file;
}

afterEach(() => {
  for (const dir of made.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("indexing a directory the operator controls", () => {
  it("skips an entry it cannot read and keeps the rest", () => {
    const dir = skillsDir();
    // A SKILL.md that is itself a directory: it exists, so the guards above
    // pass, and reading it throws EISDIR. Without the catch, one malformed
    // entry in the operator's own skills directory took every skill after it
    // down with it.
    mkdirSync(path.join(dir, "broken", "SKILL.md"), { recursive: true });
    writeSkill(dir, "good-skill");

    const skills = indexSkills([dir]);

    expect(skills.map((s) => s.name)).toEqual(["good-skill"]);
  });

  it("skips a SKILL.md that points nowhere", () => {
    const dir = skillsDir();
    writeSkill(dir, "good-skill");
    mkdirSync(path.join(dir, "dangling"), { recursive: true });
    symlinkSync(path.join(dir, "nothing-here"), path.join(dir, "dangling", "SKILL.md"));

    expect(indexSkills([dir]).map((s) => s.name)).toEqual(["good-skill"]);
  });

  it("ignores a file sitting where a skill directory would be", () => {
    const dir = skillsDir();
    writeSkill(dir, "good-skill");
    writeFileSync(path.join(dir, "README.md"), "not a skill");

    expect(indexSkills([dir]).map((s) => s.name)).toEqual(["good-skill"]);
  });

  it("ignores a directory that has never been created", () => {
    expect(indexSkills([path.join(tmpdir(), "harness-no-such-skills-dir")])).toEqual([]);
  });

  it("indexes the same skill once when two configured directories are the same place", () => {
    const dir = skillsDir();
    writeSkill(dir, "only-once");
    const link = `${dir}-link`;
    symlinkSync(dir, link);
    made.push(link);

    // ~/skills is commonly a symlink to ~/.claude/skills, and both ship in the
    // default config — indexing twice would crowd the top-k match slots.
    expect(indexSkills([dir, link]).map((s) => s.name)).toEqual(["only-once"]);
  });

  it("falls back to the directory name and the body when there is no frontmatter", () => {
    const dir = skillsDir();
    writeSkill(dir, "bare-skill", "# Just a heading and some prose about what it does.\n");

    const [skill] = indexSkills([dir]);

    expect(skill!.name).toBe("bare-skill");
    expect(skill!.description).toContain("Just a heading");
  });
});

describe("checking a skill still is what was indexed", () => {
  it("confirms an unchanged file", () => {
    const dir = skillsDir();
    writeSkill(dir, "stable");
    const [skill] = indexSkills([dir]);

    expect(verifyHash(skill!)).toBe(true);
  });

  it("rejects a file that changed after it was indexed", () => {
    const dir = skillsDir();
    const file = writeSkill(dir, "edited");
    const [skill] = indexSkills([dir]);
    writeFileSync(file, "---\nname: edited\n---\n\nsomething else entirely\n");

    expect(verifyHash(skill!)).toBe(false);
  });

  it("rejects a file that has gone away rather than throwing", () => {
    const dir = skillsDir();
    writeSkill(dir, "deleted");
    const [skill] = indexSkills([dir]);
    rmSync(path.join(dir, "deleted"), { recursive: true, force: true });

    expect(verifyHash(skill!)).toBe(false);
  });
});
