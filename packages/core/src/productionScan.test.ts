import { PlannedTask } from "@charrette/shared";
import { describe, expect, it } from "vitest";
import { renderProduction, scanProduction } from "./productionScan.js";

function task(over: Partial<PlannedTask> = {}): PlannedTask {
  return {
    id: "task-a",
    epicId: "epic-e",
    title: "A task",
    spec: "Do a thing.",
    acceptanceCriteria: ["The thing is done"],
    dependsOn: [],
    touchedPaths: [],
    estimatedSize: "M",
    ...over,
  } as PlannedTask;
}

describe("scanProduction", () => {
  it("says nothing at all about a plan whose brief never asked for any of it", () => {
    // A parsing library. No demand anywhere, so no paragraph — the reason an
    // operator still reads this section when it does appear.
    expect(scanProduction("Write a CSV parser with a streaming API.", [task()])).toEqual([]);
  });

  it("reports a deployment nobody planned when the brief asked for production", () => {
    const found = scanProduction("Ship this to production.", [task({ title: "Order API", spec: "REST handlers." })]);
    expect(found.map((f) => f.dimension)).toEqual(["deploy"]);
    expect(found[0]!.asked).toBe("production");
  });

  it("stays quiet when any task in the plan owns the dimension", () => {
    // Ownership is a property of the plan, not of one task: whichever task
    // carries the deployment, the operator has one.
    const tasks = [task({ id: "task-a", title: "Order API" }), task({ id: "task-b", title: "Terraform for the API" })];
    expect(scanProduction("Ship this to production.", tasks)).toEqual([]);
  });

  it("finds the supply in acceptance criteria, not only the title", () => {
    const tasks = [task({ title: "Order API", spec: "REST handlers.", acceptanceCriteria: ["`terraform validate` passes"] })];
    expect(scanProduction("Ship this to production.", tasks)).toEqual([]);
  });

  it("reports an unowned login when the brief asked for accounts", () => {
    const found = scanProduction("Users sign in and see their own orders.", [task({ title: "Orders list" })]);
    expect(found.map((f) => f.dimension)).toEqual(["security"]);
  });

  it("reports unowned visual design when the brief asked for a UI", () => {
    const found = scanProduction("A responsive web UI for the orders.", [
      task({ title: "Orders endpoint", spec: "JSON over HTTP.", acceptanceCriteria: ["Returns 200"] }),
    ]);
    expect(found.map((f) => f.dimension)).toEqual(["design"]);
  });

  it("reports unowned observability when the brief asked to be alerted", () => {
    const found = scanProduction("We need alerting when a payment fails.", [
      task({ title: "Payments", spec: "Charge a card.", acceptanceCriteria: ["A charge succeeds"] }),
    ]);
    expect(found.map((f) => f.dimension)).toEqual(["observability"]);
  });

  it("reports every dimension the brief asked for and the plan skipped", () => {
    const found = scanProduction("A production web app with sign-in, a designed UI, and monitoring.", [
      task({ title: "Domain model", spec: "Types.", acceptanceCriteria: ["Types compile"] }),
    ]);
    expect(found.map((f) => f.dimension)).toEqual(["deploy", "security", "design", "observability"]);
  });

  it("reads the brief the operator gave, so the PRD can supply the demand the assignment left implicit", () => {
    // planSummary passes assignment + PRD as one brief: a one-line assignment
    // with a PRD that spells out hosting still has a deployment gap.
    const brief = "Build the thing.\n# PRD\nThe service is deployed to AWS.";
    expect(scanProduction(brief, [task()]).map((f) => f.dimension)).toEqual(["deploy"]);
  });
});

describe("renderProduction", () => {
  it("renders nothing for no findings, so the gate does not print a heading with nothing under it", () => {
    expect(renderProduction([])).toBe("");
  });

  it("quotes the operator's own word back so they can judge whether the match is real", () => {
    const out = renderProduction(scanProduction("Ship this to production.", [task()]));
    expect(out).toContain("Production shape");
    expect(out).toContain('deploy (you said "production")');
    expect(out).toContain("nowhere to run");
    expect(out).toContain("If one is deliberately out of scope, approve and it stays out.");
  });
});
