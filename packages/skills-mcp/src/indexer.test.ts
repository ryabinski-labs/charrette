import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { indexSkills, matchSkills, verifyHash } from "./indexer.js";

function fixtureDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "skills-"));
  mkdirSync(path.join(dir, "stripe-setup"));
  writeFileSync(
    path.join(dir, "stripe-setup", "SKILL.md"),
    `---\nname: stripe-setup\ndescription: Configure Stripe checkout, billing, and webhooks\n---\nHow to set up Stripe payments, checkout sessions, webhooks.`
  );
  mkdirSync(path.join(dir, "qa-agent"));
  writeFileSync(
    path.join(dir, "qa-agent", "SKILL.md"),
    `---\nname: qa-agent\ndescription: End-to-end testing and regression tests\n---\nRun end-to-end tests, write regression tests, capture evidence.`
  );
  return dir;
}

describe("skills indexer", () => {
  it("indexes SKILL.md files with frontmatter and hashes", () => {
    const skills = indexSkills([fixtureDir()]);
    expect(skills.map((s) => s.name).sort()).toEqual(["qa-agent", "stripe-setup"]);
    expect(skills[0]!.sha256).toHaveLength(64);
  });

  it("matches by relevance and skips unrelated skills", () => {
    const skills = indexSkills([fixtureDir()]);
    const matches = matchSkills(skills, "Add Stripe checkout payment flow with webhooks", 3);
    expect(matches[0]!.skill.name).toBe("stripe-setup");
  });

  it("verifyHash detects tampering (SEC-14)", () => {
    const dir = fixtureDir();
    const skills = indexSkills([dir]);
    const skill = skills.find((s) => s.name === "stripe-setup")!;
    expect(verifyHash(skill)).toBe(true);
    writeFileSync(skill.path, "tampered content");
    expect(verifyHash(skill)).toBe(false);
  });

  it("ignores missing directories", () => {
    expect(indexSkills(["/nonexistent/path"])).toEqual([]);
  });

  it("indexes each skill once when the configured dirs alias the same location", () => {
    // The real-world default: ~/skills is a symlink to ~/.claude/skills and
    // both are in skillsDirs — every skill used to index twice.
    const dir = fixtureDir();
    const link = path.join(mkdtempSync(path.join(os.tmpdir(), "skills-alias-")), "skills");
    symlinkSync(dir, link);
    const skills = indexSkills([dir, link]);
    expect(skills.map((s) => s.name).sort()).toEqual(["qa-agent", "stripe-setup"]);
  });
});
