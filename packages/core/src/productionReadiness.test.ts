import { describe, expect, it } from "vitest";
import { plannerBreakdownSystemPrompt, validatorSystemPrompt } from "./prompts.js";

/**
 * Run 40da9337 is the case these guard. It spent $773.55, merged all 36 of its
 * tasks, passed every QA verdict, and produced something that could not be
 * deployed and could not move a dollar:
 *
 *   - six of seven vendor clients were `throw liveProviderNotConfigured(...)`
 *   - no scheduler existed anywhere, so four written-and-tested workers never ran
 *   - no deployment artifact of any kind
 *   - a payee enrollment invite with no email sender, handing the raw token back
 *     to the API caller
 *
 * The validator caught the second of those and reported it beautifully. It read
 * the first and said "Core money-movement logic ... wired correctly". It was
 * never asked about the third or fourth. These assert the instructions that
 * close that distance — the prompts are the mechanism, so the prompts are what
 * there is to test.
 */
describe("what the planner is now required to decide", () => {
  const prompt = plannerBreakdownSystemPrompt();

  it("makes live the default for anything that talks to a third party", () => {
    expect(prompt).toContain("which side of the mock/live line it delivers");
    expect(prompt).toContain("the default is live");
    expect(prompt).toMatch(/sandbox or documented test mode|vendor's sandbox/);
  });

  it("gives an honest way to scope live out, in words the gate can find", () => {
    // The scan reads this exact phrase off the spec, so the two have to agree.
    expect(prompt).toContain('"Live is out of scope because"');
  });

  it("names the two criteria that actually shipped the stubs", () => {
    // Quoting them is the point: an abstract rule about "testability" is what
    // produced these in the first place.
    expect(prompt).toContain("the suite makes no outbound HTTP call");
    expect(prompt).toContain("each vendor category has a deterministic mock");
    expect(prompt).toContain("describe the test strategy, not the deliverable");
  });

  it("still requires infrastructure to be a task, including a scheduled job", () => {
    expect(prompt).toContain("Infrastructure is a legitimate deliverable");
    expect(prompt).toContain("a scheduled job");
  });

  it("still requires infrastructure criteria that never provision anything", () => {
    expect(prompt).toContain("checkable WITHOUT provisioning anything");
  });

  it("still treats a product's visual language as its own first task", () => {
    expect(prompt).toContain("its visual language is a deliverable with a task of its own, and it comes FIRST");
  });
});

describe("what the validator is now required to judge", () => {
  const prompt = validatorSystemPrompt();

  it("asks whether the external services are real, not whether they compile", () => {
    expect(prompt).toContain("The external services are real");
    expect(prompt).toContain("notConfigured");
    expect(prompt).toContain("is not an integration, it is the shape of one");
    // The run's own number, so the instruction carries its evidence.
    expect(prompt).toContain('shipped one real client out of seven');
  });

  it("asks whether anything starts the background work", () => {
    expect(prompt).toContain("Something starts the background work");
    expect(prompt).toContain("Reachable from a test or an on-demand HTTP route is not scheduled");
  });

  it("asks whether it can be deployed at all, without deploying it", () => {
    expect(prompt).toContain("It can be deployed");
    expect(prompt).toContain("Do not provision anything; read what is committed");
  });

  it("asks where the credentials and the outbound messages go", () => {
    expect(prompt).toContain("Configuration and secrets have a home");
    expect(prompt).toContain("The messages it has to send can be sent");
    // Verbatim from billing-app's payeeEnrollmentService, which says exactly this.
    expect(prompt).toContain("deliver out of band");
  });

  it("asks whether a failure would ever be noticed", () => {
    expect(prompt).toContain("Failure is visible");
  });

  it("judges against what the operator asked for, not a general standard", () => {
    // Otherwise every prototype gets a FAIL for having no Kubernetes, the
    // verdict stops meaning anything, and the operator stops reading it.
    expect(prompt).toContain("Judge these against what the operator asked for");
    // …but not against what the repository says about itself. A run that could
    // not finish something can always write down that it chose not to, and that
    // sentence is not the operator's (issue #119).
    expect(prompt).toContain("Scope is fixed by the brief, not read from the tree");
    expect(prompt).toContain("a gap those documents disclose is still a gap");
    expect(prompt).not.toContain("if the repo says so");
  });

  it("keeps the seam reading it already did well", () => {
    expect(prompt).toContain("The seams between tasks are yours alone");
    expect(prompt).toContain("A fully written module nobody wired in");
  });

  it("still refuses to launch the product, which is a later agent's job", () => {
    expect(prompt).toContain("Do NOT build a release artifact");
  });
});
