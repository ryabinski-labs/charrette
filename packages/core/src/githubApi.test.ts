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
/**
 * One endpoint, with a default reply a test can replace by any shape the real
 * API returns. Deliberately loose: inferring the type from the default would
 * make `mockResolvedValue` reject every field the default happens not to carry,
 * which is most of what these tests are about.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { data: any };
const endpoint = (data: unknown = {}) => vi.fn(async (..._args: unknown[]): Promise<Reply> => ({ data }));

function fakeOctokit() {
  const api = {
    issues: {
      listForRepo: endpoint([]),
      create: endpoint({ number: 7, html_url: "https://example.invalid/issues/7" }),
      listComments: endpoint([]),
      createComment: endpoint(),
      get: endpoint({ state: "open" }),
      update: endpoint(),
    },
    pulls: {
      list: endpoint([]),
      create: endpoint({ number: 42, html_url: "https://example.invalid/pull/42" }),
      get: endpoint({ state: "open", draft: false, head: { sha: "deadbeef" } }),
      update: endpoint(),
    },
    checks: { listForRef: endpoint([]) },
    actions: {
      listWorkflowRunsForRepo: endpoint({ workflow_runs: [] }),
      reRunWorkflowFailedJobs: endpoint(),
      listJobsForWorkflowRun: endpoint({ jobs: [] }),
      downloadJobLogsForWorkflowRun: endpoint("a log line"),
    },
    repos: { getCombinedStatusForRef: endpoint({ statuses: [] }) },
  };
  return {
    rest: api,
    graphql: vi.fn(async () => ({})),
    paginate: Object.assign(
      vi.fn(async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data),
      {
        // The real `paginate.iterator` yields one page at a time so a caller can
        // stop early. Endpoints here answer with everything at once, so a test
        // that wants several pages sets `pages` on the endpoint instead.
        iterator: vi.fn((fn: { pages?: unknown[][] } & ((p: unknown) => Promise<{ data: unknown[] }>), params: unknown) => ({
          async *[Symbol.asyncIterator]() {
            if (fn.pages) {
              for (const data of fn.pages) yield { data };
              return;
            }
            yield { data: (await fn(params)).data };
          },
        })),
      }
    ),
  };
}

type Fake = ReturnType<typeof fakeOctokit>;

function adapterWith(): { adapter: GitHubAdapter; api: Fake } {
  const adapter = new GitHubAdapter("token", "owner/repo");
  const api = fakeOctokit();
  (adapter as unknown as { octokit: unknown }).octokit = api;
  return { adapter, api };
}

const issue = (number: number, body: string | null, extra: Record<string, unknown> = {}) => ({
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
    await expect(adapter.prMergeable(1)).resolves.toBeNull();
    await expect(adapter.rerunFailedChecks(1)).resolves.toBe(false);
    await expect(adapter.failingJobLogs(1)).resolves.toEqual([]);
    await expect(adapter.mergedSha(1)).resolves.toBeNull();
    await expect(adapter.checksForRef("sha")).resolves.toBeNull();
    await expect(adapter.closePR(1, "why")).resolves.toBe(false);
    await expect(adapter.readIssue(1)).resolves.toBeNull();
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
    const args = (api.rest.issues.create.mock.calls[0] as unknown[])[0] as { body: string; labels: string[] };
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

/**
 * The read half of an issue the harness did *not* file. This is how a request
 * that is nothing but a link — "implement owner/repo#480" — becomes a brief
 * without the operator retyping the specification into a terminal.
 */
describe("reading an issue somebody else wrote", () => {
  const FULL = {
    number: 480,
    html_url: "https://github.com/owner/repo/issues/480",
    title: "Conflict engine misses overlapping holds",
    state: "open",
    user: { login: "operator" },
    labels: [{ name: "bug" }, "regression", { name: "" }, { id: 3 }],
    body: "  Two holds on the same slot both settle.  ",
  };

  it("returns the issue, its labels and its thread", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.get.mockResolvedValue({ data: FULL });
    api.rest.issues.listComments.mockResolvedValue({
      data: [{ user: { login: "operator" }, body: "  only when both are pending  " }],
    });

    await expect(adapter.readIssue(480)).resolves.toEqual({
      slug: "owner/repo",
      number: 480,
      url: "https://github.com/owner/repo/issues/480",
      title: "Conflict engine misses overlapping holds",
      state: "open",
      author: "operator",
      // A label can come back as a bare string, and one with no usable name is
      // not a label — it would otherwise render as an empty entry in the list.
      labels: ["bug", "regression"],
      body: "Two holds on the same slot both settle.",
      comments: [{ author: "operator", body: "only when both are pending" }],
      omittedComments: 0,
    });
    expect(api.rest.issues.get).toHaveBeenCalledWith({ owner: "owner", repo: "repo", issue_number: 480 });
  });

  /** An operator's link routinely points at a repo that is not the run's. */
  it("reads a different repository when the reference names one", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.get.mockResolvedValue({ data: FULL });

    await expect(adapter.readIssue(480, "other/project")).resolves.toMatchObject({ slug: "other/project" });
    expect(api.rest.issues.get).toHaveBeenCalledWith({ owner: "other", repo: "project", issue_number: 480 });
  });

  it("ignores a slug that is not owner/repo and stays on the run's own", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.get.mockResolvedValue({ data: FULL });

    await expect(adapter.readIssue(480, "nonsense")).resolves.toMatchObject({ slug: "owner/repo" });
  });

  /**
   * Null, not a throw and not an empty issue: private, deleted and mistyped all
   * arrive the same way, and the caller has to be able to say "I could not read
   * it" rather than hand an agent a blank specification.
   */
  it("returns nothing when the issue cannot be read", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.get.mockRejectedValue(new Error("404 Not Found"));

    await expect(adapter.readIssue(480)).resolves.toBeNull();
  });

  it("still returns the issue when only its thread fails", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.get.mockResolvedValue({ data: FULL });
    api.rest.issues.listComments.mockRejectedValue(new Error("410 Gone"));

    await expect(adapter.readIssue(480)).resolves.toMatchObject({ comments: [] });
  });

  it("fills in the gaps a sparse issue leaves and drops the harness's own comments", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.get.mockResolvedValue({
      data: { number: 5, html_url: "u", title: "t", state: "closed", user: null, labels: [], body: null },
    });
    api.rest.issues.listComments.mockResolvedValue({
      data: [
        { user: { login: "operator" }, body: "merged\n\n<!-- harness-comment -->" },
        { user: null, body: "from a deleted account" },
        { user: { login: "x" }, body: null },
      ],
    });

    await expect(adapter.readIssue(5)).resolves.toEqual({
      slug: "owner/repo",
      number: 5,
      url: "u",
      title: "t",
      state: "closed",
      author: "someone",
      labels: [],
      body: "",
      comments: [{ author: "someone", body: "from a deleted account" }],
      omittedComments: 0,
    });
  });
});

/**
 * The bound on a thread, found by QA rather than by reasoning: the first widely
 * referenced public issue this was pointed at — octocat/Hello-World#1 — has
 * 2,500 comments, and reading it returned 275,000 characters, roughly 69,000
 * tokens, after 7.8 seconds of paging. The intake agent gets sixty turns and
 * carries everything it has read in the cached prefix of every one of them, so
 * a single `read_issue` call on a busy issue was enough to swamp the
 * conversation it was fetched for.
 */
describe("how much of a long thread comes back", () => {
  const HEAD = { number: 1, html_url: "u", title: "t", state: "open", user: { login: "a" }, labels: [], body: "b" };
  const say = (n: number, body: string) => Array.from({ length: n }, (_, i) => ({ user: { login: `u${i}` }, body }));

  function withThread(pages: unknown[][], total: number) {
    const { adapter, api } = adapterWith();
    api.rest.issues.get.mockResolvedValue({ data: { ...HEAD, comments: total } });
    Object.assign(api.rest.issues.listComments, { pages });
    return { adapter, api };
  }

  it("stops after three pages and says how many it left on GitHub", async () => {
    const { adapter, api } = withThread([say(100, "x"), say(100, "x"), say(100, "x"), say(100, "x"), say(100, "x")], 500);

    const issue = await adapter.readIssue(1);

    expect(issue!.comments).toHaveLength(300);
    expect(issue!.omittedComments).toBe(200);
    // Three pages fetched, not twenty-five: the cost is in the requests too.
    expect(api.paginate.iterator).toHaveBeenCalledOnce();
  });

  it("stops on the character budget when a handful of comments are enormous", async () => {
    const { adapter } = withThread([say(10, "y".repeat(15_000))], 10);

    const issue = await adapter.readIssue(1);

    // Two fit inside 40,000 characters; the third would not.
    expect(issue!.comments).toHaveLength(2);
    expect(issue!.omittedComments).toBe(8);
  });

  it("reads a thread that fits whole and claims nothing was left out", async () => {
    const { adapter } = withThread([say(3, "short")], 3);

    const issue = await adapter.readIssue(1);

    expect(issue!.comments).toHaveLength(3);
    expect(issue!.omittedComments).toBe(0);
  });

  /**
   * Skipped comments are still counted as read. Otherwise an issue whose thread
   * is nothing but the harness's own status updates would report them as
   * unread, and send the agent looking for words that are not there.
   */
  it("does not report the harness's own comments as left behind", async () => {
    const { adapter } = withThread([[{ user: { login: "a" }, body: "merged\n\n<!-- harness-comment -->" }]], 1);

    const issue = await adapter.readIssue(1);

    expect(issue!.comments).toEqual([]);
    expect(issue!.omittedComments).toBe(0);
  });

  it("keeps what it read when the thread fails partway through", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.get.mockResolvedValue({ data: { ...HEAD, comments: 200 } });
    api.paginate.iterator.mockImplementation(() => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        yield { data: say(2, "read before it broke") };
        throw new Error("410 Gone");
      },
    }));

    const issue = await adapter.readIssue(1);

    expect(issue!.comments).toHaveLength(2);
    expect(issue!.omittedComments).toBe(198);
  });

  /** An issue GitHub reports no comment count for still returns what it has. */
  it("copes with a missing comment count", async () => {
    const { adapter, api } = adapterWith();
    api.rest.issues.get.mockResolvedValue({ data: HEAD });
    Object.assign(api.rest.issues.listComments, { pages: [say(2, "x")] });

    const issue = await adapter.readIssue(1);

    expect(issue!.comments).toHaveLength(2);
    expect(issue!.omittedComments).toBe(0);
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

  it("is pending, not failing, while a failure sits alongside checks that have not finished", async () => {
    // web-app run 428d77f8: Frontend failed on this repo's slow, serialized
    // self-hosted runner while Backend/E2E/Android hadn't started yet, and
    // `settleChecks` stopped watching the instant this returned "failing" —
    // reporting one red job to the operator when three more went on to fail
    // too. The whole point of "settle" is not calling it until there is
    // nothing left to settle.
    const { adapter, api } = adapterWith();
    api.rest.checks.listForRef.mockResolvedValue({
      data: [run("frontend", "completed", "failure"), run("backend", "queued", null)],
    });

    await expect(adapter.checksForRef("sha")).resolves.toEqual({ state: "pending", failing: [], total: 2 });
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
    expect((api.rest.checks.listForRef.mock.calls[0] as unknown[])[0]).toMatchObject({ ref: "deadbeef" });
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

/**
 * Whether GitHub thinks the run's branch merges into its base.
 *
 * The distinction the whole phase turns on is between "no" and "not yet": a
 * conflict is a verdict, `mergeable: null` is a background job that has not
 * finished, and a response with no `mergeable` field at all is neither — it is
 * a shape that will never start carrying one, and polling it burns the settle
 * window learning nothing.
 */
describe("asking whether a pull request merges", () => {
  it("reads a computed yes and no, and carries the merge state status through", async () => {
    const { adapter, api } = adapterWith();

    api.rest.pulls.get.mockResolvedValue({ data: { mergeable: true, mergeable_state: "clean" } });
    await expect(adapter.prMergeable(42)).resolves.toEqual({ state: "mergeable", mergeStateStatus: "clean" });

    api.rest.pulls.get.mockResolvedValue({ data: { mergeable: false, mergeable_state: "dirty" } });
    await expect(adapter.prMergeable(42)).resolves.toEqual({ state: "conflicting", mergeStateStatus: "dirty" });
  });

  it("answers a merged pull request from its state instead of polling a merge that no longer exists", async () => {
    // GitHub reports `mergeable: null` on a merged or closed pull request for
    // ever. Waiting on that is a timeout with a known answer already on the row.
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({ data: { merged_at: "2026-08-19T10:00:00Z", mergeable: null } });

    await expect(adapter.prMergeable(42)).resolves.toEqual({ state: "mergeable", mergeStateStatus: "merged" });
  });

  it("reports a null as unknown, which is the one answer worth waiting on", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({ data: { mergeable: null, mergeable_state: "unstable" } });

    await expect(adapter.prMergeable(42)).resolves.toEqual({ state: "unknown", mergeStateStatus: "unstable" });
  });

  it("falls back to unknown when the state is missing as well", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({ data: { mergeable: null } });

    await expect(adapter.prMergeable(42)).resolves.toEqual({ state: "unknown", mergeStateStatus: "unknown" });
  });

  it("learns nothing at all from a response that does not carry the field", async () => {
    // Not the same as null: null is the background job running, absent is a
    // response that is not the one this reads. `null` here stops the polling.
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({ data: { state: "open", mergeable_state: "unknown" } });

    await expect(adapter.prMergeable(42)).resolves.toBeNull();
  });

  it("learns nothing from a pull request it could not read", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockRejectedValue(new Error("404"));

    await expect(adapter.prMergeable(42)).resolves.toBeNull();
  });
});

import { tailOfLog } from "./github.js";

/**
 * Re-running failed jobs and reading their logs — the two reads that turn
 * "CI is red" from a report into a task.
 */
describe("re-running the failed jobs on a pull request", () => {
  it("re-runs every red workflow run on the head commit and reports that it did", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({ data: { head: { sha: "abc" } } });
    api.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: { workflow_runs: [{ id: 1, conclusion: "failure" }, { id: 2, conclusion: "success" }, { id: 3, conclusion: "timed_out" }] },
    });

    await expect(adapter.rerunFailedChecks(7)).resolves.toBe(true);
    expect(api.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledTimes(2);
  });

  it("reports false when GitHub refuses every re-run", async () => {
    // A workflow that failed before any job started — a bad `services:` block —
    // has no failed jobs to re-run and GitHub refuses. Not flake, an answer.
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({ data: { head: { sha: "abc" } } });
    api.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [{ id: 1, conclusion: "failure" }] } });
    api.rest.actions.reRunWorkflowFailedJobs.mockRejectedValue(new Error("422"));

    await expect(adapter.rerunFailedChecks(7)).resolves.toBe(false);
  });

  it("reports false with nothing red, an unreadable pull request, or an unlistable run set", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({ data: { head: { sha: "abc" } } });
    await expect(adapter.rerunFailedChecks(7)).resolves.toBe(false);

    api.rest.actions.listWorkflowRunsForRepo.mockRejectedValue(new Error("500"));
    await expect(adapter.rerunFailedChecks(7)).resolves.toBe(false);

    api.rest.pulls.get.mockRejectedValue(new Error("404"));
    await expect(adapter.rerunFailedChecks(7)).resolves.toBe(false);
  });
});

describe("reading the failing jobs' logs", () => {
  it("returns each failing job with the tail of its own log", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({ data: { head: { sha: "abc" } } });
    api.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: { workflow_runs: [{ id: 1, conclusion: "failure" }, { id: 2, conclusion: "success" }, { id: 3, conclusion: "skipped" }, { id: 4, conclusion: "neutral" }, { id: 5, conclusion: null }] },
    });
    api.rest.actions.listJobsForWorkflowRun.mockResolvedValue({
      data: { jobs: [{ id: 10, name: "build", conclusion: "failure" }, { id: 11, name: "lint", conclusion: "success" }, { id: 12, name: "e2e", conclusion: "startup_failure" }] },
    });
    api.rest.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({ data: "line one\nthe verdict" });

    await expect(adapter.failingJobLogs(7)).resolves.toEqual([
      { name: "build", log: "line one\nthe verdict" },
      { name: "e2e", log: "line one\nthe verdict" },
    ]);
  });

  it("degrades to a name with no log rather than an error", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({ data: { head: { sha: "abc" } } });
    api.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [{ id: 1, conclusion: "failure" }] } });
    api.rest.actions.listJobsForWorkflowRun.mockResolvedValue({ data: { jobs: [{ id: 10, name: "build", conclusion: "failure" }] } });
    api.rest.actions.downloadJobLogsForWorkflowRun.mockRejectedValue(new Error("410 expired"));

    await expect(adapter.failingJobLogs(7)).resolves.toEqual([{ name: "build", log: "" }]);
  });

  it("answers empty for an unreadable pull request, unlistable runs, or unlistable jobs", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockRejectedValue(new Error("404"));
    await expect(adapter.failingJobLogs(7)).resolves.toEqual([]);

    api.rest.pulls.get.mockResolvedValue({ data: { head: { sha: "abc" } } });
    api.rest.actions.listWorkflowRunsForRepo.mockRejectedValue(new Error("500"));
    await expect(adapter.failingJobLogs(7)).resolves.toEqual([]);

    api.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [{ id: 1, conclusion: "failure" }] } });
    api.rest.actions.listJobsForWorkflowRun.mockRejectedValue(new Error("500"));
    await expect(adapter.failingJobLogs(7)).resolves.toEqual([]);
  });

  it("copes with a log endpoint that answers with nothing at all", async () => {
    const { adapter, api } = adapterWith();
    api.rest.pulls.get.mockResolvedValue({ data: { head: { sha: "abc" } } });
    api.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [{ id: 1, conclusion: "failure" }] } });
    api.rest.actions.listJobsForWorkflowRun.mockResolvedValue({ data: { jobs: [{ id: 10, name: "build", conclusion: "failure" }] } });
    api.rest.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({ data: undefined });

    await expect(adapter.failingJobLogs(7)).resolves.toEqual([{ name: "build", log: "" }]);
  });
});

describe("the tail of a log", () => {
  it("keeps a short log whole and cuts a long one by lines, then by bytes", () => {
    expect(tailOfLog("a\nb")).toBe("a\nb");
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    expect(tailOfLog(lines).split("\n")[0]).toBe("line 80");
    const fat = Array.from({ length: 100 }, () => "x".repeat(200)).join("\n");
    expect(tailOfLog(fat).length).toBe(8_000);
  });
});
