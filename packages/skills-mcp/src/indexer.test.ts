import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { indexSkills, matchSkills, verifyHash, type IndexedSkill } from "./indexer.js";

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

  it("reads aliases, tags and delegates_to, and matches on aliases", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "skills-fm-"));
    mkdirSync(path.join(dir, "spec-clarifier"));
    writeFileSync(
      path.join(dir, "spec-clarifier", "SKILL.md"),
      "---\nname: spec-clarifier\ndescription: Interrogate a prompt until nothing is ambiguous\n" +
        "aliases: disambiguate, requirements interview\ntags: [requirements, ambiguity]\n" +
        "delegates_to: feedback-provider, prd-to-tdd\n---\nBody."
    );
    mkdirSync(path.join(dir, "branding"));
    writeFileSync(path.join(dir, "branding", "SKILL.md"), "---\nname: branding\ndescription: Brand names and voice\n---\nBody.");
    const skills = indexSkills([dir]);
    const clarifier = skills.find((s) => s.name === "spec-clarifier")!;
    expect(clarifier.aliases).toEqual(["disambiguate", "requirements interview"]);
    expect(clarifier.tags).toEqual(["requirements", "ambiguity"]);
    expect(clarifier.delegatesTo).toEqual(["feedback-provider", "prd-to-tdd"]);
    // "disambiguate" appears only in the alias line, never in name, description or body.
    expect(matchSkills(skills, "please disambiguate this request", 3)[0]!.skill.name).toBe("spec-clarifier");
  });

  // An IndexedSkill built by hand, or by an index written before these fields
  // existed, carries no aliases or tags; matching must not trip over that.
  it("matches a skill that carries no aliases or tags", () => {
    const bare: IndexedSkill = { name: "stripe-setup", description: "Configure Stripe checkout", path: "/x/SKILL.md", sha256: "0", body: "Stripe.", tokensApprox: 2 };
    expect(matchSkills([bare], "set up stripe checkout", 3)[0]!.skill.name).toBe("stripe-setup");
  });
});
