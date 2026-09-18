import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { originSlug } from "./github.js";

/** A repo whose `origin` is the given URL — no network, the remote is never contacted. */
function repoWithRemote(url?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-origin-slug-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  if (url) execFileSync("git", ["remote", "add", "origin", url], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("reading the repo slug off the origin remote", () => {
  it("reads an ssh remote", async () => {
    expect(await originSlug(repoWithRemote("git@github.com:ryabinski-labs/billing-app.git"))).toBe(
      "ryabinski-labs/billing-app"
    );
  });

  it("reads an https remote, with or without the .git suffix", async () => {
    expect(await originSlug(repoWithRemote("https://github.com/ryabinski-labs/billing-app.git"))).toBe(
      "ryabinski-labs/billing-app"
    );
    expect(await originSlug(repoWithRemote("https://github.com/ryabinski-labs/billing-app"))).toBe(
      "ryabinski-labs/billing-app"
    );
  });

  it("returns nothing for a repo with no origin, rather than throwing", async () => {
    expect(await originSlug(repoWithRemote())).toBeNull();
  });

  it("refuses a non-github host — a wrong link is worse than no link", async () => {
    expect(await originSlug(repoWithRemote("git@gitlab.com:acme/thing.git"))).toBeNull();
    expect(await originSlug(repoWithRemote("https://ghe.corp.example/acme/thing.git"))).toBeNull();
  });

  it("returns nothing for a path that is not a repository at all", async () => {
    expect(await originSlug(mkdtempSync(path.join(tmpdir(), "charrette-not-a-repo-")))).toBeNull();
  });
});
