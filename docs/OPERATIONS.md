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

You give the harness **a sentence** and a **target repository**. It runs this loop:

```
what you typed
   ↓  intake agent (Opus)       reads the repo, then interviews you until the
   ↓                            assignment is unambiguous → agreed brief
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

Three rules that shape everything:

1. **Ambiguity is resolved with you before anything gets built.** The intake agent
   asks rather than guesses. Its questions carry options and a recommendation, and
   your answers become a brief the planner treats as settled.
2. **The harness never merges a PR into your branches.** There is no code path that
   can. Merging is your decision, always.
3. **A task becomes ready only when every dependency is `MERGED`**, not merely
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
pnpm test           # 58 unit tests, no API calls, no network
```

### Put `harness` on your PATH

The build emits an executable `apps/cli/dist/main.js`. Symlink it into a
directory already on your PATH:

```bash
pnpm link-cli       # ln -s apps/cli/dist/main.js ~/.local/bin/harness
harness --help
```

If `harness: command not found`, `~/.local/bin` is not on your PATH. Add it:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && exec zsh
```

Prefer a different location? Any directory on your PATH works — the target must
stay in place, because the symlink resolves back into this repo's
`node_modules`:

```bash
ln -sf "$PWD/apps/cli/dist/main.js" /usr/local/bin/harness
```

`pnpm link --global` also works, but only after `pnpm setup` has configured a
global bin directory; the symlink above needs no setup.

Rebuilding (`pnpm build`) updates the linked command in place — no re-linking.
Every example below uses `harness`; if you skipped linking, substitute
`node apps/cli/dist/main.js`.

---

## 4. Authentication

### Anthropic (required)

The harness never handles Anthropic credentials itself — there is no API-key
code path anywhere in it. It calls the Claude Agent SDK's `query()`, and the SDK
resolves credentials from the environment exactly as the Claude Code CLI does.
Pick one:

```bash
# Option A — Claude Pro/Max subscription (no API account needed)
claude setup-token            # prints a long-lived OAuth token
export CLAUDE_CODE_OAUTH_TOKEN=...

# Option B — API key, billed per token to your Anthropic API account
export ANTHROPIC_API_KEY=sk-ant-...
```

Put the chosen line in your shell profile so background and scheduled runs
inherit it. If both are set, **`ANTHROPIC_API_KEY` wins** — unset it if you
intend to run on a subscription.

Agents inherit **nothing** from your personal Claude Code settings: the pool sets
`settingSources: []` deliberately, so your global `CLAUDE.md`, hooks, and MCP
servers never leak into worker context. That switch governs *settings*, not
credentials, so authentication still resolves normally.

### Running on a subscription: two consequences

**The budget caps become a volume proxy, not a spend limit.** The ledger prices
tokens at API list rates ([§12](#12-budget-control)). On a subscription you are
not billed per token, so `--run-cap 30` means "stop after roughly $30 *worth* of
tokens", not "$30 will leave your account". It is still the right runaway guard;
just don't read the dashboard cost meter as money.

**Rate limits become the binding constraint.** A run fans planner, worker, and QA
agents against your 5-hour and weekly limits. Hitting a limit kills the agent
mid-task. This is recoverable — `harness resume <runId>` continues from the last
completed task, and nothing already finished is re-executed or re-paid — but
expect it on large runs and plan to resume.

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
4. **It has working check commands.** These run inside each worktree before any
   QA tokens are spent. The harness auto-detects them (see below); override with
   `--check "pnpm test" --check "pnpm lint"`. Cheap and specific beats broad.
5. **Branch protection on the default branch** is a good idea. The harness only
   ever pushes `harness/<runId>/*`, but protection makes that guarantee enforced
   by GitHub rather than by trust.
6. Add these to the target repo's `.gitignore`:

   ```gitignore
   .harness/
   ```

   `harness.config.json` ([§8](#8-configuration-reference)) is meant to be
   **committed** — it is per-repo defaults your whole team shares.

Sibling directory note: worktrees are created **next to** the repo, in
`<repo>-wt/`. If your repo is `~/code/my-app`, the harness creates
`~/code/my-app-wt/`. Make sure that path is writable and not inside a synced
folder that fights with git.

---

## 6. Your first run

Start with something small and verifiable — the point of the first run is to
measure your *QA first-pass rate* and *cost per merged PR*, not to ship a feature.

```bash
cd ~/code/my-app
harness run
```

That is the whole command — no assignment on the command line, no flags. The
harness resolves the target repo, the checks, the budget, and the dashboard for
you, and prints exactly what it resolved before spending anything:

```
  repo       /Users/you/code/my-app
  checks     pnpm run typecheck · pnpm run lint · pnpm run test   (auto-detected from package.json scripts via pnpm)
  budget     run $30 · task $10   (defaults)
  skills     /Users/you/.claude/skills · /Users/you/skills   (defaults)
  intake     conversation before planning   (default)
  dashboard  http://127.0.0.1:4777/#a1b2…   (the fragment is your auth token)
```

Read that banner before answering anything. If `checks` says `none`, QA has no
hard signal and you should add one with `--check`.

Then it asks what to build, and keeps asking until the assignment is unambiguous:

```
What should the harness build?
  A sentence is enough — the intake agent will ask about the rest.
  Finish with a blank line.

> add rate limiting to the API

● package.json pins fastify 5 and there is no middleware directory, so this is
  a new layer rather than an edit to an existing one.

  Where should the limit be enforced?
  1. Fastify plugin, in-process (recommended) — no new infra, and the deploy
     config shows a single instance
  2. Redis-backed — survives horizontal scaling, adds a dependency
  3. Reverse proxy — no app changes, but no per-user keys
  [1-3, enter = 1, or type your own answer]
> 1
```

Answer with a number, press enter to take the recommendation, or type anything
else — free text always wins over the options, including "no, do it this way
instead". When the agent has enough, it shows you the brief for approval; only
then does the planner start.

Skip the conversation entirely by putting the assignment on the command line:

```bash
harness run "Add a /healthz endpoint that returns build SHA and uptime, with a unit test"
```

For a first run, tighten the budget:

```bash
harness run "Add a /healthz endpoint…" --run-cap 10 --task-cap 4
```

What you will see:

1. The dashboard URL from the banner — open it. **The fragment after `#` is the
   auth token**; without it the page loads but every API call 401s.
2. The intake conversation, in the terminal. The dashboard shows the questions
   and your answers in the activity feed, but you answer in the terminal.
3. The planner surveys the repo (read-only tools) and emits a plan.
4. **Gate 1.** In the dashboard: the generated PRD, the task list, an *Approve*
   button and a rejection textarea. In the terminal (`--no-dashboard`): the PRD
   is printed and `y` approves; **any other text is sent back to the planner as
   rejection feedback** and it replans.
5. Tasks execute serially, streaming agent logs, tool calls, and cost.
6. Each accepted task merges into `harness/<runId>/main` and gets a PR.
7. The run ends in `PR_REVIEW`. You review and merge on GitHub.

Local-only first run (no GitHub, no dashboard, no conversation) is a good smoke
test:

```bash
harness run "Add a CONTRIBUTING.md" --run-cap 3 --no-dashboard --no-chat
git log --oneline harness/<runId>/main
```

---

## 7. CLI reference

Every command defaults `--repo` to **the git repository containing your current
directory**, found by walking up for `.git` — so subdirectories work too. Outside
a repository you get an actionable error rather than a confusing one.

### `harness run [assignment]`

The assignment is optional. Omit it and the harness asks you in a conversation;
pass it and the harness takes it as final.

| Flag | Default | Meaning |
|---|---|---|
| `-r, --repo <path>` | enclosing git root | target repository |
| `--run-cap <usd>` | `30` | hard ceiling for the whole run |
| `--task-cap <usd>` | `10` | hard ceiling per task |
| `--check <cmd...>` | auto-detected | deterministic commands run in the worktree before QA; repeatable |
| `--no-checks` | — | run none, even if detected |
| `--dashboard` / `--no-dashboard` | **on** | serve the monitor on `127.0.0.1:4777` and resolve Gate 1 there, or fall back to the terminal |
| `--chat` / `--no-chat` | on when no assignment is given | interview you with an intake agent before planning |

Exit leaves the run in a resumable state whatever happens.

#### The intake conversation

The intake agent surveys the repository first, then asks — one question at a
time, at most six — about the things where two answers would produce different
code: scope boundaries, where a change belongs, behaviour at the edges,
compatibility, and what you explicitly do *not* want. It is instructed never to
ask what the repo already answers, and to mark exactly one option as recommended
with a reason.

You can always answer in free text instead of picking an option; that answer wins
over any recommendation. When the agent is satisfied it shows you a draft brief
and only proceeds once you approve it.

The brief is written to `.harness/<runId>/BRIEF.md` and becomes the run's
assignment — so `harness status`, the dashboard, and the planner all see the
agreed version, not the sentence you started with. Interrupting mid-conversation
loses it: a resume plans from the assignment on record instead of re-interviewing.

Intake runs on the same ledger and budget cap as the rest of the run. It is a
cheap phase (one Opus session, read-only tools), but it is not free.

#### How checks are detected

When you pass no `--check`, the harness reads the target repo and infers
conventional, non-destructive commands:

| Repo contains | Detected checks |
|---|---|
| `package.json` with `typecheck`/`type-check`, `lint`, `test` scripts | those scripts, run via the lockfile's package manager (`pnpm`/`yarn`/`bun`/`npm`) |
| `Cargo.toml` | `cargo test`, `cargo clippy -- -D warnings` |
| `go.mod` | `go build ./...`, `go test ./...` |
| none of the above | nothing — the banner says so |

Only those. Anything project-specific (integration suites, Python, Make targets)
needs an explicit `--check` or a `harness.config.json`. Detection never runs
`build` for Node projects — it is slow and usually redundant with `typecheck`.

### `harness init`

```bash
harness init            # writes harness.config.json with the resolved defaults
harness init --force    # overwrite an existing one
```

Materializes the defaults into a committable config file so the whole team gets
them. Refuses to clobber an existing file without `--force`.

### `harness resume <runId>`

```bash
harness resume 3f9a2c11
```

Prunes stale worktrees, reloads state from SQLite, and drives the run forward from
exactly where it stopped. Tasks already `MERGED` are skipped, and nothing already
paid for is paid for again. Takes the same `--dashboard` / `--no-dashboard` flags
as `run`.

### `harness status`

```bash
harness status
```

Prints every open run with its state, spend, and per-task states, QA iteration
counts, and PR numbers. Read-only, free, no agents spawned.

---

## 8. Configuration reference

Settings are layered, highest priority first:

1. **CLI flag** — `--run-cap 50`
2. **`harness.config.json`** at the target repo root
3. **Auto-detection** — checks only ([§7](#7-cli-reference))
4. **Built-in default**

Whatever wins is printed in the run banner with its source, so a bare
`harness run` is never silently doing something you didn't intend.

### `harness.config.json`

Written by `harness init`, committed alongside the code it configures. Every key
is optional; unknown keys are a **hard error** rather than a silent no-op, so a
typo surfaces immediately.

```json
{
  "budget": { "runCapUsd": 50, "taskCapUsd": 12 },
  "deterministicChecks": ["pnpm test", "pnpm lint"],
  "dashboard": true,
  "chat": true,
  "skillsDirs": ["~/.claude/skills", "~/skills"],
  "qaIterationCap": 3,
  "models": { "planner": "claude-opus-5", "worker": "claude-sonnet-5" }
}
```

`~` is expanded in `skillsDirs`, so the file stays portable across machines.

### Every field

Run configuration is a zod-validated `RunConfig`
([`packages/shared/src/config.ts`](../packages/shared/src/config.ts)).

| Field | Default | CLI flag | Config file | Notes |
|---|---|---|---|---|
| `maxParallelWorkers` | `1` | — | ✅ | v0.0 is serial by design. The scheduler is already a ready-queue over the DAG, so raising this is the v0.1 change, not a rewrite. |
| `qaIterationCap` | `3` | — | ✅ | worker↔QA round trips before a task is parked as `NEEDS_HUMAN` |
| `workerRespawnCap` | `3` | — | ✅ | crashed-session restarts before parking; the replacement gets a "read your own git log and continue" note |
| `taskWallClockMinutes` | `45` | — | ✅ | reserved for the v0.1 watchdog |
| `models.intake` | `claude-opus-5` | — | ✅ | this one talks to you; question quality is the whole value |
| `models.planner` | `claude-opus-5` | — | ✅ | planning quality dominates run cost efficiency |
| `models.worker` | `claude-sonnet-5` | — | ✅ | |
| `models.qa` | `claude-sonnet-5` | — | ✅ | |
| `models.integrator` | `claude-sonnet-5` | — | ✅ | |
| `budget.runCapUsd` | `30` | `--run-cap` | ✅ | checked **before every agent turn** |
| `budget.taskCapUsd` | `10` | `--task-cap` | ✅ | |
| `skillsDirs` | `~/.claude/skills`, `~/skills` | — | ✅ | |
| `deterministicChecks` | auto-detected | `--check`, `--no-checks` | ✅ | shell strings, run via `sh -c` in the worktree |
| `githubRepo` | unset | — | ✅ | `HARNESS_GITHUB_REPO` takes precedence when set |
| *(not in RunConfig)* `dashboard` | `true` | `--dashboard`, `--no-dashboard` | ✅ | CLI-only concern |
| *(not in RunConfig)* `chat` | on when no assignment is given | `--chat`, `--no-chat` | ✅ | set `false` to make a repo always plan directly |

For anything beyond this — a custom gate handler, embedding the harness in
another program — drive the controller directly:

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
| `CLAUDE_CODE_OAUTH_TOKEN` | one of these | Claude Pro/Max subscription credential |
| `ANTHROPIC_API_KEY` | one of these | Anthropic API credential; **wins if both are set** |
| `GITHUB_TOKEN` | no | enables issues + PRs |
| `HARNESS_GITHUB_REPO` | with token | `owner/repo` |

---

## 9. What the harness writes where

Inside the **target repo**:

| Path | Contents |
|---|---|
| `.harness/harness.db` | event log + materialized run/task/usage state (SQLite, WAL) |
| `.harness/<runId>/BRIEF.md` | the brief the intake conversation produced — what the planner was actually given |
| `.harness/<runId>/planner-attempt-N.txt` | the raw output of any rejected planning attempt, kept verbatim for post-mortem |
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

On by default; `--no-dashboard` runs headless. It binds **127.0.0.1 only** on
port `4777`.

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

### What the page shows

The layout is built around one question — *what is happening right now, and do I
need to step in?* — so the activity feed owns most of the window and everything
else sits in a fixed sidebar.

- **Activity** — the event stream, capped at 2000 lines. Every line is attributed
  to the agent that caused it and says what actually happened: `worker  read
  src/server.ts`, `planner  grep onRequest|preHandler in src`, `qa  $ pnpm test`,
  `token-bucket  QA iteration 1: PASS — …`. Paths are shown relative to the repo.
  Five toggles (agent output, tool calls, state, cost, git) filter by category —
  turning off *tool calls* leaves you with just the narrative. The feed follows
  the tail until you scroll up, then offers **Jump to latest** instead of yanking
  you back. GitHub lines link to the issue or PR.
- **Now** — one card per running agent: role, model, elapsed time, turn count,
  and the last thing it did. This is the panel to watch when a task feels stuck.
- **Tasks** — a card per task with its state, dependencies, QA iteration count,
  injected skills, and linked issue/PR numbers. Before the plan exists the panel
  explains which phase you are in rather than sitting empty. Issue and PR numbers
  link straight to GitHub when `HARNESS_GITHUB_REPO` (or `githubRepo`) is set.
- **Run** — repo path, integration branch, elapsed, resolved checks and caps, and
  the full assignment the planner received (the intake brief, if you used one).
- **Cost meter** — spend against the run cap, with a bar that turns amber past
  60% and red past 85%. It only moves when a session *ends*, because that is when
  usage is booked; the note under the meter says so rather than leaving you to
  wonder why a long planner run reads `$0.00`.
- **Gate 1** — when the plan needs approval it takes over the full width above
  everything else, because it is blocking the run.

The page is a single self-contained HTML file with no build step
([`packages/dashboard/src/page.ts`](../packages/dashboard/src/page.ts)). All
dynamic text is inserted with `textContent`, never `innerHTML` — agent output and
repository contents are untrusted input. `packages/dashboard/preview.mjs` serves
it against a seeded fake run for UI work without spending tokens:

```bash
pnpm --filter @harness/dashboard build && node packages/dashboard/preview.mjs
GATE=1 node packages/dashboard/preview.mjs   # …with the plan gate open
```

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
harness status            # find the runId and where it stopped
harness resume <runId>
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
| Intake reach | the intake agent gets `Read`/`Glob`/`Grep` and its `ask_user` tool only — it cannot edit, run commands, or reach the network |

Full threat model: PRD §12.

---

## 15. Troubleshooting

**`harness: command not found`**
The symlink target directory is not on your PATH. See [§3](#3-install) — with the
default `pnpm link-cli` location, add `export PATH="$HOME/.local/bin:$PATH"` to
your shell profile.

**`... is not inside a git repository`**
You are outside the target repo. `cd` into it, or pass `--repo <path>`.

**`3 planner attempts rejected — …`**
The message names which of the three failure modes happened — the JSON could not
be read, the plan did not match the required shape, or the plan was not a valid
DAG — and points at `.harness/<runId>/planner-attempt-N.txt`, which holds each
rejected attempt verbatim. Read attempt 1 first: if the analysis looks right and
only the output was malformed, the assignment is fine and it is worth re-running.

Only the first attempt surveys the repository. Retries are given the previous
output with no tools and a 4-turn budget, because a rejected plan is nearly always
a formatting failure rather than a thinking failure — re-surveying three times is
what once turned a single failed planning phase into $3.34.

**The intake agent asks too many questions, or the wrong ones**
Give it more to work with: a two-sentence seed with the constraint you care about
beats a three-word one. To skip the conversation for a run, pass the assignment on
the command line; to skip it for a repo, set `"chat": false` in
`harness.config.json`. The brief it produced is in `.harness/<runId>/BRIEF.md` —
worth reading if the plan came out wrong, since that file is what the planner saw.

**The conversation was interrupted**
The brief lives only in the agent's session, so `harness resume` cannot continue
it — the run moves to planning using the assignment on record (your original
seed). If the conversation mattered, abandon the run and start a new one.

**`harness.config.json is invalid: Unrecognized key(s)`**
A typo, or a key that belongs one level deeper (`runCapUsd` lives under
`budget`). The schema is strict on purpose — see [§8](#8-configuration-reference)
for the exact shape, or regenerate with `harness init --force`.

**The banner says `checks none`**
Auto-detection found no conventional test/lint scripts, so QA has no hard signal
and will rely entirely on the agent reading the diff. Add `--check "<cmd>"` or a
`deterministicChecks` entry in `harness.config.json`.

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
| `packages/shared` | zod contracts: run/task states + legal transitions, event union, plan schema and DAG validation, intake `Brief`, `RunConfig` |
| `packages/core` | store (event-sourced SQLite), bus, budget/pricing, git + worktrees, agent pool, prompts, intake conversation, QA checks, run controller, GitHub adapter |
| `packages/skills-mcp` | `SKILL.md` indexer, lexical matcher, provenance hashing, stdio MCP server |
| `packages/dashboard` | Fastify backend + single-file SPA, plus `preview.mjs` for UI work against a seeded run |
| `apps/cli` | `harness run / resume / status / init`, terminal intake chat (`chat.ts`), repo-root resolution, check detection, and config-file layering (`defaults.ts`) |

Conventions worth keeping:

- **Every state change goes through the store**, in a transaction, as an event
  plus a materialized update. Nothing mutates state behind the bus's back.
- **Transitions are validated** against `RUN_TRANSITIONS` / `TASK_TRANSITIONS`;
  an illegal transition throws rather than silently corrupting a run.
- **Mutating git operations in the main repo are serialized** through a mutex —
  git's index lock is global and parallel worktree operations corrupt it.
- **GitHub writes are idempotent** via an HTML-comment marker in the body, so
  replay after a crash never duplicates an issue or PR.
- **The dashboard never uses `innerHTML` for dynamic text.** Agent output and
  repository contents are untrusted; everything goes through `textContent`.
- **Anything the operator answers is asked through a transport interface**
  (`IntakeUi`, `GateHandler`) rather than by calling readline from core — that is
  what lets the terminal and the dashboard implement the same conversation.
- Tests are pure: no network, no API keys, `:memory:` databases.
