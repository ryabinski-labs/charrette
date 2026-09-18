import { Octokit } from "octokit";
import { git } from "./git.js";

/** A PR that exists on GitHub, whether this call opened it or a previous one did. */
/** The repo's own verdict on a pull request's head commit. */
export interface PrChecks {
  state: "passing" | "failing" | "pending" | "none";
  /** Names of the checks that failed, for the operator to go and read. */
  failing: string[];
  total: number;
  /**
   * Every check run and status context the commit carried when it was read —
   * skipped and neutral ones included, which `total` leaves out.
   *
   * This is what lets a caller tell a settled answer from an incomplete one.
   * A re-run drops a workflow's check runs out of GitHub's answer for the
   * moment before it re-attaches them, and the checks left behind — the ones
   * that had already passed — read, correctly and uselessly, as `passing`.
   * Names are stable across that gap where a count is not: a job that ends up
   * `skipped` leaves `total` and stays here.
   *
   * Optional only so an adapter that reads a verdict and nothing else (the
   * test fakes) still satisfies the type; `checksForRef` always fills it.
   */
  names?: string[];
  /**
   * The commit the answer is about — the pull request's head when read through
   * `prChecks`. What `names` are compared against is the last answer for the
   * *same* commit: a new head can honestly carry a different set of checks
   * (a path-filtered workflow), and only the same head cannot lose one.
   */
  sha?: string;
  /** Only explicit successes; skipped/neutral/missing checks never enter this set. */
  successful?: string[];
  /** At least one GitHub check surface could not be read. Never release evidence. */
  unavailable?: boolean;
}

export interface PrRef {
  number: number;
  url: string;
  /** Set when this very call created the PR, rather than finding one already there. */
  fresh?: boolean;
}

/** Stamped on every comment the charrette writes, so it never reads its own back. */
const CHARRETTE_COMMENT_MARKER = "<!-- charrette-comment -->";

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
 * When no token/repo is configured the charrette runs local-only and all methods no-op.
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

  /** Called only under the run's explicit automatic-merge authority. SHA is a CAS guard. */
  async mergeApprovedPR(prNumber: number, head: string, base: string, expectedSha: string): Promise<boolean> {
    if (!this.octokit || !expectedSha) return false;
    const args = { owner: this.owner, repo: this.repo, pull_number: prNumber };
    const pr = await this.octokit.rest.pulls.get(args).then((r) => r.data).catch(() => null);
    if (!pr || pr.state !== "open" || pr.draft || pr.head.ref !== head || pr.base.ref !== base || pr.head.sha !== expectedSha) return false;
    if (pr.head.repo?.full_name !== `${this.owner}/${this.repo}`) return false;
    return this.octokit.rest.pulls.merge({ ...args, sha: expectedSha, merge_method: "merge" })
      .then((r) => r.data.merged).catch(() => false);
  }

  private marker(runId: string, id: string): string {
    return `<!-- charrette-run:${runId}/${id} -->`;
  }

  /** Scopes every issue a run files, so they can be listed back exactly. */
  private runLabel(runId: string): string {
    return `charrette-run:${runId}`;
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
      const m = /<!-- charrette-run:[^/]+\/([^ ]+) -->/.exec(item.body ?? "");
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
    // The cached copy is deliberately not `fresh`: this call opened the issue,
    // the next call that finds it in the cache did not.
    issues.set(marker, ref);
    return { ...ref, fresh: true };
  }

  /**
   * Every comment on an issue the charrette filed, oldest first.
   *
   * The charrette used to write issues and never read them, so an operator who
   * answered a stuck task in its issue thread — the most natural place to
   * answer it — was talking to nobody. This is the read half.
   *
   * Comments the charrette wrote itself are excluded by id, not by author: the
   * token may well be the operator's own, and dropping everything that account
   * said would drop exactly the words we came for.
   */
  async issueComments(issueNumber: number): Promise<{ id: number; author: string; body: string }[]> {
    if (!this.octokit) return [];
    const items = await this.octokit
      .paginate(this.octokit.rest.issues.listComments, { owner: this.owner, repo: this.repo, issue_number: issueNumber, per_page: 100 })
      .catch(() => []);
    return items
      .filter((c) => !(c.body ?? "").includes(CHARRETTE_COMMENT_MARKER))
      .map((c) => ({ id: c.id, author: c.user?.login ?? "someone", body: (c.body ?? "").trim() }))
      .filter((c) => c.body.length > 0);
  }

  /**
   * Read any issue or pull request — this repo's or another one the token can
   * see — as title, body, labels and thread.
   *
   * The charrette wrote to GitHub from the beginning and only ever read back the
   * threads it started itself. But an operator's opening sentence is routinely
   * "implement ryabinski-labs/agentdraft#480": the specification is already
   * written, on GitHub, and this process is holding a token that can fetch it.
   * With no tool for it the intake agent had one move left — ask the operator to
   * paste the issue back at it — which is a strange thing for a charrette that
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
          // The charrette's own status comments are not part of the specification.
          if ((c.body ?? "").includes(CHARRETTE_COMMENT_MARKER)) continue;
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
   * Keyed rather than unconditional because every status the charrette has to say
   * is replayable: a resumed run re-walks the same terminal states, and an issue
   * that collects "merged" three times is noise an operator has to read past.
   * The charrette marker goes on too, so `issueComments` never reads this back as
   * an operator answer — the run would otherwise take its own status update as
   * guidance and hand it to the next worker.
   *
   * Returns whether this call wrote the comment.
   */
  async commentOnIssue(issueNumber: number, key: string, body: string): Promise<boolean> {
    if (!this.octokit) return false;
    const marker = `<!-- charrette-status:${key} -->`;
    const existing = await this.octokit
      .paginate(this.octokit.rest.issues.listComments, { owner: this.owner, repo: this.repo, issue_number: issueNumber, per_page: 100 })
      .catch(() => []);
    if (existing.some((c) => (c.body ?? "").includes(marker))) return false;
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body: `${body}\n\n${CHARRETTE_COMMENT_MARKER}\n${marker}`,
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
    // Bounded once, here, so both paths below send a body GitHub will take.
    // The update path has always survived a refusal (`refreshPrBody`); the
    // create path could not, and a 422 there costs the entire pull request —
    // and, because every gate downstream keys off the PR number, the CI hold
    // behind it. ledger-app a8df0107 merged 127 tasks, was refused a body 19,555
    // characters over the limit, and walked to PR_REVIEW over a branch nothing
    // had ever checked with `holdUntilGreen` on.
    const fitted = fitPrBody(body, runId, MAX_PR_BODY - this.marker(runId, `pr-${taskId}`).length - 2);
    const prior = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      head: `${this.owner}:${head}`,
      base,
      state: "all",
      per_page: 100,
    });
    const open = prior.data.find((p) => p.state === "open");
    if (open) {
      await this.refreshPrBody(runId, taskId, open.number, open.body ?? "", fitted);
      return { number: open.number, url: open.html_url };
    }

    // A merged or closed PR does not count as "the PR for this branch". A run
    // that keeps merging tasks after its rollup PR was merged used to find that
    // merged PR here and conclude there was nothing to do — stranding the new
    // commits with no PR at all (marrymath run 7c0599b0). Whether the branch
    // holds anything the base lacks is GitHub's call: try to create, and let
    // the "no commits between" 422 say otherwise.
    try {
      const created = await this.createPR(runId, taskId, head, base, title, fitted, opts?.draft ?? false);
      return { ...created, fresh: true };
    } catch (e) {
      if (isNoCommitsError(e)) {
        const last = prior.data[0];
        return last ? { number: last.number, url: last.html_url } : null;
      }
      // `fitted` was measured in UTF-16 units and GitHub counts characters, so
      // a body can clear our arithmetic and fail theirs. Half the limit clears
      // it by any counting. A description is worth retrying for; it is not
      // worth the pull request, which is what throwing here spends.
      if (isBodyTooLongError(e)) {
        const created = await this.createPR(runId, taskId, head, base, title, fitPrBody(fitted, runId, MAX_PR_BODY / 2), opts?.draft ?? false);
        return { ...created, fresh: true };
      }
      throw e;
    }
  }

  /**
   * Write a recomputed body back onto a PR this run already opened.
   *
   * The body is derived from the live task list, and that list grows: a task
   * merged after the PR was opened contributes its own `Closes #n`. Returning
   * the existing PR without writing the new body back froze it at whatever the
   * first INTEGRATING pass computed, and every issue for a task merged later
   * survived the merge that shipped it. Revetment run bc691359 is the worked
   * example — rollup PR #334 opened 2026-08-22 carrying closing refs up to
   * #333, merged 2026-08-30 having also shipped tasks #335-#423, and left 79
   * finished issues open for a human to close by hand. `markPrReady` refreshed
   * the body on the way out of draft, which is why the bug only bites a run
   * that keeps merging after its PR is ready.
   *
   * Only a body this run still owns is rewritten. The marker is the proof of
   * ownership: a human who has taken the PR over and written their own summary
   * drops it, and their prose outranks ours. The title is left alone for the
   * same reason — nothing about it goes stale the way the task list does.
   */
  private async refreshPrBody(runId: string, taskId: string, prNumber: number, current: string, body: string): Promise<void> {
    const marker = this.marker(runId, `pr-${taskId}`);
    if (!current.includes(marker)) return;
    const next = `${body}\n\n${marker}`;
    if (current === next) return;
    // A refused body write is not a pull request that failed to open. Until this
    // call existed the already-open path could not fail at all, and everything
    // `openRunPr` does after `ensurePR` returns — flipping the draft ready,
    // pointing every merged task at the PR number, publishing `github.pr_opened`
    // — is what keeps `hasRecoverableWork`, the dashboard chips and `status`
    // truthful. Throwing would trade all of that for a description, and the
    // caller would log "the pull request could not be opened" about a PR that is
    // open. It is also the cheapest thing in the run to retry: every INTEGRATING
    // pass recomputes and rewrites the body, and `markPrReady` writes it once
    // more on the way out of draft.
    await this.octokit!.rest.pulls.update({ owner: this.owner, repo: this.repo, pull_number: prNumber, body: next }).catch(() => undefined);
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
    const marker = this.marker(runId, `pr-${taskId}`);
    await this.octokit.rest.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      title,
      body: `${fitPrBody(body, runId, MAX_PR_BODY - marker.length - 2)}\n\n${marker}`,
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
   * Ask Actions to re-run the failed jobs on this pull request's head commit.
   *
   * The cheapest possible answer to a red check is that it was never really
   * red: a serialized self-hosted runner, a network blip, a container that
   * lost a race. Asked once before any fix task is queued, because a task
   * spawned against a flake "fixes" code that was never broken and the diff it
   * produces is pure noise. Returns whether any re-run was actually requested
   * — commit statuses from external CI have nothing to re-run, and a `false`
   * tells the caller to diagnose the failure as it stands.
   */
  async rerunFailedChecks(prNumber: number): Promise<boolean> {
    if (!this.octokit) return false;
    const pr = await this.octokit.rest.pulls
      .get({ owner: this.owner, repo: this.repo, pull_number: prNumber })
      .then((r) => r.data)
      .catch(() => null);
    if (!pr) return false;
    const runs = await this.octokit.rest.actions
      .listWorkflowRunsForRepo({ owner: this.owner, repo: this.repo, head_sha: pr.head.sha, per_page: 100 })
      .then((r) => r.data.workflow_runs)
      .catch(() => [] as { id: number; conclusion: string | null }[]);
    let reran = 0;
    for (const run of runs) {
      // The same set `checksForRef` reads as red. "cancelled" and
      // "action_required" are here for the same reason they are there: neither
      // is a green branch, and both can be a runner's bad day.
      if (!run.conclusion || !["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(run.conclusion)) continue;
      const ok = await this.octokit.rest.actions
        .reRunWorkflowFailedJobs({ owner: this.owner, repo: this.repo, run_id: run.id })
        .then(() => true)
        // A workflow that failed before any job started (a bad `services:`
        // block, a syntax error) has no failed jobs to re-run and GitHub
        // refuses. That is a real answer: nothing about this failure is flake.
        .catch(() => false);
      if (ok) reran++;
    }
    return reran > 0;
  }

  /**
   * The failing jobs on this pull request's head commit, each with the tail of
   * its own log.
   *
   * This is what turns "CI is red: Backend (Go) vet + test" into a task an
   * agent can act on: the log carries the failing assertion, the coverage
   * number, the missing binary — the thing the fix is actually about. Only the
   * tail is kept: a Go test log is megabytes of pass lines and the verdict is
   * at the bottom.
   *
   * Best-effort by design. Jobs from external CI have no Actions log, a log
   * can expire, and the API can refuse — every failure here degrades to a
   * name with no log rather than an error, because "fix this check, log
   * unavailable" is still a workable task and a crash here is not.
   */
  async failingJobLogs(prNumber: number): Promise<{ name: string; log: string }[]> {
    if (!this.octokit) return [];
    const pr = await this.octokit.rest.pulls
      .get({ owner: this.owner, repo: this.repo, pull_number: prNumber })
      .then((r) => r.data)
      .catch(() => null);
    if (!pr) return [];
    const runs = await this.octokit.rest.actions
      .listWorkflowRunsForRepo({ owner: this.owner, repo: this.repo, head_sha: pr.head.sha, per_page: 100 })
      .then((r) => r.data.workflow_runs)
      .catch(() => [] as { id: number; conclusion: string | null }[]);
    const out: { name: string; log: string }[] = [];
    for (const run of runs) {
      if (!run.conclusion || run.conclusion === "success" || run.conclusion === "skipped" || run.conclusion === "neutral") continue;
      const jobs = await this.octokit.rest.actions
        .listJobsForWorkflowRun({ owner: this.owner, repo: this.repo, run_id: run.id, per_page: 100 })
        .then((r) => r.data.jobs)
        .catch(() => [] as { id: number; name: string; conclusion: string | null }[]);
      for (const job of jobs) {
        if (job.conclusion !== "failure" && job.conclusion !== "timed_out" && job.conclusion !== "startup_failure") continue;
        const log = await this.octokit.rest.actions
          .downloadJobLogsForWorkflowRun({ owner: this.owner, repo: this.repo, job_id: job.id })
          .then((r) => String(r.data ?? ""))
          .catch(() => "");
        out.push({ name: job.name, log: tailOfLog(log) });
      }
    }
    return out;
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

  /**
   * Whether GitHub can merge this pull request into its base.
   *
   * Not the same question as `prChecks`, and the one nothing here used to ask.
   * CI judges the head commit in isolation; mergeability is about the head and
   * the base *together*, and a base that moved under a long run makes the pull
   * request unmergeable without turning a single check red. That is how run
   * 5743ce85 reported a conflicting #834 as ready for review.
   *
   * `mergeable` is computed by GitHub in the background, so it is `null` for a
   * few seconds after a push or an open. "unknown" is therefore a real, ordinary
   * state and not an error — the caller polls it the way it polls a pending
   * check, and must never read it as a pass.
   *
   * "behind" is `mergeable: true` with `mergeable_state: "behind"`: no conflict,
   * but the base has moved since the branch was cut and a protection rule that
   * requires branches to be up to date will refuse the merge button. It used to
   * read as mergeable here, which is true of the diff and false of the pull
   * request. It is its own state because the remedy is the charrette's own base
   * merge, not a person's. Every other `mergeable_state` a true `mergeable`
   * can carry — `clean`, `blocked` (a review this charrette will never give),
   * `unstable`, `has_hooks` — is mergeable for this purpose.
   *
   * `null` means GitHub is off or the pull request could not be read, which is
   * different again: nothing was learned at all.
   */
  async prMergeable(prNumber: number): Promise<{ state: "mergeable" | "conflicting" | "behind" | "unknown"; mergeStateStatus: string } | null> {
    if (!this.octokit) return null;
    const data = await this.octokit.rest.pulls
      .get({ owner: this.owner, repo: this.repo, pull_number: prNumber })
      .then((r) => r.data)
      .catch(() => null);
    if (!data) return null;
    // A merged or closed pull request has no merge to compute, and GitHub
    // reports `mergeable: null` for both forever. Polling one is a timeout
    // waiting to happen, so answer from the state instead.
    if (data.merged_at) return { state: "mergeable", mergeStateStatus: "merged" };
    const status = data.mergeable_state ?? "unknown";
    if (data.mergeable === true) return { state: status === "behind" ? "behind" : "mergeable", mergeStateStatus: status };
    if (data.mergeable === false) return { state: "conflicting", mergeStateStatus: status };
    // `null` is GitHub still computing, and is worth waiting on. The field being
    // absent entirely is not the same thing and must not be polled: a response
    // that never carries `mergeable` will never start carrying it, so treating
    // the two alike spends the whole settle window learning nothing. `null` is
    // what a single-pull-request GET always returns while the background job
    // runs; absent is a response that is not one.
    if (!("mergeable" in data)) return null;
    return { state: "unknown", mergeStateStatus: status };
  }

  /** The combined verdict of every check and status attached to one commit. */
  async checksForRef(ref: string): Promise<PrChecks | null> {
    if (!this.octokit) return null;
    let unavailable = false;
    const runs = await this.octokit
      .paginate(this.octokit.rest.checks.listForRef, { owner: this.owner, repo: this.repo, ref, per_page: 100 })
      .catch(() => { unavailable = true; return [] as { name: string; status: string; conclusion: string | null }[]; });
    const combined = await this.octokit.rest.repos
      .getCombinedStatusForRef({ owner: this.owner, repo: this.repo, ref })
      .then((r) => r.data)
      .catch(() => { unavailable = true; return null; });

    // "cancelled" and "action_required" are failures for this purpose: neither
    // is a green branch, and reporting them as pending would wait forever.
    const BAD = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
    const failing: string[] = [];
    const names: string[] = [];
    const successful: string[] = [];
    let pending = 0;
    let total = 0;
    for (const c of runs) {
      names.push(c.name);
      if (c.status === "completed" && c.conclusion === "success") successful.push(c.name);
      // Skipped and neutral checks are deliberate non-answers, not results.
      if (c.status === "completed" && (c.conclusion === "skipped" || c.conclusion === "neutral")) continue;
      total++;
      if (c.status !== "completed") pending++;
      else if (c.conclusion && BAD.has(c.conclusion)) failing.push(c.name);
    }
    for (const s of combined?.statuses ?? []) {
      names.push(s.context);
      if (s.state === "success") successful.push(s.context);
      total++;
      if (s.state === "pending") pending++;
      else if (s.state === "failure" || s.state === "error") failing.push(s.context);
    }
    const evidence = { successful, ...(unavailable ? { unavailable: true } : {}) };
    if (!total) return { state: "none", failing: [], total: 0, names, sha: ref, ...evidence };
    // A failure with other checks still pending is not yet the whole answer —
    // only report "failing" once nothing is left running. The shared runner run 428d77f8
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
    if (failing.length && !pending) return { state: "failing", failing, total, names, sha: ref, ...evidence };
    return { state: pending ? "pending" : "passing", failing: [], total, names, sha: ref, ...evidence };
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
    await this.octokit.rest.issues.createComment({ owner: this.owner, repo: this.repo, issue_number: prNumber, body: `${comment}\n\n${CHARRETTE_COMMENT_MARKER}` });
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
/**
 * The last stretch of a CI job's log — where the verdict lives. Bounded in
 * both lines and bytes so a task spec carrying three of these stays a spec.
 */
export function tailOfLog(log: string, lines = 120, bytes = 8_000): string {
  const tail = log.split("\n").slice(-lines).join("\n");
  return tail.length > bytes ? tail.slice(-bytes) : tail;
}

/** GitHub's hard limit on a pull request or issue body. */
export const MAX_PR_BODY = 65_536;

/**
 * Cut a body down to something GitHub will accept, keeping the top.
 *
 * The top is the part that has to survive. The rollup body is written summary
 * first — the merged task list with its `closes #n` refs, then the intent
 * verdict, then the draft-hold explanations — so a reviewer who reads only the
 * first screen has read the run, and the refs that close the run's issues are
 * never the thing that gets dropped. What gets dropped is the tail of the
 * longest enumeration, and the notice says where the whole of it lives: the
 * run's own report, written to disk, subject to nobody's character limit.
 *
 * Never cuts mid-line. A truncated markdown list item renders as prose, and a
 * half-sentence about a criterion QA could not settle reads as a finding
 * rather than as a fragment.
 *
 * This is the last line of defence, not the first: a caller that assembles a
 * body out of per-task records bounds its own lists, because "the more the run
 * built, the less of it this describes" is a poor way to report a large run.
 */
export function fitPrBody(body: string, runId: string, limit = MAX_PR_BODY): string {
  if (body.length <= limit) return body;
  const notice = `\n\n…truncated: this body hit GitHub's 65,536-character limit. The full list is in \`.charrette/${runId}/REPORT.md\`.`;
  const head = body.slice(0, Math.max(0, limit - notice.length));
  const nl = head.lastIndexOf("\n");
  return `${nl > 0 ? head.slice(0, nl) : head}${notice}`;
}

export function isNoCommitsError(e: unknown): boolean {
  return is422Matching(e, /no commits between/i);
}

/** Draft PRs are a paid feature on private repos; GitHub says so with a 422. */
export function isDraftUnsupportedError(e: unknown): boolean {
  return is422Matching(e, /draft pull requests are not supported/i);
}

/**
 * GitHub's refusal of an oversized body.
 *
 * The backstop, not the bound — `fitPrBody` is the bound. This exists because
 * the two do not count the same thing: GitHub counts characters, this process
 * counts UTF-16 units, and an emoji in a task title makes them disagree. A body
 * that fits by our arithmetic and not by theirs must not cost the whole pull
 * request, which is exactly what it cost ledger-app a8df0107.
 */
export function isBodyTooLongError(e: unknown): boolean {
  return is422Matching(e, /body is too long/i);
}

function is422Matching(e: unknown, pattern: RegExp): boolean {
  const status = (e as { status?: number })?.status;
  if (status !== 422) return false;
  const errors = (e as { response?: { data?: { errors?: { message?: string }[] } } })?.response?.data?.errors ?? [];
  const text = `${(e as Error)?.message ?? ""} ${errors.map((x) => x.message ?? "").join(" ")}`;
  return pattern.test(text);
}
