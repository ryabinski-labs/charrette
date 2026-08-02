import { describe, expect, it } from "vitest";
import { GitHubAdapter, isDraftUnsupportedError } from "./github.js";

/**
 * The adapter with a hand-rolled Octokit. Only the surfaces ensurePR /
 * markPrReady / prState touch are stubbed; anything else throws on access.
 */
function stubbed(overrides: {
  list?: { state: string; number: number; html_url: string }[];
  createError?: unknown;
  draftError?: unknown;
  get?: { state: string; draft?: boolean; merged_at?: string | null; node_id?: string };
}) {
  const adapter = new GitHubAdapter("token", "owner/repo");
  const calls = { created: [] as { draft?: boolean }[], updated: [] as { title?: string; body?: string }[], graphql: [] as unknown[] };
  const octokit = {
    rest: {
      pulls: {
        list: async () => ({ data: overrides.list ?? [] }),
        create: async (args: { draft?: boolean }) => {
          if (args.draft && overrides.draftError) throw overrides.draftError;
          if (overrides.createError) throw overrides.createError;
          calls.created.push(args);
          return { data: { number: 42, html_url: "https://example.invalid/pr/42" } };
        },
        get: async () => ({ data: overrides.get }),
        update: async (args: { title?: string; body?: string }) => {
          calls.updated.push(args);
          return { data: {} };
        },
      },
    },
    graphql: async (_q: string, vars: unknown) => {
      calls.graphql.push(vars);
      return {};
    },
  };
  (adapter as unknown as { octokit: unknown }).octokit = octokit;
  return { adapter, calls };
}

const err422 = (message: string) => Object.assign(new Error(message), { status: 422 });

describe("ensurePR after the branch outlived its PR", () => {
  it("still prefers an open PR over creating anything", async () => {
    const { adapter, calls } = stubbed({ list: [{ state: "open", number: 7, html_url: "u7" }] });
    const pr = await adapter.ensurePR("r", "run", "head", "main", "t", "b");
    expect(pr).toEqual({ number: 7, url: "u7" });
    expect(calls.created).toHaveLength(0);
  });

  it("a merged prior PR does not block a follow-up for the commits it never carried", async () => {
    // The marrymath failure: the rollup was merged mid-run, four more tasks
    // landed on the branch, and ensurePR found the merged PR and did nothing.
    const { adapter, calls } = stubbed({ list: [{ state: "closed", number: 89, html_url: "u89" }] });
    const pr = await adapter.ensurePR("r", "run", "head", "main", "t", "b");
    expect(pr).toEqual({ number: 42, url: "https://example.invalid/pr/42", fresh: true });
    expect(calls.created).toHaveLength(1);
  });

  it("falls back to the prior PR when the branch holds nothing new — a replay stays idempotent", async () => {
    const { adapter } = stubbed({
      list: [{ state: "closed", number: 89, html_url: "u89" }],
      createError: err422("Validation Failed: No commits between main and head"),
    });
    const pr = await adapter.ensurePR("r", "run", "head", "main", "t", "b");
    expect(pr).toEqual({ number: 89, url: "u89" });
  });

  it("downgrades to a non-draft PR where GitHub does not sell drafts", async () => {
    const { adapter, calls } = stubbed({ draftError: err422("Draft pull requests are not supported in this repository.") });
    const pr = await adapter.ensurePR("r", "run", "head", "main", "t", "b", { draft: true });
    expect(pr?.number).toBe(42);
    expect(calls.created).toEqual([expect.objectContaining({ draft: false })]);
  });
});

describe("markPrReady", () => {
  it("updates the stale draft body and flips it ready via GraphQL", async () => {
    const { adapter, calls } = stubbed({ get: { state: "open", draft: true, node_id: "NODE" } });
    expect(await adapter.markPrReady("r", "run", 7, "final title", "final body")).toBe(true);
    expect(calls.updated[0]!.body).toContain("final body");
    expect(calls.updated[0]!.body).toContain("<!-- harness-run:r/pr-run -->");
    expect(calls.graphql).toEqual([{ id: "NODE" }]);
  });

  it("leaves a PR that is not an open draft exactly as it is", async () => {
    const { adapter, calls } = stubbed({ get: { state: "open", draft: false } });
    expect(await adapter.markPrReady("r", "run", 7, "t", "b")).toBe(false);
    expect(calls.updated).toHaveLength(0);
    expect(calls.graphql).toHaveLength(0);
  });
});

describe("prState", () => {
  it("reports merged before closed — GitHub says merged PRs are closed too", async () => {
    const { adapter } = stubbed({ get: { state: "closed", merged_at: "2026-08-01T16:56:45Z" } });
    expect(await adapter.prState(89)).toBe("merged");
  });

  it("tells open drafts from ready PRs", async () => {
    expect(await stubbed({ get: { state: "open", draft: true, merged_at: null } }).adapter.prState(1)).toBe("draft");
    expect(await stubbed({ get: { state: "open", draft: false, merged_at: null } }).adapter.prState(1)).toBe("open");
  });
});

/** The adapter with only the issue surfaces stubbed. */
function issueStub(overrides: { comments?: { body: string }[]; state?: string }) {
  const adapter = new GitHubAdapter("token", "owner/repo");
  const calls = { comments: [] as { body: string }[], updates: [] as { state?: string; state_reason?: string }[] };
  const octokit = {
    paginate: async () => overrides.comments ?? [],
    rest: {
      issues: {
        listComments: () => {},
        createComment: async (args: { body: string }) => {
          calls.comments.push(args);
          return { data: {} };
        },
        get: async () => ({ data: { state: overrides.state ?? "open" } }),
        update: async (args: { state?: string; state_reason?: string }) => {
          calls.updates.push(args);
          return { data: {} };
        },
      },
    },
  };
  (adapter as unknown as { octokit: unknown }).octokit = octokit;
  return { adapter, calls };
}

describe("commenting the outcome onto an issue", () => {
  it("writes the status once and marks it so the harness never reads it back as operator guidance", async () => {
    const { adapter, calls } = issueStub({});
    expect(await adapter.commentOnIssue(7, "run/task/MERGED", "Done")).toBe(true);
    expect(calls.comments[0]!.body).toContain("Done");
    expect(calls.comments[0]!.body).toContain("<!-- harness-status:run/task/MERGED -->");
    // The read half filters on this marker; without it the run takes its own
    // status update as an answer and hands it to the next worker.
    expect(calls.comments[0]!.body).toContain("<!-- harness-comment -->");
  });

  it("stays silent on a replay that reaches the same state again", async () => {
    const { adapter, calls } = issueStub({ comments: [{ body: "Done\n\n<!-- harness-status:run/task/MERGED -->" }] });
    expect(await adapter.commentOnIssue(7, "run/task/MERGED", "Done")).toBe(false);
    expect(calls.comments).toHaveLength(0);
  });

  it("still speaks for a different state on the same task", async () => {
    const { adapter, calls } = issueStub({ comments: [{ body: "Parked\n\n<!-- harness-status:run/task/NEEDS_HUMAN -->" }] });
    expect(await adapter.commentOnIssue(7, "run/task/MERGED", "Done")).toBe(true);
    expect(calls.comments).toHaveLength(1);
  });
});

describe("closeIssue", () => {
  it("closes an open issue with the reason given", async () => {
    const { adapter, calls } = issueStub({ state: "open" });
    expect(await adapter.closeIssue(7, "not_planned")).toBe(true);
    expect(calls.updates).toEqual([expect.objectContaining({ state: "closed", state_reason: "not_planned" })]);
  });

  it("leaves an already-closed issue alone — whoever closed it said something", async () => {
    const { adapter, calls } = issueStub({ state: "closed" });
    expect(await adapter.closeIssue(7, "not_planned")).toBe(false);
    expect(calls.updates).toHaveLength(0);
  });
});

describe("telling the draft 422 apart", () => {
  it("matches only the draft-unsupported message", () => {
    expect(isDraftUnsupportedError(err422("Draft pull requests are not supported in this repository."))).toBe(true);
    expect(isDraftUnsupportedError(err422("No commits between a and b"))).toBe(false);
    expect(isDraftUnsupportedError({ status: 404, message: "Draft pull requests are not supported" })).toBe(false);
  });
});
