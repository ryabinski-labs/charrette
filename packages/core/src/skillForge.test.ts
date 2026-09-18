import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
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
      new Set(),
      prov
    );
    expect(draft).toEqual({ slug: "dynamodb-single-table-design", description: "one two three", body: "the playbook" });
  });

  it("rejects a name that reduces to nothing usable, in either direction", () => {
    expect(validateDraft({ name: "a!", description: "d", body: "b" }, new Set(), prov)).toHaveProperty("error");
    expect(validateDraft({ name: "x".repeat(80), description: "d", body: "b" }, new Set(), prov)).toHaveProperty("error");
  });

  it("refuses to shadow a name the run can already see — routing addresses skills by name", () => {
    const out = validateDraft({ name: "QA Playbook", description: "d", body: "b" }, new Set(["qa-playbook"]), prov);
    expect(out).toHaveProperty("error");
    expect((out as { error: string }).error).toContain("qa-playbook");
  });

  it("needs both a description and a body", () => {
    expect(validateDraft({ name: "log-rotation", description: "   ", body: "b" }, new Set(), prov)).toHaveProperty("error");
    expect(validateDraft({ name: "log-rotation", description: "d", body: "  \n " }, new Set(), prov)).toHaveProperty("error");
  });

  it("hard-rejects a body over the cap rather than truncating a playbook mid-sentence", () => {
    const out = validateDraft({ name: "log-rotation", description: "d", body: "word ".repeat(FORGED_TOKEN_CAP) }, new Set(), prov);
    expect(out).toHaveProperty("error");
    expect((out as { error: string }).error).toContain(String(FORGED_TOKEN_CAP));
  });

  it("caps a runaway description at 300 characters", () => {
    const out = validateDraft({ name: "log-rotation", description: "d".repeat(500), body: "b" }, new Set(), prov) as { description: string };
    expect(out.description).toHaveLength(300);
  });

  // Regression: the cap used to measure the body alone, so a body just under
  // the cap plus a maximal description and provenance installed as a file over
  // runController's 1500-token full-text limit — and a forged skill that big
  // silently fell to reference mode, pointing at a path outside the worker's
  // worktree. The cap is on the file the indexer will measure, or it is not
  // a cap at all.
  it("caps the composed file, not the body — frontmatter and provenance count", () => {
    const longProv = { runId: "0f3c7a1e-9b2d-4e8f-a1c6-7d5e3b9a0f12", taskId: "task-sanctions-screening-adapter" };
    const draft = {
      name: "a".repeat(64),
      description: "d".repeat(300),
      body: "x".repeat(FORGED_TOKEN_CAP * 4), // the body alone sits exactly at the cap
    };
    const out = validateDraft(draft, new Set(), longProv);
    expect(out).toHaveProperty("error");
    expect((out as { error: string }).error).toContain(String(FORGED_TOKEN_CAP));
  });

  it("what it accepts, the indexer measures at or under the cap", () => {
    const d = dir();
    const body = "x".repeat((FORGED_TOKEN_CAP - 40) * 4); // leaves exactly the frontmatter's worth of room
    const out = validateDraft({ name: "big-but-legal", description: "tight fit", body }, new Set(), prov);
    expect(out).not.toHaveProperty("error");
    const skill = installForged(d, out as { slug: string; description: string; body: string }, prov);
    expect(skill.tokensApprox).toBeLessThanOrEqual(FORGED_TOKEN_CAP);
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
    expect(raw).toContain("forged-by: charrette run r1, task t1");
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

// Regression: both writers used to follow a symlink planted inside the forge
// straight out of it — extendForged appended a provenance-stamped section to
// whatever file the link named, and installForged wrote a fresh SKILL.md into
// whatever directory a planted slug resolved to. The forge writes inside the
// forge, or not at all.
describe("a symlink planted inside the forge", () => {
  it("does not let extend grow a file outside it", () => {
    const d = dir();
    const operator = dir();
    const operatorFile = path.join(operator, "SKILL.md");
    writeFileSync(operatorFile, "---\nname: operator-skill\ndescription: theirs\n---\nprecious\n");
    mkdirSync(path.join(d, "sneaky"));
    symlinkSync(operatorFile, path.join(d, "sneaky", "SKILL.md"));
    const before = readFileSync(operatorFile, "utf8");
    const out = extendForged(d, "sneaky", "harvested", prov);
    expect(out).toHaveProperty("error");
    expect((out as { error: string }).error).toContain("outside the forge");
    expect(readFileSync(operatorFile, "utf8")).toBe(before);
  });

  it("does not let install write through a planted slug directory", () => {
    const d = dir();
    const elsewhere = dir();
    symlinkSync(elsewhere, path.join(d, "planted"));
    expect(() => installForged(d, { slug: "planted", description: "x", body: "y" }, prov)).toThrow(/outside the forge/);
    expect(existsSync(path.join(elsewhere, "SKILL.md"))).toBe(false);
  });

  it("does not let install adopt a symlinked file as though the forge wrote it", () => {
    const d = dir();
    const operator = dir();
    const operatorFile = path.join(operator, "SKILL.md");
    writeFileSync(operatorFile, "---\nname: operator-skill\ndescription: theirs\n---\nprecious\n");
    mkdirSync(path.join(d, "adopt-me"));
    symlinkSync(operatorFile, path.join(d, "adopt-me", "SKILL.md"));
    expect(() => installForged(d, { slug: "adopt-me", description: "x", body: "y" }, prov)).toThrow(/outside the forge/);
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
  it("keeps the forge beside the run database, inside .charrette", () => {
    expect(forgeDir("/repo")).toBe(path.join("/repo", ".charrette", "skills"));
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
