import { Octokit } from "octokit";

/**
 * GitHub adapter (PRD §11.1): the only module that talks to GitHub. Every write is
 * idempotent via a deterministic marker in the body, so crash-replays never duplicate.
 * When no token/repo is configured the harness runs local-only and all methods no-op.
 */
export class GitHubAdapter {
  private octokit: Octokit | null;
  private owner = "";
  private repo = "";

  constructor(token: string | undefined, repoSlug: string | undefined) {
    if (token && repoSlug && repoSlug.includes("/")) {
      const [owner, repo] = repoSlug.split("/");
      this.owner = owner!;
      this.repo = repo!;
      this.octokit = new Octokit({ auth: token });
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

  private async findByMarker(marker: string): Promise<number | null> {
    if (!this.octokit) return null;
    const q = `repo:${this.owner}/${this.repo} in:body "${marker}"`;
    const res = await this.octokit.rest.search.issuesAndPullRequests({ q });
    return res.data.items[0]?.number ?? null;
  }

  async ensureIssue(runId: string, id: string, title: string, body: string, labels: string[]): Promise<{ number: number; url: string } | null> {
    if (!this.octokit) return null;
    const marker = this.marker(runId, id);
    const existing = await this.findByMarker(marker);
    if (existing) return { number: existing, url: `https://github.com/${this.owner}/${this.repo}/issues/${existing}` };
    const res = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body: `${body}\n\n${marker}`,
      labels,
    });
    return { number: res.data.number, url: res.data.html_url };
  }

  async ensurePR(runId: string, taskId: string, head: string, base: string, title: string, body: string): Promise<{ number: number; url: string } | null> {
    if (!this.octokit) return null;
    const marker = this.marker(runId, `pr-${taskId}`);
    const existing = await this.findByMarker(marker);
    if (existing) return { number: existing, url: `https://github.com/${this.owner}/${this.repo}/pull/${existing}` };
    const res = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title,
      head,
      base,
      body: `${body}\n\n${marker}`,
    });
    return { number: res.data.number, url: res.data.html_url };
  }
}
