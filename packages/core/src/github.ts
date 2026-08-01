import { Octokit } from "octokit";
import { git } from "./git.js";

/** A PR that exists on GitHub, whether this call opened it or a previous one did. */
export interface PrRef {
  number: number;
  url: string;
  /** Set when this very call created the PR, rather than finding one already there. */
  fresh?: boolean;
}

/**
 * GitHub adapter (PRD §11.1): the only module that talks to GitHub. Every write is
 * idempotent via a deterministic marker in the body, so crash-replays never duplicate.
 * When no token/repo is configured the harness runs local-only and all methods no-op.
 *
 * Idempotency deliberately avoids the search API. Search is eventually consistent —
 * an issue created seconds ago is not indexed yet — so a replay during that window
 * finds nothing and files a duplicate, which is the exact failure the marker exists
 * to prevent. Listing by label and by branch is exact and immediate.
 */
export class GitHubAdapter {
  private octokit: Octokit | null;
  private owner = "";
  private repo = "";
  /** Marker → issue, per run. One paginated fetch per run instead of one per task. */
  private issueCache = new Map<string, Map<string, PrRef>>();

  constructor(token: string | undefined, repoSlug: string | undefined) {
    if (token && repoSlug && repoSlug.includes("/")) {
      const [owner, repo] = repoSlug.split("/");
      this.owner = owner!;
      this.repo = repo!;
      // Pin the REST API version. Unpinned requests ride whatever GitHub defaults
      // to, which is what produces the "scheduled to be removed" warning on every
      // single call — and eventually a silent behaviour change mid-run.
      this.octokit = new Octokit({ auth: token, request: { headers: { "x-github-api-version": "2022-11-28" } } });
    } else {
      this.octokit = null;
    }
  }

  get enabled(): boolean {
    return this.octokit !== null;
  }

  private marker(runId: string, id: string): string {
    return `<!-- harness-run:${runId}/${id} -->`;
  }

  /** Scopes every issue a run files, so they can be listed back exactly. */
  private runLabel(runId: string): string {
    return `harness-run:${runId}`;
  }

  /** Load this run's already-filed issues once, keyed by their body marker. */
  private async runIssues(runId: string): Promise<Map<string, PrRef>> {
    const cached = this.issueCache.get(runId);
    if (cached) return cached;
    const found = new Map<string, PrRef>();
    // A label that no issue carries yet is a 404 on some repos, not an empty list.
    const items = await this.octokit!.paginate(this.octokit!.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      labels: this.runLabel(runId),
      state: "all",
      per_page: 100,
    }).catch(() => []);
    for (const item of items) {
      // listForRepo returns pull requests too; they are not issues we filed.
      if (item.pull_request) continue;
      const m = /<!-- harness-run:[^/]+\/([^ ]+) -->/.exec(item.body ?? "");
      if (m) found.set(this.marker(runId, m[1]!), { number: item.number, url: item.html_url });
    }
    this.issueCache.set(runId, found);
    return found;
  }

  async ensureIssue(runId: string, id: string, title: string, body: string, labels: string[]): Promise<PrRef | null> {
    if (!this.octokit) return null;
    const marker = this.marker(runId, id);
    const issues = await this.runIssues(runId);
    const existing = issues.get(marker);
    if (existing) return existing;
    const res = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body: `${body}\n\n${marker}`,
      labels: [...labels, this.runLabel(runId)],
    });
    const ref = { number: res.data.number, url: res.data.html_url };
    // Keep the cache authoritative: the next task must see this one immediately.
    issues.set(marker, ref);
    return ref;
  }

  /**
   * Open the PR for a task branch, or return the one already open for it.
   *
   * `null` means there is nothing to open a PR for — GitHub is not configured, or
   * the branch carries no commits the base does not already have. The latter is a
   * real outcome, not an error: a task can legitimately produce no diff, and a
   * replay after the base moved on looks identical. It used to surface as a 422
   * that killed the run *after* the work had already been merged.
   */
  async ensurePR(
    runId: string,
    taskId: string,
    head: string,
    base: string,
    title: string,
    body: string,
    opts?: { draft?: boolean }
  ): Promise<PrRef | null> {
    if (!this.octokit) return null;
    const prior = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      head: `${this.owner}:${head}`,
      base,
      state: "all",
      per_page: 100,
    });
    const open = prior.data.find((p) => p.state === "open");
    if (open) return { number: open.number, url: open.html_url };

    // A merged or closed PR does not count as "the PR for this branch". A run
    // that keeps merging tasks after its rollup PR was merged used to find that
    // merged PR here and conclude there was nothing to do — stranding the new
    // commits with no PR at all (marrymath run 7c0599b0). Whether the branch
    // holds anything the base lacks is GitHub's call: try to create, and let
    // the "no commits between" 422 say otherwise.
    try {
      const created = await this.createPR(runId, taskId, head, base, title, body, opts?.draft ?? false);
      return { ...created, fresh: true };
    } catch (e) {
      if (isNoCommitsError(e)) {
        const last = prior.data[0];
        return last ? { number: last.number, url: last.html_url } : null;
      }
      throw e;
    }
  }

  private async createPR(runId: string, taskId: string, head: string, base: string, title: string, body: string, draft: boolean): Promise<PrRef> {
    try {
      const res = await this.octokit!.rest.pulls.create({
        owner: this.owner,
        repo: this.repo,
        title,
        head,
        base,
        draft,
        body: `${body}\n\n${this.marker(runId, `pr-${taskId}`)}`,
      });
      return { number: res.data.number, url: res.data.html_url };
    } catch (e) {
      // Free-plan private repos reject drafts outright. An open PR beats no PR;
      // the mid-run merge hazard the draft guards against is the rarer failure.
      if (draft && isDraftUnsupportedError(e)) return this.createPR(runId, taskId, head, base, title, body, false);
      throw e;
    }
  }

  /**
   * Flip a draft PR to ready-for-review, refreshing its title and body on the
   * way — a draft was written mid-run and predates the final task list and the
   * intent verdict. Non-draft or non-open PRs are left exactly as they are: a
   * human may own them by now. Returns whether this call changed anything.
   * (REST cannot clear draft status; that one mutation is GraphQL-only.)
   */
  async markPrReady(runId: string, taskId: string, prNumber: number, title: string, body: string): Promise<boolean> {
    if (!this.octokit) return false;
    const { data } = await this.octokit.rest.pulls.get({ owner: this.owner, repo: this.repo, pull_number: prNumber });
    if (data.state !== "open" || !data.draft) return false;
    await this.octokit.rest.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      title,
      body: `${body}\n\n${this.marker(runId, `pr-${taskId}`)}`,
    });
    await this.octokit.graphql(
      `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number } } }`,
      { id: data.node_id }
    );
    return true;
  }

  /** Where a PR ended up. `null` when GitHub is off or the PR cannot be read. */
  async prState(prNumber: number): Promise<"open" | "draft" | "merged" | "closed" | null> {
    if (!this.octokit) return null;
    const data = await this.octokit.rest.pulls
      .get({ owner: this.owner, repo: this.repo, pull_number: prNumber })
      .then((r) => r.data)
      .catch(() => null);
    if (!data) return null;
    if (data.merged_at) return "merged";
    return data.state === "open" ? (data.draft ? "draft" : "open") : "closed";
  }

  /**
   * Close a pull request, leaving a comment saying why. Only open PRs are
   * touched: a merged PR cannot be closed, and one a human already closed
   * carries their decision, not ours. Returns whether this call closed it.
   */
  async closePR(prNumber: number, comment: string): Promise<boolean> {
    if (!this.octokit) return false;
    const { data } = await this.octokit.rest.pulls.get({ owner: this.owner, repo: this.repo, pull_number: prNumber });
    if (data.state !== "open") return false;
    await this.octokit.rest.issues.createComment({ owner: this.owner, repo: this.repo, issue_number: prNumber, body: comment });
    await this.octokit.rest.pulls.update({ owner: this.owner, repo: this.repo, pull_number: prNumber, state: "closed" });
    return true;
  }
}

/**
 * The `owner/repo` this checkout pushes to, read from its `origin` remote.
 *
 * The dashboard needs a slug to turn "issue #28" into a link, and the run config is
 * not a reliable place to get one: a run started before the slug was persisted, or
 * before `gh auth login` was run, carries no slug at all — and its issue and PR
 * chips then render as dead plain text even though the issues plainly exist.
 *
 * Only github.com is matched. A GitHub Enterprise remote would otherwise be linked
 * to the wrong host, which is worse than no link.
 */
export async function originSlug(repoPath: string): Promise<string | null> {
  const url = await git(repoPath, ["remote", "get-url", "origin"]).catch(() => "");
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * GitHub reports "no commits between base and head" as a generic 422 validation
 * failure, distinguishable only by its message. Everything else — bad token,
 * protected branch, missing ref — must still surface.
 */
export function isNoCommitsError(e: unknown): boolean {
  return is422Matching(e, /no commits between/i);
}

/** Draft PRs are a paid feature on private repos; GitHub says so with a 422. */
export function isDraftUnsupportedError(e: unknown): boolean {
  return is422Matching(e, /draft pull requests are not supported/i);
}

function is422Matching(e: unknown, pattern: RegExp): boolean {
  const status = (e as { status?: number })?.status;
  if (status !== 422) return false;
  const errors = (e as { response?: { data?: { errors?: { message?: string }[] } } })?.response?.data?.errors ?? [];
  const text = `${(e as Error)?.message ?? ""} ${errors.map((x) => x.message ?? "").join(" ")}`;
  return pattern.test(text);
}
