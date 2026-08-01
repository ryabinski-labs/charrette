# Operating the Harness

Everything you need to install, configure, run, observe, and recover the harness.
For *why* it is built this way, read [PRD.md](../PRD.md); this document is the *how*.

- [1. Mental model](#1-mental-model)
- [2. Prerequisites](#2-prerequisites)
- [3. Install](#3-install)
- [4. Authentication](#4-authentication)
- [5. Preparing a target repository](#5-preparing-a-target-repository)
- [6. Your first run](#6-your-first-run)
- [7. CLI reference](#7-cli-reference)
- [8. Configuration reference](#8-configuration-reference)
- [9. What the harness writes where](#9-what-the-harness-writes-where)
- [10. The dashboard](#10-the-dashboard)
- [11. Skills](#11-skills)
- [12. Budget control](#12-budget-control)
- [13. Interruption, resume, and failure recovery](#13-interruption-resume-and-failure-recovery)
- [14. Operating safely](#14-operating-safely)
- [15. Troubleshooting](#15-troubleshooting)
- [16. Development](#16-development)

---

## 1. Mental model

You give the harness **one paragraph** and a **target repository**. It runs this loop:

```
assignment
   ↓  planner agent (Opus)      reads the repo, writes a PRD + a task DAG
   ↓  GATE 1 — you approve      terminal prompt or dashboard button
   ↓  GitHub issues filed       one issue per task (optional)
   ↓  for each ready task:
   ↓     worker agent (Sonnet)  implements in an isolated git worktree
   ↓     deterministic checks   your test/lint commands — cheap, run before QA
   ↓     QA agent (Sonnet)      adversarial review against acceptance criteria
   ↓       ↳ FAIL → back to the worker with a must-fix list (max 3 iterations)
   ↓     merge into harness/<runId>/main      ← this is what unblocks dependents
   ↓     open a PR for the task branch
   ↓  GATE 2 — you merge the PRs on GitHub
```

Two rules that shape everything:

1. **The harness never merges a PR into your branches.** There is no code path that
   can. Merging is your decision, always.
2. **A task becomes ready only when every dependency is `MERGED`**, not merely
   accepted — so a worker building on top of another task actually sees that code
   in its worktree.

State lives in an event-sourced SQLite database. Every run is resumable; completed
tasks never re-execute and are never re-paid for.

---

## 2. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| **Node ≥ 22** | uses the built-in `node:sqlite` module (no native deps) | `node -v` |
| **pnpm ≥ 9** | workspace monorepo | `pnpm -v` |
| **git ≥ 2.30** | worktrees | `git --version` |
| Anthropic credentials | the agents | see [§4](#4-authentication) |
| GitHub token *(optional)* | issues + PRs | see [§4](#4-authentication) |

Node 22 or 23 will print `ExperimentalWarning: SQLite is an experimental feature`.
That is expected and harmless.

---

## 3. Install

```bash
git clone git@github.com:ryabinski-labs/harness.git
cd harness
pnpm install
pnpm build          # compiles all packages to dist/
pnpm test           # 15 unit tests, no API calls, no network
```

The CLI entrypoint after building is `apps/cli/dist/main.js`. To get a global
`harness` command:

```bash
cd apps/cli && pnpm link --global    # optional
```

All examples below use the explicit path so they work without linking.

---

## 4. Authentication

### Anthropic (required)

The Claude Agent SDK resolves credentials the same way the Claude Code CLI does.
Pick one:

```bash
# Option A — API key (billed per token to your API account)
export ANTHROPIC_API_KEY=sk-ant-...

# Option B — Claude Code subscription token
claude setup-token            # prints a long-lived OAuth token
export CLAUDE_CODE_OAUTH_TOKEN=...
```

If both are set, `ANTHROPIC_API_KEY` wins. Agents inherit **nothing** from your
personal Claude Code settings — the pool sets `settingSources: []` deliberately,
so your global `CLAUDE.md`, hooks, and MCP servers never leak into worker context.

### GitHub (optional but recommended)

Without a token the harness runs **local-only**: it still plans, builds, QAs, and
merges into the local integration branch, but files no issues and opens no PRs.

To enable GitHub mode, create a **fine-grained** personal access token scoped to
the single target repository with these repository permissions:

| Permission | Access | Used for |
|---|---|---|
| Contents | Read and write | pushing `harness/<runId>/*` branches |
| Issues | Read and write | one issue per task |
| Pull requests | Read and write | one PR per accepted task |
| Metadata | Read | implied |

Then:

```bash
export GITHUB_TOKEN=github_pat_...
export HARNESS_GITHUB_REPO=owner/repo      # must match the target repo's origin
```

> The token is read from the environment by the CLI process only. It is never
> placed in an agent's context, prompt, or tool result.

---

## 5. Preparing a target repository

The target repo is the codebase the agents modify — usually *not* this repo.

Checklist:

1. **It is a git repository** with at least one commit.
2. **The working tree is clean.** The integration branch is cut from `HEAD`.
3. **`origin` points at `HARNESS_GITHUB_REPO`** if you are using GitHub mode.
4. **It has working check commands.** Pass them with `--check`; they run inside
   each worktree before any QA tokens are spent. Cheap and specific beats broad:
   `--check "pnpm test" --check "pnpm lint"`.
5. **Branch protection on the default branch** is a good idea. The harness only
   ever pushes `harness/<runId>/*`, but protection makes that guarantee enforced
   by GitHub rather than by trust.
6. Add these to the target repo's `.gitignore`:

   ```gitignore
   .harness/
   ```

Sibling directory note: worktrees are created **next to** the repo, in
`<repo>-wt/`. If your repo is `~/code/my-app`, the harness creates
`~/code/my-app-wt/`. Make sure that path is writable and not inside a synced
folder that fights with git.

---

## 6. Your first run

Start with something small and verifiable — the point of the first run is to
measure your *QA first-pass rate* and *cost per merged PR*, not to ship a feature.

```bash
export ANTHROPIC_API_KEY=sk-ant-...

node ~/Documents/projects/harness/apps/cli/dist/main.js run \
  "Add a /healthz endpoint that returns build SHA and uptime, with a unit test" \
  --repo ~/code/my-app \
  --check "npm test" \
  --run-cap 10 \
  --task-cap 4 \
  --dashboard
```

What you will see:

1. `Dashboard: http://127.0.0.1:4777/#<token>` — open it. **The fragment after
   `#` is the auth token**; without it the page loads but every API call 401s.
2. The planner surveys the repo (read-only tools) and emits a plan.
3. **Gate 1.** In the dashboard: the generated PRD, the task list, an *Approve*
   button and a rejection textarea. In the terminal (no `--dashboard`): the PRD
   is printed and `y` approves; **any other text is sent back to the planner as
   rejection feedback** and it replans.
4. Tasks execute serially, streaming agent logs, tool calls, and cost.
5. Each accepted task merges into `harness/<runId>/main` and gets a PR.
6. The run ends in `PR_REVIEW`. You review and merge on GitHub.

Local-only first run (no GitHub, no dashboard) is a good smoke test:

```bash
node apps/cli/dist/main.js run "Add a CONTRIBUTING.md" --repo ~/code/my-app --run-cap 3
git -C ~/code/my-app log --oneline harness/<runId>/main
```

---

## 7. CLI reference

### `harness run <assignment>`

| Flag | Default | Meaning |
|---|---|---|
| `-r, --repo <path>` | `cwd` | target repository |
| `--run-cap <usd>` | `30` | hard ceiling for the whole run |
| `--task-cap <usd>` | `10` | hard ceiling per task |
| `--check <cmd...>` | none | deterministic commands run in the worktree before QA; repeatable |
| `--dashboard` | off | serve the monitor on `127.0.0.1:4777` and resolve Gate 1 there |

Exit leaves the run in a resumable state whatever happens.

### `harness resume <runId>`

```bash
node apps/cli/dist/main.js resume 3f9a2c11 --repo ~/code/my-app
```

Prunes stale worktrees, reloads state from SQLite, and drives the run forward from
exactly where it stopped. Tasks already `MERGED` are skipped. Uses the terminal
gate handler (no `--dashboard` flag on resume yet — see [§8](#8-configuration-reference)).

### `harness status`

```bash
node apps/cli/dist/main.js status --repo ~/code/my-app
```

Prints every open run with its state, spend, and per-task states, QA iteration
counts, and PR numbers. Read-only, free, no agents spawned.

---

## 8. Configuration reference

Run configuration is a zod-validated `RunConfig`
([`packages/shared/src/config.ts`](../packages/shared/src/config.ts)). The CLI
exposes the fields you change per run; the rest are code-level defaults today.

| Field | Default | CLI flag | Notes |
|---|---|---|---|
| `maxParallelWorkers` | `1` | — | v0.0 is serial by design. The scheduler is already a ready-queue over the DAG, so raising this is the v0.1 change, not a rewrite. |
| `qaIterationCap` | `3` | — | worker↔QA round trips before a task is parked as `NEEDS_HUMAN` |
| `workerRespawnCap` | `3` | — | crashed-session restarts before parking; the replacement gets a "read your own git log and continue" note |
| `taskWallClockMinutes` | `45` | — | reserved for the v0.1 watchdog |
| `models.planner` | `claude-opus-5` | — | planning quality dominates run cost efficiency |
| `models.worker` | `claude-sonnet-5` | — | |
| `models.qa` | `claude-sonnet-5` | — | |
| `models.integrator` | `claude-sonnet-5` | — | |
| `budget.runCapUsd` | `30` | `--run-cap` | checked **before every agent turn** |
| `budget.taskCapUsd` | `10` | `--task-cap` | |
| `skillsDirs` | `~/.claude/skills`, `~/skills` | — | set by the CLI |
| `deterministicChecks` | `[]` | `--check` | shell strings, run via `sh -c` in the worktree |
| `githubRepo` | unset | — | the CLI uses `HARNESS_GITHUB_REPO` instead |

To change a code-level default, edit `defaultConfig()` in
[`apps/cli/src/main.ts`](../apps/cli/src/main.ts) and rebuild, or drive the
controller directly:

```ts
import { AgentPool, Bus, GitHubAdapter, RunController, Store } from "@harness/core";
import { RunConfig } from "@harness/shared";

const store = new Store(".harness/harness.db");
const bus = new Bus(store);
const controller = new RunController(
  store, bus, new AgentPool(store, bus),
  new GitHubAdapter(process.env.GITHUB_TOKEN, "owner/repo"),
  { async resolvePlanGate() { return { approved: true, feedback: "" }; } },  // headless
  "/path/to/target/repo",
);
await controller.startRun("assignment", RunConfig.parse({
  models: { planner: "claude-opus-5", worker: "claude-sonnet-5", qa: "claude-sonnet-5", integrator: "claude-sonnet-5" },
  budget: { runCapUsd: 50, taskCapUsd: 12 },
  deterministicChecks: ["pnpm test"],
}));
```

Auto-approving Gate 1 like that removes the only cheap check on a bad plan. Use it
for CI of the harness itself, not for real work.

### Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | one of these | Anthropic API credential |
| `CLAUDE_CODE_OAUTH_TOKEN` | one of these | Claude Code subscription credential |
| `GITHUB_TOKEN` | no | enables issues + PRs |
| `HARNESS_GITHUB_REPO` | with token | `owner/repo` |

---

## 9. What the harness writes where

Inside the **target repo**:

| Path | Contents |
|---|---|
| `.harness/harness.db` | event log + materialized run/task/usage state (SQLite, WAL) |
| `.harness/<runId>/PRD.md` | the PRD the planner produced — the thing you approve |
| `.harness/<runId>/CONVENTIONS.md` | conventions injected into every worker's system prompt |
| `.harness/<runId>/plan.json` | full plan incl. task DAG; SHA-256 of this is the approved `planHash` |

Git objects in the **target repo**:

| Ref | Meaning |
|---|---|
| `harness/<runId>/main` | integration branch, cut from `HEAD` at run start; every accepted task merges here |
| `harness/<runId>/<taskId>` | one branch per task, cut from the integration branch *at dispatch time* |

Worktrees, in the **sibling directory** `<repo>-wt/`:

| Path | Meaning |
|---|---|
| `<repo>-wt/<runId>/<taskId>` | the worker's and QA's working directory |
| `<repo>-wt/<runId>/__integration__` | scratch worktree used only for merges |

Cleanup after a finished run:

```bash
git -C ~/code/my-app worktree list                       # inspect
git -C ~/code/my-app worktree remove --force <path>      # per worktree
git -C ~/code/my-app worktree prune
git -C ~/code/my-app branch -D $(git -C ~/code/my-app branch --list "harness/<runId>/*" | tr -d ' ')
```

Do not delete `.harness/harness.db` while a run is resumable — it is the only
record of what has been paid for and completed.

---

## 10. The dashboard

Start it with `--dashboard`. It binds **127.0.0.1 only** on port `4777`.

- **Auth:** a fresh 128-bit token per process, delivered in the URL *fragment*.
  Fragments are never sent to the server or logged in proxies; the page reads it
  from `location.hash` and sends it as an `Authorization: Bearer` header on every
  request. Anyone hitting the port without the token gets `401`.
- **CSRF:** state changes are `POST`-only and validate both `Host` and `Origin`
  against localhost patterns — a page on another site cannot approve your plan.
- **Streaming:** events are consumed by `fetch()` + `ReadableStream`, not
  `EventSource`, because `EventSource` cannot set headers. The stream cursor is
  the event sequence number, so reconnecting replays from where you left off
  rather than losing history.

The page shows the task board (colour-coded by state), a live event log capped at
2000 lines, the running cost meter against the cap, and the Gate 1 panel.

Sharing the URL shares the token. Treat it as a password for the run.

To change the port today, construct `new Dashboard(store, bus, { port })` in
`apps/cli/src/main.ts`; there is no flag yet.

---

## 11. Skills

Skills are `SKILL.md` playbooks — the same format Claude Code uses. The harness
indexes `~/.claude/skills` and `~/skills` by default, matches them lexically
against each task's title and spec, and injects the top matches into the worker's
system prompt.

Injection is bounded on purpose ([PRD PERF-4](../PRD.md)):

- a skill is injected **in full** only if it is ≤ ~1500 tokens, and at most **two**
  full-text skills per task;
- everything else is injected **by reference** (name + path) so the worker can read
  it on demand if it wants;
- every skill is hashed with SHA-256 at index time and the hash is **re-verified
  immediately before injection**. A skill edited mid-run is dropped, not used.

Which skills were injected — and in which mode — is recorded per task and emitted
as a `skills.injected` event, so the dashboard log tells you exactly what shaped a
worker's behaviour.

### Using the indexer as a standalone MCP server

`packages/skills-mcp` also ships a stdio MCP server exposing `search_skills` and
`describe_skill`, usable from Claude Code or any MCP client:

```bash
node packages/skills-mcp/dist/server.js [dir ...]
```

Register it with Claude Code:

```bash
claude mcp add harness-skills -- node ~/Documents/projects/harness/packages/skills-mcp/dist/server.js
```

---

## 12. Budget control

Every agent turn is priced from the SDK's reported token usage — input, output,
cache reads at 0.1×, cache writes at 1.25× — and appended to a ledger in SQLite.

- The cap is checked **before each turn and on every streamed message**. When the
  ceiling is hit, the session's `AbortController` fires immediately; you do not
  pay for the rest of the turn.
- Run cap exceeded → the run stops in a resumable state. Raise the cap and
  `resume`.
- Task cap exceeded → that task stops; other tasks are unaffected.
- **Unknown model IDs are priced at the most expensive tier.** The estimate is
  never below reality.

`harness status` prints spend per run at any time; the dashboard meter shows it
live against the cap.

Sizing guidance, from the PRD's pre-benchmark model — **verify these against your
own first runs before trusting them**:

| Assignment shape | Envelope |
|---|---|
| Single small feature, 1–3 tasks | $5–15 |
| Multi-component feature, 5–8 tasks | $30–90 |
| Small service from scratch | $150–400 |

Start `--run-cap` at roughly what you are willing to lose, not at what you expect
to spend.

---

## 13. Interruption, resume, and failure recovery

Every state change is an event committed transactionally before it takes effect,
so *anything* — Ctrl-C, crash, laptop sleep, budget abort — leaves a consistent,
resumable run.

```bash
node apps/cli/dist/main.js status --repo ~/code/my-app     # find the runId and where it stopped
node apps/cli/dist/main.js resume <runId> --repo ~/code/my-app
```

| Symptom | What happened | What to do |
|---|---|---|
| Task in `NEEDS_HUMAN`, reason `QA iteration cap` | 3 worker↔QA rounds without a PASS | read the QA reasons in the log, fix it yourself in the task worktree and commit, or drop the task and replan |
| Task in `NEEDS_HUMAN`, reason `merge conflicts` | accepted branch conflicts with the integration branch | resolve manually in `<repo>-wt/<runId>/__integration__`, commit, then `resume` |
| Task in `NEEDS_HUMAN`, reason `worker crash cap` | 3 sessions died | inspect the branch — partial work is committed and preserved |
| Tasks `CANCELLED`, reason `unreachable` | their dependencies parked, so they can never become ready | expected fallout; fix the blocking task and start a new run |
| Run `FAILED` at planning | planner produced invalid JSON/DAG 3× | the assignment is probably ambiguous — rewrite it more concretely |
| `BudgetExceeded` | cap hit | raise the cap, `resume` |

Rejecting at Gate 1 is not a failure: your feedback text goes straight back into
the planner's next attempt, and it replans. Rejecting is much cheaper than
approving a plan you do not believe in.

---

## 14. Operating safely

Read this before pointing the harness at anything you care about.

**Worker agents run with `bypassPermissions`.** They edit files and run shell
commands inside their worktree without asking. OS-level sandboxing (macOS
Seatbelt) is on the roadmap and **not implemented yet**. Until it lands, the
honest posture is:

- **Run against repositories you trust**, and prefer a scratch clone over your
  primary working copy.
- The blast radius is the worktree plus whatever a shell command can reach from
  it — which, without a sandbox, is your user account.
- Prefer a fine-grained GitHub token scoped to one repository. If it leaks, one
  repo is exposed, not your account.

What *is* enforced today:

| Control | Guarantee |
|---|---|
| Push allowlist | only `harness/<runId>/*` refs are ever pushed |
| No merge path | the harness cannot merge a PR; the code does not exist |
| Secret isolation | tokens live in the CLI process; never in prompts or agent context |
| Setting isolation | `settingSources: []` — your Claude Code config never reaches workers |
| Skill provenance | SHA-256 verified at injection; tampered skills are dropped |
| Dashboard | loopback bind, bearer token, `Origin`/`Host` validation on writes |
| Plan integrity | the approved plan is hashed; execution consumes that exact version |
| Web access | `WebSearch` disallowed for workers and QA |

Full threat model: PRD §12.

---

## 15. Troubleshooting

**`ExperimentalWarning: SQLite is an experimental feature`**
Expected on Node 22/23. Silence with `NODE_OPTIONS=--no-warnings`.

**`Cannot find module 'node:sqlite'`**
Node < 22. Upgrade. Do not reintroduce `better-sqlite3` — it has no prebuilt
binaries for current Node and was removed deliberately.

**`tsc: command not found` during build**
Run `pnpm install` at the repo root, not inside a package.

**Dashboard loads but the board says "auth failed"**
You opened the URL without the `#token` fragment. Copy the full line the CLI
printed. The token changes every process — an old bookmark will not work.

**Nothing appears in the dashboard event log**
Check the run ID is open (`harness status`). The stream only tails events for
runs returned by `/api/state`.

**No issues or PRs appear**
`GITHUB_TOKEN` or `HARNESS_GITHUB_REPO` is unset, the token lacks Issues/PR write,
or the target repo's `origin` is a different repository. The harness degrades to
local-only silently by design — check `harness status` for merged tasks with no
PR number.

**PR creation fails with "base branch not found"**
The integration branch push failed — usually a token missing Contents write.
Fix the token and `resume`; PR creation is idempotent and will not duplicate.

**Worker keeps failing the same deterministic check**
Your check command probably does not work from a fresh worktree — dependencies
are not installed there. Either make the check self-contained
(`--check "npm ci && npm test"`) or commit a working setup script.

**Merge conflicts on every task**
The tasks the planner produced overlap too much. Reject at Gate 1 with feedback
like "tasks 2 and 3 both rewrite `src/server.ts` — split by file ownership".

---

## 16. Development

```bash
pnpm build          # tsc across all packages
pnpm test           # vitest, all packages
pnpm typecheck      # no-emit typecheck
```

| Package | Responsibility |
|---|---|
| `packages/shared` | zod contracts: run/task states + legal transitions, event union, plan schema and DAG validation, `RunConfig` |
| `packages/core` | store (event-sourced SQLite), bus, budget/pricing, git + worktrees, agent pool, prompts, QA checks, run controller, GitHub adapter |
| `packages/skills-mcp` | `SKILL.md` indexer, lexical matcher, provenance hashing, stdio MCP server |
| `packages/dashboard` | Fastify backend + single-file SPA |
| `apps/cli` | `harness run / resume / status` |

Conventions worth keeping:

- **Every state change goes through the store**, in a transaction, as an event
  plus a materialized update. Nothing mutates state behind the bus's back.
- **Transitions are validated** against `RUN_TRANSITIONS` / `TASK_TRANSITIONS`;
  an illegal transition throws rather than silently corrupting a run.
- **Mutating git operations in the main repo are serialized** through a mutex —
  git's index lock is global and parallel worktree operations corrupt it.
- **GitHub writes are idempotent** via an HTML-comment marker in the body, so
  replay after a crash never duplicates an issue or PR.
- Tests are pure: no network, no API keys, `:memory:` databases.
