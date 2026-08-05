// @vitest-environment happy-dom

/**
 * The dashboard is a string of HTML with a string of JavaScript inside it, so
 * nothing about it is importable and none of it was ever covered. These tests
 * take the one property that a rendering loop can quietly lose and pin it:
 * *the operator's place*. The page re-renders several times a minute from a
 * poll and from every agent event, and each of those used to wipe the panel it
 * touched — which meant a disclosure closed itself, a scrolled block jumped to
 * the top, and a selection died about two words into being dragged.
 *
 * The assertion that carries almost all of that is DOM node identity. An equal
 * node is not the same node: replacing one takes the selection, the focus and
 * the scroll offset with it, and no amount of "it looks right" catches that.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_HTML } from "./page.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- the page is untyped JS. */
type Any = any;

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function task(over: Partial<Record<string, Any>> = {}): Any {
  return {
    id: "t1", title: "A task", state: "WORKING", dependsOn: [], qaIterations: 0,
    assignedSkills: [], acceptanceCriteria: [], spec: null, errorSummary: null,
    githubIssueNumber: null, prNumber: null, ...over,
  };
}

function run(over: Partial<Record<string, Any>> = {}): Any {
  return {
    id: "r1", repoPath: "/repo", integrationBranch: "harness/r1/main",
    createdAt: NOW - 3 * 3600_000, state: "EXECUTING", githubRepo: "acme/app",
    assignment: "Build the thing.", spentUsd: 1, sessions: [],
    config: {
      deterministicChecks: ["build", "test"], qaIterationCap: 3,
      budget: { runCapUsd: 100, taskCapUsd: 10 },
    },
    tasks: [task()], ...over,
  };
}

function state(over: Partial<Record<string, Any>> = {}): Any {
  return { runs: [run()], planGate: null, budgetGate: null, taskGates: [], pitStop: null, ...over };
}

interface Mounted {
  /** Poll once, as the 5s interval and every state-changing event do. */
  refresh(): Promise<void>;
  /** Serve this on the next poll. */
  serve(next: Any): void;
}

/**
 * Put the page in a document and run its script.
 *
 * `fetch` and `setInterval` are passed in rather than patched onto the global:
 * as parameters they shadow the real ones for the whole script body, so the
 * page cannot reach the network and cannot leave a timer behind after the test.
 */
function mount(initial: Any): Mounted {
  const opensAt = PAGE_HTML.indexOf("<script>");
  const closesAt = PAGE_HTML.indexOf("</script>");
  const source = PAGE_HTML.slice(opensAt + "<script>".length, closesAt);
  document.documentElement.innerHTML =
    (PAGE_HTML.slice(0, opensAt) + PAGE_HTML.slice(closesAt + "</script>".length))
      .replace(/^[\s\S]*?<html[^>]*>/, "")
      .replace(/<\/html>\s*$/, "");

  let payload = initial;
  const fetchStub = (url: string): Promise<Any> => {
    if (url === "/api/state") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    }
    // The event stream, opened once per run. Never answering it is what a run
    // with nothing to say looks like, and keeps the test to the poll path.
    return new Promise(() => {});
  };

  const factory = new Function("fetch", "setInterval", source + "\n;return { refresh: refresh };");
  const api = factory(fetchStub, () => 0);
  return {
    refresh: () => api.refresh(),
    serve: (next: Any) => { payload = next; },
  };
}

/** Open a <details> the way a click does, including the event the page listens for. */
function open(d: Element): void {
  (d as HTMLDetailsElement).open = true;
  d.dispatchEvent(new Event("toggle"));
}

const $ = (sel: string) => document.querySelector(sel);
const all = (sel: string) => [...document.querySelectorAll(sel)];
const titles = () => all("#board .task .title").map((n) => n.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  return () => vi.useRealTimers();
});

describe("the run panel", () => {
  it("keeps the assignment open, scrolled and selected across a poll", async () => {
    const page = mount(state());
    await page.refresh();

    const details = $("#runinfo details")!;
    open(details);
    const pre = details.querySelector("pre")!;
    pre.scrollTop = 120;

    // A poll that changed only the spend — the overwhelming majority of them.
    page.serve(state({ runs: [run({ spentUsd: 42 })] }));
    await page.refresh();

    expect($("#runinfo details")).toBe(details);
    expect((details as HTMLDetailsElement).open).toBe(true);
    expect(details.querySelector("pre")).toBe(pre);
    expect(pre.scrollTop).toBe(120);
  });

  it("ticks the elapsed clock without rebuilding the panel", async () => {
    const page = mount(state());
    await page.refresh();

    const details = $("#runinfo details")!;
    const age = $("#runinfo span")!;
    expect(age.textContent).toBe("3h 0m ago");

    vi.setSystemTime(NOW + 61_000);
    await page.refresh();

    expect(age.textContent).toBe("3h 1m ago");
    expect($("#runinfo span")).toBe(age);
    expect($("#runinfo details")).toBe(details);
  });

  it("rebuilds when the assignment itself changes, and reopens it", async () => {
    const page = mount(state());
    await page.refresh();

    const details = $("#runinfo details")!;
    open(details);

    page.serve(state({ runs: [run({ assignment: "Build a different thing." })] }));
    await page.refresh();

    const rebuilt = $("#runinfo details")!;
    expect(rebuilt).not.toBe(details);
    expect(rebuilt.querySelector("pre")!.textContent).toBe("Build a different thing.");
    // The operator had it open. A rebuild is not a reason to close it.
    expect((rebuilt as HTMLDetailsElement).open).toBe(true);
  });

  it("leaves the assignment closed when the operator never opened it", async () => {
    const page = mount(state());
    await page.refresh();
    page.serve(state({ runs: [run({ assignment: "Something else." })] }));
    await page.refresh();

    expect(($("#runinfo details") as HTMLDetailsElement).open).toBe(false);
  });

  it("puts the scroll regions in the tab order", async () => {
    const page = mount(state());
    await page.refresh();

    // Nothing inside a <pre> is focusable, and only Chrome and Firefox put a
    // scrollable box in the tab order on their own — without this the
    // assignment is unreadable in Safari without a mouse.
    const pre = $("#runinfo details pre") as HTMLElement;
    expect(pre.tabIndex).toBe(0);
    expect(pre.getAttribute("role")).toBe("group");
    expect(pre.getAttribute("aria-label")).toBe("Assignment the planner received");
    expect(($("#gate-prd") as HTMLElement).tabIndex).toBe(0);
  });

  it("says so when there is no run at all", async () => {
    const page = mount(state({ runs: [] }));
    await page.refresh();
    expect($("#runinfo")!.textContent).toBe("No active runs.");
  });
});

describe("what is running now", () => {
  const session = (over: Partial<Record<string, Any>> = {}): Any => ({
    id: "s1", role: "worker", taskId: "t1", state: "running",
    startedAt: NOW - 60_000, turns: 12, model: "claude-opus-5", ...over,
  });

  it("lists the running agent", async () => {
    const page = mount(state({ runs: [run({ sessions: [session()] })] }));
    await page.refresh();

    expect($("#now")!.textContent).toContain("worker · t1");
    expect($("#now")!.textContent).toContain("12 replies");
    expect($("#nowcount")!.textContent).toBe("");
  });

  it("does not claim the harness is waiting on you between two agents", async () => {
    // The worker has ended, QA has not started, and the task is plainly still
    // in progress — the gap every handover leaves in the sessions table.
    const page = mount(state({
      runs: [run({ tasks: [task({ id: "t1", state: "QA" })], sessions: [session({ state: "done" })] })],
    }));
    await page.refresh();

    const now = $("#now")!.textContent!;
    expect(now).toContain("Between agents on t1");
    expect(now).toContain("Nothing is waiting on you");
    expect(now).not.toContain("waiting on you, on git");
    expect($("#nowcount")!.textContent).toBe("between agents");
  });

  it("says so once the gap is longer than a handover takes", async () => {
    const page = mount(state({
      runs: [run({ tasks: [task({ id: "t1", state: "WORKING" })], sessions: [session({ state: "done" })] })],
    }));
    await page.refresh();

    vi.setSystemTime(NOW + 200_000);
    await page.refresh();

    expect($("#now")!.textContent).toContain("longer than a handover takes");
  });

  it("still says it is idle when no task is in progress either", async () => {
    const page = mount(state({
      runs: [run({ tasks: [task({ id: "t1", state: "NEEDS_HUMAN" })], sessions: [session({ state: "done" })] })],
    }));
    await page.refresh();

    expect($("#now")!.textContent).toContain("the harness is waiting on you, on git, or between tasks");
    expect($("#nowcount")!.textContent).toBe("idle");
  });

  it("stops counting the gap as soon as an agent is running again", async () => {
    const page = mount(state({
      runs: [run({ tasks: [task({ id: "t1", state: "WORKING" })], sessions: [session({ state: "done" })] })],
    }));
    await page.refresh();

    vi.setSystemTime(NOW + 200_000);
    await page.refresh();
    expect($("#now")!.textContent).toContain("longer than a handover takes");

    // An agent starts, then hands over again: the new gap is short, and must
    // not inherit the age of the one before it.
    page.serve(state({ runs: [run({ tasks: [task({ id: "t1", state: "WORKING" })], sessions: [session()] })] }));
    await page.refresh();
    page.serve(state({
      runs: [run({ tasks: [task({ id: "t1", state: "WORKING" })], sessions: [session({ state: "done" })] })],
    }));
    await page.refresh();

    expect($("#now")!.textContent).toContain("Between agents on t1");
    expect($("#now")!.textContent).not.toContain("longer than a handover");
  });
});

describe("the task board", () => {
  const two = () => state({
    runs: [run({
      tasks: [
        task({ id: "t1", title: "First", state: "WORKING" }),
        task({ id: "t2", title: "Second", state: "PENDING" }),
      ],
    })],
  });

  it("hands back the same card when nothing about it changed", async () => {
    const page = mount(two());
    await page.refresh();

    const cards = all("#board .task");
    const groups = all("#board details");
    page.serve(two());
    await page.refresh();

    expect(all("#board .task")).toEqual(cards);
    expect(all("#board details")).toEqual(groups);
  });

  it("replaces only the card whose facts changed", async () => {
    const page = mount(two());
    await page.refresh();
    const [first, second] = all("#board .task");

    page.serve(state({
      runs: [run({
        tasks: [
          task({ id: "t1", title: "First", state: "WORKING", qaIterations: 2 }),
          task({ id: "t2", title: "Second", state: "PENDING" }),
        ],
      })],
    }));
    await page.refresh();

    const after = all("#board .task");
    expect(after[0]).not.toBe(first);
    expect(after[0]!.textContent).toContain("QA ×2");
    expect(after[1]).toBe(second);
  });

  it("keeps an open task disclosure open through a poll", async () => {
    const page = mount(state({
      runs: [run({ tasks: [task({ spec: "Do it carefully.", acceptanceCriteria: ["It works"] })] })],
    }));
    await page.refresh();

    const what = $("#board .task details")!;
    open(what);
    page.serve(state({
      runs: [run({ spentUsd: 9, tasks: [task({ spec: "Do it carefully.", acceptanceCriteria: ["It works"] })] })],
    }));
    await page.refresh();

    expect($("#board .task details")).toBe(what);
    expect((what as HTMLDetailsElement).open).toBe(true);
  });

  it("moves a card between groups without rebuilding it", async () => {
    const page = mount(two());
    await page.refresh();
    const second = all("#board .task")[1];

    // t2 starts running: it leaves Queued for Running, and the card itself is
    // unchanged apart from the state the group already says.
    page.serve(state({
      runs: [run({
        tasks: [
          task({ id: "t1", title: "First", state: "WORKING" }),
          task({ id: "t2", title: "Second", state: "WORKING" }),
        ],
      })],
    }));
    await page.refresh();

    expect(titles()).toEqual(["First", "Second"]);
    expect(all("#board details")).toHaveLength(1);
    // The card is rebuilt — its own state changed — but it landed in the right
    // group in the right order rather than being appended wherever.
    expect(all("#board .task")[1]).not.toBe(second);
  });

  it("reorders in place, keeping every card it already had", async () => {
    const page = mount(state({
      runs: [run({
        tasks: [
          task({ id: "t1", title: "First", state: "WORKING" }),
          task({ id: "t2", title: "Second", state: "WORKING" }),
          task({ id: "t3", title: "Third", state: "WORKING" }),
        ],
      })],
    }));
    await page.refresh();
    const before = all("#board .task");

    page.serve(state({
      runs: [run({
        tasks: [
          task({ id: "t3", title: "Third", state: "WORKING" }),
          task({ id: "t1", title: "First", state: "WORKING" }),
          task({ id: "t2", title: "Second", state: "WORKING" }),
        ],
      })],
    }));
    await page.refresh();

    expect(titles()).toEqual(["Third", "First", "Second"]);
    expect(new Set(all("#board .task"))).toEqual(new Set(before));
  });

  it("drops a card that is gone and forgets it", async () => {
    const page = mount(two());
    await page.refresh();
    const [first] = all("#board .task");

    page.serve(state({ runs: [run({ tasks: [task({ id: "t2", title: "Second", state: "PENDING" })] })] }));
    await page.refresh();
    expect(titles()).toEqual(["Second"]);

    // Back again with different facts: the card must be built from those, not
    // resurrected from a cache that outlived it.
    page.serve(two());
    await page.refresh();
    expect(titles()).toEqual(["First", "Second"]);
    expect(all("#board .task")[0]).not.toBe(first);
  });

  it("clears the board when the last task goes away", async () => {
    const page = mount(two());
    await page.refresh();
    expect(all("#board .task")).toHaveLength(2);

    page.serve(state({ runs: [run({ state: "PLANNING", tasks: [] })] }));
    await page.refresh();

    expect(all("#board .task")).toHaveLength(0);
    expect($("#board")!.textContent).toContain("The planner is reading the repository");
    expect($("#taskcount")!.textContent).toBe("");
  });

  it("counts what is done, in the group heading and the bar", async () => {
    const page = mount(state({
      runs: [run({
        tasks: [
          task({ id: "t1", title: "First", state: "MERGED" }),
          task({ id: "t2", title: "Second", state: "WORKING" }),
        ],
      })],
    }));
    await page.refresh();

    expect($("#taskcount")!.textContent).toBe("1 of 2 done");
    expect(all("#board details .n").map((n) => n.textContent)).toEqual([" 1", " 1"]);
    expect(($("#tbar")!.children[0] as HTMLElement).style.width).toBe("50%");
  });

  it("keeps a group the operator closed closed", async () => {
    const page = mount(two());
    await page.refresh();

    const group = $("#board details") as HTMLDetailsElement;
    group.open = false;
    group.dispatchEvent(new Event("toggle"));

    page.serve(state({ runs: [run({ spentUsd: 7, tasks: two().runs[0].tasks })] }));
    await page.refresh();

    expect($("#board details")).toBe(group);
    expect(group.open).toBe(false);
  });
});

describe("the pull request list", () => {
  const withPr = (over: Partial<Record<string, Any>> = {}) => state({
    runs: [run({ tasks: [task({ id: "t1", title: "First", state: "MERGED", prNumber: 7, ...over })] })],
  });

  it("leaves the list alone on a poll that changed nothing in it", async () => {
    const page = mount(withPr());
    await page.refresh();

    const row = $("#prs .pr")!;
    page.serve(state({
      runs: [run({ spentUsd: 99, tasks: [task({ id: "t1", title: "First", state: "MERGED", prNumber: 7 })] })],
    }));
    await page.refresh();

    expect($("#prs .pr")).toBe(row);
    expect($("#prcount")!.textContent).toBe("1");
  });

  it("redraws when a pull request arrives", async () => {
    const page = mount(withPr());
    await page.refresh();

    page.serve(state({
      runs: [run({
        tasks: [
          task({ id: "t1", title: "First", state: "MERGED", prNumber: 7 }),
          task({ id: "t2", title: "Second", state: "MERGED", prNumber: 8 }),
        ],
      })],
    }));
    await page.refresh();

    expect(all("#prs .pr")).toHaveLength(2);
    expect($("#prcount")!.textContent).toBe("2");
    expect(($("#prs a") as HTMLAnchorElement).href).toBe("https://github.com/acme/app/pull/7");
  });

  it("explains an empty list differently once the run has ended", async () => {
    const page = mount(state());
    await page.refresh();
    expect($("#prs")!.textContent).toContain("None yet.");

    page.serve(state({ runs: [run({ state: "PR_REVIEW" })] }));
    await page.refresh();
    expect($("#prs")!.textContent).toContain("see what is parked above");
  });
});
