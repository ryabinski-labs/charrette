import { describe, expect, it, vi } from "vitest";
import { GitHubAdapter } from "./github.js";

describe("SHA-bound authorized release merge", () => {
  const original = () => ({ state: "open", draft: false, head: { ref: "charrette/r/main", sha: "tested", repo: { full_name: "owner/repo" } }, base: { ref: "main" } });
  function fixture(data = original()) {
    const github = new GitHubAdapter("fixture", "owner/repo");
    const merge = vi.fn(async (_args: unknown) => ({ data: { merged: true } }));
    const get = vi.fn(async () => ({ data }));
    (github as unknown as { octokit: unknown }).octokit = { rest: { pulls: { get, merge } } };
    return { github, merge, get };
  }
  it("binds GitHub's compare-and-set merge to the exact validated head", async () => {
    const f = fixture();
    expect(await f.github.mergeApprovedPR(7, "charrette/r/main", "main", "tested")).toBe(true);
    expect(f.merge).toHaveBeenCalledWith({ owner: "owner", repo: "repo", pull_number: 7, sha: "tested", merge_method: "merge" });
  });
  it.each(["head", "base", "sha", "fork", "draft", "closed"])("refuses an unexpected %s without attempting merge", async (change) => {
    const data = original();
    if (change === "head") data.head.ref = "another";
    if (change === "base") data.base.ref = "another";
    if (change === "sha") data.head.sha = "untested";
    if (change === "fork") data.head.repo.full_name = "stranger/repo";
    if (change === "draft") data.draft = true;
    if (change === "closed") data.state = "closed";
    const f = fixture(data);
    expect(await f.github.mergeApprovedPR(7, "charrette/r/main", "main", "tested")).toBe(false);
    expect(f.merge).not.toHaveBeenCalled();
  });
  it("does not bypass unavailable access or server-side protection", async () => {
    expect(await new GitHubAdapter(undefined, undefined).mergeApprovedPR(7, "charrette/r/main", "main", "tested")).toBe(false);
    const f = fixture();
    expect(await f.github.mergeApprovedPR(7, "charrette/r/main", "main", "")).toBe(false);
    f.merge.mockRejectedValueOnce(new Error("branch protection requires review"));
    expect(await f.github.mergeApprovedPR(7, "charrette/r/main", "main", "tested")).toBe(false);
    f.merge.mockResolvedValueOnce({ data: { merged: false } });
    expect(await f.github.mergeApprovedPR(7, "charrette/r/main", "main", "tested")).toBe(false);
  });
});
