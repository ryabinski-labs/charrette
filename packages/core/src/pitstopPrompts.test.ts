import { describe, expect, it } from "vitest";
import {
  demoPrompt,
  demoSystemPrompt,
  intakeSystemPrompt,
  PRIOR_DECISION_MAX,
  PRIOR_DECISIONS_BUDGET,
  pitStopDeciderPrompt,
  pitStopDeciderSystemPrompt,
  priorDecisionsBlock,
  replanPrompt,
  reviewerPrompt,
  reviewerSystemPrompt,
} from "./prompts.js";

/**
 * What the pit stop's agents are actually told. These prompts carry the whole
 * of the feature's judgment — a demo agent that reads the diff instead of
 * running the product, or a reviewer with no lens, produces exactly the report
 * the plan gate already produced.
 */

describe("the demo agent", () => {
  const system = demoSystemPrompt("/repo/.charrette/r1/pitstops/1", "/repo-wt/r1/__integration__", "\ntoolbelt", "\nskills");

  it("is told to run the thing, not to read it", () => {
    expect(system).toContain("START the half-built product");
    expect(system).toContain("A unit test passing is not a demo");
  });

  it("is told that saying what it could not reach is the valuable part", () => {
    // Run ec40b527's validator was right about a broken seam and right that it
    // had not looked for more of the same. The second half is what nobody read.
    expect(system).toContain("Say plainly what you could NOT reach");
    expect(system).toContain("Never imply coverage you do not have");
  });

  it("is told which checkout is the product, because the evidence path is in another one", () => {
    // Pit stop 33 of run bc691359: the demo was cwd'd into the integration
    // worktree and told to write its captures to
    // `<repoPath>/.charrette/<runId>/pitstops/33`. That path is inside the
    // operator's own checkout, which was parked on `main` — four crates and a
    // whole `ui/` behind the integration branch. The agent read the artifacts
    // path as "the repo", explored it, and reported the control plane, the k8s
    // controller and the UI as never built. All three had merged days earlier.
    // Nothing caught it: the tree-clean rule inspects the worktree, so reading
    // a different checkout is invisible to it.
    expect(system).toContain("/repo-wt/r1/__integration__");
    expect(system).toMatch(/Demo \/repo-wt\/r1\/__integration__ and nothing else/);
    expect(system).toMatch(/never read the product from it/);
    expect(system).toMatch(/never `cd`, `ls`, `cat`, `git` or `cargo` your way into any other checkout/);
    expect(system).toMatch(/is not a gap, and reporting it as one sends the run to rebuild something it already merged/);
  });

  it("is given somewhere to put the evidence, and told to leave the tree alone", () => {
    expect(system).toContain("/repo/.charrette/r1/pitstops/1");
    expect(system).toContain("Do not modify the repository");
    expect(system).toContain("the operator's diff is not yours to touch");
  });

  it("is never allowed to deploy or provision anything to make a better demo", () => {
    expect(system).toContain("NEVER deploy, provision or destroy infrastructure");
  });

  it("carries the toolbelt and the skills it was given", () => {
    expect(system).toContain("toolbelt");
    expect(system).toContain("skills");
  });

  it("is told what has merged and what has not, so it hunts for the right things", () => {
    const prompt = demoPrompt("build a map app", "- Sign in (task-a)", "- The map (task-b)");

    expect(prompt).toContain("build a map app");
    expect(prompt).toContain("Not built yet, so do not go looking for it");
    expect(prompt).toContain("The map (task-b)");
  });

  it("leaves out the not-yet-built list when there is nothing left", () => {
    expect(demoPrompt("build a map app", "- Sign in (task-a)", "")).not.toContain("Not built yet");
  });
});

describe("a reviewer", () => {
  it("is given one lens and told to stay in it", () => {
    const system = reviewerSystemPrompt("product-manager");

    expect(system).toContain("**product-manager**");
    expect(system).toContain("Stay in your lane");
    expect(system).toContain("is this still the thing the operator asked for?");
  });

  it("is told that manufacturing a concern is worse than having none", () => {
    expect(reviewerSystemPrompt("qa-agent")).toContain("A reviewer that manufactures a concern to look useful is worse than a quiet one");
  });

  it("reads the demo, not just the diff", () => {
    const prompt = reviewerPrompt("qa-agent", "build a map app", "# PRD", '{"started":true}', "- task-a: MERGED", "- task-b");

    expect(prompt).toContain("What the demo agent found when it ran the product");
    expect(prompt).toContain('{"started":true}');
    expect(prompt).toContain("The PRD:");
    expect(prompt).toContain("Still to be built");
  });

  it("skips the sections it has nothing for", () => {
    const prompt = reviewerPrompt("qa-agent", "build a map app", "", "{}", "- task-a: MERGED", "");

    expect(prompt).not.toContain("The PRD:");
    expect(prompt).not.toContain("Still to be built");
  });
});

describe("re-planning at a pit stop", () => {
  const prompt = () =>
    replanPrompt("build a map app", "# PRD", "- task-a: Sign in [MERGED]", "- task-c: Offline mode", "drop the offline mode", "- epic-one: Sign-in");

  it("tells the planner exactly what it may not touch", () => {
    expect(prompt()).toContain("IMMOVABLE");
    expect(prompt()).toContain("task-a: Sign in [MERGED]");
    expect(prompt()).toContain("Emit only the replacement tasks — never the merged ones");
  });

  it("carries the operator's words verbatim, and the epics they belong to", () => {
    expect(prompt()).toContain("drop the offline mode");
    expect(prompt()).toContain("- epic-one: Sign-in");
  });

  it("lets a surviving task keep its id, and its issue with it", () => {
    expect(prompt()).toContain("reuse the same id when a task survives unchanged");
  });

  it("works without a PRD to show", () => {
    expect(replanPrompt("a", "", "b", "c", "d", "e")).not.toContain("The PRD it was planned from");
  });
});

describe("the agent that decides what the run does next", () => {
  const system = pitStopDeciderSystemPrompt("product-manager");

  it("wears the hat it was named as, and knows nobody is behind it", () => {
    expect(system).toContain("**product-manager**");
    expect(system).toContain("Nobody is going to confirm it");
  });

  it("names the cheap answer as the one that needs the most evidence", () => {
    // An agent handed a decision reaches for the one that ends the
    // conversation, and at a pit stop that is "continue".
    expect(system).toContain('"continue" is the answer that ends this conversation fastest');
  });

  it("names the opposite failure too, so it does not re-plan every checkpoint", () => {
    expect(system).toContain("Prefer the smallest action that fixes what you found");
    expect(system).toContain("A stopped run waits for a person who may be asleep");
  });

  it("makes stopping the expensive answer rather than the careful one", () => {
    // f338b5c8 stopped at 2am over two good questions, with $127 of cap and
    // eight buildable tasks that neither question blocked, and opened no PR.
    expect(system).toContain("**Stopping is not the careful answer. It is the expensive one.**");
    expect(system).toContain("could I have written this as a redirect?");
  });

  it("enumerates the four things only an operator can settle, and demands one", () => {
    for (const only of ["**money**", "**scope**", "**access**", "**direction**"]) expect(system).toContain(only);
    expect(system).toContain('`blockedOn` is required when — and only when — the action is "stop"');
    // The two excuses that are not authority, named so they cannot be reached for.
    expect(system).toContain('"I would like a human to confirm this" is not one of the four categories');
    expect(system).toContain('Neither is "there are two reasonable options"');
  });

  it("separates the sentence for the record from the words the run acts on", () => {
    expect(system).toContain("`feedback` is what the run acts on, and it is read by agents, not by you");
    expect(system).toContain("instructions someone can follow without having read this report");
  });

  it("puts the whole report in front of it, and what the run has left to spend", () => {
    const prompt = pitStopDeciderPrompt("build a map app", "# PRD", "# Pit stop 1 — first epic merged", "It has spent $12 of $30.\n\n");
    expect(prompt).toContain("# Pit stop 1 — first epic merged");
    expect(prompt).toContain("The PRD it was planned from");
    expect(prompt).toContain("It has spent $12 of $30.");
  });

  it("works without a PRD to show", () => {
    expect(pitStopDeciderPrompt("a", "", "b", "c")).not.toContain("The PRD it was planned from");
  });

  it("shows it what it has already decided, and why repeating it is the failure", () => {
    // A fresh session each time, so without this it is free to give the same
    // redirect a third time and call it a new idea.
    const prompt = pitStopDeciderPrompt("a", "", "b", "c", "1. **redirect** (product-manager) — the empty states are missing");
    expect(prompt).toContain("What was decided at this run's earlier pit stops");
    expect(prompt).toContain("the empty states are missing");
    expect(prompt).toContain("repeating it is how a run spends its budget going round");
  });

  it("says nothing about earlier decisions at the first pit stop", () => {
    expect(pitStopDeciderPrompt("a", "", "b", "c")).not.toContain("earlier pit stops");
  });

  it("tells it that its last instruction is still in force, not history", () => {
    // Run 407c2b0b's decider superseded its own earlier instruction at stop 6
    // ("I am the one who gave it to you") — by then the tasks had been carrying
    // the wrong figure for three stops.
    const prompt = pitStopDeciderPrompt("a", "", "b", "c", "1. **redirect** (product-manager) — x");
    expect(prompt).toContain("it is the instruction those tasks are still carrying");
    expect(prompt).toContain("say which instruction it replaces");
  });
});

describe("what the decider is shown of its own earlier instructions", () => {
  const decision = (n: number, feedback: string) => ({
    action: "redirect",
    decidedBy: "product-manager",
    why: `reason ${n}`,
    feedback,
  });

  it("shows a short run's instructions in full, oldest first", () => {
    const block = priorDecisionsBlock([decision(1, "do the thing"), decision(2, "do the other thing")]);

    expect(block).toContain("1. **redirect** (product-manager) — reason 1");
    expect(block).toContain("do the thing");
    expect(block).toContain("do the other thing");
    expect(block).not.toContain("more characters");
    // Oldest first: the decider needs the order they were given to see what
    // did not take.
    expect(block.indexOf("reason 1")).toBeLessThan(block.indexOf("reason 2"));
  });

  it("shows enough of a real pit stop's feedback to read past the preamble", () => {
    // The bug this replaces: run 407c2b0b's eight stops wrote 5,028–10,415
    // characters of feedback each and the next decider saw the first 500 — of
    // which 136 were the same "KEEP EVERYTHING MERGED" preamble every time. It
    // was shown eight near-identical paragraphs and none of the instructions.
    const preamble = "KEEP EVERYTHING MERGED. Nothing is reverted. ".padEnd(500, ".");
    const real = `${preamble}THE ACTUAL INSTRUCTION: cut tiering to two sweeps.`;
    const block = priorDecisionsBlock([decision(1, real)]);

    expect(block).toContain("THE ACTUAL INSTRUCTION: cut tiering to two sweeps.");
  });

  it("spends the budget on the newest instructions when there is not enough for all", () => {
    // Twenty stops of maximum-length feedback: the ones still in force survive
    // and the ancient history is what degrades.
    const long = "x".repeat(PRIOR_DECISION_MAX);
    const block = priorDecisionsBlock(Array.from({ length: 20 }, (_, i) => decision(i + 1, `${i + 1}|${long}`)));

    expect(block).toContain("20|xxx");
    expect(block).toContain("19|xxx");
    // And the oldest are named, with their reason, rather than vanishing — a
    // decision missing from the list reads as a decision never made.
    expect(block).toContain("1. **redirect** (product-manager) — reason 1");
    expect(block).toContain("[omitted — ");
  });

  it("stays within its budget however much was written", () => {
    const long = "y".repeat(PRIOR_DECISION_MAX * 2);
    const block = priorDecisionsBlock(Array.from({ length: 30 }, (_, i) => decision(i + 1, long)));

    // Headers and markers are outside the budget, so allow for them; what is
    // bounded is the feedback, and the point is that thirty pit stops cannot
    // push the report out of the prompt.
    expect(block.length).toBeLessThan(PRIOR_DECISIONS_BUDGET * 2);
    expect((block.match(/y/g) ?? []).length).toBeLessThanOrEqual(PRIOR_DECISIONS_BUDGET);
  });

  it("says how much it cut rather than ending mid-sentence", () => {
    const block = priorDecisionsBlock([decision(1, "z".repeat(PRIOR_DECISION_MAX + 250))]);

    expect(block).toContain("[…250 more characters]");
  });

  it("leaves out the feedback line entirely for a decision that carried none", () => {
    // `continue` usually does. A dangling "What the run was told:" with nothing
    // after it reads like the instruction was lost.
    const block = priorDecisionsBlock([{ action: "continue", decidedBy: "product-manager", why: "on track", feedback: "" }]);

    expect(block).toBe("1. **continue** (product-manager) — on track");
  });

  it("has nothing to say before the first pit stop resolves", () => {
    expect(priorDecisionsBlock([])).toBe("");
  });

  it("still names a decision whose why was empty", () => {
    const block = priorDecisionsBlock([{ action: "stop", decidedBy: "operator", why: "", feedback: "" }]);

    expect(block).toBe("1. **stop** (operator)");
  });
});

describe("the intake agent's disambiguation sweep", () => {
  const system = intakeSystemPrompt();

  it("asks about the things that are expensive to change later", () => {
    for (const dimension of ["Look and feel", "Architecture and stack", "Performance and scale", "Security, privacy and compliance", "Deployment and operations"]) {
      expect(system).toContain(dimension);
    }
  });

  it("wants reference products rather than adjectives for the visual direction", () => {
    // "Modern and clean" is not answerable and not buildable; two agents given
    // it produce two different products.
    expect(system).toContain('"like Linear: dense, dark, keyboard-first" is answerable');
  });

  it("still refuses to ask what the repository already answers", () => {
    expect(system).toContain('"Which test framework?" is a failure if package.json says vitest');
    expect(system).toContain("A question whose answers all lead to the same build is a question you should not ask");
  });

  it("writes down the decision even when the operator waves it off", () => {
    // Otherwise every worker invents its own answer, separately.
    expect(system).toContain('A dimension the operator waves off ("you decide", "don\'t care") is decided');
  });

  it("leads with the choices that constrain the most downstream work", () => {
    expect(system).toContain("A decision made late invalidates what was built before it");
  });
});
