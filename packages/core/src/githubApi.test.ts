import { describe, expect, it, vi } from "vitest";

import { GitHubAdapter, isNoCommitsError } from "./github.js";

/**
 * A hand-rolled Octokit, complete enough for the read paths.
 *
 * `paginate` is the real thing's contract reduced to one page: it is handed an
 * endpoint function and its parameters, and returns the aggregated items. Every
 * endpoint here is a vi.fn so a test can make it throw — the `.catch(() => [])`
 * arms are not incidental, they are what keeps a repo with no CI, or a label no
 * issue carries yet, from failing a run.
 */
function fakeOctokit() {
  const api = {
    issues: {
      listForRepo: vi.fn(async () => ({ data: [] as unknown[] })),
      create: vi.fn(async () => ({ data: { number: 7, html_url: "https://example.invalid/issues/7" } })),
      listComments: vi.fn(async () => ({ data: [] as unknown[] })),
      createComment: vi.fn(async () => ({ data: {} })),
      get: vi.fn(async () => ({ data: { state: "open" } })),
      update: vi.fn(async () => ({ data: {} })),
    },
    pulls: {
      list: vi.fn(async () => ({ data: [] as unknown[] })),
      create: vi.fn(async () => ({ data: { number: 42, html_url: "https://example.invalid/pull/42" } })),
      get: vi.fn(async () => ({ data: { state: "open", draft: false, head: { sha: "deadbeef" } } })),
      update: vi.fn(async () => ({ data: {} })),
    },
    checks: { listForRef: vi.fn(async () => ({ data: [] as unknown[] })) },
    repos: { getCombinedStatusForRef: vi.fn(async () => ({ data: { statuses: [] as unknown[] } })) },
  };
  return {
    rest: api,
    graphql: vi.fn(async () => ({})),
    paginate: vi.fn(async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data),
  };
}

type Fake = ReturnType<typeof fakeOctokit>;

function adapterWith(): { adapter: GitHubAdapter; api: Fake } {
  const adapter = new GitHubAdapter("token", "owner/repo");
  const api = fakeOctokit();
  (adapter as unknown as { octokit: unknown }).octokit = api;
  return { adapter, api };
}

const issue = (number: number, body: string, extra: Record<string, unknown> = {}) => ({
  number,
  html_url: `https://example.invalid/issues/${number}`,
  body,
  ...extra,
});

describe("an adapter with nothing configured", () => {
  /**
   * Every method has to be a no-op rather than a throw: a run without a GitHub
   * token is a supported way to use the harness, and it walks the same code
   * paths as one with a token.
   */
  it.each([
    ["a token but no repo", "token", undefined],
    ["a repo but no token", undefined, "owner/repo"],
    ["a repo that is not owner/repo", "token", "just-a-name"],
    ["neither", undefined, undefined],
  ])("stays local-only with %s", async (_case, token, slug) => {
    const adapter = new GitHubAdapter(token, slug);

    expect(adapter.enabled).toBe(false);
    await expect(adapter.ensureIssue("r", "t", "title", "body", [])).resolves.toBeNull();
    await expect(adapter.issueComments(1)).resolves.toEqual([]);
    await expect(adapter.commentOnIssue(1, "k", "b")).resolves.toBe(false);
    await expect(adapter.closeIssue(1, "completed")).resolves.toBe(false);
    await expect(adapter.ensurePR("r", "t", "head", "main", "title", "body")).resolves.toBeNull();
    await expect(adapter.markPrReady("r", "t", 1, "title", "body")).resolves.toBe(false);
    await expect(adapter.prState(1)).resolves.toBeNull();
    await expect(adapter.prChecks(1)).resolves.toBeNull();
    await expect(adapter.mergedSha(1)).resolves.toBeNull();
    await expect(adapter.checksForRef("sha")).resolves.toBeNull();
    await expect(adapter.closePR(1, "why")).resolves.toBe(false);
  });

  it("is enabled once both halves are there", () => {
    expect(new GitHubAdapter("token", "owner/repo").enabled).toBe(true);
  });
});

describe("filing a run's issues", () => {
  it("creates the issue, labels it with the run, and stamps it so a replay finds it", async () => {
    const { adapter, api } = adapterWith();

    const ref = await adapter.ensureIssue("run1", "auth-task", "Auth", "Build the auth flow", ["harness"]);

    expect(ref).toEqual({ number: 7, url: "https://example.invalid/issues/7" });
    const args = api.rest.issues.create.mock.calls[0]![0] as { body: string; labels: string[] };
    expect(args.body).toBe("Build the auth flow\n\n<!-- harness-run:run1/auth-task -->");
    expect(args.labels).toEqual(["harness", "harness-run:run1"]);
  });

  it("returns the issue it already filed rather than filing a second one", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.listForRepo.mockResolvedValue({
      data: [issue(12, "whatever\n\n<!-- harness-run:run1/auth-task -->")],
    });

    const ref = await adapter.ensureIssue("run1", "auth-task", "Auth", "body", []);

    expect(ref).toEqual({ number: 12, url: "https://example.invalid/issues/12" });
    expect(api.rest.issues.create).not.toHaveBeenCalled();
  });

  it("reads the run's issues once, however many tasks ask", async () => {
    const { adapter, api } = adapterWith();

    await adapter.ensureIssue("run1", "a", "A", "body", []);
    await adapter.ensureIssue("run1", "b", "B", "body", []);

    expect(api.paginate).toHaveBeenCalledOnce();
    // The second task must see the first task's issue without another fetch.
    expect(api.rest.issues.create).toHaveBeenCalledTimes(2);
  });

  it("keeps its cache authoritative, so an immediate replay does not duplicate", async () => {
    const { adapter, api } = adapterWith();

    const first = await adapter.ensureIssue("run1", "a", "A", "body", []);
    const again = await adapter.ensureIssue("run1", "a", "A", "body", []);

    expect(again).toEqual(first);
    expect(api.rest.issues.create).toHaveBeenCalledOnce();
  });

  it("keeps separate runs apart", async () => {
    const { adapter, api } = adapterWith();

    await adapter.ensureIssue("run1", "a", "A", "body", []);
    await adapter.ensureIssue("run2", "a", "A", "body", []);

    expect(api.paginate).toHaveBeenCalledTimes(2);
    expect(api.rest.issues.create).toHaveBeenCalledTimes(2);
  });

  it("treats a label no issue carries yet as an empty list, not a failure", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.listForRepo.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

    await expect(adapter.ensureIssue("run1", "a", "A", "body", [])).resolves.toEqual({
      number: 7,
      url: "https://example.invalid/issues/7",
    });
  });

  it("ignores pull requests and unstamped issues that carry the run label", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.listForRepo.mockResolvedValue({
      data: [
        issue(3, "<!-- harness-run:run1/a -->", { pull_request: { url: "x" } }),
        issue(4, "an issue a human filed"),
        issue(5, null),
      ],
    });

    // None of those is the issue for task `a`, so one gets filed.
    await expect(adapter.ensureIssue("run1", "a", "A", "body", [])).resolves.toEqual({
      number: 7,
      url: "https://example.invalid/issues/7",
    });
  });
});

describe("reading what an operator wrote on an issue", () => {
  it("returns the comments oldest first, with their authors", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.listComments.mockResolvedValue({
      data: [
        { id: 1, user: { login: "operator" }, body: "  the table is never created  " },
        { id: 2, user: { login: "someone-else" }, body: "agreed" },
      ],
    });

    await expect(adapter.issueComments(9)).resolves.toEqual([
      { id: 1, author: "operator", body: "the table is never created" },
      { id: 2, author: "someone-else", body: "agreed" },
    ]);
  });

  /**
   * By marker, not by author: the token is often the operator's own, so
   * dropping everything that account said would drop exactly the words the
   * harness came for.
   */
  it("skips what the harness wrote itself, even under the operator's account", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.listComments.mockResolvedValue({
      data: [
        { id: 1, user: { login: "operator" }, body: "merged\n\n<!-- harness-comment -->" },
        { id: 2, user: { login: "operator" }, body: "actually, retry it" },
      ],
    });

    await expect(adapter.issueComments(9)).resolves.toEqual([{ id: 2, author: "operator", body: "actually, retry it" }]);
  });

  it("drops empty comments and names an unknown author", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.listComments.mockResolvedValue({
      data: [
        { id: 1, user: null, body: "from a deleted account" },
        { id: 2, user: { login: "x" }, body: "   " },
        { id: 3, user: { login: "y" }, body: null },
      ],
    });

    await expect(adapter.issueComments(9)).resolves.toEqual([{ id: 1, author: "someone", body: "from a deleted account" }]);
  });

  it("returns nothing when the thread cannot be read", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.listComments.mockRejectedValue(new Error("410 Gone"));

    await expect(adapter.issueComments(9)).resolves.toEqual([]);
  });

  it("copes with an existing comment whose body is empty when checking for its marker", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.listComments.mockResolvedValue({ data: [{ id: 1, body: null }] });

    await expect(adapter.commentOnIssue(9, "merged", "it merged")).resolves.toBe(true);
    expect(api.rest.issues.createComment).toHaveBeenCalledOnce();
  });

  it("says nothing twice about the same state", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.listComments.mockResolvedValue({
      data: [{ id: 1, body: "merged\n\n<!-- harness-comment -->\n<!-- harness-status:merged -->" }],
    });

    await expect(adapter.commentOnIssue(9, "merged", "it merged")).resolves.toBe(false);
    expect(api.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("reads no comments when the listing fails on the status path either", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.listComments.mockRejectedValue(new Error("410 Gone"));

    await expect(adapter.commentOnIssue(9, "merged", "it merged")).resolves.toBe(true);
  });
});

describe("what CI says about a commit", () => {
  const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });

  it("is green when every check and status passed", async () => {
    const { adapter, api } = adapterWith();
    api.rest.checks.listForRef.mockResolvedValue({ data: [run("build", "completed", "success")] });
    api.rest.repos.getCombinedStatusForRef.mockResolvedValue({ data: { statuses: [{ state: "success", context: "ci/external" }] } });

    await expect(adapter.checksForRef("sha")).resolves.toEqual({ state: "passing", failing: [], total: 2 });
  });

  it("names what failed, so the operator knows where to look", async () => {
    const { adapter, api } = adapterWith();
    api.rest.checks.listForRef.mockResolvedValue({
      data: [run("build", "completed", "success"), run("lint", "completed", "failure")],
    });
    api.rest.repos.getCombinedStatusForRef.mockResolvedValue({
      data: { statuses: [{ state: "error", context: "ci/deploy" }] },
    });

    await expect(adapter.checksForRef("sha")).resolves.toEqual({
      state: "failing",
      failing: ["lint", "ci/deploy"],
      total: 3,
    });
  });

  it.each(["failure", "timed_out", "cancelled", "action_required", "startup_failure"])(
    "counts a %s conclusion as a failure, not something to wait for",
    async (conclusion) => {
      const { adapter, api } = adapterWith();
      api.rest.checks.listForRef.mockResolvedValue({ data: [run("build", "completed", conclusion)] });

      await expect(adapter.checksForRef("sha")).resolves.toMatchObject({ state: "failing", failing: ["build"] });
    }
  );

  it("is pending while anything is still running", async () => {
    const { adapter, api } = adapterWith();
    api.rest.checks.listForRef.mockResolvedValue({
      data: [run("build", "completed", "success"), run("test", "in_progress", null)],
    });

    await expect(adapter.checksForRef("sha")).resolves.toEqual({ state: "pending", failing: [], total: 2 });
  });

  it("is pending on an unfinished commit status too", async () => {
    const { adapter, api } = adapterWith();
    api.rest.repos.getCombinedStatusForRef.mockResolvedValue({ data: { statuses: [{ state: "pending", context: "ci" }] } });

    await expect(adapter.checksForRef("sha")).resolves.toEqual({ state: "pending", failing: [], total: 1 });
  });

  it("does not count a skipped or neutral check as a result", async () => {
    const { adapter, api } = adapterWith();
    api.rest.checks.listForRef.mockResolvedValue({
      data: [run("changelog", "completed", "skipped"), run("advisory", "completed", "neutral")],
    });

    // Deliberate non-answers, so the commit has nothing attached to it at all.
    await expect(adapter.checksForRef("sha")).resolves.toEqual({ state: "none", failing: [], total: 0 });
  });

  it("counts a completed check with no conclusion at all as neither pass nor fail", async () => {
    const { adapter, api } = adapterWith();
    api.rest.checks.listForRef.mockResolvedValue({ data: [run("odd", "completed", null)] });

    await expect(adapter.checksForRef("sha")).resolves.toEqual({ state: "passing", failing: [], total: 1 });
  });

  it("reports none when the repo has no CI on either surface", async () => {
    const { adapter } = adapterWith();

    await expect(adapter.checksForRef("sha")).resolves.toEqual({ state: "none", failing: [], total: 0 });
  });

  it("survives both surfaces being unreadable", async () => {
    const { adapter, api } = adapterWith();
    api.rest.checks.listForRef.mockRejectedValue(new Error("403"));
    api.rest.repos.getCombinedStatusForRef.mockRejectedValue(new Error("403"));

    await expect(adapter.checksForRef("sha")).resolves.toEqual({ state: "none", failing: [], total: 0 });
  });

  it("asks about the pull request's head commit", async () => {
    const { adapter, api } = adapterWith();
    api.rest.checks.listForRef.mockResolvedValue({ data: [run("build", "completed", "success")] });

    await expect(adapter.prChecks(3)).resolves.toMatchObject({ state: "passing" });
    expect(api.rest.checks.listForRef.mock.calls[0]![0]).toMatchObject({ ref: "deadbeef" });
  });

  /**
   * `null` is not "no checks". A caller that treated an unreadable pull request
   * as a pass would report green CI on a branch nobody has checked.
   */
  it("answers null, not none, when the pull request cannot be read", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockRejectedValue(new Error("404"));

    await expect(adapter.prChecks(3)).resolves.toBeNull();
  });
});

describe("following a merge to the commit it landed as", () => {
  it("returns the merge commit of a merged pull request", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({
      data: { state: "closed", merged_at: "2026-08-01T10:00:00Z", merge_commit_sha: "abc123" },
    });

    await expect(adapter.mergedSha(3)).resolves.toBe("abc123");
  });

  it("returns null for a pull request nobody has merged", async () => {
    const { adapter } = adapterWith();

    await expect(adapter.mergedSha(3)).resolves.toBeNull();
  });

  it("returns null when a merged pull request reports no merge commit", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({ data: { merged_at: "2026-08-01T10:00:00Z" } });

    await expect(adapter.mergedSha(3)).resolves.toBeNull();
  });

  it("returns null when the pull request cannot be read", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockRejectedValue(new Error("404"));

    await expect(adapter.mergedSha(3)).resolves.toBeNull();
  });

  it("reports a closed pull request that was never merged as closed", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({ data: { state: "closed", merged_at: null } });

    await expect(adapter.prState(3)).resolves.toBe("closed");
  });

  it("reports null when the pull request cannot be read at all", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockRejectedValue(new Error("404"));

    await expect(adapter.prState(3)).resolves.toBeNull();
  });
});

describe("closing a pull request", () => {
  it("says why in a comment, then closes it", async () => {
    const { adapter, api } = adapterWith();

    await expect(adapter.closePR(5, "superseded by the rollup")).resolves.toBe(true);

    expect(api.rest.issues.createComment.mock.calls[0]![0]).toMatchObject({
      issue_number: 5,
      body: "superseded by the rollup\n\n<!-- harness-comment -->",
    });
    expect(api.rest.pulls.update.mock.calls[0]![0]).toMatchObject({ pull_number: 5, state: "closed" });
  });

  it("leaves a pull request that is not open alone", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({ data: { state: "closed" } });

    await expect(adapter.closePR(5, "why")).resolves.toBe(false);
    expect(api.rest.issues.createComment).not.toHaveBeenCalled();
    expect(api.rest.pulls.update).not.toHaveBeenCalled();
  });
});

describe("opening a pull request", () => {
  it("lets a real failure surface instead of reporting no pull request", async () => {
    const { adapter, api } = adapterWith();
    // A protected base branch, a bad token, a missing ref — none of these mean
    // "the branch had nothing to push", and swallowing them would leave the run
    // reporting success with no pull request anywhere.
    api.rest.pulls.create.mockRejectedValue(Object.assign(new Error("Resource not accessible by integration"), { status: 403 }));

    await expect(adapter.ensurePR("run1", "task1", "head", "main", "title", "body")).rejects.toThrow(
      "Resource not accessible by integration"
    );
  });

  it("stamps the pull request body so a replay can recognise it", async () => {
    const { adapter, api } = adapterWith();

    await expect(adapter.ensurePR("run1", "task1", "head", "main", "title", "body")).resolves.toEqual({
      number: 42,
      url: "https://example.invalid/pull/42",
      fresh: true,
    });
    expect((api.rest.pulls.create.mock.calls[0]![0] as { body: string }).body).toBe(
      "body\n\n<!-- harness-run:run1/pr-task1 -->"
    );
  });

  it("returns nothing at all when the branch is empty and no prior pull request exists", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.create.mockRejectedValue(
      Object.assign(new Error("Validation Failed"), {
        status: 422,
        response: { data: { errors: [{ message: "No commits between main and head" }] } },
      })
    );

    await expect(adapter.ensurePR("run1", "task1", "head", "main", "title", "body")).resolves.toBeNull();
  });
});

describe("telling the no-commits 422 apart", () => {
  it("matches the message GitHub actually sends", () => {
    expect(
      isNoCommitsError(
        Object.assign(new Error("Validation Failed"), {
          status: 422,
          response: { data: { errors: [{ message: "No commits between main and harness/run1/task" }] } },
        })
      )
    ).toBe(true);
  });

  it("does not swallow another 422, or the same message with another status", () => {
    expect(isNoCommitsError(Object.assign(new Error("branch is protected"), { status: 422 }))).toBe(false);
    expect(isNoCommitsError(Object.assign(new Error("no commits between"), { status: 404 }))).toBe(false);
    expect(isNoCommitsError(undefined)).toBe(false);
  });

  it("copes with a 422 whose body carries no errors array or message", () => {
    expect(isNoCommitsError({ status: 422 })).toBe(false);
    expect(isNoCommitsError(Object.assign(new Error(""), { status: 422, response: { data: { errors: [{}] } } }))).toBe(false);
  });
});
