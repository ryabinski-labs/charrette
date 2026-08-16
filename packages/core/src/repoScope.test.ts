import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { foreignRepoPaths, validatePlanScope } from "./repoScope.js";

/**
 * Regression cover for the run-7ef8fb4d shape: a plan whose task is written
 * against a repository the run does not own.
 *
 * The rule under test is narrow on purpose — a sibling of the run's own
 * checkout, nothing else — because the wide version flags routes, ARNs and
 * `/tmp` and gets switched off. Half these cases exist to hold that line.
 */

const REPO = "/Users/dev/projects/api-service-new-ui";
const task = (over: Partial<{ id: string; spec: string; acceptanceCriteria: string[]; touchedPaths: string[] }> = {}) => ({
  id: "task-a",
  spec: "do the thing",
  acceptanceCriteria: ["it works"],
  touchedPaths: [],
  ...over,
});

describe("a task written against a sibling checkout", () => {
  it("is found from the spec, named as the repository rather than the file", () => {
    const t = task({ spec: "In `/Users/dev/projects/api-service-new-api/`, add the api-service_delivery_log table." });
    expect(foreignRepoPaths(t, REPO)).toEqual(["/Users/dev/projects/api-service-new-api"]);
  });

  it("is found through a `~` path, the way the planner actually wrote it", () => {
    const home = os.homedir();
    const repo = path.join(home, "projects", "ui");
    const t = task({ spec: "In `~/projects/api/template.yaml`, add the table." });
    expect(foreignRepoPaths(t, repo)).toEqual([path.join(home, "projects", "api")]);
  });

  it("reports the repository once however many of its files are named", () => {
    const t = task({
      spec: "Edit /Users/dev/projects/api-service-new-api/template.yaml",
      acceptanceCriteria: ["/Users/dev/projects/api-service-new-api/app/config.json has the key"],
      touchedPaths: ["/Users/dev/projects/api-service-new-api/tests/test_delivery_log_table.py"],
    });
    expect(foreignRepoPaths(t, REPO)).toEqual(["/Users/dev/projects/api-service-new-api"]);
  });

  it("reads criteria and touchedPaths, not only the spec", () => {
    expect(foreignRepoPaths(task({ acceptanceCriteria: ["/Users/dev/projects/runner/config.py is updated"] }), REPO)).toEqual([
      "/Users/dev/projects/runner",
    ]);
    expect(foreignRepoPaths(task({ touchedPaths: ["/Users/dev/projects/runner/config.py"] }), REPO)).toEqual(["/Users/dev/projects/runner"]);
  });
});

describe("what is deliberately not a scope error", () => {
  it("ignores paths inside the run's own repository", () => {
    const t = task({ spec: "Edit /Users/dev/projects/api-service-new-ui/src/libs/plan.js and add a test." });
    expect(foreignRepoPaths(t, REPO)).toEqual([]);
  });

  it("ignores the repository root itself", () => {
    expect(foreignRepoPaths(task({ spec: "Work in /Users/dev/projects/api-service-new-ui" }), REPO)).toEqual([]);
  });

  it("ignores routes, system paths and anything else outside the sibling set", () => {
    const t = task({
      spec: "The /pricing route must match. Write fixtures to /tmp/fixtures and grant arn:aws:dynamodb:::table/x/index/*.",
      acceptanceCriteria: ["/etc/hosts is untouched"],
    });
    expect(foreignRepoPaths(t, REPO)).toEqual([]);
  });

  it("ignores dot-directories, which sit beside a repo checked out in $HOME but are tooling", () => {
    const home = os.homedir();
    const t = task({ spec: "Read ~/.claude/settings.json for the skills directory." });
    expect(foreignRepoPaths(t, path.join(home, "myrepo"))).toEqual([]);
  });

  it("ignores the directory the repositories sit in, which names no repository", () => {
    expect(foreignRepoPaths(task({ spec: "Everything lives under /Users/dev/projects." }), REPO)).toEqual([]);
  });

  it("checks nothing for a repository at a filesystem root, which has no sibling set", () => {
    const t = task({ spec: "In /anything/at/all, do the thing." });
    expect(foreignRepoPaths(t, "/repo")).toEqual([]);
    expect(foreignRepoPaths(t, "/")).toEqual([]);
  });
});

describe("validatePlanScope", () => {
  it("says which repository the run owns and what to do instead", () => {
    const errors = validatePlanScope([task({ id: "api-delivery-table-infra", spec: "In `/Users/dev/projects/api-service-new-api/`, add the table." })], REPO);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("task api-delivery-table-infra is written against api-service-new-api");
    expect(errors[0]).toContain("api-service-new-ui");
    expect(errors[0]).toContain("separate run");
  });

  it("is empty for a plan that stays in the run's repository", () => {
    expect(validatePlanScope([task(), task({ id: "task-b", spec: "Edit src/index.ts" })], REPO)).toEqual([]);
  });
});
