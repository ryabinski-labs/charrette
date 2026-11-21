import { execFile } from "node:child_process";
import path from "node:path";
import type { Bus } from "@charrette/core";
import type { CharretteEvent } from "@charrette/shared";

/**
 * Tell the operator the run is over.
 *
 * The dashboard raises a browser notification, but only while a tab is open — and
 * the CLI stops the dashboard the moment the run ends. This is the channel that
 * always fires: the operator started a long run in a terminal and walked away.
 *
 * Every part of it is best-effort. A missing notifier, a headless box, a locked
 * screen — none of that may fail a run that already succeeded, so nothing here
 * throws and nothing is awaited.
 */
export function notifyDone(title: string, body: string): void {
  // The bell is the one signal that works over SSH, in tmux, and with no desktop.
  process.stdout.write("\u0007");
  const [cmd, args] = notifier(title, body) ?? [];
  if (cmd) execFile(cmd, args!, () => undefined);
}

function notifier(title: string, body: string): [string, string[]] | null {
  if (process.platform === "darwin") {
    return ["osascript", ["-e", `display notification ${osa(body)} with title ${osa(title)}`]];
  }
  if (process.platform === "linux") {
    return ["notify-send", [clean(title), clean(body)]];
  }
  return null;
}

/** One line, bounded length — a notification body is not a place for a stack trace. */
function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * AppleScript string literal. Escaping after truncation could cut a `\` free of
 * what it escapes and turn the script into a syntax error, so clean first.
 */
function osa(s: string): string {
  return `"${clean(s).replace(/[\\"]/g, "\\$&")}"`;
}

/** How a notice is put on the wire. */
export type NotifyFormat = "ntfy" | "json";

export interface NotifyTarget {
  url: string;
  format: NotifyFormat;
  token?: string;
}

export interface Notice {
  event: string;
  runId: string;
  repo: string;
  title: string;
  message: string;
  priority: "high" | "default";
  tags: string[];
  ts: number;
}

export interface PushResult {
  ok: boolean;
  /** The HTTP status, or 0 when no response was received at all. */
  status: number;
  attempts: number;
  latencyMs: number;
  /** Empty on success; a message on every failure. */
  error: string;
}

export interface PushOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
  timeoutMs?: number;
  now?: () => number;
}

export interface WatchPushOptions extends PushOptions {
  project: string;
  target: NotifyTarget;
}

/**
 * Where push notices go, or null when they go nowhere.
 *
 * The URL is read from the environment rather than the run config on purpose:
 * it is a property of the person being reached, not of the run, and a run's
 * config is recorded in SQLite and copied into pull requests. A key that opens
 * a phone is not one of those.
 */
export function notifyTarget(env: NodeJS.ProcessEnv = process.env): NotifyTarget | null {
  const raw = (env.CHARRETTE_NOTIFY_URL ?? "").trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CHARRETTE_NOTIFY_URL is not a valid URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("CHARRETTE_NOTIFY_URL must be an https:// URL, or http:// to localhost or 127.0.0.1");
  }

  const explicit = (env.CHARRETTE_NOTIFY_FORMAT ?? "").trim();
  if (explicit && explicit !== "ntfy" && explicit !== "json") {
    throw new Error('CHARRETTE_NOTIFY_FORMAT must be "ntfy" or "json"');
  }
  // ntfy's publish API is identified by its host, or by a single path segment —
  // the topic. A deeper path is somebody else's endpoint and gets JSON.
  const segments = url.pathname.split("/").filter(Boolean).length;
  const format: NotifyFormat = explicit === "json" || explicit === "ntfy"
    ? explicit
    : url.hostname === "ntfy.sh" || segments === 1
      ? "ntfy"
      : "json";

  const token = (env.CHARRETTE_NOTIFY_TOKEN ?? "").trim();
  return { url: raw, format, ...(token ? { token } : {}) };
}

/** The banner line, with the path elided so a topic is not printed. */
export function notifyBanner(target: NotifyTarget | null): string[] {
  if (!target) return ["notify      off — no CHARRETTE_NOTIFY_URL"];
  return [`notify      ${new URL(target.url).host}/…`];
}

/** One line, bounded length. A notice is not a place for a stack trace. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function gateMessage(kind: string, payload: unknown): string {
  const data = (payload ?? {}) as Record<string, unknown>;
  if (kind === "budget") {
    const spent = typeof data.spentUsd === "number" ? data.spentUsd : undefined;
    const cap = typeof data.capUsd === "number" ? data.capUsd : undefined;
    if (spent !== undefined && cap !== undefined) {
      return `Budget gate at $${spent.toFixed(2)} of $${cap.toFixed(2)}`;
    }
    return "Budget gate needs you";
  }
  if (kind === "subscription") {
    const summary = typeof data.summary === "string" ? data.summary : "";
    return oneLine(`Subscription limit reached${summary ? `: ${summary}` : ""}`);
  }
  if (kind === "integration-conflict") return "Integration conflict needs you";
  if (kind === "task-escalation") return "Task escalation needs you";
  if (kind === "pit-stop") return "Pit stop needs your feedback";
  return "Plan ready for approval";
}

/**
 * The notice a run event produces, or null for an event nobody is paged about.
 *
 * Only the fields that say *what happened* are read. Anything else an event
 * happens to carry — a gate payload, a session id, a path — stays out of the
 * notice, which is how a prompt, a diff or a token in a payload cannot reach a
 * phone by being copied wholesale.
 */
export function noticeForEvent(event: CharretteEvent, project: string): Notice | null {
  if (event.type === "run.gate_opened") {
    return {
      event: event.type,
      runId: event.runId,
      repo: project,
      title: `${project} — ${event.kind} gate · ${event.runId}`,
      message: oneLine(gateMessage(event.kind, event.payload)),
      priority: "high",
      tags: ["charrette", event.kind],
      ts: event.ts,
    };
  }
  if (event.type === "run.pitstop_opened") {
    return {
      event: event.type,
      runId: event.runId,
      repo: project,
      title: `${project} — pit stop · ${event.runId}`,
      message: oneLine(`Pit stop ${event.stop}: ${event.reason}`),
      priority: "high",
      tags: ["charrette", "pit-stop"],
      ts: event.ts,
    };
  }
  if (event.type === "task.gate_opened") {
    return {
      event: event.type,
      runId: event.runId,
      repo: project,
      title: `${project} — task gate · ${event.runId}`,
      message: oneLine(`Task ${event.taskId} needs you: ${event.why}`),
      priority: "high",
      tags: ["charrette", "task-gate"],
      ts: event.ts,
    };
  }
  if (event.type === "task.state_changed" && event.to === "NEEDS_HUMAN") {
    return {
      event: event.type,
      runId: event.runId,
      repo: project,
      title: `${project} — task needs you · ${event.runId}`,
      message: oneLine(`Task ${event.taskId} needs you: ${event.reason}`),
      priority: "high",
      tags: ["charrette", "needs-human"],
      ts: event.ts,
    };
  }
  if (event.type === "run.state_changed" && event.to === "DONE") {
    return {
      event: event.type,
      runId: event.runId,
      repo: project,
      title: `${project} — run done · ${event.runId}`,
      message: oneLine(`Run done${event.reason ? `: ${event.reason}` : ""}`),
      priority: "default",
      tags: ["charrette", "run-done"],
      ts: event.ts,
    };
  }
  return null;
}

/** The notice for a run that stopped on an error, built where the error is caught. */
export function notifyStopped(runId: string, repo: string, error: unknown): Notice {
  const reason = oneLine(error instanceof Error ? error.message : String(error));
  return {
    event: "run.stopped",
    runId,
    repo,
    title: `${repo} — run stopped · ${runId}`,
    message: `Run stopped: ${reason}`,
    priority: "default",
    tags: ["charrette", "run-stopped"],
    ts: Date.now(),
  };
}

type Wire = { headers: Record<string, string>; body: string };

function wireFor(target: NotifyTarget, notice: Notice): Wire {
  const auth: Record<string, string> = target.token ? { Authorization: `Bearer ${target.token}` } : {};
  if (target.format === "json") {
    return {
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        event: notice.event,
        runId: notice.runId,
        repo: notice.repo,
        title: notice.title,
        message: notice.message,
        ts: notice.ts,
      }),
    };
  }
  return {
    headers: {
      Title: notice.title,
      Priority: notice.priority,
      Tags: notice.tags.join(","),
      "Content-Type": "text/plain; charset=utf-8",
      ...auth,
    },
    body: notice.message,
  };
}

/** Wait between attempts: two seconds, then ten. */
const RETRY_DELAYS = [2_000, 10_000] as const;
const ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * Send one notice, with the documented retry policy.
 *
 * Best-effort by contract: a broken endpoint may not fail a run, so every
 * failure is returned rather than thrown. 4xx is not retried — the request is
 * wrong and repeating it asks the same question — while 5xx and a timeout past
 * five seconds are.
 */
export async function sendPush(
  target: NotifyTarget,
  notice: Notice,
  opts: PushOptions = {}
): Promise<PushResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const wire = wireFor(target, notice);

  let attempts = 0;
  let status: number | undefined;
  let error = "";

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS[attempt - 1]!);
    attempts++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(target.url, {
        method: "POST",
        headers: wire.headers,
        body: wire.body,
        signal: controller.signal,
      });
      status = response.status;
      if (response.ok) {
        return { ok: true, status, attempts, latencyMs: now() - started, error: "" };
      }
      error = `HTTP ${status}`;
      // A 4xx is a configuration problem; retrying it changes nothing.
      if (status < 500) return { ok: false, status, attempts, latencyMs: now() - started, error };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, status: status ?? 0, attempts, latencyMs: now() - started, error };
}

/** One test notice, for diagnosing an endpoint from the terminal. */
export async function sendTestNotice(target: NotifyTarget, opts: PushOptions = {}): Promise<PushResult> {
  const repo = path.basename(process.cwd());
  return sendPush(
    target,
    {
      event: "notify.test",
      runId: "notify-test",
      repo,
      title: `${repo} — test notice`,
      message: "Test notice from charrette: notifications are working.",
      priority: "default",
      tags: ["charrette", "test"],
      ts: Date.now(),
    },
    opts
  );
}

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 20;

/**
 * Subscribe for the life of a run, one notice per opening gate and per ending.
 *
 * The rate limit is per run and per rolling ten-minute window. The summary is
 * sent in place of the twenty-first notice, then the window is silent: a gate
 * storm is one page, not two hundred.
 */
export function watchPush(bus: Bus, opts: WatchPushOptions): () => void {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number; summarized: boolean }>();

  const deliver = (notice: Notice): void => {
    void sendPush(opts.target, notice, opts).then((result) => {
      if (result.ok) {
        bus.publish({
          type: "notify.sent",
          runId: notice.runId,
          event: notice.event,
          status: result.status,
          attempts: result.attempts,
          latencyMs: result.latencyMs,
          ts: now(),
        });
        return;
      }
      // One line, not one per attempt. The endpoint is broken; the operator
      // needs to know before they miss a gate, and the run carries on.
      bus.publish({
        type: "notify.failed",
        runId: notice.runId,
        event: notice.event,
        status: result.status,
        error: result.error,
        ts: now(),
      });
      bus.publish({
        type: "agent.log",
        runId: notice.runId,
        sessionId: "notify",
        text: `notify failed (${notice.event}): ${result.error}`,
        ts: now(),
      });
    });
  };

  return bus.subscribe(({ event }) => {
    const notice = noticeForEvent(event, opts.project);
    if (!notice) return;

    const at = now();
    let window = windows.get(event.runId);
    if (!window || at - window.start >= WINDOW_MS) {
      window = { start: at, count: 0, summarized: false };
      windows.set(event.runId, window);
    }
    if (window.summarized) return;

    if (window.count >= MAX_PER_WINDOW) {
      window.summarized = true;
      deliver({
        ...notice,
        event: "notify.summary",
        title: `${opts.project} — notices suppressed`,
        message: "More than 20 notices in 10 minutes; further notices are suppressed for this window.",
        priority: "default",
        tags: ["charrette", "summary"],
        ts: at,
      });
      return;
    }

    window.count++;
    deliver(notice);
  });
}
