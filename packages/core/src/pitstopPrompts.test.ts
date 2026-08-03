import { describe, expect, it } from "vitest";
import { demoPrompt, demoSystemPrompt, intakeSystemPrompt, replanPrompt, reviewerPrompt, reviewerSystemPrompt } from "./prompts.js";

/**
 * What the pit stop's agents are actually told. These prompts carry the whole
 * of the feature's judgment — a demo agent that reads the diff instead of
 * running the product, or a reviewer with no lens, produces exactly the report
 * the plan gate already produced.
 */

describe("the demo agent", () => {
  const system = demoSystemPrompt("/repo/.harness/r1/pitstops/1", "\ntoolbelt", "\nskills");

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

  it("is given somewhere to put the evidence, and told to leave the tree alone", () => {
    expect(system).toContain("/repo/.harness/r1/pitstops/1");
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
