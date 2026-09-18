import { PlannedTask } from "@charrette/shared";
import { describe, expect, it } from "vitest";
import { PATCH_COVERAGE_FLOOR, renderCi, scanCi } from "./ciScan.js";

function task(over: Partial<PlannedTask> = {}): PlannedTask {
  return {
    id: "task-a",
    epicId: "epic-e",
    title: "A task",
    spec: "Do a thing.",
    acceptanceCriteria: ["The thing is done"],
    dependsOn: [],
    touchedPaths: [],
    completionProbe: "",
    estimatedSize: "M",
    ...over,
  } as PlannedTask;
}

/** A task that owns both halves, for the plans that are supposed to be quiet. */
function pipeline(over: Partial<PlannedTask> = {}): PlannedTask {
  return task({
    id: "ci",
    title: "CI pipeline",
    spec: "GitHub Actions workflow running build, lint and the suite.",
    acceptanceCriteria: ["Coverage below 80% fails the build"],
    touchedPaths: [".github/workflows/ci.yml"],
    ...over,
  });
}

describe("scanCi", () => {
  it("reports both gaps for a plan that builds an application and nothing that checks it", () => {
    // Run 3ae58e02, in miniature: sixty tasks, tests everywhere, no pipeline.
    const found = scanCi([task({ title: "Order API", spec: "REST handlers." }), task({ id: "b", title: "Orders UI" })]);
    expect(found.map((f) => f.gap)).toEqual(["workflow", "coverage"]);
  });

  it("is not demand-driven: a parsing library with no pipeline is still reported", () => {
    // The difference from productionScan, which stays silent on a brief that
    // never asked. Nothing has to ask for CI.
    expect(scanCi([task({ title: "CSV parser", spec: "A streaming API." })]).map((f) => f.gap)).toContain("workflow");
  });

  it("stays quiet when any task in the plan owns the pipeline and a floor", () => {
    expect(scanCi([task({ title: "Order API" }), pipeline()])).toEqual([]);
  });

  it("finds the workflow in touchedPaths, where the planner is told to name it", () => {
    const tasks = [task({ title: "Build and test", spec: "Wire it up.", touchedPaths: [".github/workflows/ci.yml"], acceptanceCriteria: ["Coverage threshold enforced"] })];
    expect(scanCi(tasks)).toEqual([]);
  });

  it("accepts the pipeline under a name that is not GitHub's", () => {
    for (const spec of ["A .gitlab-ci.yml with a test stage.", "CircleCI config running the suite.", "A Jenkinsfile with build and test stages.", "Buildkite pipeline for the monorepo."]) {
      const found = scanCi([pipeline({ spec, touchedPaths: [] })]);
      expect(found.map((f) => f.gap), spec).toEqual([]);
    }
  });

  it("does not accept a container image as a pipeline", () => {
    // The exact substitution that let 3ae58e02 through productionScan's deploy
    // probe: a thing to run is not a thing that checks.
    const tasks = [
      task({ title: "Docker Compose stack, .env.example and README", spec: "Dockerfile for the API and a compose file for local dev.", acceptanceCriteria: ["Coverage below 80% fails the build"] }),
    ];
    expect(scanCi(tasks).map((f) => f.gap)).toEqual(["workflow"]);
  });

  it("does not accept a coverage report as a coverage floor", () => {
    // "The suite reports coverage" is satisfied by a run that prints 11% and
    // exits zero. A floor is a number the build fails under.
    const tasks = [pipeline({ acceptanceCriteria: ["The test job prints a coverage summary"] })];
    expect(scanCi(tasks).map((f) => f.gap)).toEqual(["coverage"]);
  });

  it("accepts a floor written any of the ways a floor gets written", () => {
    for (const criterion of [
      "Coverage below 80% fails the build",
      "Line coverage is at least 75%",
      "The job runs pytest --cov-fail-under=80",
      "jest coverageThreshold is set for global lines",
      "nyc check-coverage gates the test job",
      "80% coverage is enforced on changed lines",
      "A codecov patch status blocks the merge",
    ]) {
      const found = scanCi([pipeline({ acceptanceCriteria: [criterion] })]);
      expect(found.map((f) => f.gap), criterion).toEqual([]);
    }
  });

  it("reads the plan as one haystack, so the floor may live in a different task than the workflow", () => {
    const tasks = [
      task({ id: "wf", title: "CI workflow", touchedPaths: [".github/workflows/ci.yml"] }),
      task({ id: "cov", title: "Coverage gate", acceptanceCriteria: ["The build fails under 80% coverage"] }),
    ];
    expect(scanCi(tasks)).toEqual([]);
  });
});

describe("renderCi", () => {
  it("renders nothing for no findings, so the gate does not print a heading with nothing under it", () => {
    expect(renderCi([])).toBe("");
  });

  it("names the number, so the operator is not left to invent one", () => {
    const out = renderCi(scanCi([task()]));
    expect(out).toContain("Continuous integration");
    expect(out).toContain("empty checks list");
    expect(out).toContain(`${PATCH_COVERAGE_FLOOR}% of the lines a change touches`);
    expect(out).toContain("approve and it stays that way");
  });
});
