import { describe, expect, it } from "vitest";
import { pathsRepeat, planRepeats, planRepeatsNote, subjectWords, titleRepeats } from "./planRepeats.js";

/**
 * Every case here is spelled the way run 6fe4ba37 (waf) spelled it. That run
 * merged `seclang ast types` twice under two ids, planned and merged the
 * multipart, JSON and XML body parsers twice each, and then paid a further task
 * to consolidate the duplicates it had made. All of it was legible in the task
 * titles at the pit stop that approved the second plan, and nothing compared
 * them (issue #128).
 */
describe("the words of a title that say what it is about", () => {
  it("keeps the subject and drops the scaffolding around it", () => {
    expect([...subjectWords("Implement the multipart body parser")]).toEqual(["multipart", "body", "parser"]);
  });

  it("reads a slug, a path and a sentence as the same words", () => {
    expect(subjectWords("body-parser/multipart.rs")).toEqual(subjectWords("Body parser: multipart rs"));
  });

  it("drops single letters, which distinguish nothing", () => {
    // `a`, `x` and the `v` of `v2` are noise in a title; `v2` itself is not.
    expect([...subjectWords("a v2 x parser")]).toEqual(["v2", "parser"]);
  });

  it("counts a word said twice once", () => {
    expect([...subjectWords("parser parser tests")]).toEqual(["parser", "tests"]);
  });
});

describe("two titles that describe the same work", () => {
  it("matches the same subject written at two lengths", () => {
    expect(titleRepeats("Body parser: multipart", "Implement the multipart body parser")).toBe(true);
  });

  it("matches across capitalisation, which is the form the real duplicate took", () => {
    expect(titleRepeats("seclang ast types", "Seclang AST types")).toBe(true);
  });

  it("does not match two tasks that merely share a word", () => {
    expect(titleRepeats("multipart body parser", "seclang parser")).toBe(false);
  });

  it("does not match a title whose subject is one word, however common that word is", () => {
    // "Add the parser" against every other parser task in the plan is a gate
    // that fires constantly and is read by nobody.
    expect(titleRepeats("Add the parser", "Implement the multipart body parser")).toBe(false);
  });

  it("does not match when it is the other title that says almost nothing", () => {
    expect(titleRepeats("Implement the multipart body parser", "Add the parser")).toBe(false);
  });
});

describe("a task whose paths are already somebody else's", () => {
  it("matches a file the merged task changed", () => {
    expect(pathsRepeat(["src/body/multipart.rs"], ["src/body/multipart.rs", "src/body/json.rs"])).toBe(true);
  });

  it("matches a file inside a directory the merged task owned", () => {
    expect(pathsRepeat(["src/body/multipart.rs"], ["src/body"])).toBe(true);
  });

  it("reads ./src/body/ and src/body as the same directory", () => {
    expect(pathsRepeat(["./src/body/multipart.rs"], ["src/body/"])).toBe(true);
  });

  it("does not match a task that also reaches somewhere new", () => {
    expect(pathsRepeat(["src/body/multipart.rs", "src/http/router.rs"], ["src/body"])).toBe(false);
  });

  it("does not match a sibling directory whose name merely starts the same way", () => {
    // `src/bodyguard` is not inside `src/body`, and a prefix test without the
    // separator would say it is.
    expect(pathsRepeat(["src/bodyguard/x.rs"], ["src/body"])).toBe(false);
  });

  it("says nothing about a task that named no paths", () => {
    expect(pathsRepeat([], ["src/body"])).toBe(false);
  });

  it("says nothing when the merged task named no paths", () => {
    expect(pathsRepeat(["src/body/multipart.rs"], ["  "])).toBe(false);
  });
});

describe("work a re-plan is about to pay for twice", () => {
  it("names the merged task a proposed one repeats, and which comparison found it", () => {
    const found = planRepeats(
      [{ id: "task-ast", title: "seclang ast types", touchedPaths: ["src/seclang/ast.rs"] }],
      [{ id: "task-ast-2", title: "Seclang AST types", touchedPaths: [] }]
    );
    expect(found).toEqual([
      {
        taskId: "task-ast-2",
        title: "Seclang AST types",
        mergedId: "task-ast",
        mergedTitle: "seclang ast types",
        why: "the titles describe the same work",
      },
    ]);
  });

  it("catches a repeat that was renamed, by the files it says it will edit", () => {
    const found = planRepeats(
      [{ id: "task-mp", title: "Body parser: multipart", touchedPaths: ["src/body/multipart.rs"] }],
      [{ id: "task-uploads", title: "Handle file uploads", touchedPaths: ["src/body/multipart.rs"] }]
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.why).toBe("every path it names is one that task already changed");
  });

  it("leaves alone a plan that builds something new", () => {
    expect(
      planRepeats(
        [{ id: "task-mp", title: "Body parser: multipart", touchedPaths: ["src/body/multipart.rs"] }],
        [{ id: "task-router", title: "Route requests by host header", touchedPaths: ["src/http/router.rs"] }]
      )
    ).toEqual([]);
  });

  it("does not accuse a task of repeating itself", () => {
    // A re-plan reuses the ids of tasks it is keeping, and the kept task is
    // usually already merged. That is the same task, not a second one.
    expect(
      planRepeats(
        [{ id: "task-mp", title: "Body parser: multipart", touchedPaths: ["src/body/multipart.rs"] }],
        [{ id: "task-mp", title: "Body parser: multipart", touchedPaths: ["src/body/multipart.rs"] }]
      )
    ).toEqual([]);
  });

  it("reports a proposed task once, against the first merged task it matches", () => {
    const found = planRepeats(
      [
        { id: "task-mp", title: "Body parser: multipart", touchedPaths: ["src/body"] },
        { id: "task-mp-again", title: "The multipart body parser", touchedPaths: ["src/body"] },
      ],
      [{ id: "task-mp-3", title: "multipart body parser", touchedPaths: ["src/body/multipart.rs"] }]
    );
    expect(found.map((r) => r.mergedId)).toEqual(["task-mp"]);
  });
});

describe("what the operator is told about it", () => {
  it("says nothing at all about a plan that repeats nothing", () => {
    expect(planRepeatsNote([])).toBe("");
  });

  it("names the pair and what this comparison is worth", () => {
    const note = planRepeatsNote(
      planRepeats(
        [{ id: "task-ast", title: "seclang ast types", touchedPaths: [] }],
        [{ id: "task-ast-2", title: "Seclang AST types", touchedPaths: [] }]
      )
    );
    expect(note).toContain('1 task(s) in this plan look like work this run has already merged: task-ast-2 ("Seclang AST types") repeats task-ast');
    // The operator is told what the finding is made of, so they can overrule it.
    expect(note).toContain("not a judgment about the work");
    expect(note).not.toContain("more");
  });

  it("counts the repeats it does not have room to name", () => {
    const merged = Array.from({ length: 7 }, (_, i) => ({ id: `merged-${i}`, title: `parser number ${i}`, touchedPaths: [] }));
    const proposed = Array.from({ length: 7 }, (_, i) => ({ id: `again-${i}`, title: `Parser number ${i}`, touchedPaths: [] }));
    const note = planRepeatsNote(planRepeats(merged, proposed));
    expect(note).toContain("7 task(s) in this plan look like work this run has already merged");
    expect(note).toContain("+2 more");
    // Five named, and the sixth and seventh only counted.
    expect(note).not.toContain("again-5");
  });
});
