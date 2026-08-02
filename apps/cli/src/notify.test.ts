import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { notifyDone } from "./notify.js";

/**
 * `process.platform` is read at call time, so each test sets the platform it is
 * about rather than being skipped on the wrong host — otherwise the Linux
 * branch would never execute on the Mac this is developed on, and the Windows
 * branch would never execute anywhere.
 */
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

const realPlatform = process.platform;

describe("notifyDone", () => {
  let written: string[];

  beforeEach(() => {
    execFileMock.mockReset();
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    onPlatform(realPlatform);
  });

  it("rings the terminal bell on every platform, including one with no notifier", () => {
    onPlatform("win32");

    notifyDone("title", "body");

    expect(written).toContain("\u0007");
    // The bell is the whole notification on Windows — nothing is spawned.
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("sends a macOS notification through osascript", () => {
    onPlatform("darwin");

    notifyDone("harness — run done", "abc123: 3 PRs opened.");

    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("osascript");
    expect(args[0]).toBe("-e");
    expect(args[1]).toBe('display notification "abc123: 3 PRs opened." with title "harness — run done"');
  });

  it("sends a Linux notification through notify-send", () => {
    onPlatform("linux");

    notifyDone("harness", "run done");

    expect(execFileMock.mock.calls[0]).toEqual(["notify-send", ["harness", "run done"], expect.any(Function)]);
  });

  it("collapses newlines and caps the body, so a stack trace cannot become the notification", () => {
    onPlatform("linux");
    const stack = `boom\n    at one\n    at two\n${"x".repeat(500)}`;

    notifyDone("t", stack);

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args[1]).toHaveLength(200);
    expect(args[1]).not.toContain("\n");
    expect(args[1]!.startsWith("boom at one at two")).toBe(true);
  });

  it("escapes quotes and backslashes so an AppleScript literal cannot be broken out of", () => {
    onPlatform("darwin");

    notifyDone('a "quoted" title', "path C:\\tmp and a \" quote");

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args[1]).toBe(
      'display notification "path C:\\\\tmp and a \\" quote" with title "a \\"quoted\\" title"'
    );
  });

  it("truncates before escaping, so a cut cannot orphan a backslash from what it escapes", () => {
    onPlatform("darwin");
    // 199 chars, then a backslash at index 199 — the last character that
    // survives `clean`'s 200-char slice. Escaping first would produce two
    // characters there, and the slice would keep only the first: a lone
    // trailing `\` that makes the AppleScript unparseable.
    const body = `${"a".repeat(199)}\\${"b".repeat(50)}`;

    notifyDone("t", body);

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args[1]).toBe(`display notification "${"a".repeat(199)}\\\\" with title "t"`);
  });

  it("ignores whatever execFile reports — a failed notification never fails a finished run", () => {
    onPlatform("darwin");

    notifyDone("t", "b");

    const callback = execFileMock.mock.calls[0]![2] as (e: Error | null) => unknown;
    expect(callback(new Error("osascript not found"))).toBeUndefined();
  });
});
