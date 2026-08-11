import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extendForged, FORGED_TOKEN_CAP, forgeDir, installForged, SkillForgeDecision, validateDraft } from "./skillForge.js";
import { skillsmithPrompt, skillsmithSystemPrompt } from "./prompts.js";

const dir = () => mkdtempSync(path.join(tmpdir(), "forge-"));
const prov = { runId: "r1", taskId: "t1" };

describe("validateDraft", () => {
  it("normalizes a display name into a slug and flattens the description", () => {
    const draft = validateDraft(
      { name: "  DynamoDB Single-Table!! Design ", description: "one\ntwo   three", body: "the playbook" },
      new Set()
    );
    expect(draft).toEqual({ slug: "dynamodb-single-table-design", description: "one two three", body: "the playbook" });
  });

  it("rejects a name that reduces to nothing usable, in either direction", () => {
    expect(validateDraft({ name: "a!", description: "d", body: "b" }, new Set())).toHaveProperty("error");
    expect(validateDraft({ name: "x".repeat(80), description: "d", body: "b" }, new Set())).toHaveProperty("error");
  });

  it("refuses to shadow a name the run can already see — routing addresses skills by name", () => {
    const out = validateDraft({ name: "QA Playbook", description: "d", body: "b" }, new Set(["qa-playbook"]));
    expect(out).toHaveProperty("error");
    expect((out as { error: string }).error).toContain("qa-playbook");
  });

  it("needs both a description and a body", () => {
    expect(validateDraft({ name: "log-rotation", description: "   ", body: "b" }, new Set())).toHaveProperty("error");
    expect(validateDraft({ name: "log-rotation", description: "d", body: "  \n " }, new Set())).toHaveProperty("error");
  });

  it("hard-rejects a body over the cap rather than truncating a playbook mid-sentence", () => {
    const out = validateDraft({ name: "log-rotation", description: "d", body: "word ".repeat(FORGED_TOKEN_CAP) }, new Set());
    expect(out).toHaveProperty("error");
    expect((out as { error: string }).error).toContain(String(FORGED_TOKEN_CAP));
  });

  it("caps a runaway description at 300 characters", () => {
    const out = validateDraft({ name: "log-rotation", description: "d".repeat(500), body: "b" }, new Set()) as { description: string };
    expect(out.description).toHaveLength(300);
  });
});

describe("installForged", () => {
  it("writes frontmatter the indexer reads back, with provenance naming the run and task", () => {
    const d = dir();
    const skill = installForged(d, { slug: "log-rotation", description: "rotating logs here", body: "Do it like this." }, prov);
    expect(skill.name).toBe("log-rotation");
    expect(skill.description).toBe("rotating logs here");
    expect(skill.body).toContain("Do it like this.");
    const raw = readFileSync(path.join(d, "log-rotation", "SKILL.md"), "utf8");
    expect(raw).toContain("forged-by: harness run r1, task t1");
  });

  it("adopts an existing file instead of clobbering one another task may be carrying the hash of", () => {
    const d = dir();
    const first = installForged(d, { slug: "log-rotation", description: "original", body: "original body" }, prov);
    const second = installForged(d, { slug: "log-rotation", description: "rival", body: "rival body" }, { runId: "r2", taskId: "t2" });
    expect(second.sha256).toBe(first.sha256);
    expect(second.body).toContain("original body");
  });
});

describe("extendForged", () => {
  it("refuses a name that is not a plain slug — it arrives from a model, and a path must stay a rejected string", () => {
    const d = dir();
    expect(extendForged(d, "../escape", "more", prov)).toHaveProperty("error");
    expect(extendForged(d, "Not-A-Slug", "more", prov)).toHaveProperty("error");
  });

  it("only extends skills that are actually in the forge", () => {
    const out = extendForged(dir(), "never-forged", "more", prov);
    expect(out).toHaveProperty("error");
    expect((out as { error: string }).error).toContain("never-forged");
  });

  it("refuses an empty addendum", () => {
    const d = dir();
    installForged(d, { slug: "log-rotation", description: "x", body: "y" }, prov);
    expect(extendForged(d, "log-rotation", "  \n ", prov)).toHaveProperty("error");
  });

  it("refuses growth past the cap that keeps forged skills full-text injectable", () => {
    const d = dir();
    installForged(d, { slug: "log-rotation", description: "x", body: "word ".repeat(1000) }, prov);
    const out = extendForged(d, "log-rotation", "more ".repeat(500), prov);
    expect(out).toHaveProperty("error");
    expect((out as { error: string }).error).toContain("log-rotation");
  });

  it("appends a dated section and re-hashes, finding its file among the others", () => {
    const d = dir();
    installForged(d, { slug: "other-skill", description: "x", body: "y" }, prov);
    const before = installForged(d, { slug: "log-rotation", description: "x", body: "base body" }, prov);
    const out = extendForged(d, "log-rotation", "What t9 taught us.", { runId: "r2", taskId: "t9" });
    expect(out).not.toHaveProperty("error");
    const skill = (out as { skill: typeof before }).skill;
    expect(skill.name).toBe("log-rotation");
    expect(skill.sha256).not.toBe(before.sha256);
    expect(skill.body).toContain("base body");
    expect(skill.body).toContain("## Learned in run r2 (task t9)");
    expect(skill.body).toContain("What t9 taught us.");
  });
});

describe("SkillForgeDecision", () => {
  it("defaults a bare decline's why to empty", () => {
    expect(SkillForgeDecision.parse({ action: "none" })).toEqual({ action: "none", why: "" });
  });
});

describe("the skillsmith's briefing", () => {
  it("states the contract with and without a toolbelt", () => {
    expect(skillsmithSystemPrompt()).toContain('"action":"create"');
    expect(skillsmithSystemPrompt("TOOLBELT")).toContain("TOOLBELT");
  });

  it("tells the smith what was close, what it already forged, and what will prove the task done", () => {
    const full = skillsmithPrompt(
      "Rotate the logs",
      "Truncate stale files",
      ["files rotate weekly"],
      [{ name: "near-miss", description: "almost" }],
      [{ name: "prior-forge", description: "mine" }]
    );
    expect(full).toContain("files rotate weekly");
    expect(full).toContain("near-miss: almost");
    expect(full).toContain("prior-forge: mine");

    const bare = skillsmithPrompt("Rotate the logs", "Truncate stale files", [], [], []);
    expect(bare).toContain("had nothing even close");
    expect(bare).not.toContain("prove it done");
  });
});

describe("forgeDir", () => {
  it("keeps the forge beside the run database, inside .harness", () => {
    expect(forgeDir("/repo")).toBe(path.join("/repo", ".harness", "skills"));
  });
});

describe("the forge and the indexer agree", () => {
  it("a forged file whose directory was renamed by hand still indexes under its frontmatter name", () => {
    // Not a supported operation — just pinning that installForged reads back
    // through the same parser the run uses, so what the forge returns is what
    // selection will later see.
    const d = dir();
    mkdirSync(path.join(d, "renamed-dir"));
    writeFileSync(path.join(d, "renamed-dir", "SKILL.md"), "---\nname: real-name\ndescription: x\n---\nbody");
    const out = extendForged(d, "renamed-dir", "addendum", prov);
    expect(out).not.toHaveProperty("error");
    expect((out as { skill: { name: string } }).skill.name).toBe("real-name");
  });
});
