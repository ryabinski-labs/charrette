import { execFile } from "node:child_process";

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
