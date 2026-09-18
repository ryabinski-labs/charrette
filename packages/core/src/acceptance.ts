import { gating, type RunSpec, type ScenarioPriority, type SpecScenario } from "@charrette/shared";

/**
 * Whether the merged work does what the specification said it would.
 *
 * The gate this file decides is the first one in the charrette that is not an
 * agent's opinion. Every other check on the way out — QA's verdict, the intent
 * check, the pit-stop reviewers — is a model reading a diff and forming a view,
 * and the failure mode they share is agreeing with the code because they
 * misunderstood the requirement in the same direction it did. A scenario
 * derived from the brief *before* the code existed cannot make that mistake;
 * it either goes green or it does not.
 *
 * A failing process always fails the gate. A successful process must also
 * report a positive result for every required scenario: an empty selection,
 * skipped tests, or a silent no-op proves nothing. Parsed test output is still
 * weaker than the oracle itself, which independent live validation checks.
 *
 * Pure, like `evidence` and `deployCapability`: the caller runs the command and
 * hands over the bytes.
 */

/** What running the scenario suite produced. */
export interface SuiteRun {
  /** Zero means every scenario the command selected went green. */
  exitCode: number;
  /** stdout and stderr together, as the runner wrote them. */
  output: string;
  /** Set when the command could not be run at all — no framework, no command. */
  error?: string;
}

/**
 * The three answers this gate can give.
 *
 * Not a boolean, because a boolean had only two, and the third — "nothing here
 * was proven either way" — got spelled as the first. A specification with no
 * gating scenario, or whose every gating scenario is blocked on a question
 * nobody answered, returned `passed: true`, and the one caller tested exactly
 * that field: rust-service de2cb7aa carried four blocked P0 scenarios through the gate
 * that way. A caller handed this type cannot confuse the cases without saying
 * so in its own code.
 */
export type AcceptanceCall = "green" | "red" | "no-opinion";

export interface AcceptanceVerdict {
  /** Green requires process success and evidence for every required scenario. */
  verdict: AcceptanceCall;
  /** Scenario ids the output named as failing, worst first. */
  failing: string[];
  /**
   * Whether `failing` can be trusted as the complete list.
   *
   * False when the suite went red and no id could be read out of it — a runner
   * this parser does not know, a crash before any test ran, a compile error. The
   * run still fails; what changes is that the report says so instead of naming
   * two scenarios and implying the rest are fine.
   */
  named: boolean;
  /** Gating scenarios that never ran because an open question blocks them. */
  blocked: string[];
  /** One sentence for the operator, the pit stop, and the pull request body. */
  line: string;
  /**
   * The tail of what the runner wrote, for the one task a red suite that named
   * no scenario can honestly queue: make the suite runnable and readable. Empty
   * for every other answer — a green suite's output is nobody's work.
   */
  output: string;
}

/** How much of a red suite's output travels with the verdict into a task. */
const OUTPUT_TAIL = 4000;

/**
 * A failing line, in the vocabularies the runners this charrette meets actually
 * use.
 *
 * Deliberately a list of markers rather than one clever pattern: vitest writes
 * `×`, jest `✕`, pytest `FAILED`, go `--- FAIL:`, TAP `not ok`, playwright `✘`.
 * A single expression covering all of them is one nobody can check by reading,
 * and the cost of missing one is not a wrong answer — the exit code has already
 * given the answer — it is a report that cannot name the scenario.
 */
const FAILURE_MARKERS = [/^\s*(?:×|✕|✗|✘)\s/, /\bFAILED\b/, /\bFAIL\b/, /^\s*not ok\b/, /^\s*---\s*FAIL:/, /^\s*●\s/, /\bAssertionError\b/];

/** Lines that say a test passed, so an id on them is never read as a failure. */
const PASS_MARKERS = [/^\s*(?:✓|√|✔)\s/, /^\s*ok\s+\d/, /\bPASSED\b/, /^\s*---\s*PASS:/];

/** Require a positive result for each promised scenario, not just process success. */
export function passedScenarios(output: string, known: Iterable<string>): string[] {
  const ids = [...known];
  const passed = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    if (!PASS_MARKERS.some((m) => m.test(line)) && !/^\s*test .+ \.\.\. ok\s*$/.test(line)) continue;
    if (/\b(SKIP|SKIPPED|TODO|ignored)\b/i.test(line)) continue;
    for (const id of ids) {
      if (new RegExp(`(?<![A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9-])`).test(line)) passed.add(id);
    }
  }
  return [...passed];
}

/**
 * The scenario ids a test runner reported as failing.
 *
 * `prd-to-tdd` requires the scenario id verbatim in the test name, which is
 * what makes this possible at all: the id travels with the test into whatever
 * the runner prints. Every id is matched against the ids the spec actually
 * declares, so a stray `SC-` in a stack trace or a source line cannot invent a
 * scenario that does not exist.
 */
export function failingScenarios(output: string, known: Iterable<string>): string[] {
  const ids = new Set(known);
  if (!ids.size) return [];
  // Longest first: `SC-1` must not match inside `SC-12` and claim the wrong one.
  const ordered = [...ids].sort((a, b) => b.length - a.length);
  const found = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (PASS_MARKERS.some((m) => m.test(line))) continue;
    if (!FAILURE_MARKERS.some((m) => m.test(line))) continue;
    for (const id of ordered) {
      // Bounded on both sides so `SC-12` does not match within `SC-120`.
      if (new RegExp(`(?<![A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9-])`).test(line)) found.add(id);
    }
  }
  return [...found].sort();
}

/**
 * Worst first, then by id inside a band.
 *
 * A rank table rather than a chain of comparisons on the label: `darkSwitches`
 * orders its kinds the same way, and the string comparison it replaces had a
 * branch no sort would ever take, which is a branch nobody can test.
 */
const RANK: Record<ScenarioPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const bySeverity = (a: SpecScenario, b: SpecScenario): number => RANK[a.priority] - RANK[b.priority] || a.id.localeCompare(b.id);

/**
 * Read one run of the scenario suite as a verdict on the run.
 *
 * A nonzero exit always fails, including crashes that name no scenario. A zero
 * exit also needs positive execution evidence for every required scenario and
 * no blocked requirements. The explicit review-only legacy override relaxes
 * parsing, never the process exit or blocked-scenario checks.
 */
export function acceptanceVerdict(spec: RunSpec, run: SuiteRun, requireExecutionEvidence = true): AcceptanceVerdict {
  const scenarios = gating(spec);
  const blocked = spec.scenarios
    .filter((s) => s.blocked && (s.priority === "P0" || s.priority === "P1"))
    .sort(bySeverity)
    .map((s) => s.id);

  // Nothing to hold the run to. Not a pass and not a failure — a statement that
  // this gate has no opinion, which the caller can tell apart from a green suite
  // because it is spelled differently. Blocked scenarios are named so that the
  // caller can put the question behind them to the operator: a P0 nobody could
  // run because nobody answered is the charrette's question, not its pass.
  if (!scenarios.length) {
    return {
      verdict: "no-opinion",
      failing: [],
      named: true,
      blocked,
      line: blocked.length
        ? `no scenario could be run: all ${blocked.length} gating scenario(s) are blocked on an unanswered question`
        : "the specification declares no gating scenario, so nothing here was proven either way",
      output: "",
    };
  }

  if (run.error) {
    return {
      verdict: "red",
      failing: [],
      named: false,
      blocked,
      line: `the scenario suite could not be run (${run.error}) — ${scenarios.length} gating scenario(s) are therefore unproven, not passing`,
      output: run.output.slice(-OUTPUT_TAIL),
    };
  }

  const failing = failingScenarios(run.output, scenarios.map((s) => s.id));
  // Severity first, then declaration order within a band. The operator reads
  // the head of this sentence and stops; a P0 listed fourth is a P0 nobody saw.
  const order = new Map([...scenarios].sort(bySeverity).map((s, i) => [s.id, i]));
  const sorted = [...failing].sort((a, b) => order.get(a)! - order.get(b)!);

  if (run.exitCode === 0) {
    const passed = new Set(passedScenarios(run.output, scenarios.map((s) => s.id)));
    const missing = requireExecutionEvidence ? scenarios.filter((s) => !passed.has(s.id) || failing.includes(s.id)).map((s) => s.id) : [];
    if (blocked.length || missing.length) {
      return {
        verdict: "red", failing: missing, named: missing.length > 0, blocked,
        line: [missing.length ? `${missing.length} required scenario(s) have no passing execution result: ${missing.join(", ")}` : "",
          blocked.length ? `${blocked.length} required scenario(s) remain blocked: ${blocked.join(", ")}` : ""].filter(Boolean).join("; "),
        output: run.output.slice(-OUTPUT_TAIL),
      };
    }
    return {
      verdict: "green",
      failing: [],
      named: true,
      blocked,
      line: `${scenarios.length} gating scenario(s) green`,
      output: "",
    };
  }
  return {
    verdict: "red",
    failing: sorted,
    named: sorted.length > 0,
    blocked,
    line: sorted.length
      ? `${sorted.length} of ${scenarios.length} gating scenario(s) failing: ${sorted.slice(0, 4).join(", ")}${sorted.length > 4 ? `, +${sorted.length - 4} more` : ""}`
      : `the scenario suite is red and its output named no scenario — ${scenarios.length} gating scenario(s) are unproven`,
    output: run.output.slice(-OUTPUT_TAIL),
  };
}

/**
 * The open questions behind the gating scenarios a verdict could not run, so
 * the caller can ask them rather than pass over them.
 *
 * A blocked scenario carries no question of its own; it is blocked because its
 * requirement is, and the requirement names the question. Walked here, in the
 * pure module, so the sentence the operator is shown is testable without a
 * run. A scenario whose chain does not reach a question is reported under its
 * own id, never dropped — the whole point is that nothing blocked goes unsaid.
 */
export function blockingQuestionsFor(spec: RunSpec, blocked: Iterable<string>): string[] {
  const scenarios = new Map(spec.scenarios.map((s) => [s.id, s]));
  const requirements = new Map(spec.requirements.map((r) => [r.id, r]));
  const questions = new Map(spec.openQuestions.map((q) => [q.id, q]));
  const out: string[] = [];
  for (const id of blocked) {
    const req = requirements.get(scenarios.get(id)?.requirement ?? "");
    const asked = (req?.blockedBy ?? []).map((q) => questions.get(q)?.question ?? q);
    const line = asked.length ? `${id} waits on: ${asked.join(" / ")}` : `${id} is blocked and names no question`;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/**
 * What a failed suite command actually says, in a shape the verdict can read.
 *
 * Here rather than in the controller because the interesting cases are all
 * shapes of failure that are awkward to produce on purpose — a suite the
 * charrette killed, a runner that died on a signal with no exit code — and each
 * of them means something different to the verdict above.
 */
export function suiteRunFrom(err: { stdout?: string; stderr?: string; message?: string; code?: number; killed?: boolean }, timeoutMinutes: number): SuiteRun {
  // A suite the charrette killed produced no verdict at all. Reporting its
  // partial output as "these scenarios failed" would name whichever ones
  // happened to run first, which is a statement about ordering.
  if (err.killed) return { exitCode: 1, output: "", error: `the scenario suite did not finish inside ${timeoutMinutes} minutes` };
  const output = [err.stdout, err.stderr || err.message].filter(Boolean).join("\n");
  return { exitCode: typeof err.code === "number" ? err.code : 1, output };
}

/**
 * The scenarios a task is judged by, given what the run knows.
 *
 * Null spec, no ids, ids the specification does not declare, ids that are
 * blocked — every one of them produces no command, which the caller reads as
 * "this task has no scenario check" and never as "run everything".
 */
export function scenarioProbeCommand(spec: RunSpec | null, ids: string[]): string {
  if (!spec || !ids.length) return "";
  const runnable = new Set(spec.scenarios.filter((s) => !s.blocked).map((s) => s.id));
  return scenarioCommand(spec.commands, ids.filter((id) => runnable.has(id)));
}

/**
 * The command that runs one task's scenarios, from the template the spec agent
 * detected.
 *
 * A worker is judged on what it was asked to build, not on the run: holding
 * task three to a scenario task nine has not started is how a gate teaches a
 * worker to fix somebody else's file. Empty when there is no template or no
 * scenario to select, which the caller reads as "this task has no scenario
 * check" rather than as "run everything".
 */
export function scenarioCommand(commands: { byId: string }, ids: string[]): string {
  if (!commands.byId.trim() || !ids.length) return "";
  // `|` is what every runner this meets uses for alternation in a name filter —
  // vitest and jest `-t`, pytest `-k` takes `or`, which the agent puts in the
  // template itself. The separator is the template's business; the ids are ours.
  return commands.byId.replaceAll("{{ids}}", ids.join("|"));
}

/**
 * What the specification proves about the finished run, for the completion
 * report.
 *
 * The report already answers "is this feature switched on". This answers the
 * question underneath it — is there anything that would notice if it broke —
 * and the two are independent: a feature can be live and unproven, or dark and
 * thoroughly specified.
 */
export interface SpecCoverage {
  /** Requirements with at least one gating scenario that went green. */
  proven: number;
  /** Requirements whose scenarios exist and are failing. */
  broken: number;
  /** Requirements with no scenario at all, or only blocked ones. */
  unproven: string[];
  total: number;
}

export function specCoverage(spec: RunSpec, failing: Iterable<string>): SpecCoverage {
  const red = new Set(failing);
  const runnable = new Map<string, SpecScenario[]>();
  for (const s of spec.scenarios) {
    if (s.blocked) continue;
    const list = runnable.get(s.requirement);
    if (list) list.push(s);
    else runnable.set(s.requirement, [s]);
  }
  let proven = 0;
  let broken = 0;
  const unproven: string[] = [];
  for (const req of spec.requirements) {
    const mine = runnable.get(req.id) ?? [];
    if (!mine.length) unproven.push(req.id);
    else if (mine.some((s) => red.has(s.id))) broken += 1;
    else proven += 1;
  }
  return { proven, broken, unproven, total: spec.requirements.length };
}
