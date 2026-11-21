import { execFile } from "node:child_process";
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
  status?: number;
  attempts: number;
  latencyMs: number;
  error?: string;
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

/** Minimal interface for the red phase. */
export function notifyTarget(_env: NodeJS.ProcessEnv = process.env): NotifyTarget | null {
  return null;
}

export function notifyBanner(_target: NotifyTarget | null): string[] {
  return [];
}

export function noticeForEvent(_event: CharretteEvent, _project: string): Notice | null {
  return null;
}

export function notifyStopped(runId: string, repo: string, _error: unknown): Notice {
  return { event: "run.stopped", runId, repo, title: "", message: "", priority: "default", tags: [], ts: Date.now() };
}

export async function sendPush(_target: NotifyTarget, _notice: Notice, _opts: PushOptions = {}): Promise<PushResult> {
  return { ok: false, attempts: 0, latencyMs: 0 };
}

export async function sendTestNotice(
  _target: NotifyTarget,
  _opts: PushOptions = {}
): Promise<PushResult> {
  return { ok: false, attempts: 0, latencyMs: 0 };
}

export function watchPush(_bus: Bus, _opts: WatchPushOptions): () => void {
  return () => undefined;
}
