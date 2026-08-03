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
   ↓       ↳ at the cap → GATE — the harness asks YOU, and your answer restarts
   ↓                      the worker with fresh iterations (or parks the task)
   ↓     merge into harness/<runId>/main      ← this is what unblocks dependents
   ↓  validator agent (Sonnet)  judges the merged whole against your original
   ↓                            intent — the last step before any PR exists
   ↓  open one PR per merged task
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

The third rule has a consequence worth knowing before your first run: a task the
harness cannot finish parks as `NEEDS_HUMAN`, and everything downstream of it can
then never become ready. Those tasks are cancelled unattempted, and the run ends
with fewer PRs than the plan had tasks — or with none at all. That is the design
working, not a fault, but it means **`PR_REVIEW` is where the harness stops, not
proof that it succeeded.** Read what it produced, which the closing line and
`harness status` both spell out.

Before a task parks, though, the harness asks you first. Hitting a cap opens a
**task-escalation gate** — in the terminal, or as an amber panel (and a desktop
notification) on the dashboard — showing what failed and why. One sentence from
you ("the tests need DynamoDB running — `podman compose up -d` first", "skip
that flaky check", "you misread the spec: do X") restarts the worker with your
words and a fresh iteration budget. Leaving it blank, or clicking *Park it*,
parks the task exactly as before. Most cap hits are an environment or intent
problem only you can resolve; the gate is how you resolve it without losing the
run.

Two more things happen between the last task and `PR_REVIEW`. First, a
**validator agent** reads the integration branch whole and judges it against
your original assignment — did the sum of the merged tasks deliver what you
asked for, not merely pass their own acceptance criteria? Its verdict (and each
gap it finds) goes into the closing report and the run's events. Second, only
after that verdict is the pull request opened — by default **one rollup PR for
the whole run**, from the integration branch, listing every merged task (one
`--no-ff` merge commit each) with the validator's verdict in the body, so a
reviewer never sees a PR the harness has not finished judging. A FAIL verdict
does not withhold the PR — the harness never merges, and human review is
exactly where the gap list belongs — but it is printed first, above it.

Why a rollup and not one PR per task: task branches are cut from the
integration branch, so each carries every merge that landed before it — by the
last task, its "own" PR is nearly the whole run's diff again. Set
`"prMode": "per-task"` in `harness.config.json` if you want the old behaviour
anyway; `harness regroup` converts an already-published per-task run.

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
| `gh` *(or a GitHub token)* | issues + PRs | `gh auth status`, see [§4](#4-authentication) |
| `podman`, `adb`/`emulator`, `aws` *(optional)* | offered to worker + QA agents when present | the `tools` line in the run banner |

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

### GitHub (recommended)

Credentials are resolved in this order, and the run banner tells you which one
won:

1. `GITHUB_TOKEN` + `HARNESS_GITHUB_REPO` from the environment.
2. **The `gh` CLI**, if it is authenticated (`gh auth status`). The token comes
   from `gh auth token` and the `owner/repo` slug from `gh repo view`, run in the
   target repo. Nothing to export — if you already use `gh`, GitHub mode is on.

With neither, the harness runs **local-only**: it still plans, builds, QAs, and
merges into the local integration branch, but files no issues and opens no PRs.
The banner says `github  off — …` when that happens, with the reason.

To use a token instead of `gh`, create a **fine-grained** personal access token
scoped to the single target repository with these repository permissions:

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

> However it is obtained, the token lives in the CLI process only. It is never
> placed in an agent's context, prompt, or tool result. Note that a worker with
> Bash could run `gh auth token` itself — see [§14](#14-operating-safely).

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
7. The run ends in `PR_REVIEW` and prints what it actually produced — every pull
   request as a URL, plus anything parked or cancelled. `PR_REVIEW` means *the
   harness is finished*, not *it succeeded*: a run whose early tasks all park
   cancels everything downstream and ends there having opened nothing. The
   closing line distinguishes the two; read it before going to GitHub.

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
| `--dashboard` / `--no-dashboard` | **on** | serve the monitor on `127.0.0.1` and resolve Gate 1 there, or fall back to the terminal |
| `--port <n>` | first free port from `4777` | pin the dashboard port; a pinned port that is busy is an error rather than a silent move |
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

### `harness resume [runId]`

```bash
harness resume            # the newest run with something left to do
harness resume 3f9a2c11   # a specific one
```

Prunes stale worktrees, reloads state from SQLite, and drives the run forward from
exactly where it stopped. Tasks already `MERGED` are skipped, and nothing already
paid for is paid for again. Takes the same `--dashboard` / `--no-dashboard` flags
as `run`.

A *finished* run still resumes when it has recoverable work. Each `NEEDS_HUMAN`
task opens its escalation gate now — your answer revives it with a fresh
iteration budget and puts its "unreachable" `CANCELLED` dependents back in the
queue; declining (or an empty answer) leaves it parked. A `CANCELLED` task whose
blockers have **since merged** (revived in an earlier session, say) is requeued
without any gate — the work it was waiting for exists now. Merged tasks whose
pull requests never opened get them retried, and a run from before base-branch
capture has its base branch repaired from the repo's current branch first. A
reopened run re-runs the intent validator only if something new merged since the
last verdict. Fix the environment before you resume — start the service the
checks need, correct the checks in `harness.config.json` — or your answer buys
iterations that fail the same way.

### `harness regroup [runId]`

```bash
harness regroup           # the newest run with pull requests
harness regroup 3f9a2c11  # a specific one
```

Replaces a run's per-task pull requests with the single rollup PR. The rollup
opens first, then each superseded PR is closed with a comment pointing at it —
there is never a moment with no PR open. PRs a human already merged or closed
are left exactly as they are, and GitHub shrinks the rollup's diff to whatever
the base branch is still missing. Also flips the run's `prMode` to `single`, so
later resumes publish the same way. No agents, no tokens.

### `harness status`

```bash
harness status
harness status --all      # finished runs too
```

Prints each run with its state, spend, per-task states, QA iteration counts, and
every pull request it opened as a full clickable URL. Read-only, free, no agents
spawned.

Open runs are shown by default — and if none are open, the most recent finished
run is, because a run that has just ended is exactly when you need to know what
it produced. `--all` prints the lot. When a run reached `INTEGRATING` or
`PR_REVIEW` without opening a single PR, the output says so in those words rather
than omitting the line and leaving you to conclude the list failed to print.

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
  "pitStop": { "every": "epic" },
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
| `models.demo` | `claude-sonnet-5` | — | ✅ | starts the half-built product at a pit stop and drives it — mostly tool work |
| `models.reviewer` | `claude-opus-5` | — | ✅ | judges the demo through one named lens; this is the judgment a pit stop exists to buy |
| `pitStop.every` | `"epic"` | — | ✅ | when the run stops to show you what it built: `"epic"`, `"never"`, `{"tasks":5}`, `{"usd":100}`, `{"minutes":90}` — see [PITSTOP.md](./PITSTOP.md) |
| `pitStop.reviewers` | `product-manager`, `critical-challenger`, `qa-agent` | — | ✅ | one short session per lens, by skill name; max 4, `[]` for none. This is the pit stop's price. |
| `pitStop.demoMaxTurns` | `80` | — | ✅ | the demo agent has to start a product it has never seen; too low and its report says only "I could not start it" |
| `budget.runCapUsd` | `30` | `--run-cap` | ✅ | checked **before every agent turn** |
| `budget.taskCapUsd` | `10` | `--task-cap` | ✅ | |
| `skillsDirs` | `~/.claude/skills`, `~/skills` | — | ✅ | |
| `deterministicChecks` | auto-detected | `--check`, `--no-checks` | ✅ | shell strings, run via `sh -c` in the worktree |
| `githubRepo` | `gh repo view` in the target repo | — | ✅ | `HARNESS_GITHUB_REPO` takes precedence when set |
| `prMode` | `single` | — | ✅ | `single` = one rollup PR for the whole run; `per-task` = one PR per task (they overlap — task branches stack on the integration branch) |
| `externalTools` | everything detected on PATH | — | ✅ | allowlist of CLIs named to worker/QA agents (`gh`, `aws`, `podman`, `docker`, `adb`, `emulator`, `xcrun`, `maestro`); `[]` advertises none |
| *(not in RunConfig)* `dashboard` | `true` | `--dashboard`, `--no-dashboard` | ✅ | CLI-only concern |
| *(not in RunConfig)* `dashboardPort` | first free port from `4777` | `--port` | ✅ | pin it per repo when you want a stable bookmark |
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
| `GITHUB_TOKEN` | no | enables issues + PRs; falls back to `gh auth token` |
| `HARNESS_GITHUB_REPO` | no | `owner/repo`; falls back to `gh repo view` |

The harness also *sets* variables in every task agent's environment. They are not
yours to configure — they are how a task is told what part of the machine it owns:

| Variable | Meaning |
|---|---|
| `COMPOSE_PROJECT_NAME` | `harness-<taskId>-<runhash>`, so `docker compose` / `podman compose` acts only on that task's own stack |
| `HARNESS_PORT_BASE` / `HARNESS_PORT_END` | the 16 host ports the task may bind; derived from the run and task ids, in 20000–28191 (never the ephemeral range) |

See **Worktrees are not machine isolation** under §14 for what this does and does
not protect against.

---

## 9. What the harness writes where

Inside the **target repo**:

| Path | Contents |
|---|---|
| `.harness/harness.db` | event log + materialized run/task/usage state (SQLite, WAL) |
| `.harness/<runId>/BRIEF.md` | the brief the intake conversation produced — what the planner was actually given |
| `.harness/<runId>/planner-attempt-docs-N.txt` | raw output of planning phase A (PRD + conventions), kept verbatim for post-mortem |
| `.harness/<runId>/planner-attempt-dag-N.txt` | raw output of planning phase B (the task DAG), same |
| `.harness/<runId>/PRD.md` | the PRD the planner produced — the thing you approve |
| `.harness/<runId>/CONVENTIONS.md` | conventions injected into every worker's system prompt |
| `.harness/<runId>/plan.json` | full plan incl. task DAG; SHA-256 of this is the approved `planHash` |

Git objects in the **target repo**:

| Ref | Meaning |
|---|---|
| `harness/<runId>/main` | integration branch, cut from `HEAD` at run start; every accepted task merges here |
| `harness/<runId>/<taskId>` | one branch per task, cut from the integration branch *at dispatch time* |

Both are pushed to `origin` when GitHub is configured; nothing else ever is
(SEC-5). Each component PR is opened **from** its task branch **into the branch
the run started from** — not into the integration branch, which already contains
the task by the time the PR is opened and would leave the PR empty. The branch is
recorded as `baseBranch` in the run's config, so a resume targets the same one
even if you have since checked out something else.

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

On by default; `--no-dashboard` runs headless. It binds **127.0.0.1 only**, on
the first free port from `4777` upward — one harness per repo means several
dashboards at once, so a busy port moves to the next one rather than killing the
run. The banner prints the port that was actually taken. `--port <n>` (or
`dashboardPort` in the config) pins it; a pinned port that is busy is an error,
because quietly moving would send you to another run's dashboard.

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

- **Title** — the repository folder the agents are working in, e.g. `harness
  billing-app`, and the same name in the browser tab (`billing-app · Harness`).
  One harness per repo means several dashboards on adjacent ports at once, and
  the folder is the only part of a run you can say out loud. The run id stays in
  the state pill beside it because that is the handle `harness resume` takes.
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
- **Tasks** — grouped into **Needs you**, **In progress**, **Done**, **Queued**
  and **Cancelled**, in that order, each with a count and each collapsible; the
  bar under the heading shows done / in flight / blocked as a share of the plan.
  A flat list of thirty task cards answers no question you actually have; the
  groups answer *what landed*, *what is stuck on me*, and *how far in are we*.
  Done cards carry a green rule and a check, and **Done** counts `ACCEPTED`
  alongside `MERGED` — accepted work has passed QA and is waiting only on the
  integrator. Each card opens to the spec and the acceptance criteria QA signed
  off against ("what it did"), which is the honest answer to what a task
  delivered; what you open stays open across the background refresh. A card also
  carries its state, dependencies, QA iteration count, injected skills, and
  linked issue/PR numbers. Before the plan exists the panel
  explains which phase you are in rather than sitting empty. Issue and PR numbers
  link straight to GitHub: the slug comes from `HARNESS_GITHUB_REPO`, then the
  run's `githubRepo`, and failing both from the repo's `origin` remote — so a run
  started before the slug was recorded still links its issues instead of printing
  a dead `issue #28`. Only `github.com` remotes are linked; a GitHub Enterprise
  remote gets plain text, because a link to the wrong host is worse than none.
- **Pull requests** — every PR the run has opened, as a link, with the task title
  beside it. The one thing you want at the end of a run is the list of things to
  review, and hunting for it across thirty task cards is not that. When there are
  none it says so — and once the run is over, "none" is the answer, not a
  loading state.
- **Run** — repo path, integration branch, elapsed, resolved checks and caps, and
  the full assignment the planner received (the intake brief, if you used one).
- **Cost meter** — spend against the run cap, with a bar that turns amber past
  60% and red past 85%. It only moves when a session *ends*, because that is when
  usage is booked; the note under the meter says so rather than leaving you to
  wonder why a long planner run reads `$0.00`.
- **Gate 1** — when the plan needs approval it takes over the full width above
  everything else, because it is blocking the run.
- **Budget cap reached** — the same treatment when a cap trips ([§12](#12-budget-control)).
  The suggested new cap is pre-filled, and a value you are typing survives the
  background refresh. An agent is paused waiting on this panel, so a rejected cap
  reports the error rather than quietly leaving the run stuck.
- **A task hit its cap** — the task-escalation gate, same amber treatment. One
  card per waiting task: what failed (the QA reasons or the failing check
  output), the branch its work is on, and a textarea. *Send & continue* hands
  your words to the worker with a fresh iteration budget; *Park it for later*
  parks the task as `NEEDS_HUMAN` exactly as an unanswered gate would. The list
  only re-renders when the set of waiting tasks changes, so a half-typed answer
  survives the background refresh. With notifications on, each gate fires a
  desktop notification — this is precisely the "needs you" moment the Notify
  button exists for. An empty answer is rejected rather than treated as
  guidance: a misclick must not spend three more iterations on no information.

### Being told when it is over

A run takes tens of minutes. You are meant to walk away from it, so the harness
tells you when it stops needing to be left alone. Two channels, because neither
one alone is reliable:

- **The terminal.** The CLI rings the bell and raises a desktop notification when
  a run finishes or dies — `osascript` on macOS, `notify-send` on Linux. Both are
  best-effort and neither is awaited: a machine with no notifier must never fail a
  run that already succeeded. This channel always fires, including over SSH (the
  bell) and after the dashboard has already shut down.
- **The dashboard.** Press **Notify me** in the header to grant permission, and
  the page raises a browser notification on the six states worth interrupting you
  for: `PR_REVIEW` (done), `FAILED`, `ABORTED`, `PAUSED`, `BUDGET_HOLD` and
  `PLAN_REVIEW`. The last three are the ones that pay for themselves — the run has
  stopped and will not move again until you act. Permission is requested from your
  click, never on page load, and the choice is remembered.

  The tab title changes too (`billing-app · done`, `billing-app · waiting`), so a
  background tab is readable without notifications at all. Only transitions that
  happen while the page is open count: the stream replays a run's whole history on
  connect, and without that rule the page would announce a gate you resolved an
  hour ago, again on every reconnect.

The CLI stops the dashboard the moment a run ends, well inside the 100 ms window
the event stream normally coalesces on, so terminal transitions are flushed to the
browser synchronously rather than on the timer. Without that the one event you
most wanted was the one guaranteed to be lost.

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

### Routing beats scoring, and order beats both

Lexical matching cannot decide which specialist owns a task — measured against a
real corpus, the top match for a sanctions-screening task was
`testimonial-collector`. So `skillRouting` lets you bind skills to a class of work
by name: `when` is a case-insensitive regular expression tested against the task's
title and spec, and every named skill that exists in `skillsDirs` is injected
before scoring fills whatever room is left. `roleSkills` does the same for a *job*
rather than a topic — the planner carries `product-manager` whatever the
assignment says, because "add rate limiting" is still a product decision.

The defaults route architecture, UI, product, marketing, sales and research work,
plus two narrow rules that must stay near the top of the list:

| Rule | Skill |
|---|---|
| DNS, dns-project, CNAME/TXT records, cert-manager, DNS-01, ACME, Route 53 | `dns-project-iac-engineer` |
| greenfield, scaffolding, technology-stack choice, DynamoDB, magic-link, WebAuthn, serverless | `fullstack-app` |

**A role carries at most four skills.** Rules are applied in list order and the
fifth match is dropped, so a narrow rule placed below a broad one never fires in
practice: a DNS task also says "infrastructure" and a greenfield task also says
"system design", and the architecture rule alone fills all four slots. Put the
specific rule above the general one — the regression tests in
`skillsInjection.test.ts` assert exactly this and go red if the order is reversed.

A rule may also name the `roles` it applies to (`intake`, `planner`, `worker`,
`qa`, `prod`); omit the field and it applies to all of them, which is what every
rule written before this option existed still means. Use it when a skill belongs
to one side of the work rather than to the topic — the UI defaults build with
`frontend-design`, `ui-ux-cx-engineer` and `product-manager`, and grade with
`visual-qa-agent`, which never reaches the agent that drew the screen. It also
buys back cap: a builder skill and a grader skill no longer compete for the same
four slots.

```json
{ "when": "\\b(ui|ux|frontend|screen|theme)\\b", "skills": ["visual-qa-agent"], "roles": ["qa"] }
```

### Design is a planned deliverable, not the first UI task's side effect

The planner is told that when a product has a user interface, one task
establishes the visual language — name, logo, palette, type scale, spacing,
shared primitives — derived from what the product already has, and every other UI
task `dependsOn` it. Without that rule, parallel workers each invent a screen from
nothing in a separate worktree and the result is a set of screens that share no
visual language and belong to no product. Routing the design skills does not fix
it: run `ec40b527` carried `frontend-design` and `ui-ux-cx-engineer` on every UI
task, worker and QA, and still shipped an unbranded generic card. UI acceptance
criteria are also required to be settleable from the rendered screen — "uses the
design system" cannot be judged, "the sign-in screen shows the product logo and
its primary button uses the palette's primary token" can.

### What QA and the validator owe you

Two obligations exist because a green run shipped a broken build:

- **QA runs the application.** For application code the suite passing is where
  verification starts. A criterion satisfied only against a mock, a fake or a
  stub is reported as unverified, not passed; new code must be traced to the
  entrypoint that actually invokes it; and the unhappy path gets exercised too,
  because a handler that swallows its error and answers `{"ok":true}` is
  indistinguishable from a working one. `main.go` never calling
  `store.EnsureTable()` was invisible to `go vet && go test && go build` because
  nothing ever executed `main`.
- **The intent validator checks the seams.** It is the only agent that ever sees
  the merged whole, so it verifies the contracts *between* tasks: field and
  parameter names matching on the wire, routes and env var names agreeing, and
  everything implemented being mounted, registered or called from somewhere. A
  client posting `{token}` to a handler requiring `orderToken` type-checks on
  both sides and passes both suites; a fully implemented router that `app.ts`
  never mounts 404s for every user. Task-level QA cannot see either, by
  construction — each task is judged alone in its own worktree.

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

- The cap is checked **before each turn and on every streamed message**.
- **A cap is a checkpoint, not a wall.** Reaching one opens a *budget gate*: the
  agent that tripped it is paused mid-session and you are asked whether to raise
  the cap. Raise it and that same agent carries on from where it stopped — the
  half-finished task is not thrown away. Decline and the run parks.
- **Unknown model IDs are priced at the most expensive tier.** The estimate is
  never below reality.

`harness status` prints spend per run at any time; the dashboard meter shows it
live against the cap.

### The budget gate

In the terminal:

```
===== BUDGET =====
The run cap of $8.00 was reached: $8.50 spent.
The agent is paused, not cancelled — raising the cap continues it.
New run cap in USD? [enter = $16.50 / s = stop and park the run]
```

On the dashboard the same choice appears as an amber panel above the board, with
the suggested cap pre-filled.

- **Enter / "Raise cap & continue"** — the new cap is written to the run's config
  in SQLite, so a later `resume` runs under the cap you agreed to rather than
  tripping on the old one immediately.
- **A cap at or below what is already spent is refused**, in the terminal and over
  the API. It would trip again on the very next check.
- **"s" / "Stop & park the run"** — the run moves to `BUDGET_HOLD` and the process
  exits with `run parked. Raise the cap and pick it up with: harness resume <id>`.
  Nothing is lost: committed worker output stays on its branch.
- Resuming from `BUDGET_HOLD` under the *same* cap simply re-opens the gate, so
  you get asked again rather than failing.
- A task cap trips the same way and names the task; the run total is shown too, so
  you can tell "this one task is expensive" from "the whole run is".

Both gates are the operator's decision, and the run blocks until you answer. For
an unattended run, set caps you are willing to have the run stop at, and check on
it — there is no auto-raise.

One caveat on "paused, not cancelled": the harness stops reading from the agent's
stream while it waits for you, but it cannot promise the SDK session survives an
arbitrarily long wait. Answer within a few minutes and the agent continues; leave
it overnight and the session may die, in which case the worker is respawned
against its own committed git history — the same recovery path as any crash, so
work is still not lost.

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
| Run `FAILED` at planning, reason `cut off mid-JSON` | the plan was longer than one message allows, 3× | the assignment covers too much — split it, or name a narrower scope |
| Run in `BUDGET_HOLD` | a cap was reached and you declined to raise it | `harness resume <runId>` re-opens the gate; raise it there |
| `BudgetExceeded` | cap reached and declined | raise the cap, `resume` |

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

**`maxParallelWorkers` counts agents, not tasks.** A task sitting at an
escalation gate waiting for your answer holds no agent, so it does not occupy a
worker slot — the run dispatches something else and comes back to it when you
answer. One consequence worth knowing: answering a gate resumes that task
immediately rather than queueing it, so for a few seconds the run can be one
worker over the cap for each gate you answer at once.

**Worktrees are not machine isolation.** Each task gets its own checkout, its own
branch and its own dependency install. It does *not* get its own network stack or
its own container daemon, and three workers running at once share both. Two
mitigations are in place, and neither is a sandbox:

- Every task session carries a `COMPOSE_PROJECT_NAME` of its own, so an agent
  running `compose up`, `restart` or `down` acts on its own containers. Before
  this, every worktree shipped the same compose file and therefore the same
  default project name, and one agent restarting "its" database restarted the
  one every other in-flight task was testing against.
- Every task is given a block of 16 host ports (`HARNESS_PORT_BASE`…`HARNESS_PORT_END`)
  and told in its prompt that the rest of the machine belongs to somebody else.

An agent can still ignore both and bind port 8000 anyway. If you are running
several tasks that each need a database, check that the repo's compose file reads
its host ports from the environment rather than hardcoding them — a hardcoded
shared port is the one failure mode this cannot fix, and it shows up as tests
failing in one task because of what another task did.

**Agents leave processes behind, and the harness kills them.** A session that
ends — cleanly, at its turn cap, or killed — leaves whatever it backgrounded
still running. The harness sweeps its own worktree at the end of every session,
and sweeps the whole run's worktree tree at start and resume. The sweep kills only
processes whose working directory is inside the run's worktrees *and* which have
no controlling terminal, so **a shell you opened yourself in a worktree is left
alone** — but a script you started from that shell and detached is not.

**Workers inherit your PATH, and therefore your CLIs.** `gh`, `aws`, `podman`,
`adb`, `emulator`, `xcrun` and `maestro` are detected at run start and named in
the worker and QA system prompts, each with the rule that governs it — `gh` is
read-only and must never open a PR; `aws` is read-only unless the task names the
resource. The banner lists what was offered.

This is a prompt-level rule, not a sandbox. A worker with Bash could always have
reached these binaries; telling it they exist makes it *use* them, which is the
point for QA (real containers, a booted emulator) and the risk for anything
holding live credentials. Two consequences worth internalising:

- An agent that can run `aws` can, in principle, touch real infrastructure. Set
  `"externalTools"` in `harness.config.json` to an allowlist — e.g.
  `["gh", "podman"]` — for repos that should never see your cloud credentials,
  or `[]` to advertise nothing.
- An agent that can run `gh auth token` can read your GitHub token. Secret
  isolation covers the harness's own plumbing, not what a shell command can
  fetch for itself. This was true before the toolbelt existed.

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
| Read-only roles | intake and the planner are given `tools: ["Read","Glob","Grep"]`, which removes `Bash`/`Edit`/`Write` from their tool set entirely; a planner retry gets `tools: []` |

> The SDK's `allowedTools` is an **auto-approve** list, not a restriction — under
> `permissionMode: "bypassPermissions"` it confines nothing. `tools` is the option
> that removes built-ins. Any new read-only role must set `tools`.

Full threat model: PRD §12.

---

## 15. Troubleshooting

**Every task parks with `iteration cap hit on deterministic checks`**
Almost always the checks cannot pass in a *fresh worktree*, whatever the workers
do. The three ways this has actually happened: the test suite needs a service
that is not running (`podman compose up -d` first); the checks point at a
package the run's tasks never touch (checks ran `web/` while the work was in
`mobile/`) and that package has no `node_modules` in a fresh worktree; or the
suite was already red on the base branch before the run started. Verify with the
exact configured command in a clean worktree of the base branch — not in your
main checkout, which has state a worktree does not inherit. When the escalation
gate asks, the fix is one answer: say what to start or skip, and the run
continues.

**The run is sitting still and nothing is spending**
Look for an amber panel: a gate is open and an agent is paused on your answer —
plan approval, a budget cap, or a task at its iteration cap. A gate never times
out; unanswered, it waits indefinitely. In a terminal run the same question is
sitting on stdin.

**`harness: command not found`**
The symlink target directory is not on your PATH. See [§3](#3-install) — with the
default `pnpm link-cli` location, add `export PATH="$HOME/.local/bin:$PATH"` to
your shell profile.

**`... is not inside a git repository`**
You are outside the target repo. `cd` into it, or pass `--repo <path>`.

**`N planner attempts rejected — …`**
Planning runs in two phases, and the message says which one failed.

*Phase A* surveys the repository and writes the PRD and the conventions document
as plain markdown between `<prd>` and `<conventions>` tags. Two attempts; raw
output in `.harness/<runId>/planner-attempt-docs-N.txt`.

*Phase B* turns that prose into the epic/task DAG as JSON, with no tools at all —
the survey already happened and its output is quoted back. Three attempts; raw
output in `.harness/<runId>/planner-attempt-dag-N.txt`. The message names which of
the three failure modes happened: the JSON could not be read, it did not match the
required shape, or it was not a valid DAG.

Read attempt 1 first. If the analysis looks right and only the output was
malformed, the assignment is fine and it is worth re-running. Only phase A ever
surveys the repository; phase B retries repair the previous JSON with a 4-turn
budget, because a rejected DAG is nearly always a formatting failure rather than a
thinking failure — re-deriving the decomposition three times is what once turned a
single failed planning phase into $3.34.

**`ran past the output-token limit and was cut off`**
A message that hits the output ceiling comes back as unparseable text, which looks
exactly like bad JSON unless you check for it.

The split above is the fix. A PRD, a conventions doc and every task spec
JSON-escaped into one object does not fit in one message for any real repository —
and escaping thousands of words of markdown into a JSON string is itself most of
the cost. Emitted separately, each half fits comfortably.

Do not count on raising the ceiling instead. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is
requested at 64k, but the SDK clamps it against a per-model table matched by
substring, and a model the installed SDK predates falls through to **32k** no
matter what you ask for. Check with:

```bash
node -e 'console.log(require("@anthropic-ai/claude-agent-sdk/package.json").version)'
```

If a phase still truncates on all its attempts, the assignment is too broad: name
a narrower scope, or split it across runs. "Review everything and fix all the
issues" is the shape that does this.

**`No commits between harness/<runId>/main and harness/<runId>/<taskId>`**
Fixed — but if you see it, you are on a build from before component PRs were
based on the run's start branch. The integrator merges each accepted task into the
integration branch *and then* opens its PR, so a PR based on the integration
branch has no commits of its own and GitHub rejects it with a 422. Rebuild
(`pnpm -r build`) and start a fresh run; a run already in flight keeps the old
behaviour.

A genuinely empty task branch — a task that produced no diff — is no longer an
error either. It is reported on the activity log as *"no commits that `<base>` does
not already have"* and the run carries on.

**A PR failed to open, but the task says `MERGED`**
That is intended. The merge is the work; the PR is how you see it. A GitHub
outage, an expired token or a rejected push no longer unwinds an accepted, merged
task — the failure is logged as *"merged locally, but the pull request could not
be opened"* and the run continues. The commits are on `harness/<runId>/<taskId>`
and in `harness/<runId>/main`; open the PR by hand, or re-run once the cause is
fixed and the idempotency check will find the branch rather than duplicating it.

**`issue #28` on a task card is plain text, not a link**
The dashboard could not work out which repository the number belongs to. It tries
`HARNESS_GITHUB_REPO`, then the run's stored `githubRepo`, then the `origin`
remote — so this now means the repo has no `origin`, or `origin` is not on
`github.com` (a GitHub Enterprise remote is deliberately not linked, because a
link to the wrong host is worse than no link). Set `HARNESS_GITHUB_REPO=owner/repo`
to force it. Note the issue itself is fine either way; only the link is missing.

**The run ended in `PR_REVIEW` but there are no pull requests**
`PR_REVIEW` means the harness has stopped, not that it succeeded. If the closing
line reads `no pull requests opened`, nothing was pushed and there is nothing on
GitHub to look for. The usual cause is a foundation task parking: everything that
depends on it, directly or through another task, becomes unreachable and is
cancelled without being attempted. The closing line names each parked task, why
it stopped, its issue, the branch its work is on, and how many tasks were queued
behind it; `harness status` prints the same after the fact. Two earlier builds
printed `PRs opened; human review on GitHub` unconditionally here — that message
was wrong, not a sign that the PRs went missing.

**`harness resume` says there is nothing to resume**
The run is already in a terminal state (`PR_REVIEW`, `FAILED`, `ABORTED`) and no
state machine will move it again. Resume is for a run interrupted mid-flight. A
parked task's work is committed on its own `harness/<runId>/<taskId>` branch —
take it forward by hand, or start a fresh run now that you know what stalled.

**A task is `NEEDS_HUMAN` and the card does not say why**
It should: the reason is written to the task when it parks, and the dashboard
falls back to the transition event for runs recorded before that was stored. If
it is still blank, the activity feed has the QA verdicts and the check output —
filter to *state* to find the transition, then read backwards from it.

**The run finished and nothing told me**
Check the header button reads **Notifying**, not *Notify me* — permission is only
requested when you click it, and browsers scope the grant per port, so a dashboard
that moved from `4777` to `4778` needs the grant again. The terminal is the
fallback that always fires; if even the bell is silent, your terminal has the
audible bell turned off. `notify-send` on Linux needs a notification daemon
running, which a bare SSH session does not have.

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

**`listen EADDRINUSE: address already in use 127.0.0.1:4777`**
Fixed — the dashboard now takes the next free port. If you still see it, you
pinned a busy port with `--port`; drop the flag or choose another. Note that this
error used to kill the run *before* the intake prompt appeared, which looked like
the conversation being missing rather than a port clash.

**Dashboard loads but the board says "auth failed"**
You opened the URL without the `#token` fragment. Copy the full line the CLI
printed. The token changes every process — an old bookmark will not work.

**Nothing appears in the dashboard event log**
Check the run ID is open (`harness status`). The stream only tails events for
runs returned by `/api/state`.

**No issues or PRs appear**
Check the `github` line in the run banner first — it names the credential source,
or says `off` with the reason. Either `gh` is not authenticated and no
`GITHUB_TOKEN` is set, the repo has no GitHub remote, or the token lacks
Issues/PR write. `gh auth login` is usually the whole fix. The run itself
degrades to local-only rather than failing, so also check `harness status` for
merged tasks with no PR number.

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
