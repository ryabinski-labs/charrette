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
      budget: { runCapUsd: 100 },
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
  /** Every write the page sent, in order. */
  posts: { url: string; method: string; contentType?: string }[];
  /** What the next write is answered with. */
  reply(res: { ok: boolean; body?: Any }): void;
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
  const posts: { url: string; method: string; contentType?: string }[] = [];
  let answer: { ok: boolean; body?: Any } = { ok: true, body: {} };
  const fetchStub = (url: string, init?: Any): Promise<Any> => {
    if (url === "/api/state") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    }
    if (init && init.method === "POST") {
      posts.push({ url, method: init.method, contentType: init.headers && init.headers["content-type"] });
      return Promise.resolve({
        ok: answer.ok,
        status: answer.ok ? 200 : 409,
        json: () => Promise.resolve(answer.body ?? {}),
      });
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
    posts,
    reply: (res: { ok: boolean; body?: Any }) => { answer = res; },
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

describe("the header's budget cap", () => {
  it("is an editable control only when exactly one run is showing", async () => {
    const page = mount(state({ runs: [run()] }));
    await page.refresh();

    const cap = $("#cap")!;
    expect(cap.getAttribute("role")).toBe("button");
    expect((cap as HTMLElement).tabIndex).toBe(0);
    expect(cap.textContent).toBe("/ $100");
  });

  it("is not exposed as interactive when there is no single run to point a raise at", async () => {
    const page = mount(state({ runs: [run({ id: "r1" }), run({ id: "r2" })] }));
    await page.refresh();

    const cap = $("#cap")!;
    // A screen reader has no use for "button" on a figure that does nothing
    // when activated — the click handler itself already no-ops past one run,
    // but the role must not claim otherwise.
    expect(cap.getAttribute("role")).toBeNull();
    expect((cap as HTMLElement).tabIndex).toBe(-1);
  });

  it("has no role to claim when there are no runs at all", async () => {
    const page = mount(state({ runs: [] }));
    await page.refresh();

    const cap = $("#cap")!;
    expect(cap.getAttribute("role")).toBeNull();
    expect(cap.textContent).toBe("");
  });
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

describe("the subscription banner", () => {
  const gate = (over: Partial<Record<string, Any>> = {}): Any => ({
    window: "seven_day", percent: 96, resetsAt: NOW + 3 * 86_400_000, pauseAtPercent: 95,
    summary: "96% of the weekly limit · resets Aug 18 at 10pm (Australia/Melbourne)",
    untilReset: "3d 4h", account: "personal", alternatives: ["work", "spare"], ...over,
  });

  it("stays out of the way until the account is nearly spent", async () => {
    const page = mount(state());
    await page.refresh();
    expect(($("#sub") as HTMLElement).style.display).toBe("none");
  });

  it("says what was crossed, when it reopens, and what is being spent", async () => {
    const page = mount(state({ subscriptionGate: gate() }));
    await page.refresh();

    expect(($("#sub") as HTMLElement).style.display).toBe("block");
    const said = $("#sub-detail")!.textContent!;
    expect(said).toContain("96% of the weekly limit");
    expect(said).toContain("past the 95% line");
    expect(said).toContain("reopens in 3d 4h");
    expect(said).toContain('spending "personal"');
  });

  it("offers one button per subscription this run could move to", async () => {
    const page = mount(state({ subscriptionGate: gate() }));
    await page.refresh();

    expect(all("#sub-accounts button").map((b) => b.textContent)).toEqual(["Continue on work", "Continue on spare"]);
  });

  it("does not rebuild the buttons under the operator's cursor", async () => {
    // refresh() runs on a timer and on every streamed event; a rebuilt button
    // is a click that lands on nothing.
    const page = mount(state({ subscriptionGate: gate() }));
    await page.refresh();
    const button = $("#sub-accounts button")!;

    page.serve(state({ subscriptionGate: gate(), runs: [run({ spentUsd: 42 })] }));
    await page.refresh();

    expect($("#sub-accounts button")).toBe(button);
  });

  it("tells an operator with nothing to switch to how to get something to switch to", async () => {
    const page = mount(state({ subscriptionGate: gate({ alternatives: [], account: "" }) }));
    await page.refresh();

    expect(all("#sub-accounts button")).toHaveLength(0);
    expect($("#sub-accounts")!.textContent).toContain("subscription.accounts");
    expect($("#sub-detail")!.textContent).not.toContain('spending ""');
  });

  it("draws the gate that is actually open, even when it reads the same as the last one", async () => {
    // Regression: the guard keyed on the summary, and two gates in a row read
    // identically — which is the *normal* case, because the gate after a switch
    // asks about the account the switch just moved to. The page kept the first
    // gate's buttons, so clicking "Continue on work" on a gate that no longer
    // offered it came back "unknown subscription account". Found by driving the
    // real dashboard in a browser, not by any unit test.
    const page = mount(state({ subscriptionGate: gate() }));
    await page.refresh();
    expect(all("#sub-accounts button").map((b) => b.textContent)).toEqual(["Continue on work", "Continue on spare"]);

    // Same summary, different account and different offer.
    page.serve(state({ subscriptionGate: gate({ account: "work", alternatives: ["spare"] }) }));
    await page.refresh();

    expect(all("#sub-accounts button").map((b) => b.textContent)).toEqual(["Continue on spare"]);
    expect($("#sub-detail")!.textContent).toContain('spending "work"');
  });

  it("says the run is on quota rather than at a pit stop", async () => {
    // Regression: `notify` hardcoded the pit-stop label, so the tab read
    // "harness · pit stop" while the run was parked on a spent subscription —
    // the one thing an operator glancing at a tab strip would act on
    // differently.
    const page = mount(state({ subscriptionGate: gate() }));
    await page.refresh();

    expect(document.title).toContain("subscription");
    expect(document.title).not.toContain("pit stop");
  });

  it("draws the next gate rather than the one that was answered", async () => {
    const page = mount(state({ subscriptionGate: gate() }));
    await page.refresh();

    page.serve(state({ subscriptionGate: null }));
    await page.refresh();
    expect(($("#sub") as HTMLElement).style.display).toBe("none");

    page.serve(state({ subscriptionGate: gate({ summary: "97% of the weekly opus limit", alternatives: ["work"] }) }));
    await page.refresh();
    expect($("#sub-detail")!.textContent).toContain("97% of the weekly opus limit");
  });
});

describe("the Pause button", () => {
  /** Click it the way the operator does, through the listener the page attached. */
  const clickPause = () => $("#pause")!.dispatchEvent(new Event("click"));
  const btn = () => $("#pause") as HTMLButtonElement;

  it("is offered only while a single run is still working", async () => {
    const page = mount(state({ runs: [run({ state: "EXECUTING" })] }));
    await page.refresh();
    expect(btn().hidden).toBe(false);

    // Browsing history, or two repositories on one page: pausing "the run"
    // would be choosing which one for them.
    page.serve(state({ runs: [run({ id: "r1" }), run({ id: "r2" })] }));
    await page.refresh();
    expect(btn().hidden).toBe(true);

    page.serve(state({ runs: [run({ state: "PR_REVIEW" })] }));
    await page.refresh();
    expect(btn().hidden).toBe(true);
  });

  it("takes two clicks to stop a run", async () => {
    const page = mount(state());
    await page.refresh();

    clickPause();
    expect(page.posts).toEqual([]);
    expect(btn().textContent).toBe("Stop the run?");

    clickPause();
    await Promise.resolve();
    // No content-type, because there is no content. Declaring one is what made
    // this button answer 400 rather than stop the run.
    expect(page.posts).toEqual([{ url: "/api/runs/r1/pause", method: "POST", contentType: undefined }]);
  });

  it("stands down on its own, so an armed button is never left lying around", async () => {
    const page = mount(state());
    await page.refresh();

    clickPause();
    vi.advanceTimersByTime(6000);
    expect(btn().textContent).toBe("Pause");

    clickPause();
    expect(page.posts).toEqual([]);
  });

  it("stands down on Escape", async () => {
    const page = mount(state());
    await page.refresh();

    clickPause();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(btn().textContent).toBe("Pause");
  });

  it("says the request landed, and refuses to send a second one", async () => {
    const page = mount(state());
    page.reply({ ok: true, body: { message: "pausing — the agents stop at their next message" } });
    await page.refresh();

    clickPause();
    clickPause();
    await vi.advanceTimersByTimeAsync(0);

    expect(btn().textContent).toBe("Pausing…");
    expect(btn().disabled).toBe(true);
    // In the panel, not the header's status line: renderHeader() rewrites that
    // on the very next poll, and pausing triggers one immediately.
    expect($("#paused-h")!.textContent).toBe("Stopping the run…");
    expect($("#paused-detail")!.textContent).toBe("pausing — the agents stop at their next message");

    clickPause();
    expect(page.posts).toHaveLength(1);
  });

  it("shows the refusal rather than claiming the run stopped", async () => {
    const page = mount(state());
    page.reply({ ok: false, body: { error: "this run is PAUSED — only a run that is still working can be paused" } });
    await page.refresh();

    clickPause();
    clickPause();
    await vi.advanceTimersByTimeAsync(0);

    expect($("#paused-detail")!.textContent).toContain("only a run that is still working");
    expect(($("#paused-detail p") as HTMLElement).style.color).toBe("var(--red)");
    expect(btn().disabled).toBe(false);
  });
});

describe("a run that has stopped", () => {
  it("says nothing while the run is working", async () => {
    const page = mount(state());
    await page.refresh();
    expect(($("#paused") as HTMLElement).style.display).toBe("none");
  });

  it("stops calling its tasks working, on a run where nothing is working", async () => {
    // The pause leaves in-flight tasks in the state their session died in —
    // that is what tells `resume` to requeue them from their own commits. An
    // amber WORKING pill on a stopped run reads as "Pause did nothing".
    const page = mount(state({ runs: [run({ state: "PAUSED", tasks: [task({ state: "WORKING" })] })] }));
    await page.refresh();

    expect($("#board .task .pill")!.textContent).toBe("PAUSED");
    expect($("#board .task .pill")!.className).toBe("pill s-PAUSED");
  });

  it("rebuilds the card when the run pauses under it", async () => {
    // The bug this pins: the card is cached on a signature, the run's state was
    // not in it, and a card built while the run was EXECUTING kept saying
    // WORKING through every poll after the pause. Mounting straight into a
    // paused run does not reproduce it — only the transition does.
    const page = mount(state({ runs: [run({ state: "EXECUTING", tasks: [task({ state: "WORKING" })] })] }));
    await page.refresh();
    expect($("#board .task .pill")!.textContent).toBe("WORKING");

    page.serve(state({ runs: [run({ state: "PAUSED", tasks: [task({ state: "WORKING" })] })] }));
    await page.refresh();

    expect($("#board .task .pill")!.textContent).toBe("PAUSED");
  });

  it("does not narrate a handover on a run that has stopped", async () => {
    const page = mount(state({ runs: [run({ state: "PAUSED", tasks: [task({ state: "WORKING" })] })] }));
    await page.refresh();

    expect($("#nowcount")!.textContent).toBe("paused");
    expect($("#now")!.textContent).toContain("t1 stopped mid-task");
    expect($("#now")!.textContent).not.toContain("Between agents");
  });

  it("says nothing is running when the paused run had nothing in flight", async () => {
    const page = mount(state({ runs: [run({ state: "PAUSED", tasks: [task({ state: "PENDING" })] })] }));
    await page.refresh();

    expect($("#now")!.textContent).toBe("Paused. Nothing is running.");
  });

  it("names the command that brings the run and this page back", async () => {
    const page = mount(state({ runs: [run({ state: "PAUSED" })] }));
    await page.refresh();

    expect(($("#paused") as HTMLElement).style.display).toBe("block");
    expect($("#paused-detail code")!.textContent).toBe("harness resume r1");
    expect($("#paused-detail")!.textContent).toContain("still in their worktrees");
  });
});

describe("a task that is waiting on the operator", () => {
  const parked = (over: Record<string, Any> = {}) =>
    task({ id: "t1", state: "NEEDS_HUMAN", errorSummary: "the task branch is still empty after 5 attempts", ...over });

  it("carries the control that answers it, which no other card needs", async () => {
    // The card says NEEDS YOU and had nothing on it to act with: the composer
    // that revives the task is two panels up, behind a dropdown listing every
    // open task, with nothing anywhere connecting the two.
    const page = mount(state({ runs: [run({ tasks: [parked(), task({ id: "t2", state: "WORKING" })] })] }));
    await page.refresh();

    const buttons = all("#board .task button.answer");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.closest(".task")!.textContent).toContain("t1");
  });

  it("aims the composer at that task and says what answering will do", async () => {
    const page = mount(state({ runs: [run({ tasks: [parked()] })] }));
    await page.refresh();

    ($("#board .task button.answer") as HTMLButtonElement).dispatchEvent(new Event("click"));

    expect(($("#fb-task") as HTMLSelectElement).value).toBe("r1/t1");
    expect($("#fb-note")!.textContent).toContain("Answering reopens t1");
    expect(document.activeElement).toBe($("#fb-text"));
  });

  it("does not promise a reopen on a run that has stopped", async () => {
    // The controller only reopens a parked task while the scheduler is looping.
    // On a paused run the note waits instead, and saying otherwise is a promise
    // the operator watches not happen.
    const page = mount(state({ runs: [run({ state: "PAUSED", tasks: [parked()] })] }));
    await page.refresh();

    ($("#board .task button.answer") as HTMLButtonElement).dispatchEvent(new Event("click"));

    expect($("#fb-note")!.textContent).toContain("waits with the task");
    expect($("#fb-note")!.textContent).not.toContain("reopens");
  });

  it("refuses to aim at a task the composer no longer lists", async () => {
    // Between the poll that drew the card and the click, the task merged. A
    // <select> silently keeps its old value, which would send the answer to
    // whichever task happened to be selected.
    const page = mount(state({ runs: [run({ tasks: [parked()] })] }));
    await page.refresh();
    const button = $("#board .task button.answer") as HTMLButtonElement;

    page.serve(state({ runs: [run({ tasks: [task({ id: "t2", state: "WORKING" })] })] }));
    await page.refresh();
    button.dispatchEvent(new Event("click"));

    expect($("#fb-note")!.textContent).toContain("not open for feedback any more");
    expect(($("#fb-note") as HTMLElement).style.color).toBe("var(--red)");
  });

  it("lets the whole reason be read, not just the first 220 characters", async () => {
    const long = "the task branch is still empty after 5 attempts: ".padEnd(400, "x") + "END";
    const page = mount(state({ runs: [run({ tasks: [parked({ errorSummary: long })] })] }));
    await page.refresh();

    expect($("#board .task .why")!.textContent!.length).toBeLessThan(long.length);
    expect($("#board .task .whymore .why")!.textContent).toBe(long);
    expect($("#board .task .whymore summary")!.textContent).toBe("the rest of the reason");
  });

  it("adds nothing to unclip when the reason already fits", async () => {
    const page = mount(state({ runs: [run({ tasks: [parked()] })] }));
    await page.refresh();

    expect($("#board .task .whymore")).toBeNull();
  });

  it("keeps the reason open across a poll", async () => {
    const long = "parked: ".padEnd(400, "y");
    const page = mount(state({ runs: [run({ tasks: [parked({ errorSummary: long })] })] }));
    await page.refresh();
    open($("#board .task .whymore")!);

    page.serve(state({ runs: [run({ spentUsd: 9, tasks: [parked({ errorSummary: long })] })] }));
    await page.refresh();

    expect(($("#board .task .whymore") as HTMLDetailsElement).open).toBe(true);
  });
});
