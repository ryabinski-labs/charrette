import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig } from "@harness/shared";
import { Bus, Store } from "@harness/core";
import { Dashboard } from "./index.js";
import { PAGE_HTML } from "./page.js";

/**
 * The parts of the dashboard the browser reaches over the wire: the page
 * itself, the event stream, the plan gate, and the checks that stand between a
 * page on another origin and a running harness.
 */

const started: Dashboard[] = [];

afterEach(async () => {
  for (const d of started.splice(0)) await d.stop();
});

async function serving(): Promise<{ dash: Dashboard; url: string; store: Store; bus: Bus }> {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const dash = new Dashboard(store, bus);
  started.push(dash);
  const url = await dash.start();
  return { dash, url, store, bus };
}

function makeRun(store: Store, id = "r1"): void {
  store.createRun({
    id,
    repoPath: "/tmp/repo",
    assignment: "build a thing",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: `harness/${id}/main`,
    config: RunConfig.parse({}),
  });
}

const auth = (dash: Dashboard) => ({ authorization: `Bearer ${dash.token}`, connection: "close" });

/**
 * The seq to open a stream at so nothing replays. Creating a run publishes
 * `run.created`, so a stream opened at 0 always has one frame waiting before
 * the live tail starts — which would make every "what arrives next" assertion
 * pass on the replay instead.
 */
const cursor = (store: Store, runId = "r1") => store.eventsSince(runId, 0, 10_000).at(-1)?.seq ?? 0;

/**
 * Opens a live tail at `after` and runs `publish` while the request is in
 * flight.
 *
 * The request cannot simply be awaited first: with an empty replay the handler
 * writes nothing, and Node holds the response headers until the first write —
 * so `fetch` would not resolve until the very event the caller is waiting to
 * publish, and the test would deadlock against itself.
 */
async function tailing(url: string, dash: Dashboard, after: number, publish: () => void): Promise<Response> {
  const pending = fetch(new URL(`/api/runs/r1/events?after=${after}`, url), { headers: auth(dash) });
  await new Promise((r) => setTimeout(r, 50));
  publish();
  return pending;
}

/**
 * Reads from an SSE response until `want` frames arrive or the deadline passes,
 * then gives up the socket.
 *
 * The deadline is raced against each read rather than checked between them: the
 * stream is a live tail that stays open indefinitely, so a `read()` with nothing
 * to deliver never returns, and a loop that only checks the clock afterwards
 * waits forever instead of reporting "nothing arrived" — which is precisely
 * what the coalescing test needs to be able to observe.
 */
async function readFrames(res: Response, want: number, timeoutMs = 4000): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (frames.length < want) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), left);
        }),
      ]);
      clearTimeout(timer);
      if (chunk === null || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      const parts = text.split("\n\n");
      text = parts.pop() ?? "";
      frames.push(...parts.filter(Boolean));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

describe("serving the page", () => {
  it("answers / with the dashboard HTML", async () => {
    const { url } = await serving();

    const res = await fetch(url.replace(/#.*$/, ""), { headers: { connection: "close" } });

    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(PAGE_HTML);
  });

  /**
   * The page is public because the token lives in the URL fragment, which a
   * browser never sends. Everything the page then asks for is not.
   */
  it("refuses every data endpoint without the bearer token", async () => {
    const { url } = await serving();

    for (const path of ["/api/state", "/api/runs/r1/events"]) {
      expect((await fetch(new URL(path, url), { headers: { connection: "close" } })).status).toBe(401);
    }
    for (const path of ["/api/gates/plan", "/api/gates/budget", "/api/gates/task", "/api/feedback"]) {
      const res = await fetch(new URL(path, url), {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: "{}",
      });
      expect(res.status).toBe(401);
    }
  });

  /**
   * A page served from anywhere else must not be able to answer this run's
   * gates, even if it somehow guessed the token.
   */
  it("refuses a state-changing request from another origin", async () => {
    const { dash, url } = await serving();

    for (const path of ["/api/gates/plan", "/api/gates/budget", "/api/gates/task", "/api/feedback"]) {
      const res = await fetch(new URL(path, url), {
        method: "POST",
        headers: { ...auth(dash), "content-type": "application/json", origin: "https://evil.example.com" },
        body: "{}",
      });
      expect(res.status).toBe(403);
    }
  });

  it("accepts a request from the localhost page, and one with no Origin at all", async () => {
    const { dash, url } = await serving();
    const port = new URL(url).port;

    for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`, undefined]) {
      const res = await fetch(new URL("/api/gates/plan", url), {
        method: "POST",
        headers: {
          ...auth(dash),
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ approved: true }),
      });
      // 409 is "past the origin check, but no gate is open" — which is the
      // answer that proves the origin was accepted.
      expect(res.status).toBe(409);
    }
  });
});

describe("guards that should never fire", () => {
  /**
   * HTTP/1.0 has no mandatory Host header, and `fetch` will always send one —
   * so the only way to ask what happens without it is to speak the protocol
   * directly. Nothing that cannot name the host it is talking to gets to answer
   * a gate.
   */
  it("refuses a request that names no host at all", async () => {
    const { dash, url } = await serving();
    const { port } = new URL(url);

    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write(
          `POST /api/gates/plan HTTP/1.0\r\nauthorization: Bearer ${dash.token}\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}`
        );
      });
      let text = "";
      socket.on("data", (d) => void (text += d.toString()));
      socket.on("error", reject);
      socket.on("end", () => resolve(text.split("\r\n")[0]!));
    });

    expect(status).toContain("403");
  });

  it("shows no reason at all rather than an empty one", async () => {
    const { dash, url, store } = await serving();
    makeRun(store);
    store.insertTasks("r1", [{ id: "e1", title: "E" }], [
      {
        id: "t1", epicId: "e1", title: "T", spec: "", acceptanceCriteria: [], dependsOn: [], state: "PENDING",
        branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null, qaIterations: 0, respawns: 0,
        assignedSkills: [], errorSummary: null,
      },
    ]);
    store.transitionTask("r1", "t1", "READY");
    store.transitionTask("r1", "t1", "WORKING");
    // Parked with no reason recorded anywhere.
    store.transitionTask("r1", "t1", "NEEDS_HUMAN");

    const res = await fetch(new URL("/api/state", url), { headers: auth(dash) });
    const body = (await res.json()) as { runs: { tasks: { errorSummary: string | null }[] }[] };

    expect(body.runs[0]!.tasks[0]!.errorSummary).toBeNull();
  });

  it("refuses a budget answer when the gate is half torn down", async () => {
    const { dash, url } = await serving();
    // A resolver with no payload behind it: not reachable through the normal
    // lifecycle, which is exactly why the guard is the only thing covering it.
    (dash as unknown as { pendingBudgetGate: unknown }).pendingBudgetGate = () => undefined;

    const res = await fetch(new URL("/api/gates/budget", url), {
      method: "POST",
      headers: { ...auth(dash), "content-type": "application/json" },
      body: JSON.stringify({ capUsd: 50 }),
    });

    expect(res.status).toBe(409);
  });

  it("refuses a task answer that names no task", async () => {
    const { dash, url } = await serving();

    const res = await fetch(new URL("/api/gates/task", url), {
      method: "POST",
      headers: { ...auth(dash), "content-type": "application/json" },
      body: JSON.stringify({ guidance: "do the thing" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no open gate for that task" });
  });

  it("refuses feedback with no message, however it is left out", async () => {
    const { dash, url } = await serving();
    dash.attach({ sendFeedback: () => "live" });

    for (const body of [{ runId: "r1", taskId: "t1" }, { runId: "r1", taskId: "t1", text: "   " }]) {
      const res = await fetch(new URL("/api/feedback", url), {
        method: "POST",
        headers: { ...auth(dash), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it("relays a refusal that was not thrown as an Error", async () => {
    const { dash, url } = await serving();
    dash.attach({
      sendFeedback: () => {
        throw "task t1 has already finished";
      },
    });

    const res = await fetch(new URL("/api/feedback", url), {
      method: "POST",
      headers: { ...auth(dash), "content-type": "application/json" },
      body: JSON.stringify({ runId: "r1", taskId: "t1", text: "one more thing" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "task t1 has already finished" });
  });
});

describe("finding a port when every one is taken", () => {
  /**
   * Driven through a stubbed listen rather than by occupying 33 real ports:
   * one of those ports is very likely to be a dashboard the operator is
   * actually using, and a test that fights a running harness for 4777 is a
   * test that fails for reasons unrelated to what it is checking.
   */
  function alwaysBusy(opts?: { port?: number }): Dashboard {
    const store = new Store(":memory:");
    const dash = new Dashboard(store, new Bus(store), opts);
    (dash as unknown as { app: unknown }).app = {
      listen: async () => {
        throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
      },
      close: async () => undefined,
      // start() registers the routes before it binds; the stub only has to
      // accept them, since nothing here ever sends a request.
      get: () => undefined,
      post: () => undefined,
    };
    return dash;
  }

  it("gives up after scanning, and says how to get past it", async () => {
    await expect(alwaysBusy().start()).rejects.toThrow(
      "no free dashboard port between 4777 and 4809. Pass --port <n> or --no-dashboard."
    );
  });

  it("does not scan at all past a port the operator named", async () => {
    // Moving silently would point them at a different run's dashboard.
    await expect(alwaysBusy({ port: 5000 }).start()).rejects.toThrow(
      /dashboard port 5000 is already in use — another harness is probably serving there/
    );
  });

  it("lets a failure that is not a busy port surface as itself", async () => {
    const store = new Store(":memory:");
    const dash = new Dashboard(store, new Bus(store));
    (dash as unknown as { app: unknown }).app = {
      listen: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
      close: async () => undefined,
      // start() registers the routes before it binds; the stub only has to
      // accept them, since nothing here ever sends a request.
      get: () => undefined,
      post: () => undefined,
    };

    await expect(dash.start()).rejects.toThrow("permission denied");
  });
});

describe("the plan gate", () => {
  it("shows the PRD and the breakdown, then hands the approval back", async () => {
    const { dash, url } = await serving();
    const pending = dash.resolvePlanGate("# The PRD", "3 tasks");

    const state = await (await fetch(new URL("/api/state", url), { headers: auth(dash) })).json();
    expect((state as { planGate: { prd: string; summary: string } }).planGate).toEqual({ prd: "# The PRD", summary: "3 tasks" });

    const res = await fetch(new URL("/api/gates/plan", url), {
      method: "POST",
      headers: { ...auth(dash), "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });

    expect(res.status).toBe(200);
    await expect(pending).resolves.toEqual({ approved: true, feedback: "" });
  });

  it("carries the operator's rejection feedback to the planner", async () => {
    const { dash, url } = await serving();
    const pending = dash.resolvePlanGate("prd", "summary");

    await fetch(new URL("/api/gates/plan", url), {
      method: "POST",
      headers: { ...auth(dash), "content-type": "application/json" },
      body: JSON.stringify({ approved: false, feedback: "split the auth task in two" }),
    });

    await expect(pending).resolves.toEqual({ approved: false, feedback: "split the auth task in two" });
  });

  it("closes the gate so a double submit cannot resolve it twice", async () => {
    const { dash, url } = await serving();
    dash.resolvePlanGate("prd", "summary");
    const post = () =>
      fetch(new URL("/api/gates/plan", url), {
        method: "POST",
        headers: { ...auth(dash), "content-type": "application/json" },
        body: JSON.stringify({ approved: true }),
      });

    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(409);
  });

  it("reports no open gate when nothing is waiting", async () => {
    const { dash, url } = await serving();

    const res = await fetch(new URL("/api/gates/plan", url), {
      method: "POST",
      headers: { ...auth(dash), "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no open plan gate" });
  });
});

describe("the event stream", () => {
  it("replays what the run has already done, from the cursor the browser held", async () => {
    const { dash, url, store, bus } = await serving();
    makeRun(store);
    bus.publish({ type: "agent.log", runId: "r1", sessionId: "s", text: "first", ts: 1 });
    bus.publish({ type: "agent.log", runId: "r1", sessionId: "s", text: "second", ts: 2 });

    // From the very beginning, which is what a browser opening the page fresh does.
    const res = await fetch(new URL("/api/runs/r1/events", url), { headers: auth(dash) });
    const frames = await readFrames(res, 3);

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(frames.join("\n")).toContain('"text":"first"');
    expect(frames.join("\n")).toContain('"text":"second"');
    // Each frame carries the event seq, which is the cursor a reconnect resumes from.
    expect(frames[0]).toMatch(/^id: \d+\ndata: /);
  });

  it("resumes after the cursor rather than replaying everything", async () => {
    const { dash, url, store, bus } = await serving();
    makeRun(store);
    bus.publish({ type: "agent.log", runId: "r1", sessionId: "s", text: "already seen", ts: 1 });
    const seq = store.lastEventSeq("r1", "agent.log");
    bus.publish({ type: "agent.log", runId: "r1", sessionId: "s", text: "new since", ts: 2 });

    const res = await fetch(new URL(`/api/runs/r1/events?after=${seq}`, url), { headers: auth(dash) });
    const frames = await readFrames(res, 1);

    expect(frames.join("\n")).toContain("new since");
    expect(frames.join("\n")).not.toContain("already seen");
  });

  it("live-tails what happens next, and ignores other runs", async () => {
    const { dash, url, store, bus } = await serving();
    makeRun(store);
    makeRun(store, "r2");

    const res = await tailing(url, dash, cursor(store), () => {
      bus.publish({ type: "agent.log", runId: "r2", sessionId: "s", text: "another run", ts: 1 });
      bus.publish({ type: "agent.log", runId: "r1", sessionId: "s", text: "this run", ts: 2 });
    });
    const frames = await readFrames(res, 1);

    expect(frames.join("\n")).toContain("this run");
    expect(frames.join("\n")).not.toContain("another run");
  });

  /**
   * The CLI stops the dashboard within milliseconds of a run reaching one of
   * these states — well inside the 100ms coalescing window — so the event the
   * operator most needs is the one most likely to be lost.
   */
  it.each(["PR_REVIEW", "FAILED", "ABORTED"])("flushes %s immediately rather than on the timer", async (to) => {
    const { dash, url, store, bus } = await serving();
    makeRun(store);

    const res = await tailing(url, dash, cursor(store), () => {
      bus.publish({ type: "run.state_changed", runId: "r1", from: "INTEGRATING", to, ts: 1 } as never);
    });
    const frames = await readFrames(res, 1);

    expect(frames.join("\n")).toContain(`"to":"${to}"`);
  });

  it("stops buffering for a browser that has gone away", async () => {
    const { dash, url, store, bus } = await serving();
    makeRun(store);
    const res = await tailing(url, dash, cursor(store), () => {
      bus.publish({ type: "agent.log", runId: "r1", sessionId: "s", text: "while watching", ts: 1 });
    });
    await readFrames(res, 1);

    // The unsubscribe happens on close; publishing afterwards must not throw
    // into the bus, which would take the run down with the browser tab.
    expect(() => bus.publish({ type: "agent.log", runId: "r1", sessionId: "s", text: "after", ts: 2 })).not.toThrow();
  });

  it("drops frames rather than growing without bound when nothing is reading", async () => {
    const { dash, url, store, bus } = await serving();
    makeRun(store);
    await tailing(url, dash, cursor(store), () => {
      bus.publish({ type: "agent.log", runId: "r1", sessionId: "s", text: "first", ts: 0 });
    });

    for (let i = 0; i < 600; i++) {
      bus.publish({ type: "agent.log", runId: "r1", sessionId: "s", text: `line ${i}`, ts: i });
    }

    // 500 is the ceiling on what is buffered for the browser; the run keeps
    // recording everything regardless of whether anyone is watching.
    // run.created + the one published to open the tail + 600.
    expect(store.eventsSince("r1", 0, 1000).length).toBe(602);
  });
});
