import { describe, expect, it } from "vitest";
import {
  INTERFACE_STANDARD,
  advisorPrompt,
  advisorSystemPrompt,
  demoEvidenceReaskPrompt,
  demoSystemPrompt,
  emptyBranchPrompt,
  extractJson,
  plannerBreakdownSystemPrompt,
  qaSystemPrompt,
  skillsBlock,
  workerSystemPrompt,
} from "./prompts.js";

const fence = "```";

describe("extractJson", () => {
  it("reads a plain fenced object", () => {
    expect(extractJson(`${fence}json\n{"verdict":"PASS","notes":"fine"}\n${fence}`)).toEqual({
      verdict: "PASS",
      notes: "fine",
    });
  });

  it("reads an object with no fence around it", () => {
    expect(extractJson('Here you go: {"verdict":"PASS","notes":""}')).toEqual({ verdict: "PASS", notes: "" });
  });

  /**
   * The production failure: a planner PRD about JSON manifests embedded its own
   * ```json examples inside the prdMarkdown string. The old non-greedy fence
   * regex sliced at the first inner fence and threw away three valid plans.
   */
  it("survives a string field that embeds its own json fences", () => {
    const prd = [
      "# PRD",
      "The manifest looks like:",
      `${fence}json`,
      '{"posts":[{"slug":"a"}]}',
      fence,
      "and the sitemap entry is:",
      `${fence}json`,
      '{"loc":"/blog/a"}',
      fence,
    ].join("\n");
    const payload = { prdMarkdown: prd, conventionsMarkdown: "use vitest", epics: [], tasks: [] };
    const text = `Here is the plan.\n\n${fence}json\n${JSON.stringify(payload)}\n${fence}`;

    expect(extractJson(text)).toEqual(payload);
  });

  it("survives braces and escaped quotes inside string values", () => {
    const payload = { spec: 'call foo({ "a": 1 }) and expect "ok"', tasks: [] };
    expect(extractJson(`${fence}json\n${JSON.stringify(payload)}\n${fence}`)).toEqual(payload);
  });

  it("survives an unbalanced brace inside a string value", () => {
    const payload = { spec: "the regex is /^\\{+$/ which is fine" };
    expect(extractJson(JSON.stringify(payload))).toEqual(payload);
  });

  it("ignores prose before and after the object", () => {
    const text = `I surveyed the repo. Root cause: the deploy step overwrites {the manifest}.\n\n${fence}json\n{"ok":true}\n${fence}\n\nLet me know if you want changes.`;
    expect(extractJson(text)).toEqual({ ok: true });
  });

  it("takes the last complete object when the agent shows a draft first", () => {
    const text = `Draft:\n${fence}json\n{"v":1}\n${fence}\nFinal:\n${fence}json\n{"v":2}\n${fence}`;
    expect(extractJson(text)).toEqual({ v: 2 });
  });

  it("keeps nested objects and arrays intact", () => {
    const payload = { tasks: [{ id: "a", dependsOn: [], meta: { size: "S" } }] };
    expect(extractJson(JSON.stringify(payload))).toEqual(payload);
  });

  it("does not mistake an inner object for the answer", () => {
    const payload = { outer: true, inner: { outer: false } };
    expect(extractJson(`${fence}json\n${JSON.stringify(payload)}\n${fence}`)).toEqual(payload);
  });

  it("throws a diagnosable error when there is no object at all", () => {
    expect(() => extractJson("I could not complete this task.")).toThrow(/no JSON object found in 31 chars/);
  });

  it("throws rather than returning a fragment when the object is truncated", () => {
    expect(() => extractJson(`${fence}json\n{"prdMarkdown":"# PRD`)).toThrow(/no JSON object found/);
  });
});

/**
 * The harness could not build infrastructure for a reason that had nothing to do
 * with the worker: QA's only notion of "verified" was a green test suite, so
 * declarative configuration — which has no unit tests by construction — was
 * rejected for missing evidence it can never produce, three times, then parked.
 */
describe("infrastructure work", () => {
  it("stops QA failing declarative config for having no unit tests", () => {
    const p = qaSystemPrompt();
    expect(p).toMatch(/Do not fail an infra task for an empty tests directory/);
    expect(p).toMatch(/demanding them is a defect in your review/);
  });

  it("gives QA the verification loop the tools actually provide", () => {
    const p = qaSystemPrompt();
    for (const cmd of ["terraform plan", "cdk synth", "helm template", "kubectl --dry-run=server"]) {
      expect(p).toContain(cmd);
    }
    // A plan is QA's green suite, and it has to show its work like any verdict.
    expect(p).toMatch(/a plan that succeeds is your equivalent of a green suite/i);
  });

  it("points QA at the defects a plan cannot show", () => {
    // Infra bugs are almost never syntax; they are a wildcard nobody read.
    const p = qaSystemPrompt();
    for (const smell of ["0.0.0.0/0", "wildcard", "unencrypted", "deletion protection"]) {
      expect(p.toLowerCase()).toContain(smell.toLowerCase());
    }
  });

  it("forbids QA provisioning anything to settle a criterion", () => {
    const p = qaSystemPrompt();
    expect(p).toMatch(/NEVER apply, deploy, or destroy anything to verify it/);
    // An unverifiable criterion is a reported gap, never a licence to deploy.
    expect(p).toMatch(/a gap to report, not a reason to touch the operator's infrastructure/);
  });

  it("tells the planner infra is a deliverable, with criteria that need no account", () => {
    const p = plannerBreakdownSystemPrompt();
    expect(p).toMatch(/Infrastructure is a legitimate deliverable/);
    expect(p).toMatch(/checkable WITHOUT provisioning anything/);
    // The trap this closes: "the bucket exists in staging" is unjudgeable here.
    expect(p).toMatch(/cannot be judged and will park the task/);
  });

  /**
   * The probe used to be reserved for sweeps, and the measurement said so: of
   * 406 planned tasks across twelve runs, 305 carried no probe at all. A task
   * without one cannot reach the light tier however small it is — `taskTier`
   * refuses it outright — so the instruction, not the rule, was what kept the
   * cheap worker at zero tasks in every run this harness has ever done.
   */
  it("asks for a completion probe on every small task, not only on sweeps", () => {
    const p = plannerBreakdownSystemPrompt();
    expect(p).toContain("Write one for every task you size `S`");
    // The sweep case is still the one that cannot be written any other way.
    expect(p).toMatch(/cannot be half-satisfied/);
    // And the ordinary task now has an example, which is what makes the ask
    // concrete rather than an instruction to be creative.
    expect(p).toMatch(/npx tsc --noEmit/);
  });

  /**
   * Widening what gets a probe widens what a bad probe can cost. Run f338b5c8
   * spent nine rounds and about $80 on one task whose probe was a false
   * positive — red for a reason the task was never asked to fix — so the rule
   * that would have caught it is stated as a rule rather than left to taste.
   */
  it("refuses a probe that is red before the task starts, and prefers none to a wrong one", () => {
    const p = plannerBreakdownSystemPrompt();
    expect(p).toMatch(/a probe that is red before the task starts parks the task forever/);
    expect(p).toMatch(/a wrong probe costs far more than a missing one/);
    // Still read-only and still re-runnable: the harness runs it on every QA
    // iteration against the tree the operator is about to review.
    expect(p).toMatch(/never something that writes, deploys, installs or provisions/);
  });
});

/**
 * Skill routing decides whether an agent gets the *playbooks*; this decides
 * whether it gets the *rules*. The distinction is the whole design: routing is
 * a regex over task text, and the operator asked for interfaces that are always
 * good — not interfaces that are good whenever a planner happened to write the
 * word "component" into a spec.
 */
describe("the interface standard", () => {
  const worker = workerSystemPrompt("use vitest", "", "");
  const qa = qaSystemPrompt();

  it("reaches every worker, whatever the task text says", () => {
    // No skill, no toolbelt, conventions that mention nothing visual — the
    // conditions under which routing injects precisely nothing.
    expect(worker).toContain(INTERFACE_STANDARD);
    // And it scopes itself, so a database migration is not held to it.
    expect(worker).toMatch(/whenever what you build renders anything a human being looks at/);
    expect(worker).toMatch(/Ignore it only when this task produces nothing anyone sees/);
  });

  it("is the same text on both sides of the gate", () => {
    // Two copies would drift, and drift here has a specific victim: a worker
    // failed for a rule it was never given, three times, then parked.
    expect(qa).toContain(INTERFACE_STANDARD);
    expect(qa).toMatch(/The worker was handed this same list verbatim/);
  });

  it("is fenced off from the instructions that quote it", () => {
    // Both call sites embed it inside their own bulleted list. Unfenced, QA's
    // "judge it against the standard below" ran straight into six bullets that
    // read as QA's own rules, and the "FAIL on the standard above" that follows
    // them had no visible antecedent.
    for (const prompt of [worker, qa]) {
      expect(prompt).toContain(`<interface-standard>\n${INTERFACE_STANDARD}\n</interface-standard>`);
    }
  });

  it("says what a native control is, because that is the loudest tell", () => {
    // The operator's words: app-native selectors, not browser defaults.
    expect(INTERFACE_STANDARD).toMatch(/Use the application's own components/);
    expect(INTERFACE_STANDARD).toContain("<select>");
    expect(INTERFACE_STANDARD).toContain("window.confirm");
    expect(INTERFACE_STANDARD).toMatch(/build the primitive once/);
  });

  it("gives the list thresholds as numbers a reviewer can count", () => {
    // "Add filters if the list is long" is not checkable and so cannot gate.
    expect(INTERFACE_STANDARD).toMatch(/More than 7 options in a selector: make it searchable/);
    expect(INTERFACE_STANDARD).toMatch(/More than 20 rows or cards in a list: give it filter and sort/);
    expect(INTERFACE_STANDARD).toMatch(/More than 100: paginate or virtualize/);
    // The state that is forgotten every single time a filter is added.
    expect(INTERFACE_STANDARD).toMatch(/empty state that says how to clear the filter/);
  });

  it("requires the three states nobody builds, and forbids the error nobody can act on", () => {
    expect(INTERFACE_STANDARD).toMatch(/loading, empty, error, and full/);
    expect(INTERFACE_STANDARD).toMatch(/never "Something went wrong"/);
  });

  it("wants the interface self-explanatory before it is documented", () => {
    expect(INTERFACE_STANDARD).toMatch(/self-explanatory first and documented second/);
    expect(INTERFACE_STANDARD).toMatch(/a tooltip explaining a confusing label is the second-best fix/);
    expect(INTERFACE_STANDARD).toMatch(/not in a doc they will never open/);
  });
});

describe("QA's authority over how something looks", () => {
  const qa = qaSystemPrompt();

  it("makes QA open the app and look, rather than read the markup", () => {
    expect(qa).toMatch(/screenshot the surface this task touched/);
    expect(qa).toMatch(/Desktop width and mobile width/);
    expect(qa).toMatch(/Reading the JSX is not looking at the screen/);
  });

  /**
   * The bounded half of the mandate, and the one that keeps it usable. A task
   * gets three QA iterations in its life; a reviewer who may fail on taste can
   * spend all three on a disagreement the worker cannot resolve, and the task
   * parks having been correct the whole time.
   */
  it("fails only on the countable rules and demotes taste to a note", () => {
    expect(qa).toMatch(/FAIL on the standard above and only on it/);
    expect(qa).toMatch(/Everything else you notice about how it looks is a NOTE, not a FAIL/);
    expect(qa).toMatch(/a palette you would have chosen differently/);
    expect(qa).toMatch(/three QA iterations in its whole life/);
    // And a failure has to be actionable, or the worker cannot clear it either.
    expect(qa).toMatch(/Name the file and the component in mustFix/);
  });

  it("keeps an unrenderable surface an honest gap rather than a pass", () => {
    expect(qa).toMatch(/say which parts of the standard went unchecked/);
    expect(qa).toMatch(/how an unusable screen ships/);
  });

  it("still lets infrastructure work be infrastructure work", () => {
    // The visual block sits directly above the infra block and neither may
    // swallow the other: declarative config renders nothing and has no states.
    expect(qa).toMatch(/Do not fail an infra task for an empty tests directory/);
    expect(qa.indexOf("FAIL on the standard above and only on it")).toBeLessThan(
      qa.indexOf("When the artifact is infrastructure")
    );
  });
});

describe("what the demo agent photographs", () => {
  it("captures both widths and the states, because a lens reads it afterwards", () => {
    // The pit stop's design reviewer never runs the product. Everything it can
    // say about the interface comes out of this directory.
    const p = demoSystemPrompt("/tmp/artifacts");
    expect(p).toMatch(/at desktop width and again at mobile width/);
    expect(p).toMatch(/capture the empty and error states/);
    expect(p).toMatch(/A surface you described but did not capture is a surface nobody reviewed/);
  });

  it("makes it look at its own screenshots, and says what a blank one costs", () => {
    // A pit stop shipped a 1082x2202 white rectangle as evidence of a mobile
    // page. The agent knew — it said so, four paragraphs into its summary — and
    // listed the file anyway.
    const p = demoSystemPrompt("/tmp/artifacts");
    expect(p).toMatch(/LOOK AT EVERY SCREENSHOT YOU TAKE, with Read, before you list it/);
    expect(p).toMatch(/one flat colour is a failed capture/);
    // Told how to fix it, not just that it is forbidden: both failures the
    // harness has actually seen — an unpainted page, and a device descriptor
    // pinning a browser that is not installed.
    expect(p).toContain("--wait-for-timeout=3000");
    expect(p).toContain("--viewport-size=390,844");
    expect(p).toMatch(/The harness inspects every image you list/);
  });

  it("asks for the claim each file backs, not a list of filenames", () => {
    const p = demoSystemPrompt("/tmp/artifacts");
    expect(p).toContain('"artifacts":[{"file":string,"shows":string}]');
    expect(p).toMatch(/what a reader learns by opening that file/);
    expect(p).toMatch(/A file you cannot write a claim for is a file that proves nothing/);
  });

  it("sends the retake back with the faults named and the stack still up", () => {
    const p = demoEvidenceReaskPrompt(["mobile.png — 390x844 of a single colour — the page never painted"]);
    expect(p).toContain("mobile.png");
    expect(p).toMatch(/the same session, nothing has been torn down/);
    // And the way out of a retake that fails again: say it, do not ship it.
    expect(p).toMatch(/drop from artifacts and say so in couldNotReach/);
    expect(p).toMatch(/Do not re-drive journeys you already ran/);
  });
});

describe("what an agent is told about the machine it is on", () => {
  it("tells QA a test that pins this host is worse than no test", () => {
    // Run 40da9337's PR came back red on CI over a QA-authored sanity check
    // that asserted `fe80::1` was rejected as an SSRF target. True on the
    // laptop that wrote it, false everywhere else, and green in the run.
    const p = qaSystemPrompt();
    expect(p).toMatch(/pass on a machine that is not this one/);
    expect(p).toContain("fe80::1");
    for (const trap of ["home directory", "timezone", "environment variable"]) {
      expect(p).toContain(trap);
    }
    // And the way out, so the rule does not just forbid without instructing.
    expect(p).toMatch(/a temp directory the test creates and removes/);
    expect(p).toMatch(/report it as unverified rather than committing a test that pins it/);
  });
});

describe("what the advisor is told about the repository", () => {
  const task = {
    id: "task-a", runId: "r", epicId: "e", title: "A", spec: "s", acceptanceCriteria: ["x"],
    dependsOn: [], state: "WORKING" as const, branch: null, worktreePath: null,
    githubIssueNumber: null, prNumber: null, qaIterations: 0, respawns: 0,
    assignedSkills: [], errorSummary: null, touchedPaths: [], completionProbe: "", unverified: [], estimatedSize: "M" as const,
  };

  it("names the commands the repository actually checks a task with", () => {
    // The advisor is asked to verify QA's claims and dropped into a worktree
    // with no idea how anything runs. In run 40da9337 the fact it needed was
    // one line, and nothing ever told it.
    const p = advisorPrompt(task, "QA rejected it", ["npx tsx scripts/testRun.ts <file>", "npm run lint"]);

    expect(p).toContain("npx tsx scripts/testRun.ts <file>");
    expect(p).toContain("npm run lint");
    expect(p).toMatch(/rather than guessing at a command/);
  });

  it("says nothing about checks when the repository declares none", () => {
    const p = advisorPrompt(task, "QA rejected it");

    expect(p).not.toMatch(/How this repository checks a task/);
    expect(p).toContain("Investigate the worktree you are in");
  });

  it("drafts for a human by default, and answers as the named skill when there is one", () => {
    const draft = advisorSystemPrompt();
    expect(draft).toContain("draft the answer they will probably give");
    // Nothing about handing anything back: there is nobody to hand it to, the
    // operator is already reading it.
    expect(draft).not.toContain("needsOperator");

    const decides = advisorSystemPrompt("", "product-manager", skillsBlock([{ name: "product-manager", content: "# PM playbook", path: "/s/pm" }]));
    expect(decides).toContain("**product-manager**");
    expect(decides).toContain("sent to the worker as-is");
    expect(decides).toContain("# PM playbook");
    // The one thing it can do that stops the run, and the four cases for it.
    expect(decides).toContain('"needsOperator":boolean');
    expect(decides).toMatch(/a credential issued/);
    expect(decides).toMatch(/product decision nobody has made/);
    // Both are still asked to investigate rather than summarise.
    for (const p of [draft, decides]) expect(p).toMatch(/Check the cheap ones against the code/);
  });

  /**
   * The operator's half of an escalation, and the reason it has to be asked for
   * rather than left to the prose: run 7ef8fb4d parked a task on "this needs a
   * real deploy and a real magic-link token" — true, complete, and it left the
   * operator to work out which repository, which workflow, which account, and
   * what evidence would count as an answer.
   */
  it("asks for a runbook whoever is answering, and says when not to write one", () => {
    for (const p of [advisorSystemPrompt(), advisorSystemPrompt("", "product-manager")]) {
      expect(p).toContain('"runbook":{"blocked":string,"steps":[{"do":string,"command":string}],"sendBack":string}|null');
      expect(p).toContain("Most escalations are `null`; do not manufacture chores for the operator");
      // The two failure modes that make a runbook useless: a placeholder
      // command, and an answer the worker cannot act on.
      expect(p).toMatch(/rather than a placeholder/);
      expect(p).toContain('"Confirm it worked" is not an answer the worker can use');
    }
  });

  it("offers the probe field only at the gate the probe opened", () => {
    // Every other escalation is about the attempt, and a knob for rewriting the
    // task's definition of done has no business being on the table there.
    expect(advisorSystemPrompt("", "product-manager")).not.toContain('"probe"');

    const p = advisorSystemPrompt("", "product-manager", "", "! rg -qi 'passkey' src");
    expect(p).toContain('"probe":string|null');
    // The probe it is being asked about, quoted back verbatim.
    expect(p).toContain("! rg -qi 'passkey' src");
    // Why the field exists at all: agreeing with a failing probe reopens the
    // same gate forever.
    expect(p).toMatch(/no instruction you give can make a wrong probe pass/);
    // And the two rails on it: narrow rather than delete, and leave it alone by
    // default.
    expect(p).toMatch(/Narrow it, do not delete it/);
    expect(p).toMatch(/right answer nearly every time/);
  });

  it("stops arguing for `null` once the gate it opens has opened repeatedly", () => {
    // The default lean toward leaving a probe alone is right, and on run
    // 1e7d3df3 it was right fourteen times in a row about a probe that demanded
    // proof of an operation the run's own tooling forbids. A repeat is the
    // evidence that hedge was hedging against, so past the second round the
    // advisor is made to re-read the probe before reaching for `null` again.
    const first = advisorSystemPrompt("", "product-manager", "", "test -f apply.log", 1);
    expect(first).toMatch(/right answer nearly every time/);
    expect(first).not.toContain("This gate has already opened");

    const again = advisorSystemPrompt("", "product-manager", "", "test -f apply.log", 6);
    expect(again).toContain("This gate has already opened 6 times on this task");
    expect(again).toMatch(/an answer of the same kind has now been tried 6 times/);
    expect(again).toMatch(/demands an artifact the run's own tooling forbids producing/);
    // Not a licence to clear it: a probe that survives the re-read is still the
    // right answer, it just has to be said out loud so the next round knows.
    expect(again).toMatch(/say so in `why` and leave it `null`/);
    // And it is still the probe gate's language only.
    expect(advisorSystemPrompt("", "product-manager", "", "", 6)).not.toContain("This gate has already opened");
  });

  it("tells the advisor how many times this task has already stopped someone", () => {
    const task = { title: "T", spec: "s", acceptanceCriteria: ["x"] } as Parameters<typeof advisorPrompt>[0];

    expect(advisorPrompt(task, "the probe still fails", [])).not.toContain("This is not the first time");

    const once = advisorPrompt(task, "the probe still fails", [], 1);
    expect(once).toContain("This gate has opened once before on this task");

    const many = advisorPrompt(task, "the probe still fails", [], 13);
    expect(many).toContain("This gate has opened 13 times before on this task");
    // The attempt count in the question is not evidence — every answer reset it.
    expect(many).toMatch(/reset by each answer and does not show it/);
    // And the specific shape the loop takes, so the advisor can recognise it.
    expect(many).toMatch(/documenting why it cannot proceed rather than proceeding/);
  });
});

/**
 * The worker has to be told which of the two mistakes it made. "No commits" is
 * work that went somewhere else; "commits that change nothing" is an empty
 * commit or a change and its own revert, and looking for missing files is the
 * wrong thing to do about it.
 */
describe("telling a worker its branch delivers nothing", () => {
  it("says a branch with no commits has none", () => {
    const p = emptyBranchPrompt("harness/r/task-a", 0);

    expect(p).toContain("`harness/r/task-a` delivers nothing: it has no commits on it at all.");
    expect(p).toContain("git stash list");
  });

  it("counts the commits that changed nothing, in the singular and the plural", () => {
    expect(emptyBranchPrompt("b", 1)).toContain("it has 1 commit, and together they change no files.");
    expect(emptyBranchPrompt("b", 3)).toContain("it has 3 commits, and together they change no files.");
  });
});
