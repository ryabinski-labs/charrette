import { Octokit } from "octokit";
import { git } from "./git.js";

/** A PR that exists on GitHub, whether this call opened it or a previous one did. */
/** The repo's own verdict on a pull request's head commit. */
export interface PrChecks {
  state: "passing" | "failing" | "pending" | "none";
  /** Names of the checks that failed, for the operator to go and read. */
  failing: string[];
  total: number;
}

export interface PrRef {
  number: number;
  url: string;
  /** Set when this very call created the PR, rather than finding one already there. */
  fresh?: boolean;
}

/** Stamped on every comment the harness writes, so it never reads its own back. */
const HARNESS_COMMENT_MARKER = "<!-- harness-comment -->";

/** An issue or pull request as the operator would read it, thread included. */
export interface IssueRead {
  /** owner/repo it was actually fetched from, which may not be the run's. */
  slug: string;
  number: number;
  url: string;
  title: string;
  state: string;
  author: string;
  labels: string[];
  body: string;
  comments: { author: string; body: string }[];
  /** Comments left on GitHub because the thread ran past what is worth carrying. */
  omittedComments: number;
}

/**
 * How much of a thread comes back.
 *
 * Long enough for a specification and the discussion that settled it; short
 * enough that reading an issue cannot swallow the conversation that asked for
 * it. octocat/Hello-World#1 — the first widely-referenced public issue tried
 * against this — has 2,500 comments, which is 275,000 characters, about 69,000
 * tokens, and 7.8 seconds of paging. That is not an exotic case: threads that
 * long are exactly what accumulates on the issues people ask for help with, and
 * an intake agent gets 60 turns with everything it has read sitting in the
 * cached prefix of every one of them.
 */
const THREAD_PAGE_CAP = 3;
const THREAD_BUDGET_CHARS = 40_000;

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
   * Every comment on an issue the harness filed, oldest first.
   *
   * The harness used to write issues and never read them, so an operator who
   * answered a stuck task in its issue thread — the most natural place to
   * answer it — was talking to nobody. This is the read half.
   *
   * Comments the harness wrote itself are excluded by id, not by author: the
   * token may well be the operator's own, and dropping everything that account
   * said would drop exactly the words we came for.
   */
  async issueComments(issueNumber: number): Promise<{ id: number; author: string; body: string }[]> {
    if (!this.octokit) return [];
    const items = await this.octokit
      .paginate(this.octokit.rest.issues.listComments, { owner: this.owner, repo: this.repo, issue_number: issueNumber, per_page: 100 })
      .catch(() => []);
    return items
      .filter((c) => !(c.body ?? "").includes(HARNESS_COMMENT_MARKER))
      .map((c) => ({ id: c.id, author: c.user?.login ?? "someone", body: (c.body ?? "").trim() }))
      .filter((c) => c.body.length > 0);
  }

  /**
   * Read any issue or pull request — this repo's or another one the token can
   * see — as title, body, labels and thread.
   *
   * The harness wrote to GitHub from the beginning and only ever read back the
   * threads it started itself. But an operator's opening sentence is routinely
   * "implement ryabinski-labs/agentdraft#480": the specification is already
   * written, on GitHub, and this process is holding a token that can fetch it.
   * With no tool for it the intake agent had one move left — ask the operator to
   * paste the issue back at it — which is a strange thing for a harness that
   * files issues to be doing.
   *
   * `null` when GitHub is not configured, or the issue does not exist, or the
   * token cannot see it. The caller says which rather than inventing contents.
   */
  async readIssue(number: number, slug?: string): Promise<IssueRead | null> {
    if (!this.octokit) return null;
    const [owner, repo] = slug?.includes("/") ? (slug.split("/") as [string, string]) : [this.owner, this.repo];
    const issue = await this.octokit.rest.issues
      .get({ owner, repo, issue_number: number })
      .then((r) => r.data)
      .catch(() => null);
    if (!issue) return null;
    const { comments, omitted } = await this.thread(owner, repo, number, issue.comments ?? 0);
    return {
      slug: `${owner}/${repo}`,
      number: issue.number,
      url: issue.html_url,
      title: issue.title,
      state: issue.state,
      author: issue.user?.login ?? "someone",
      labels: issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter((l) => l.length > 0),
      body: (issue.body ?? "").trim(),
      comments,
      omittedComments: omitted,
    };
  }

  /**
   * The readable part of an issue's thread, oldest first, and a count of what
   * was left behind.
   *
   * Paged rather than aggregated so a thread with twenty-five pages costs three
   * requests instead of twenty-five, and stopped on a character budget as well,
   * because a hundred comments can be as long as a thousand. `total` is GitHub's
   * own count of the thread, which is what makes "and 2,488 more" honest.
   */
  private async thread(
    owner: string,
    repo: string,
    number: number,
    total: number
  ): Promise<{ comments: { author: string; body: string }[]; omitted: number }> {
    const kept: { author: string; body: string }[] = [];
    let seen = 0;
    let chars = 0;
    try {
      const pages = this.octokit!.paginate.iterator(this.octokit!.rest.issues.listComments, {
        owner,
        repo,
        issue_number: number,
        per_page: 100,
      });
      let page = 0;
      for await (const { data } of pages) {
        for (const c of data) {
          seen++;
          // The harness's own status comments are not part of the specification.
          if ((c.body ?? "").includes(HARNESS_COMMENT_MARKER)) continue;
          const body = (c.body ?? "").trim();
          if (!body) continue;
          if (chars + body.length > THREAD_BUDGET_CHARS) {
            return { comments: kept, omitted: Math.max(total, seen) - seen + 1 };
          }
          chars += body.length;
          kept.push({ author: c.user?.login ?? "someone", body });
        }
        if (++page >= THREAD_PAGE_CAP) break;
      }
    } catch {
      // A thread that cannot be read is not a reason to withhold the issue.
      return { comments: kept, omitted: Math.max(total - seen, 0) };
    }
    return { comments: kept, omitted: Math.max(total - seen, 0) };
  }

  /**
   * Write a status comment on an issue, once per `key`.
   *
   * Keyed rather than unconditional because every status the harness has to say
   * is replayable: a resumed run re-walks the same terminal states, and an issue
   * that collects "merged" three times is noise an operator has to read past.
   * The harness marker goes on too, so `issueComments` never reads this back as
   * an operator answer — the run would otherwise take its own status update as
   * guidance and hand it to the next worker.
   *
   * Returns whether this call wrote the comment.
   */
  async commentOnIssue(issueNumber: number, key: string, body: string): Promise<boolean> {
    if (!this.octokit) return false;
    const marker = `<!-- harness-status:${key} -->`;
    const existing = await this.octokit
      .paginate(this.octokit.rest.issues.listComments, { owner: this.owner, repo: this.repo, issue_number: issueNumber, per_page: 100 })
      .catch(() => []);
    if (existing.some((c) => (c.body ?? "").includes(marker))) return false;
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body: `${body}\n\n${HARNESS_COMMENT_MARKER}\n${marker}`,
    });
    return true;
  }

  /**
   * Close an issue the run is finished with. An issue that is already closed is
   * left alone — whoever closed it, human or the merge of a "Closes #n" PR, has
   * said something we would only be overwriting. Returns whether this call
   * closed it.
   */
  async closeIssue(issueNumber: number, reason: "completed" | "not_planned"): Promise<boolean> {
    if (!this.octokit) return false;
    const { data } = await this.octokit.rest.issues.get({ owner: this.owner, repo: this.repo, issue_number: issueNumber });
    if (data.state !== "open") return false;
    await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      state: "closed",
      state_reason: reason,
    });
    return true;
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
   * What the repo's own CI says about a pull request's head commit.
   *
   * Both surfaces are read: check runs (GitHub Actions, most apps) and the older
   * commit statuses (many external CI providers still only write those). A repo
   * that uses one and not the other would otherwise look like it has no CI at
   * all, which reads as "nothing to wait for" rather than "not checked".
   *
   * `null` means GitHub is off or the pull request could not be read — that is
   * not the same as "no checks", and callers must not treat it as a pass.
   */
  async prChecks(prNumber: number): Promise<PrChecks | null> {
    if (!this.octokit) return null;
    const pr = await this.octokit.rest.pulls
      .get({ owner: this.owner, repo: this.repo, pull_number: prNumber })
      .then((r) => r.data)
      .catch(() => null);
    if (!pr) return null;
    return this.checksForRef(pr.head.sha);
  }

  /**
   * The commit a merged pull request landed as, or `null` if it is not merged.
   * That commit is where the base branch's own workflows run — the deploy the
   * merge triggered — so it is what "did this actually ship?" is asked about.
   */
  async mergedSha(prNumber: number): Promise<string | null> {
    if (!this.octokit) return null;
    const data = await this.octokit.rest.pulls
      .get({ owner: this.owner, repo: this.repo, pull_number: prNumber })
      .then((r) => r.data)
      .catch(() => null);
    if (!data?.merged_at) return null;
    return data.merge_commit_sha ?? null;
  }

  /** The combined verdict of every check and status attached to one commit. */
  async checksForRef(ref: string): Promise<PrChecks | null> {
    if (!this.octokit) return null;
    const runs = await this.octokit
      .paginate(this.octokit.rest.checks.listForRef, { owner: this.owner, repo: this.repo, ref, per_page: 100 })
      .catch(() => [] as { name: string; status: string; conclusion: string | null }[]);
    const combined = await this.octokit.rest.repos
      .getCombinedStatusForRef({ owner: this.owner, repo: this.repo, ref })
      .then((r) => r.data)
      .catch(() => null);

    // "cancelled" and "action_required" are failures for this purpose: neither
    // is a green branch, and reporting them as pending would wait forever.
    const BAD = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
    const failing: string[] = [];
    let pending = 0;
    let total = 0;
    for (const c of runs) {
      // Skipped and neutral checks are deliberate non-answers, not results.
      if (c.status === "completed" && (c.conclusion === "skipped" || c.conclusion === "neutral")) continue;
      total++;
      if (c.status !== "completed") pending++;
      else if (c.conclusion && BAD.has(c.conclusion)) failing.push(c.name);
    }
    for (const s of combined?.statuses ?? []) {
      total++;
      if (s.state === "pending") pending++;
      else if (s.state === "failure" || s.state === "error") failing.push(s.context);
    }
    if (!total) return { state: "none", failing: [], total: 0 };
    // A failure with other checks still pending is not yet the whole answer —
    // only report "failing" once nothing is left running. web-app run 428d77f8
    // reported "CI is red: Frontend" the moment that one job failed, while
    // Backend/E2E/Android hadn't even started on the repo's single, serialized
    // self-hosted runner; they went on to fail too, minutes later, and the
    // operator only learned that by checking GitHub directly. `settleChecks`
    // (runController.ts) stops polling as soon as this returns anything but
    // "pending", so reporting "failing" here while checks remain in flight
    // silently truncates the operator's picture to whichever check happened to
    // finish first — exactly the false confidence `awaitChecks`'s "a timeout is
    // reported as pending, never as a pass" rule exists to prevent, just from
    // the other direction.
    if (failing.length && !pending) return { state: "failing", failing, total };
    return { state: pending ? "pending" : "passing", failing: [], total };
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
    await this.octokit.rest.issues.createComment({ owner: this.owner, repo: this.repo, issue_number: prNumber, body: `${comment}\n\n${HARNESS_COMMENT_MARKER}` });
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
