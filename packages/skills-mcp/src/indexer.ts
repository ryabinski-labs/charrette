import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

export interface IndexedSkill {
  name: string;
  path: string;
  sha256: string;
  description: string;
  body: string;
  tokensApprox: number;
}

/** Parse minimal YAML frontmatter (name/description lines) without a YAML dependency. */
function parseFrontmatter(text: string): { name?: string; description?: string; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { body: text };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(name|description):\s*(.+)$/);
    if (kv) fm[kv[1]!] = kv[2]!.trim();
  }
  return { name: fm.name, description: fm.description, body: m[2]! };
}

/** Index SKILL.md files from the given directories (each subdir holding a SKILL.md). */
export function indexSkills(dirs: string[]): IndexedSkill[] {
  const skills: IndexedSkill[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const skillPath = path.join(dir, entry, "SKILL.md");
      try {
        if (!statSync(path.join(dir, entry)).isDirectory() || !existsSync(skillPath)) continue;
        const raw = readFileSync(skillPath, "utf8");
        const { name, description, body } = parseFrontmatter(raw);
        skills.push({
          name: name ?? entry,
          path: skillPath,
          sha256: createHash("sha256").update(raw).digest("hex"),
          description: description ?? body.slice(0, 200),
          body: raw,
          tokensApprox: Math.ceil(raw.length / 4),
        });
      } catch {
        // unreadable entries are skipped, not fatal
      }
    }
  }
  return skills;
}

const STOPWORDS = new Set("a an and are as at be by for from has have in is it of on or that the to use using with when".split(" "));

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Lexical match (v0.1 per PRD §15-Q1): TF over name/description (weighted) + body,
 * normalized by document length. Embeddings are a planned upgrade, not a dependency.
 */
export function matchSkills(skills: IndexedSkill[], taskText: string, k = 3): { skill: IndexedSkill; score: number }[] {
  const queryTerms = new Set(terms(taskText));
  const scored = skills.map((skill) => {
    const nameTerms = terms(`${skill.name} ${skill.description}`);
    const bodyTerms = terms(skill.body);
    let score = 0;
    for (const t of nameTerms) if (queryTerms.has(t)) score += 3;
    for (const t of bodyTerms) if (queryTerms.has(t)) score += 0.2;
    score /= Math.sqrt(bodyTerms.length + 1);
    return { skill, score };
  });
  return scored
    .filter((s) => s.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Re-hash at injection time; a changed file since indexing is skipped (SEC-14). */
export function verifyHash(skill: IndexedSkill): boolean {
  try {
    const raw = readFileSync(skill.path, "utf8");
    return createHash("sha256").update(raw).digest("hex") === skill.sha256;
  } catch {
    return false;
  }
}
