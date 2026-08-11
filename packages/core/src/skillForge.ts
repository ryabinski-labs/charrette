import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { indexSkills, type IndexedSkill } from "@harness/skills-mcp";

/**
 * The forge: where the harness keeps the skills it wrote for itself.
 *
 * A task about to dispatch with no matched skill is the one case the skills
 * system cannot help with — the matcher's honest answer is "your collection
 * has nothing for this", and the worker goes in cold. The forge closes that
 * gap without crossing the PRD's line that no agent modifies the skills
 * registry: a `skillsmith` session *drafts* a playbook as JSON, and the code
 * in this file — not the agent — validates it and writes it to disk, in a
 * directory that is harness state rather than the operator's collection.
 *
 * The directory sits beside the run database (`<repo>/.harness/skills/`),
 * which buys three properties at once: it is scoped to one repository by
 * construction, it is gitignored with the rest of `.harness/` so a forged
 * skill can never ride into a PR, and it survives the run — the second run in
 * a repository should not pay a session to relearn what the first one wrote
 * down. Forged files are plain markdown the operator can read, edit or
 * delete, and every one carries frontmatter naming the run and task that
 * forged it.
 */

/** Where forged skills live for a repository. */
export function forgeDir(repoPath: string): string {
  return path.join(repoPath, ".harness", "skills");
}

/**
 * What a skillsmith session may answer. Three actions, because "write
 * something" is not always the right move and the contract has to make
 * declining as easy as drafting:
 *
 *   - `create` — a new playbook for this class of task.
 *   - `extend` — an earlier *forged* skill was close but missed this task;
 *     add what it lacked rather than fragmenting the topic across files.
 *     Only forged skills can be extended — the operator's own files are not
 *     the harness's to grow.
 *   - `none`  — no playbook would help (the task is self-evident, or too
 *     particular to ever recur). A skill that restates the task spec is
 *     context spent twice, so this answer is a success, not a failure.
 */
export const SkillForgeDecision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name: z.string(), description: z.string(), body: z.string() }),
  z.object({ action: z.literal("extend"), name: z.string(), addendum: z.string() }),
  z.object({ action: z.literal("none"), why: z.string().default("") }),
]);
export type SkillForgeDecision = z.infer<typeof SkillForgeDecision>;

/**
 * Ceiling on a forged skill's whole file, in approximate tokens. Deliberately
 * under runController's `FULL_TEXT_SKILL_TOKEN_LIMIT` (1500): a forged skill
 * must always qualify for full-text injection, because its reference-mode
 * fallback — "read this file before starting" — points at a path outside the
 * worker's worktree, which is exactly the read the permission model denies.
 */
export const FORGED_TOKEN_CAP = 1400;

const TOKENS = (text: string) => Math.ceil(text.length / 4);

/** One line of provenance, written into every forged file's frontmatter. */
const provenanceLine = (prov: { runId: string; taskId: string }) => `forged-by: harness run ${prov.runId}, task ${prov.taskId}`;

export interface ForgedDraft {
  slug: string;
  description: string;
  body: string;
}

/**
 * The one composition of a forged file, shared by the validator and the
 * writer so the cap is measured on exactly the bytes that reach disk.
 */
const composeFile = (draft: ForgedDraft, prov: { runId: string; taskId: string }) =>
  `---\nname: ${draft.slug}\ndescription: ${draft.description}\n${provenanceLine(prov)}\n---\n${draft.body}\n`;

/**
 * True when `p` resolves outside the forge directory. Everything under the
 * forge is fair game for the harness to write; a symlink planted inside it —
 * a slug directory or a SKILL.md pointing at an operator's file — must not
 * become a pen the harness writes through. Both arguments exist when this is
 * called, so realpath resolves every link before the comparison.
 */
function escapesForge(dir: string, p: string): boolean {
  return !realpathSync(p).startsWith(realpathSync(dir) + path.sep);
}

/**
 * Check a `create` draft against the rules an agent cannot be trusted to keep,
 * and normalize what can be normalized rather than rejecting over it.
 *
 * The name becomes a slug because it becomes a directory name — and because
 * the indexer's frontmatter is line-based, the name and description are
 * flattened to single lines so a crafted value cannot close the frontmatter
 * early and smuggle content above the advisory wrapper. The size cap is a
 * hard reject rather than a truncation: a playbook cut mid-sentence is worse
 * than none, and the skillsmith was told the budget. It is measured on the
 * whole composed file — frontmatter, provenance and all — because the
 * indexer's `tokensApprox` is, and that number is what decides full-text
 * injection; `prov` is taken here for exactly that composition.
 *
 * `taken` is every skill name the run can currently see, the operator's
 * included. A forged skill may never shadow an operator's: `skillRouting`
 * and `roleSkills` address skills by name, and a collision would let a
 * generated file ride a route the operator wrote for their own playbook.
 */
export function validateDraft(
  draft: { name: string; description: string; body: string },
  taken: Set<string>,
  prov: { runId: string; taskId: string }
): ForgedDraft | { error: string } {
  const slug = draft.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length < 3 || slug.length > 64) {
    return { error: `skill name "${draft.name}" does not reduce to a usable slug (3-64 chars)` };
  }
  if (taken.has(slug)) {
    return { error: `a skill named "${slug}" already exists — extend it if it is forged, leave it alone if it is the operator's` };
  }
  const description = draft.description.replace(/\s+/g, " ").trim().slice(0, 300);
  const body = draft.body.trim();
  if (!description || !body) {
    return { error: "a forged skill needs both a description and a body" };
  }
  const fileTokens = TOKENS(composeFile({ slug, description, body }, prov));
  if (fileTokens > FORGED_TOKEN_CAP) {
    return { error: `the drafted file is ~${fileTokens} tokens against a cap of ${FORGED_TOKEN_CAP} — a playbook that long should be the operator's decision, not the forge's` };
  }
  return { slug, description, body };
}

/** Read one forged skill back through the same parser everything else uses. */
function indexed(dir: string, slug: string): IndexedSkill {
  // Matched by path rather than by name: the file's frontmatter is what names
  // a skill to the indexer, and an operator who hand-edited a forged file may
  // have renamed it. The file exists — this module just wrote or read it — so
  // the lookup cannot miss.
  const skillPath = path.join(dir, slug, "SKILL.md");
  return indexSkills([dir]).find((s) => s.path === skillPath)!;
}

/**
 * Write a validated draft to the forge, or hand back the skill already there.
 *
 * The reuse branch is what makes forging safe to race: two parallel tasks
 * that both came up empty on the same topic both reach here, and the second
 * one adopts the first one's file rather than clobbering a skill another
 * worker may already be carrying the hash of.
 */
export function installForged(dir: string, draft: ForgedDraft, prov: { runId: string; taskId: string }): IndexedSkill {
  const skillPath = path.join(dir, draft.slug, "SKILL.md");
  if (!existsSync(skillPath)) {
    mkdirSync(path.dirname(skillPath), { recursive: true });
    if (escapesForge(dir, path.dirname(skillPath))) {
      throw new Error(`"${draft.slug}" resolves outside the forge — refusing to write through it`);
    }
    writeFileSync(skillPath, composeFile(draft, prov));
  } else if (escapesForge(dir, skillPath)) {
    // The adopt branch reads rather than writes, but adopting a symlinked
    // file would inject whatever it points at as though the forge wrote it.
    throw new Error(`"${draft.slug}" resolves outside the forge — refusing to adopt it`);
  }
  return indexed(dir, draft.slug);
}

/**
 * Grow a previously forged skill with what this task taught the skillsmith.
 *
 * Refuses anything that is not a plain slug under the forge directory — the
 * name arrives from a model, and "extend `../../.claude/skills/deploy`" must
 * be a rejected string, not a path. The addendum lands as a dated section so
 * the file reads as the accretion it is, and the cap applies to the file as
 * a whole: a skill that outgrows full-text injection stops being injectable
 * at all (see FORGED_TOKEN_CAP), so growth past the cap is refused rather
 * than honoured.
 */
export function extendForged(
  dir: string,
  name: string,
  addendum: string,
  prov: { runId: string; taskId: string }
): { skill: IndexedSkill } | { error: string } {
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(name)) {
    return { error: `"${name}" is not a forged-skill name` };
  }
  const skillPath = path.join(dir, name, "SKILL.md");
  if (!existsSync(skillPath)) {
    return { error: `no forged skill named "${name}" — only skills in the forge can be extended` };
  }
  if (escapesForge(dir, skillPath)) {
    return { error: `"${name}" resolves outside the forge — refusing to grow it` };
  }
  const grown = addendum.trim();
  if (!grown) return { error: "an empty addendum extends nothing" };
  const current = readFileSync(skillPath, "utf8");
  const next = `${current.trimEnd()}\n\n## Learned in run ${prov.runId} (task ${prov.taskId})\n\n${grown}\n`;
  if (TOKENS(next) > FORGED_TOKEN_CAP) {
    return { error: `extending "${name}" would take it to ~${TOKENS(next)} tokens, past the ${FORGED_TOKEN_CAP} cap that keeps forged skills injectable` };
  }
  writeFileSync(skillPath, next);
  return { skill: indexed(dir, name) };
}
