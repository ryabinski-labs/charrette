import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The document an operator takes to a fresh host.
 *
 * The PRD's promise is a guide that covers a specific list in a specific order,
 * not merely a guide that exists. These cases read the committed files, so a
 * section that is deleted, renamed or moved behind another one fails here
 * rather than on the host at 2am.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const TOPICS = [
  ["threat model", /threat model/i],
  ["architecture", /architecture/i],
  ["host preparation", /host preparation|preparing the host/i],
  ["access over tailscale and ssh", /tailscale|ssh access/i],
  ["dashboard tunnel", /dashboard tunnel/i],
  ["credentials", /credentials/i],
  ["agent environment", /agent environment|agentEnv/i],
  ["notifications", /notification/i],
  ["tmux", /tmux/i],
  ["updates", /update/i],
  ["backups", /backup/i],
  ["hardening left to the operator", /hardening/i],
] as const;

describe("docs/REMOTE.md", () => {
  it("SC-012-a the guide covers the promised sections in order", () => {
    const guide = read("docs/REMOTE.md");
    const headings = guide
      .split("\n")
      .filter((line) => /^#{1,3}\s/.test(line))
      .map((line) => line.replace(/^#+\s*/, ""));

    const indices = TOPICS.map(([name, pattern]) => {
      const index = headings.findIndex((heading) => pattern.test(heading));
      expect(index, `no heading for ${name}`).toBeGreaterThanOrEqual(0);
      return index;
    });
    for (let i = 1; i < indices.length; i++) expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
    expect(guide).toContain("ssh -L 4777:127.0.0.1:4777");
  });

  it("SC-012-b both Claude logins and the scoped GitHub token are documented", () => {
    const guide = read("docs/REMOTE.md");

    expect(guide).toContain("claude setup-token");
    expect(guide).toContain("spend limit");
    expect(guide).toMatch(/an agent can read|agents? can read/i);
    expect(guide).toContain("Contents: read and write");
    expect(guide).toContain("Pull requests: read and write");
    expect(guide).toContain("Checks: read");
    expect(guide).toContain("Metadata: read");
    expect(guide).toMatch(/no Workflows|without Workflows/i);
  });

  it("SC-012-c the README and OPERATIONS point at the guide and document the new settings", () => {
    const readme = read("README.md");
    const operations = read("docs/OPERATIONS.md");
    const changelog = read("CHANGELOG.md");

    expect(readme).toContain("docs/REMOTE.md");
    for (const needle of [
      "docs/REMOTE.md",
      "agentEnv",
      "CHARRETTE_NOTIFY_URL",
      "CHARRETTE_NOTIFY_FORMAT",
      "CHARRETTE_NOTIFY_TOKEN",
    ]) {
      expect(operations).toContain(needle);
    }
    expect(changelog).toContain("agentEnv");
    expect(changelog).toContain("allowlist");
  });
});
