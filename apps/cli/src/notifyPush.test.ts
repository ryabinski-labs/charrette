import { describe, expect, it, vi } from "vitest";
import { RunConfig, type CharretteEvent } from "@charrette/shared";
import { Bus, Store } from "@charrette/core";
import {
  notifyBanner,
  notifyStopped,
  notifyTarget,
  noticeForEvent,
  sendPush,
  sendTestNotice,
  watchPush,
  type Notice,
  type NotifyTarget,
} from "./notify.js";

/**
 * The channel that reaches a phone.
 *
 * Two halves: what a notice says and how it is put on the wire, both settled
 * with an injected fetch so no test can send a real notice; and the
 * subscription that turns run events into notices, settled against a real Bus
 * and Store so the rate limit and the failed-send log are the ones the run
 * would really use.
 */

type Call = { url: string; init: RequestInit };

function recorder(statuses: number[] = []): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const status = statuses.shift() ?? 200;
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const noSleep = async (): Promise<void> => undefined;

const TARGET: NotifyTarget = { url: "https://ntfy.sh/a-topic", format: "ntfy" };

const NOTICE: Notice = {
  event: "run.gate_opened",
  runId: "run1",
  repo: "charrette",
  title: "charrette — plan gate",
  message: "Plan ready for approval",
  priority: "high",
  tags: ["charrette", "gate"],
  ts: 1_700_000_000_000,
};

const event = <T extends CharretteEvent>(value: T): T => value;

describe("turning run events into notices", () => {
  it("SC-005-a a gate opening becomes one notice", () => {
    const plan = noticeForEvent(
      event({
        type: "run.gate_opened",
        runId: "run1",
        gateId: "g1",
        kind: "plan",
        payload: { gaps: [] },
        ts: 1,
      }),
      "charrette"
    );
    const budget = noticeForEvent(
      event({
        type: "run.gate_opened",
        runId: "run1",
        gateId: "g2",
        kind: "budget",
        payload: { spentUsd: 30, capUsd: 30 },
        ts: 2,
      }),
      "charrette"
    );
    const subscription = noticeForEvent(
      event({
        type: "run.gate_opened",
        runId: "run1",
        gateId: "g3",
        kind: "subscription",
        payload: { summary: "seven-day window at 96%" },
        ts: 3,
      }),
      "charrette"
    );
    const pitStop = noticeForEvent(
      event({
        type: "run.pitstop_opened",
        runId: "run1",
        stop: 2,
        reason: "every epic",
        epicIds: ["e1"],
        mergedCount: 4,
        spentUsd: 12,
        artifactsDir: "/tmp/demo",
        demoStarted: true,
        ts: 4,
      }),
      "charrette"
    );

    for (const notice of [plan, budget, subscription, pitStop]) {
      expect(notice).not.toBeNull();
      expect(notice!.title).toContain("charrette");
      expect(notice!.priority).toBe("high");
      expect(notice!.message.length).toBeGreaterThan(0);
    }
    expect(plan!.message).toBe("Plan ready for approval");
    expect(budget!.message).toContain("$30.00");
    expect(budget!.message.match(/\$30\.00/g)).toHaveLength(2);
    expect(subscription!.message).toContain("seven-day window at 96%");
    expect(pitStop!.message).toContain("every epic");
    expect(pitStop!.event).toBe("run.pitstop_opened");
  });

  it("SC-005-b a task entering NEEDS_HUMAN becomes one notice", () => {
    const notice = noticeForEvent(
      event({
        type: "task.state_changed",
        runId: "run1",
        taskId: "api-auth",
        from: "WORKING",
        to: "NEEDS_HUMAN",
        reason: "no test can prove it",
        ts: 1,
      }),
      "charrette"
    );

    expect(notice).not.toBeNull();
    expect(notice!.message).toContain("api-auth");
    expect(notice!.message).toContain("no test can prove it");
    expect(notice!.priority).toBe("high");
  });

  it("SC-005-c a finished run becomes one notice", () => {
    const notice = noticeForEvent(
      event({
        type: "run.state_changed",
        runId: "run1",
        from: "VERIFYING",
        to: "DONE",
        reason: "14 merged, 1 parked",
        ts: 1,
      }),
      "charrette"
    );

    expect(notice).not.toBeNull();
    expect(notice!.title).toContain("run done");
    expect(notice!.message).toContain("14 merged, 1 parked");
    expect(notice!.priority).toBe("default");
  });

  it("SC-005-e a run stopped on an error becomes one notice", () => {
    const notice = notifyStopped("run1", "charrette", new Error("worktree is gone"));

    expect(notice.event).toBe("run.stopped");
    expect(notice.title).toContain("run stopped");
    expect(notice.message).toContain("worktree is gone");
    expect(notice.priority).toBe("default");
  });
});

describe("the request each format sends", () => {
  it("SC-006-a ntfy notices carry the plain-text body and priority headers", async () => {
    const { calls, fetchImpl } = recorder();

    await sendPush(TARGET, NOTICE, { fetchImpl, sleep: noSleep });

    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.init.body).toBe("Plan ready for approval");
    expect(headers.Title).toBe("charrette — plan gate");
    expect(headers.Priority).toBe("high");
    expect(headers.Tags).toContain("charrette");
  });

  it("SC-006-b json notices carry the documented object", async () => {
    const { calls, fetchImpl } = recorder();

    await sendPush({ url: "https://example.com/hook", format: "json" }, NOTICE, { fetchImpl, sleep: noSleep });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["event", "message", "repo", "runId", "title", "ts"]);
    expect(body.event).toBe("run.gate_opened");
    expect(body.runId).toBe("run1");
    expect(body.repo).toBe("charrette");
    expect(body.ts).toBe(1_700_000_000_000);
  });

  it("SC-006-c the default format follows the host and path shape", () => {
    expect(notifyTarget({ CHARRETTE_NOTIFY_URL: "https://ntfy.sh/topic" })!.format).toBe("ntfy");
    expect(notifyTarget({ CHARRETTE_NOTIFY_URL: "https://example.com/hook" })!.format).toBe("ntfy");
    expect(notifyTarget({ CHARRETTE_NOTIFY_URL: "https://example.com/a/b" })!.format).toBe("json");
    expect(notifyTarget({ CHARRETTE_NOTIFY_URL: "https://ntfy.sh/topic", CHARRETTE_NOTIFY_FORMAT: "json" })!.format).toBe(
      "json"
    );
  });

  it("SC-006-d a token becomes a bearer header", async () => {
    const { calls, fetchImpl } = recorder();

    await sendPush({ ...TARGET, token: "tk_secret" }, NOTICE, { fetchImpl, sleep: noSleep });

    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tk_secret");
  });
});

describe("what a notice may contain", () => {
  it("SC-007-a a notice carries the repo, run and reason and nothing else", () => {
    const notice = noticeForEvent(
      event({
        type: "run.gate_opened",
        runId: "run1",
        gateId: "g1",
        kind: "plan",
        payload: {
          dashboardUrl: "http://localhost:4777/#tok_dash",
          token: "tok_dash",
          prompt: "the whole prompt",
          diff: "diff --git a/secret b/secret",
          apiKey: "sk-ant-secret",
        },
        ts: 1,
      }),
      "charrette"
    )!;

    const serialized = JSON.stringify(notice);
    expect(serialized).toContain("charrette");
    expect(serialized).toContain("run1");
    expect(serialized).toContain("Plan ready for approval");
    expect(serialized).not.toContain("http://localhost:4777");
    expect(serialized).not.toContain("tok_dash");
    expect(serialized).not.toContain("the whole prompt");
    expect(serialized).not.toContain("diff --git");
    expect(serialized).not.toContain("sk-ant-secret");
  });

  it("SC-007-b the banner elides the notification path", () => {
    const line = notifyBanner({ url: "https://ntfy.sh/a-long-private-topic", format: "ntfy" }).join("\n");

    expect(line).toContain("notify");
    expect(line).toContain("ntfy.sh/…");
    expect(line).not.toContain("a-long-private-topic");
  });
});

describe("charrette notify-test", () => {
  it("SC-008-a the test notice reports the HTTP status", async () => {
    const { calls, fetchImpl } = recorder([200]);

    const result = await sendTestNotice(TARGET, { fetchImpl, sleep: noSleep });

    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.body).toContain("test");
  });
});

describe("retries and timeouts", () => {
  it("SC-009-a a 5xx is retried twice at two and ten seconds", async () => {
    const { calls, fetchImpl } = recorder([503, 503, 503, 503]);
    const sleeps: number[] = [];

    const result = await sendPush(TARGET, NOTICE, {
      fetchImpl,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([2000, 10000]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("SC-009-b a notice that times out is retried and never blocks the run", async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      return await new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as unknown as typeof fetch;

    const result = await sendPush(TARGET, NOTICE, { fetchImpl, sleep: noSleep, timeoutMs: 5 });

    expect(result.ok).toBe(false);
    expect(calls).toBe(3);
  });

  it("SC-009-c the last failure writes one agent.log line and does not throw", async () => {
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const events: CharretteEvent[] = [];
    bus.subscribe(({ event: e }) => void events.push(e));
    const { fetchImpl } = recorder([500, 500, 500]);

    const stop = watchPush(bus, { project: "charrette", target: TARGET, fetchImpl, sleep: noSleep });
    bus.publish({ type: "run.gate_opened", runId: "run1", gateId: "g1", kind: "plan", payload: {}, ts: 1 });

    await vi.waitFor(() => expect(events.some((e) => e.type === "notify.failed")).toBe(true));

    const logs = events.filter((e) => e.type === "agent.log") as { text: string }[];
    expect(logs).toHaveLength(1);
    expect(logs[0]!.text).toContain("notify");
    expect(() =>
      bus.publish({ type: "run.gate_opened", runId: "run1", gateId: "g2", kind: "plan", payload: {}, ts: 2 })
    ).not.toThrow();
    stop();
  });
});

describe("refusing a bad notification configuration", () => {
  it("SC-010-a https is accepted and plain http is only for loopback", () => {
    expect(notifyTarget({ CHARRETTE_NOTIFY_URL: "https://ntfy.sh/topic" })).not.toBeNull();
    expect(notifyTarget({ CHARRETTE_NOTIFY_URL: "http://localhost:8080/topic" })).not.toBeNull();
    expect(notifyTarget({ CHARRETTE_NOTIFY_URL: "http://127.0.0.1:8080/topic" })).not.toBeNull();

    expect(() => notifyTarget({ CHARRETTE_NOTIFY_URL: "http://example.com/topic" })).toThrow(/CHARRETTE_NOTIFY_URL/);
    expect(() => notifyTarget({ CHARRETTE_NOTIFY_URL: "not a url" })).toThrow(/CHARRETTE_NOTIFY_URL/);
    expect(() =>
      notifyTarget({ CHARRETTE_NOTIFY_URL: "https://ntfy.sh/topic", CHARRETTE_NOTIFY_FORMAT: "slack" })
    ).toThrow(/CHARRETTE_NOTIFY_FORMAT/);
  });
});

describe("the rate limit", () => {
  it("SC-011-a more than twenty notices become one summary and then silence", async () => {
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const { calls, fetchImpl } = recorder();
    let clock = 1_700_000_000_000;
    const stop = watchPush(bus, {
      project: "charrette",
      target: TARGET,
      fetchImpl,
      sleep: noSleep,
      now: () => clock,
    });

    for (let i = 0; i < 25; i++) {
      bus.publish({ type: "run.gate_opened", runId: "run1", gateId: `g${i}`, kind: "plan", payload: {}, ts: clock });
    }

    await vi.waitFor(() => expect(calls).toHaveLength(21));
    expect(String(calls.at(-1)!.init.body)).toContain("suppressed");
    expect(calls).toHaveLength(21);

    clock += 10 * 60 * 1000 + 1;
    bus.publish({ type: "run.gate_opened", runId: "run1", gateId: "later", kind: "plan", payload: {}, ts: clock });
    await vi.waitFor(() => expect(calls).toHaveLength(22));
    stop();
  });
});

describe("the watcher's happy path", () => {
  it("SC-005-d the watcher posts exactly once for an opening gate", async () => {
    const store = new Store(":memory:");
    store.createRun({
      id: "run1",
      repoPath: "/tmp/repo",
      assignment: "build a thing",
      state: "CREATED",
      prdPath: null,
      planHash: null,
      integrationBranch: "charrette/run1/main",
      config: RunConfig.parse({}),
    });
    const bus = new Bus(store);
    const events: CharretteEvent[] = [];
    bus.subscribe(({ event: e }) => void events.push(e));
    const { calls, fetchImpl } = recorder([200]);

    const stop = watchPush(bus, { project: "charrette", target: TARGET, fetchImpl, sleep: noSleep });
    bus.publish({ type: "run.gate_opened", runId: "run1", gateId: "g1", kind: "plan", payload: {}, ts: 1 });

    await vi.waitFor(() => expect(events.some((e) => e.type === "notify.sent")).toBe(true));

    expect(calls).toHaveLength(1);
    const sent = events.find((e) => e.type === "notify.sent") as { event: string; status: number };
    expect(sent.event).toBe("run.gate_opened");
    expect(sent.status).toBe(200);
    stop();
  });
});
