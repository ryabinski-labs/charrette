import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadDotEnv } from "./env.js";

/**
 * The file that supplies the vendor keys.
 *
 * Worth real coverage rather than a smoke test, because the failure it prevents
 * is the one an operator cannot diagnose: the key is *written down*, in the file
 * every other tool reads, and the harness says it is not set.
 */

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-env-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("loading .env from the working directory", () => {
  it("puts a key nobody exported into the environment", () => {
    const { dir, cleanup } = tempDir();
    writeFileSync(path.join(dir, ".env"), "HARNESS_TEST_GEMINI=from_file\n");
    const seen: Record<string, string> = {};

    // The real loader writes to the live process.env; the fake records what it
    // was pointed at, which is the part this function is responsible for.
    const loaded = loadDotEnv(dir, (p) => {
      seen.path = p;
    });

    expect(loaded).toBe(path.join(dir, ".env"));
    expect(seen.path).toBe(path.join(dir, ".env"));
    cleanup();
  });

  it("actually reaches process.env through Node's own loader", () => {
    // The test above proves the path; this one proves the wiring, using the
    // real `process.loadEnvFile` rather than a stand-in.
    const { dir, cleanup } = tempDir();
    writeFileSync(path.join(dir, ".env"), "HARNESS_TEST_ONLY_KEY=lives\n");

    expect(loadDotEnv(dir)).toBe(path.join(dir, ".env"));
    expect(process.env.HARNESS_TEST_ONLY_KEY).toBe("lives");

    delete process.env.HARNESS_TEST_ONLY_KEY;
    cleanup();
  });

  it("lets an exported variable win over the file", () => {
    // `GEMINI_API_KEY=… harness run` has to stay a working one-off override of
    // whatever the project committed.
    const { dir, cleanup } = tempDir();
    writeFileSync(path.join(dir, ".env"), "HARNESS_TEST_PRECEDENCE=from_file\n");
    process.env.HARNESS_TEST_PRECEDENCE = "from_shell";

    loadDotEnv(dir);

    expect(process.env.HARNESS_TEST_PRECEDENCE).toBe("from_shell");
    delete process.env.HARNESS_TEST_PRECEDENCE;
    cleanup();
  });

  it("does nothing at all when there is no .env, which is most invocations", () => {
    const { dir, cleanup } = tempDir();
    expect(loadDotEnv(dir)).toBeNull();
    cleanup();
  });

  it("swallows an unreadable file rather than refusing to start", () => {
    // `missingKeys` names the variable and the role a moment later. A parser
    // error here could only say that something, somewhere in .env, is wrong.
    const thrower = vi.fn(() => {
      throw new Error("invalid line 3");
    });
    expect(loadDotEnv("/wherever", thrower)).toBeNull();
    expect(thrower).toHaveBeenCalledWith("/wherever/.env");
  });

  it("defaults to the process working directory", () => {
    const seen: string[] = [];
    loadDotEnv(undefined, (p) => void seen.push(p));
    expect(seen).toEqual([`${process.cwd()}/.env`]);
  });
});
