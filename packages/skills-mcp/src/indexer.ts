import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync, existsSync } from "node:fs";
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
  // Dirs and skills are deduped by realpath: ~/skills is commonly a symlink to
  // ~/.claude/skills, and both ship in the default config — without this every
  // skill indexes twice and duplicates crowd the top-k match slots.
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const skillPath = path.join(dir, entry, "SKILL.md");
      try {
        if (!statSync(path.join(dir, entry)).isDirectory() || !existsSync(skillPath)) continue;
        const real = realpathSync(skillPath);
        if (seen.has(real)) continue;
        seen.add(real);
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
 * How much a term hit is worth, by how many skills contain it.
 *
 * Without this, every hit counted the same, and the terms a task spec is full
 * of — "test", "service", "add", "return", "user" — are exactly the terms every
 * skill body also contains. The winner was then decided by prose volume rather
 * than subject: across one 36-task run the top match was `testimonial-collector`
 * for a sanctions-screening task (scoring above every real candidate),
 * `branding-manager` for card tokenization, and `cartographer` for a state
 * machine. Threshold tuning cannot fix that, because the wrong skills scored
 * *higher* than the right ones.
 *
 * Standard BM25 idf, floored at zero: a term in every skill is worth nothing,
 * a term in one is worth a lot.
 */
function idf(documentFrequency: number, corpusSize: number): number {
  return Math.max(0, Math.log(1 + (corpusSize - documentFrequency + 0.5) / (documentFrequency + 0.5)));
}

/**
 * Lexical match (v0.1 per PRD §15-Q1): idf-weighted hits over name/description
 * (weighted) + body, normalized by document length. Embeddings are a planned
 * upgrade, not a dependency.
 */
export function matchSkills(skills: IndexedSkill[], taskText: string, k = 3): { skill: IndexedSkill; score: number }[] {
  const queryTerms = new Set(terms(taskText));
  // Document frequency over the corpus being matched against, computed per call:
  // the skill set is small and fixed for a run, and this keeps matchSkills a
  // pure function of its arguments.
  const df = new Map<string, number>();
  const docs = skills.map((skill) => ({
    skill,
    nameTerms: terms(`${skill.name} ${skill.description}`),
    bodyTerms: terms(skill.body),
  }));
  for (const d of docs) {
    for (const t of new Set([...d.nameTerms, ...d.bodyTerms])) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const weight = (t: string) => idf(df.get(t) ?? 0, docs.length);

  const scored = docs.map(({ skill, nameTerms, bodyTerms }) => {
    let score = 0;
    for (const t of nameTerms) if (queryTerms.has(t)) score += 3 * weight(t);
    for (const t of bodyTerms) if (queryTerms.has(t)) score += 0.2 * weight(t);
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
