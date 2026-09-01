import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexSkills, type IndexedSkill } from "@harness/skills-mcp";
import { pinsInPlay, skillPinBanner, skillPinLines, unresolvedRoleSkills } from "./skillPins.js";

/**
 * A `roleSkills` pin is a name, and names are matched against a collection the
 * harness does not own. Until this existed, a pin that matched nothing was
 * dropped without a word — including the default `spec` → `prd-to-tdd`, whose
 * absence changes what the run is judged against and nothing else that anyone
 * can see.
 */

const made: string[] = [];

function skillsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-pins-"));
  made.push(dir);
  return dir;
}

function writeSkill(dir: string, name: string): void {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: does ${name} things\n---\n\n# ${name}\n`);
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("finding the pins this machine cannot honour", () => {
  it("says nothing when every pinned skill is indexed", () => {
    const dir = skillsDir();
    writeSkill(dir, "prd-to-tdd");
    writeSkill(dir, "product-manager");

    expect(unresolvedRoleSkills(indexSkills([dir]), { spec: ["prd-to-tdd"], planner: ["product-manager"] })).toEqual([]);
  });

  it("names the role, the skill and why it will not be injected", () => {
    const dir = skillsDir();
    writeSkill(dir, "product-manager");

    expect(unresolvedRoleSkills(indexSkills([dir]), { intake: ["product-manager"], spec: ["prd-to-tdd"] })).toEqual([
      { role: "spec", skill: "prd-to-tdd", reason: "missing" },
    ]);
  });

  it("reports a role pinned to several skills once per unresolved name", () => {
    expect(unresolvedRoleSkills([], { qa: ["visual-qa-agent", "qa-agent"] })).toEqual([
      { role: "qa", skill: "visual-qa-agent", reason: "missing" },
      { role: "qa", skill: "qa-agent", reason: "missing" },
    ]);
  });

  /**
   * The other way injection drops a pin in silence: SEC-14 re-hashes at
   * injection time, so a skill edited after indexing is skipped exactly as a
   * missing one is. The check asks the question the same way, so it sees the
   * same thing.
   */
  it("counts an indexed skill whose bytes no longer match as unresolved", () => {
    const dir = skillsDir();
    writeSkill(dir, "prd-to-tdd");
    const stale = indexSkills([dir]).map((s): IndexedSkill => ({ ...s, sha256: "not-what-is-on-disk" }));

    expect(unresolvedRoleSkills(stale, { spec: ["prd-to-tdd"] })).toEqual([
      { role: "spec", skill: "prd-to-tdd", reason: "changed" },
    ]);
  });
});

describe("pins for a phase this run will not reach", () => {
  it("keeps every pin when the spec phase is on", () => {
    const roleSkills = { intake: ["product-manager"], spec: ["prd-to-tdd"] };

    expect(pinsInPlay({ roleSkills, spec: { enabled: true } })).toEqual(roleSkills);
  });

  it("drops the spec pin when the phase that would carry it is off", () => {
    const roleSkills = { intake: ["product-manager"], spec: ["prd-to-tdd"] };

    expect(pinsInPlay({ roleSkills, spec: { enabled: false } })).toEqual({ intake: ["product-manager"] });
  });
});

describe("the startup banner", () => {
  it("stays quiet when there is nothing the operator needs to fix", () => {
    const dir = skillsDir();
    writeSkill(dir, "prd-to-tdd");

    expect(skillPinBanner([dir], { spec: ["prd-to-tdd"] })).toEqual([]);
  });

  it("spells out what a run without prd-to-tdd is judged against", () => {
    const text = skillPinBanner([skillsDir()], { spec: ["prd-to-tdd"] }).join("\n");

    expect(text).toContain("spec is pinned to prd-to-tdd, which is in none of those directories");
    expect(text).toContain("the acceptance gate holds the run to whatever it invents");
    expect(text).toContain("put it in one of those directories, or drop the pin from roleSkills");
  });

  it("keeps every other role's consequence to what it actually is", () => {
    const text = skillPinBanner([skillsDir()], { planner: ["product-manager"] }).join("\n");

    expect(text).toContain("planner is pinned to product-manager");
    expect(text).toContain("the planner agent runs without it");
    expect(text).not.toContain("acceptance gate");
  });

  it("reports only the pin that failed when a role's collection is half there", () => {
    const dir = skillsDir();
    writeSkill(dir, "prd-to-tdd");

    const text = skillPinBanner([dir], { spec: ["prd-to-tdd"], qa: ["qa-agent"] }).join("\n");

    expect(text).toContain("qa is pinned to qa-agent, which is in none of those directories");
    expect(text).not.toContain("prd-to-tdd");
  });

  it("distinguishes a skill that changed under the index from one that was never there", () => {
    const text = skillPinLines([{ role: "spec", skill: "prd-to-tdd", reason: "changed" }]).join("\n");

    expect(text).toContain("which changed on disk since it was read, so injection skips it too");
    expect(text).not.toContain("in none of those directories");
  });

  it("indents under the skills line rather than starting a column of its own", () => {
    for (const line of skillPinBanner([skillsDir()], { spec: ["prd-to-tdd"] })) {
      expect(line.startsWith("           ")).toBe(true);
      expect(line.trim()).not.toBe("");
    }
  });
});
