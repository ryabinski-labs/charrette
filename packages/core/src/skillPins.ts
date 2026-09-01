import { indexSkills, verifyHash, type IndexedSkill } from "@harness/skills-mcp";

/**
 * A `roleSkills` pin that will not reach the role it was written for.
 *
 * Pins are matched by name against whatever `skillsDirs` holds on this machine,
 * and a name that matches nothing is skipped rather than fatal — deliberately,
 * because a routing table outlives any one machine's skill collection, and a
 * missing playbook is not a reason to refuse to run.
 *
 * Doing it *silently* is the part that was wrong. `spec` is pinned to
 * `prd-to-tdd` by default, and that pin is not advice: the spec phase without
 * it is an agent inventing its own idea of what a scenario is, and the
 * acceptance gate then holds the whole run to whatever it invented. Nothing in
 * the run reads differently afterwards — there is a spec, there are scenarios,
 * there is a verdict — so the one moment this is cheap to notice is before the
 * run has spent anything, which is where `skillPinBanner` and the controller's
 * preflight both put it.
 */
export interface UnresolvedPin {
  role: string;
  skill: string;
  /**
   * `missing` — nothing in `skillsDirs` is named that.
   * `changed` — it is there, but no longer the bytes that were indexed, so
   * injection drops it too (SEC-14; `verifyHash` in indexer.ts).
   */
  reason: "missing" | "changed";
}

/**
 * Every `roleSkills` pin the given index cannot satisfy, in config order.
 *
 * Takes the index rather than the directories so it answers the same question
 * the injection path asks, against the same list — `routedSkills` looks each
 * pin up by name in an `indexSkills` result and hash-verifies the hit, and a
 * check that reasoned about the filesystem instead would be a second opinion
 * about what "present" means.
 */
export function unresolvedRoleSkills(skills: IndexedSkill[], roleSkills: Record<string, string[]>): UnresolvedPin[] {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const out: UnresolvedPin[] = [];
  for (const [role, names] of Object.entries(roleSkills)) {
    for (const skill of names) {
      const indexed = byName.get(skill);
      if (!indexed) out.push({ role, skill, reason: "missing" });
      else if (!verifyHash(indexed)) out.push({ role, skill, reason: "changed" });
    }
  }
  return out;
}

/**
 * The pins that belong to a phase this run will actually reach.
 *
 * A run with `spec.enabled: false` never spawns a spec agent, so telling its
 * operator what the spec phase is about to improvise is advice about something
 * that will not happen — and advice the operator cannot act on reads as a bug
 * in the tool rather than as a warning about their machine. Every other pinned
 * role runs on every run, so nothing else is conditional.
 */
export function pinsInPlay(config: { roleSkills: Record<string, string[]>; spec: { enabled: boolean } }): Record<string, string[]> {
  if (config.spec.enabled) return config.roleSkills;
  return Object.fromEntries(Object.entries(config.roleSkills).filter(([role]) => role !== "spec"));
}

/**
 * What the operator loses, said in terms of the run rather than of the
 * mechanism.
 *
 * Only `spec` gets its own sentence: it is the one pin whose absence changes
 * what the run is judged *against*, rather than only how well one agent is
 * briefed. Every other role runs a little less well informed, which is a cost
 * the operator can weigh; an improvised specification is a cost they cannot
 * see, because the run looks identical from the outside.
 */
function consequence(role: string): string {
  return role === "spec"
    ? "the spec phase runs anyway, inventing its own idea of what a scenario is, and the acceptance gate holds the run to whatever it invents"
    : `the ${role} agent runs without it`;
}

/**
 * The startup banner's account of the pins that will not be honoured, as
 * continuation lines under the `skills` line.
 *
 * Empty when every pin resolves: a line that never changes is a line nobody
 * reads, and the operator whose collection is complete should hear nothing.
 */
export function skillPinLines(unresolved: UnresolvedPin[]): string[] {
  if (!unresolved.length) return [];
  const lines = unresolved.map(
    (p) =>
      `${p.role} is pinned to ${p.skill}, ` +
      (p.reason === "missing"
        ? "which is in none of those directories"
        : "which changed on disk since it was read, so injection skips it too") +
      ` — ${consequence(p.role)}`
  );
  lines.push("put it in one of those directories, or drop the pin from roleSkills");
  return lines.map((l) => `           ${l}`);
}

/**
 * The same lines, for a caller that has directories rather than an index —
 * which is every caller outside the controller, since indexing is the part
 * that touches the operator's disk.
 */
export function skillPinBanner(dirs: string[], roleSkills: Record<string, string[]>): string[] {
  return skillPinLines(unresolvedRoleSkills(indexSkills(dirs), roleSkills));
}
