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
   ↓       ↳ FAIL → one task per gap, queued and built, then judged again
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

Before a task parks, though, somebody is asked first. Hitting a cap opens a
**task-escalation gate**: an advisor agent reads the failure in the task's own
worktree, checks QA's claims against the code, and writes the answer — one
sentence like "the tests need DynamoDB running — `podman compose up -d` first",
"skip that flaky check", "you misread the spec: do X" — which restarts the
worker with a fresh iteration budget.

**By default that answer is sent without waiting for you.** `taskGate.decidedBy`
names the skill that gives it (`product-manager` out of the box); the advisor
wears that hat, with the skill's playbook in front of it, and the run carries on.
You still see the escalation and the answer, in the terminal and in the run's
events. Two things bring the question back to you: an answer only a person can
give — a service to start, a credential to issue, a product decision nobody has
made, or an investigation that came back genuinely unsure — and a task that has
already been answered by the skill `taskGate.autoAnswerRounds` times (default 2),
because an agent answering its own escalations resets the very counters that
bound it.

When it does come to you, it arrives as it always did — in the terminal, or as
an amber panel (and a desktop notification) on the dashboard — with the
advisor's draft prefilled. Leaving it blank, or clicking *Park it*, parks the
task. Set `{"taskGate":{"decidedBy":"operator"}}` to be asked every time, which
is what the harness used to do.

One escalation is not like the others. A task's **completion probe** is checked
before QA and the worker is forbidden to edit it, so when the probe itself is
wrong, no answer can end the gate it opened: "the probe is a false positive,
leave it alone" is correct, and leads straight back to the same gate. Run
f338b5c8 went round that nine times on one task before anybody noticed the
answer was never the thing that could help. So at *that* gate the decider may
also rewrite the probe — narrowing it, usually, rather than dropping it — once
per task (`taskGate.probeAmendments`), recorded as `task.probe_amended` with its
name against it, and the new probe is tried on the spot rather than costing
another worker round.

You have the same power, unbounded, and you do not need to stop the run to use
it:

```bash
harness probe ui-login "rg -q useShortcuts src/AppShell.vue" --why "the old one grepped a generated file"
harness probe ui-login --clear      # withdraw it; QA alone judges the task
```

The task loop re-reads its task every iteration, so this lands on a run in
flight. When the advisor believes a probe is wrong but is not the one who may
change it, it logs that exact command with its proposed replacement already in
it.

Two more things happen between the last task and `PR_REVIEW`. First, a
**validator agent** reads the integration branch whole and judges it against
your original assignment — did the sum of the merged tasks deliver what you
asked for, not merely pass their own acceptance criteria? Its verdict (and each
gap it finds) goes into the closing report and the run's events.

**A FAIL does not just get reported — the harness goes and closes it.** Each gap
becomes a task in its own `intent-gaps` epic, chained one after another (the
gaps are usually the same omission seen from several angles, so they land in the
same files and racing them would only produce merge conflicts), and the run goes
back to `EXECUTING` to build them. When they have merged, the validator reads the
tree again. This happens **once** by default: `{"intentFixRounds": 0}` restores
the old behaviour of reporting the verdict and stopping there, and up to 3 is
allowed. The gaps are stated against a tree that already exists, which is what
makes them the cheapest work in the run — and leaving them for the human meant
the harness declined to make exactly the fixes it was best placed to make. If a
round of fixing does not satisfy the validator, the second verdict is reported
and the PRs open carrying it.

Second, only after that verdict is the pull request opened — by default **one
rollup PR for the whole run**, from the integration branch, listing every merged
task (one `--no-ff` merge commit each) with the validator's verdict in the body,
so a reviewer never sees a PR the harness has not finished judging. A FAIL
verdict does not withhold the PR — the harness never merges, and human review is
exactly where a gap it could not close belongs — but it is printed first, above it.

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
agents against your 5-hour and weekly limits. Two different mechanisms cover the
two windows, and both are on by default:

- **The 5-hour window is slept through.** A session that hits it waits for the
  reset and continues the same conversation (`usageLimitWaitMinutes`, default six
  hours). Nothing is retried against the wall and nothing is lost.
- **The weekly window is stopped for.** At 95% the run pauses, alerts you, and
  asks — because a run that walks into the weekly wall on a Tuesday is parked
  until Friday. See [§12.1](#121-subscription-limits).

Either way `harness resume <runId>` continues from where the run stopped, and
nothing already finished is re-executed or re-paid.

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
  build      0.0.1@7453d60
  checks     pnpm run typecheck · pnpm run lint · pnpm run test   (auto-detected from package.json scripts via pnpm)
  budget     run $30 · task $10   (defaults)
  skills     /Users/you/.claude/skills · /Users/you/skills   (defaults)
  intake     conversation before planning   (default)
  dashboard  http://127.0.0.1:4777/#a1b2…   (the fragment is your auth token)
```

Read that banner before answering anything. If `checks` says `none`, QA has no
hard signal and you should add one with `--check`.

`build` is the harness itself: its version and the commit it was built from,
with a trailing `+` when the checkout had uncommitted changes. Every session
this run spawns is stamped with that same string, so a postmortem months later
can say which fixes the run actually had. It is fixed at process start —
**building a fix while a run is executing does not reach that run**, because
Node loaded its build when the process started and cannot reload it. To give an
in-flight run a fix, stop it, build, and `harness resume`.

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
| `--account <name>` | the account you are logged into | spend a named Claude subscription from `subscription.accounts` ([§12.1](#121-subscription-limits)) |

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
as `run`, plus `--account <name>` to continue on a different Claude subscription
([§12.1](#121-subscription-limits)) — the reason a run parked in `LIMIT_HOLD`
usually gets resumed at all.

A *finished* run still resumes when it has recoverable work. Each `NEEDS_HUMAN`
task opens its escalation gate now — the same gate, so `taskGate.decidedBy`
applies here too: the skill re-reads each parked task in its worktree and either
revives it with guidance or hands it to you, and a task that already spent its
`autoAnswerRounds` is yours whatever the config says. An answer revives it with a
fresh iteration budget and puts its "unreachable" `CANCELLED` dependents back in
the queue; declining (or an empty answer) leaves it parked. A `CANCELLED` task whose
blockers have **since merged** (revived in an earlier session, say) is requeued
without any gate — the work it was waiting for exists now. Merged tasks whose
pull requests never opened get them retried, and a run from before base-branch
capture has its base branch repaired from the repo's current branch first. A
reopened run re-runs the intent validator only if something new merged since the
last verdict. Fix the environment before you resume — start the service the
checks need, correct the checks in `harness.config.json` — or your answer buys
iterations that fail the same way.

A run interrupted **mid-conversation** gets the conversation back. The intake
agent's session is gone, but every question and answer is on the event log, so
resume hands the new session what was already settled and puts the questions
nobody answered in front of you first. It says so before it starts:

```
This run stopped mid-conversation — picking it up where it left off.
```

This matters more than it sounds. A conversation stops mid-question far more
often than it stops between them, and the question in flight is by construction
the one the agent judged most worth asking. Run 40da9337 was interrupted holding
*"do you want real vendor accounts wired up, or adapters against sandboxes, or
interfaces and fakes only?"*, resumed straight past it, planned mocks, and
shipped six of seven integrations as `throw notConfigured()` — every task green.
If you resume headlessly, with no terminal to answer in, the run still plans from
the assignment, but each dropped question is named in the log and counted in the
state-change reason rather than disappearing.

### `harness postmortem [runId]`

```bash
harness postmortem            # the most recent run
harness postmortem 40da9337   # a specific one
```

Answers the question `status` does not: **why is this what I got?** Local queries
only — no agent, no cost. It reports, in the order that most often explains the
outcome:

- **intake questions with no answer on record**, because the plan was made without them
- **the plan-gate verdict**, and whether the plan was sent back or approved anyway
- **the end-of-run verdict**, and how many of its gaps became tasks
- **tasks whose acceptance criteria never require anything to leave the process** — a task is finished when its criteria are met, so one of these was free to ship a stub
- **spend grouped by how the session ended**, and the hours the run spent waiting on you
- **which harness build each session ran under** — one line when the run used one build, and a table when it did not, because a run whose sessions carry two builds did not run one harness

Run against 40da9337 it prints, first line of the report:

```
1 intake question(s) went unanswered, so the plan was made without them:
  - For "all the integrations" — do you want real vendor accounts wired up, or
    production-shaped adapters running against sandboxes with no real money movement?
```

That one line is the whole explanation for a $773.55 run that shipped six of
seven integrations as stubs. Working it out by hand took an hour of SQL.

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

### `harness probe <taskId> [command]`

```bash
harness probe ui-login "rg -q useShortcuts src/AppShell.vue"   # hold it to this instead
harness probe ui-login --clear --why "it belonged to another task"
harness probe ui-login                                          # print the current one
```

Rewrites the completion probe a task is stuck on — the definition of done the
worker is forbidden to edit and QA never gets to argue with. A probe that cannot
pass reopens the same escalation gate every few iterations for as long as the
budget lasts, and until this command existed the only way to change one was to
edit SQLite by hand.

It lands on a run in flight: the task loop re-reads its task at the top of every
iteration, so there is nothing to stop and nothing to resume. Defaults to the
newest run holding that task (`--run` picks another), records the change as
`task.probe_amended` against `operator`, and does nothing at all when given
neither a command nor `--clear` — withdrawing a task's definition of done should
never be a thing you did by leaving an argument off. Read-only as far as agents
go: no tokens.

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
  "budget": { "runCapUsd": 50 },
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
| `maxParallelWorkers` | `3` | — | ✅ | concurrent *agents*, not tasks — one waiting at a gate is using neither the machine nor the API and does not hold a slot. Tasks whose planned `touchedPaths` overlap something in flight wait rather than race it into a merge conflict. |
| `qaIterationCap` | `3` | — | ✅ | worker↔QA round trips before a task is parked as `NEEDS_HUMAN` |
| `workerRespawnCap` | `3` | — | ✅ | crashed-session restarts before parking; the replacement gets a "read your own git log and continue" note |
| `workerMaxTurns` | `120` | — | ✅ | turns before the SDK cuts a worker off. A session that hits it is the most expensive kind of failure — it dies having done the most work — so hitting it raises the ceiling **for the whole run**, not just that task: the repository is the same size for all of them. |
| `qaMaxTurns` | `90` | — | ✅ | the same knob for QA, raised the same way. A QA session that runs out of turns never writes its verdict. |
| `taskWallClockMinutes` | `45` | — | ✅ | a task looping this long without being accepted opens a gate. Answering **any** gate re-arms the clock, so the bound measures unattended time rather than time since dispatch. |
| `usageLimitWaitMinutes` | `360` | — | ✅ | how long **one session** may sleep waiting for your account's usage limit to reset. A quota window closing kills every session in flight at once ("You've hit your session limit · resets 8:20pm") and is not a fault in the work, so the pool waits it out and continues the same session — same conversation, same bill, no attempt or respawn spent on it. Per session rather than per run, so an overnight run survives several outages of this length. Past the bound the failure is reported as it always was; `0` restores that immediately. |
| `models.intake` | `claude-opus-5` | — | ✅ | this one talks to you; question quality is the whole value. **Anthropic only** — see [Using other providers](#using-other-providers) |
| `models.planner` | `claude-opus-5` | — | ✅ | planning quality dominates run cost efficiency |
| `models.worker` | `claude-sonnet-5` | — | ✅ | |
| `models.workerLight` | `claude-haiku-4-5-20251001` | — | ✅ | the worker model for tasks the light-tier rule admits — sized `S`, at most two `touchedPaths`, carrying a `completionProbe`, and matching none of the risky domains (auth, money, migrations, concurrency, infrastructure). The rule is deterministic and lives in `modelTier.ts`; the planner does not nominate its own tier. A light session that dies of `error_max_turns` is re-dispatched on `models.worker` rather than retried here. Set it to the same value as `models.worker` to switch the experiment off while keeping the measurement — the rule still runs and still publishes `task.tier_decided`. |
| `models.qa` | `claude-sonnet-5` | — | ✅ | **Anthropic only** — its verdict decides whether a task merges |
| `models.integrator` | `claude-sonnet-5` | — | ✅ | **not currently used** — integration is deterministic git work, not an agent session. Setting it has no effect. |
| `models.advisor` | `claude-sonnet-5` | — | ✅ | drafts your answer when a task escalates |
| `models.prod` | `claude-opus-5` | — | ✅ | **Anthropic only** — the last word on whether the run delivered the assignment |
| `models.demo` | `claude-haiku-4-5-20251001` | — | ✅ | starts the half-built product at a pit stop and drives it — mostly tool work, at an 80-turn ceiling. Cheap because the demo's thoroughness is checked in code rather than taken on trust: `plannedJourneys` is compared against what came back, and a demo that fell short of its own plan is published as INCONCLUSIVE rather than as thin evidence. |
| `models.repair` | `claude-haiku-4-5-20251001` | — | ✅ | re-asks a finished QA session for the verdict JSON it produced but did not format. Two turns, against a resumed session, restating a conclusion reached on the judging model — there is no judgment left to degrade. Fires only when a QA agent ignores its output contract. |
| `models.reviewer` | `claude-opus-5` | — | ✅ | judges the demo through one named lens; this is the judgment a pit stop exists to buy. **Anthropic only** |
| `models.pm` | `claude-opus-5` | — | ✅ | every decision a skill makes instead of you: what the run does next at a pit stop, whether a failing plan goes back to the planner, and whether a cap that was reached is raised. The only agent whose output redirects the remaining work, re-plans it, or spends money on its own, so it is the last place to save money. |
| `pitStop.every` | `"epic"` | — | ✅ | when the run stops to show you what it built: `"epic"`, `"never"`, `{"tasks":5}`, `{"usd":100}`, `{"minutes":90}` — see [PITSTOP.md](./PITSTOP.md) |
| `pitStop.reviewers` | `product-manager`, `critical-challenger`, `qa-agent`, `ui-ux-cx-engineer` | — | ✅ | one short session per lens, by skill name; max 4, `[]` for none. This is the pit stop's price. |
| `pitStop.reviewFirstPass` | `2` | — | ✅ | how many lenses read the demo before the harness decides whether the rest are worth buying. The remaining ones are bought only when the first pass suggests there is something to find — any lens not `on-track`, any disagreement, a lens that did not finish, or an INCONCLUSIVE demo. `0` runs them all every time. Which lenses were skipped, and why, is printed with the report. |
| `pitStop.demoMaxTurns` | `80` | — | ✅ | the demo agent has to start a product it has never seen; too low and its report says only "I could not start it" |
| `pitStop.decidedBy` | `"product-manager"` | — | ✅ | who decides what the run does next, by skill name — or `"operator"` to be asked, which is what this used to be. The named skill reads the same report you would, plus what earlier pit stops in the run already decided, and answers the same four ways (continue / redirect / re-plan / stop). One that fails, or answers with something that is not one of the four, falls back to asking you. |
| `pitStop.backToWorkRounds` | `2` | — | ✅ | how many times the **closing** pit stop — the one a FAIL from the intent check opens — may send the run back to work before the next one comes to you whatever `decidedBy` says. It is the only pit stop that repeats over the same tree, and a loop a human ends by losing patience needs another way to end. |
| `taskGate.decidedBy` | `"product-manager"` | — | ✅ | who answers a task that has **escalated** — one QA keeps rejecting, or one stuck on a probe it may not edit — by skill name, or `"operator"` to be asked yourself, which is what this used to be. Not `budget.decidedBy`, four rows down, which answers a task that has run out of *money*; a task can hit either without hitting the other. The advisor investigates exactly as before; naming a skill means it answers as that skill and the answer goes straight to the worker. It hands the question back to you when only a person can settle it (something to start or provide outside the repo, an unmade product decision, a plan that is wrong rather than an attempt that is) or when its session returned nothing usable. |
| `taskGate.autoAnswerRounds` | `2` | — | ✅ | how many times a skill may answer the **same** task's escalation before the next one comes to you whatever `decidedBy` says. Each answer resets that task's iteration and respawn counters, so this is the bound on an agent answering its own escalation in a circle. `0` asks every time. |
| `taskGate.probeAmendments` | `1` | — | ✅ | how many times the decider may rewrite the **completion probe** it is escalating about, rather than answering around a probe no answer can satisfy. Recorded as `task.probe_amended`. `0` makes probes unamendable by any agent; your own `harness probe` is never bounded. |
| `budget.runCapUsd` | `30` | `--run-cap` | ✅ | one cap for the whole run, checked **before every agent turn**; the plan gate prices the plan against it before you approve. Raise it any time — reactively from the `BUDGET_HOLD` gate, or proactively from the dashboard header (click the `$` figure) or the CLI's live `budget run <usd>` stdin command — without waiting for it to be reached. |
| `budget.decidedBy` | `"product-manager"` | — | ✅ | who answers the cap once it is reached, by skill name — or `"operator"` to be asked, which is what this used to be. The skill is shown what is still in flight, what is queued behind it and what is still unbuilt before it names a figure. It may also decline, which parks the run exactly as your own `s` did. |
| `budget.ceilingUsd` | *(unset)* | — | ✅ | how far a skill may raise the cap. Unset means the gate is always yours — the run cap is the agreement, and an agent that can raise its own ceiling has none. `{"budget":{"runCapUsd":100,"ceilingUsd":600}}` reads as "go to 600 without me if the work is worth it". A figure above the ceiling is held at it. |
| `budget.autoRaiseRounds` | `3` | — | ✅ | how many times a skill may raise the cap before the next one comes to you whatever `decidedBy` says. A cap reached three times is not an estimate that was slightly off. `0` asks every time. |
| `subscription.pauseAtPercent` | `95` | — | ✅ | how much of the account's **plan** may be spent before the run stops and asks ([§12.1](#121-subscription-limits)). Not the run's dollar cap: this is quota the account burns across every machine you use, and it is what a subscription run actually runs out of. `100` restores the old behaviour of noticing only at the wall. |
| `subscription.windows` | `["seven_day"]` | — | ✅ | which limit windows that applies to, matched as name prefixes — `seven_day` covers the plan-wide weekly window and the per-model ones beside it. Add `"five_hour"` to be asked about the short window too; by default it is slept through instead (`usageLimitWaitMinutes`), because it reopens on its own. |
| `subscription.accounts` | `[]` | — | ✅ | the Claude subscriptions a run may be pointed at: `{"name":"work","env":{"CLAUDE_CONFIG_DIR":"…"}}` or `{"name":"personal","env":{"CLAUDE_CODE_OAUTH_TOKEN":"$TOKEN_VAR"}}`. A `$VAR` value is read from your shell when a session is spawned, never from this file. |
| `subscription.active` | `""` | `--account` | ✅ | which of them the run is spending; empty is the account you are logged into. **Not frozen at creation** — `harness resume --account <name>` changes it, which is the point. |
| `subscription.preflight` | `true` | — | ✅ | read the account's utilization once before the run spends anything, instead of waiting for a live session to report it. Costs no model tokens; returns nothing (and changes nothing) for accounts whose plan does not meter. |
| `planGate.decidedBy` | `"product-manager"` | — | ✅ | who weighs the plan-intent check's gaps before you approve past them, by skill name — or `"operator"` to be shown the list and asked, which is what this used to be. It has two actions and **approve is not one of them**: it either sends the plan back to the planner on its own authority, or accepts the gaps in writing, with its reasoning printed underneath the gap list you then approve or reject. Runs only when the check FAILs; a decider that fails leaves you the gate you always had. |
| `planGate.replanRounds` | `1` | — | ✅ | how many times the adjudicator may send a plan back over the intent check's gaps before the gate is yours however it answers. Each round is a planner session and another check, and a gap the planner cannot close twice is a question about the assignment rather than about the plan. `0` turns the veto off and leaves its reasoning as a note on the gate. |
| `intentFixRounds` | `1` | — | ✅ | how many times a FAIL from the intent validator may queue work to close its own gaps; `0` reports the verdict and stops there |
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
  budget: { runCapUsd: 50 },
  deterministicChecks: ["pnpm test"],
}));
```

Auto-approving Gate 1 like that removes the only cheap check on a bad plan. Use it
for CI of the harness itself, not for real work.

### Using other providers

A model is a plain string, and the vendor is read from the name: `claude-*` goes
to Anthropic, `gpt-*` to OpenAI, `gemini-*` to Google. Nothing else changes.

```json
{ "models": { "worker": "gpt-5.6-terra", "integrator": "gemini-3.5-flash-lite" } }
```

Export that vendor's key (`OPENAI_API_KEY`, `GEMINI_API_KEY`) and run. If the key
is missing the run refuses to start rather than failing at the first dispatch of
that role — `demo` first runs at a pit stop, after the whole epic has been paid
for. Spell the provider out as `openai/<model>` if you ever need a model whose
name does not announce its family.

**The default is all-Anthropic except one role.** `reviewer` is pinned to
`gemini-3.6-flash`, so `GEMINI_API_KEY` is required for every run — see the
pinned-role table below for why. Nothing else routes off Anthropic unless you
say so.

#### Changing it mid-run

You do not have to decide at the start. `--model` works on `run` and on
`resume`, and on `resume` it re-routes the roles for **the rest of the run**:

```bash
harness resume --model worker=gpt-5.6-terra --model demo=gemini-3.5-flash-lite
```

This is the knob for the run that is spending faster than it is building. The
tasks still queued are the only ones that can still be made cheaper, so a
routing table frozen at run start is frozen at the least useful moment. Editing
`models` in `harness.config.json` and resuming does the same thing; the flag wins
over the file, because nobody wants to edit JSON to stop a run from spending.

Only the roles you name change — the rest keep what the run already had. A
misspelled role is an error, not a silent no-op, and the pinned roles below and
the key check both still apply, so `resume` refuses the same things `run` does.
Completed tasks are never re-executed, so re-routing only ever affects work that
has not happened yet.

**Four roles are not yours to route**, and the run refuses to start if you move
them. Three are pinned to Anthropic and one to Google:

| Role | Pinned to | Why |
|---|---|---|
| `qa` | Anthropic | its verdict decides whether a task merges |
| `reviewer` | **Google** | its judgment is the thing a pit stop exists to buy, and it is held off the family that wrote the code |
| `prod` | Anthropic | it is the last word on whether the run delivered the assignment |
| `intake` | Anthropic | it asks you questions through an in-process tool only the Anthropic transport can expose |

`qa` and `prod` are policy in the ordinary direction. A cheaper judge does not
report that it judged worse — it reports PASS, and you find out at the pull
request, so they stay on the models their thresholds were calibrated against.

`reviewer` is policy in the other direction, and the reason is independence
rather than price. Every line it reads was written by an Anthropic worker and
has already passed an Anthropic QA; a reviewer from the same family is fluent in
exactly the reasoning that produced the work, so the objection it is least
likely to raise is the one the pit stop exists to buy. A second vendor costs one
API key and returns an opinion whose errors are uncorrelated with the ones
already in the diff. It does not drag `qa` and `prod` with it because their
verdicts are mechanical — criteria against a diff — where the reviewer's is
open-ended, which is both why independence helps it most and why nothing
downstream parses its wording.

`intake` is a capability: an intake agent that cannot ask would invent your
answers instead.

Each pinned role also has a floor within its own vendor, so the pin cannot be
satisfied by the cheapest model that happens to carry the right brand:
`claude-haiku-*` is refused for the Anthropic three, and `gemini-*-lite` for
`reviewer`. Flash is above the floor, and is what `reviewer` defaults to.

**Runs created before the pin are rewritten at open.** They recorded
`reviewer: "claude-opus-5"`, which the config now refuses, and the stored config
is re-parsed on every read — so without the rewrite those runs would not merely
refuse to resume, they would be unreadable: no ledger, no postmortem, no
dashboard row. Resuming one reviews on Gemini from that point on.

**What is different off Anthropic.** Those sessions do not run inside the Claude
Agent SDK; the harness runs the tool loop itself and gives the agent Bash, Read,
Write, Edit, Glob and Grep. This is no longer only a thing that happens when you
ask for it: pinning `reviewer` to Google put the default routing on this
transport at every pit stop. Everything the run is accounted for by is unchanged
— the ledger, the budget gate, the stall watchdog, the turn ceiling, the
worktree sweep, and mid-flight feedback from the dashboard all behave the same.
A vendor that is briefly unable rather than refusing — Gemini's "the model is
overloaded" 503 — is retried twice, seconds apart, the way the SDK retries its
own; a rate limit is not, because the pool waits that one out properly instead,
keeping the session and saying so on the bus. Three things do differ:

- **The infrastructure guard still applies.** It is the same
  [`infraMutation`](../packages/core/src/infraGuard.ts) check on the same
  command, called before any shell runs. It is not optional on any transport.
- **No resuming.** The OpenAI and Gemini APIs are stateless, so a re-dispatched
  worker starts cold instead of re-attaching to its own conversation. The run
  log says so when it happens.
- **No `WebSearch`, `WebFetch`, or MCP tools.** A role configured to need one is
  refused at the gate rather than left quietly unable to do its job.

Prices for the routed models live in
[`packages/core/src/budget.ts`](../packages/core/src/budget.ts). A model with no
row is charged at the top tier — over-charging stops a run early, where
under-charging would let a cap silently stop binding.

### Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | one of these | Claude Pro/Max subscription credential |
| `ANTHROPIC_API_KEY` | one of these | Anthropic API credential; **wins if both are set** |
| `OPENAI_API_KEY` | only if a role is routed to OpenAI | see [Using other providers](#using-other-providers) |
| `GEMINI_API_KEY` | **always** | `reviewer` is pinned to Google; `GOOGLE_API_KEY` also accepted |
| `GITHUB_TOKEN` | no | enables issues + PRs; falls back to `gh auth token` |
| `HARNESS_GITHUB_REPO` | no | `owner/repo`; falls back to `gh repo view` |

Any of these may be written to a `.env` file instead of exported. It is read
from **the directory you run `harness` from**, which is deliberately not the
repository given by `--repo`: that repository is the thing being built, a task
spec can write to it, and reading credentials out of it would let one run choose
which keys the next one uses. A variable already exported wins over the file, so
`GEMINI_API_KEY=… harness run` stays a working one-off override, and a missing
or unparseable `.env` is not an error — the key check a moment later names the
variable and the role that needed it.

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
- **Ask the PM…** — under the feedback box, the one control that can open a pit
  stop on your say-so rather than at a boundary the plan crossed. Type the
  question first (it will not arm without one), then confirm: the demo agent
  starts the half-built product and drives what you asked about first, every
  reviewer lens reads it, and the PM answers you and recommends what to do next
  — and then *you* decide, whatever `pitStop.decidedBy` names. It works even
  with `{"pitStop": {"every": "never"}}`. Nothing in flight is interrupted; the
  run stops dispatching new tasks and the stop opens once the running ones
  settle, with a free **Cancel** in the Now panel until it does. Asking twice
  replaces the question rather than buying a second demo. See
  [PITSTOP.md](./PITSTOP.md).
- **Run** — repo path, integration branch, elapsed, resolved checks and caps, and
  the full assignment the planner received (the intake brief, if you used one).
  It also holds **Models**, the run's model-per-role table, editable for the rest
  of the run: click a value, pick another model, and every agent started from
  then on uses it — a session already running keeps the model it was spawned on,
  because the harness re-routes by spawning fresh rather than switching under a
  conversation whose prompt cache is what makes it affordable. This is the knob
  to reach for when spend is climbing faster than the work, and it does not need
  a `harness resume` to apply. The four judging roles (`intake`, `qa`,
  `reviewer`, `prod`) are shown as text with no control at all: they decide
  whether work is correct or shippable, and the server refuses to move them below
  the judging floor whatever a stale tab asks for.
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
  the page raises a browser notification on the states worth interrupting you
  for: `PR_REVIEW` (done), `FAILED`, `ABORTED`, `PAUSED`, `BUDGET_HOLD`,
  `LIMIT_HOLD` and `PLAN_REVIEW`. The last four are the ones that pay for
  themselves — the run has stopped and will not move again until you act. The
  subscription gate raises one of its own the moment it opens, before the run is
  parked, because that one is worth nothing unless it is answered while the
  window is still open. Permission is requested from your click, never on page
  load, and the choice is remembered.

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
- **The intent validator asks whether it could ship.** Separately from the seams,
  it judges the tree as something that has to run somewhere for real: are the
  third-party clients live or stubs, does anything actually *schedule* the
  background work, is there a deployment artifact, do the credentials the live
  path needs have a home, can the product send the mail it promises, and would a
  failure ever be noticed. It judges these against what you asked for — a plan
  that deliberately scoped live vendors out has no gap here — but silence is not
  a scope decision.

**The plan is checked against the assignment before it is built.** The harness
has always asked "does the sum of this do what was asked?" — but at the end, of
the merged result, when the answer costs a whole run. It now asks the same
question of the plan, for about a dollar, and puts the answer in the plan
summary:

```
What this plan would not deliver, read against your assignment:
  - provider-layer's only criterion asks for a deterministic mock for all seven
    vendor categories, and no task requires a call to any vendor.
```

**A FAIL is weighed before you see it.** The check works; what did not work was
what an advisory finding is worth at nine in the evening, when the alternative
to `y` is composing re-planning feedback out of a list of absences. Run f338b5c8
was shown four gaps — one of them the missing mechanism that made its own M0
gates unmeasurable — and approved them two and a half minutes later. Fifty-one
tasks and $475 afterwards it stopped at a pit stop over exactly that gap, having
opened no pull request.

So `planGate.decidedBy` (`product-manager` out of the box) reads the assignment,
the PRD, the plan and the gaps first, and does one of two things. It can **send
the plan back to the planner on its own authority** — nothing is built yet, so
this costs one planner session and nothing else — or it can **accept the gaps in
writing**, in which case its reasoning is printed underneath them and you approve
or reject as before.

It cannot approve. That is yours, and you are at the keyboard: you started this
run a few minutes ago, so there is nothing to win by taking it. What there is to
win is that waving a FAIL through now costs something. It gets one veto by
default (`planGate.replanRounds`) — a gap the planner cannot close twice is a
question about the assignment, not about the plan — and any way it fails leaves
you exactly the gate you had before, with the gaps unchanged.

Rejecting yourself sends the list back to the planner along with whatever you
said. Turn the check off with `planIntentCheck: false`, or the adjudicator alone
with `{"planGate":{"decidedBy":"operator"}}`, if you would rather be the only
thing reading the plan.

**Which integrations are real is decided at the plan gate, not discovered at the
end.** A task that talks to a third party has to say in its acceptance criteria
which side of the mock/live line it delivers, and the default is live. If live
genuinely cannot be built, the spec says `Live is out of scope because …` and the
interface-plus-fake becomes the honest deliverable. The plan summary then lists
what will be faked, before you approve it:

```
External services — what this plan will actually talk to:
  Built as a test double, with nothing in the criteria that reaches the vendor:
    plaid-integration — Plaid integration
      The suite makes no outbound HTTP call
```

That block exists because run 40da9337's plan contained exactly two lines like
it — *"All seven vendor categories have an interface and a deterministic mock"*
and *"The suite makes no outbound HTTP call"* — and both were approved without
comment. Every integration task then passed QA **correctly**: a task is finished
when its criteria are met, and a criterion no vendor call can fail is a task that
ships without one.

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

### What the run is likely to cost, before you approve it

A cap says where a run stops, not what it needs, so the plan gate now shows an
estimate beside it:

```
Estimated cost: $46.00 (likely $28.00–$180) against a cap of $30.00.
Based on 2 previous runs in this repository.
The cap is below the estimate: expect this run to stop and ask you to raise it.
Raising it now costs nothing and interrupts you less.
```

The rate comes from what previous runs **in this repository** merged and what
they cost, weighted by the planner's own S/M/L sizing. Per repository because
that is the variable that actually moves the number: the same harness costs
around $2 a task on a small greenfield project and around $21 on a large
brownfield service, and no single figure spans that. With no finished run to
learn from, the estimate is that whole spread, and says so.

It is a range on purpose. A confident single number across an order of magnitude
would be worse than none — it reads as a promise, and the run then breaks it.
What the range is for is setting the cap deliberately: one run reached its cap
nine times and doubled it blind each time, having never been shown anything to
compare it against.

### The budget gate

In the terminal:

```
===== BUDGET =====
The run cap of $8.00 was reached: $8.50 spent.
The agent is paused, not cancelled — raising the cap continues it.
New run cap in USD? [enter = $16.50 / s = stop and park the run]
```

On the dashboard the same choice appears as an amber panel above the board — it
points you at the header's `$` figure rather than duplicating its own input,
because that figure is the one control for both raising the cap reactively (once
it's reached) and proactively (any time before then).

- **The header's spend figure is always live-editable.** Click (or tab to and
  press enter on) the `/ $<cap>` next to the spend total, type a new figure, and
  press enter or click away. This works at any point in the run, not only while
  `BUDGET_HOLD` is open — moving the cap before it is ever reached is the whole
  point. If a `BUDGET_HOLD` gate happens to be open at that moment, the same raise
  answers it too, so the paused agent carries on immediately rather than waiting
  on a second confirmation.
- The same thing from a live terminal: type `budget run <usd>` into the process
  running `harness run`/`resume` at any time — it doesn't fight the plan/task/
  pit-stop/budget gate prompts for stdin.
- **Enter / "Raise cap & continue"** in the terminal prompt (or the dashboard's
  live-edit control) writes the new cap to the run's config in SQLite, so a later
  `resume` runs under the cap you agreed to rather than tripping on the old one
  immediately.
- **A cap at or below what is already spent is refused**, in the terminal and over
  the API. It would trip again on the very next check.
- **"s" / "Stop & park the run"** — the run moves to `BUDGET_HOLD` and the process
  exits with `run parked. Raise the cap and pick it up with: harness resume <id>`.
  Nothing is lost: committed worker output stays on its branch.
- Resuming from `BUDGET_HOLD` under the *same* cap simply re-opens the gate, so
  you get asked again rather than failing.

**The cap can be answered without waiting for you.** It is not really a question
about money: the cap is your own estimate of what the whole run would cost, made
before the plan's real size was known, and reaching it says the estimate was
wrong. Your half of that had already shrunk to pressing enter on the suggested
figure — run f338b5c8's gate sat **six hours and forty-two minutes** with a
worker paused mid-task and three tasks queued behind it.

`budget.decidedBy` (`product-manager` out of the box) answers it instead, and is
shown what the terminal prompt never showed anyone: what is in flight, how many
times QA has failed it, and what is still unbuilt. It may decline, which parks
the run exactly as `s` does.

Two bounds:

- **The cap stays yours** unless you named a `budget.ceilingUsd` in advance — the
  run cap *is* the agreement, and an agent that can raise its own ceiling has
  none. Set `{"budget":{"runCapUsd":100,"ceilingUsd":600}}` to mean "go to 600
  without me if the work is worth it"; a decision above the ceiling is held at it.
- **`budget.autoRaiseRounds` (default 3).** A cap raised three times is not a
  slightly wrong estimate, it is a run that does not know how to finish.

Everything outside those bounds, and every way the decider can fail, comes to
you as it always did. `{"budget":{"decidedBy":"operator"}}` restores asking every
time. For a genuinely unattended run, set `ceilingUsd` to the number you are
actually willing to spend and let `runCapUsd` be the one the run works against.

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

### 12.1. Subscription limits

The budget cap above is *your* ceiling, in dollars, on this run. A Claude plan
has a second ceiling that the cap cannot see: a weekly window, metered by the
account across every machine and every session you use, which a run can walk
into while sitting well under its cap.

The harness watches that window and stops before it is gone:

```
===== SUBSCRIPTION =====
96% of the weekly limit · resets Aug 18 at 10pm (Australia/Melbourne)
That is past the 95% line, and the window reopens in 3d 4h.
The agents are paused, not cancelled — this run is spending "personal".
Other subscriptions configured: work
What now?
  <name>   continue on that subscription (work)
  c        carry on spending this one and take the limit when it comes
  enter    park the run; `harness resume` picks it up where it stopped
```

The same choice appears on the dashboard as an amber panel with one button per
configured subscription, and a desktop notification fires the moment it opens —
the whole value of stopping at 95% rather than at 100% is that somebody can still
choose.

**Why the weekly window and not the 5-hour one.** The short window reopens while
you are at lunch, and the pool already sleeps through it without asking anybody
anything. The weekly one does not: every session in flight dies at once, and the
run is parked for days holding worktrees, containers and a half-merged
integration branch. Add `"five_hour"` to `subscription.windows` if you want to be
asked about the short one too — sensible for a run you are watching, poor for one
you left going overnight.

**Where the numbers come from.** The account's own metering, not the harness's
ledger: the same figures `/usage` shows you. Live sessions report them as they
go, and one check runs before the run spends anything, so a run started at 97% is
stopped before it pays for a planner. That pre-run check costs no model tokens
and is skipped for accounts whose plan does not meter (API key, Bedrock, Vertex).

#### Handing a run a different subscription

Name the subscriptions in `harness.config.json`. The credentials do not belong in
that file — it is committable — so write them as `$VAR` and they are read from
your shell when a session is spawned:

```json
{
  "subscription": {
    "pauseAtPercent": 95,
    "accounts": [
      { "name": "personal", "env": { "CLAUDE_CODE_OAUTH_TOKEN": "$PERSONAL_CLAUDE_TOKEN" } },
      { "name": "work", "env": { "CLAUDE_CONFIG_DIR": "/Users/me/.claude-work" } }
    ]
  }
}
```

Two ways to point a session at another account, both of which the harness simply
puts in the session's environment:

- **A long-lived token** from `claude setup-token` run while logged into that
  account. The transcript stays where it is, so a session interrupted by the
  switch resumes the same conversation.
- **A second config directory** that account is logged into (`CLAUDE_CONFIG_DIR`).
  A different login cannot see the first one's transcripts, so an interrupted
  session starts its task again rather than resuming — the harness says so in the
  log when it happens.

An `ANTHROPIC_API_KEY` in the same place is legal and means "stop spending a
plan, start spending money".

Then:

```bash
harness run "…" --account work          # start on it
harness resume <runId> --account work   # move a parked run onto it
harness resume <runId> --account ""     # hand it back to the login you are sitting at
```

Unlike the repo path, the account is deliberately **not** frozen at run creation:
a subscription is a thing a run can run out of. Accounts are re-read from the
file on every resume too, so a subscription you set up *after* the run parked is
one the run can use.

If a named account's `$VAR` is not exported, the harness refuses rather than
spawning a session with a blank credential — an unresolved token would fall back
to the login you were trying to get away from, and the run would carry on
spending the exhausted account while the log said it had switched.

#### What it costs you when nobody answers

A harness with no gate handler at all (embedded, headless with no terminal) logs
the alert and keeps going: parking a run nobody can un-park turns a warning into
an outage. Declining at the gate parks the run in `LIMIT_HOLD`, which is its own
state rather than `BUDGET_HOLD` — the two are un-parked by completely different
things, and `harness status` should be able to tell you which one you are looking
at.

`{"subscription":{"pauseAtPercent":100}}` restores the old behaviour of noticing
only once the wall is hit.

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
| Run in `LIMIT_HOLD` | the account's plan is nearly spent and you declined to carry on ([§12.1](#121-subscription-limits)) | `harness resume <runId> --account <name>` to continue on another subscription, or resume after the window resets |
| `paused on subscription usage` naming a variable | the account you switched to reads its token from a `$VAR` that is not exported | export it (`claude setup-token` on that account) and `resume --account` again |

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

Two classes of failure never reach you, and the run's log says so when they are
filtered: one that is **also red on the integration branch** is somebody else's
bug arriving through the base (`… also fails on harness/<runId>/main — not
charged to this task`), and one that **passes when the same command is run a
second time** was never about the tree at all (`… failed once and passed on a
re-run — not charged to this task`). The second is what a shared local database,
a still-bound port, or a suite sharing state between its own cases looks like
from here; only the failing commands are re-run, so a green tree costs nothing.
If you see the re-run line often, the run is fighting something shared between
worktrees and worth isolating properly.

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
The run is already in a terminal state (`PR_REVIEW` with nothing recoverable,
`ABORTED`, or `FAILED` with work already in flight) and no state machine will
move it again. Resume is for a run interrupted mid-flight. A parked task's work
is committed on its own `harness/<runId>/<taskId>` branch — take it forward by
hand, or start a fresh run now that you know what stalled.

A run that failed *in planning* is the exception: it built nothing to talk over
and still holds the intake conversation you sat through, so `harness resume`
plans it again under the same run id rather than making you answer everything a
second time.

**The run went quiet: "the account is out of quota — waiting …"**
Your Claude plan's usage window closed. Every session in flight dies at the same
moment with the same sentence, and the only remedy is time, so the harness sleeps
until the reset the message quoted and then continues each session from where it
stopped — the same conversation, the same bill, and no attempt, respawn or QA
iteration spent on it. Nothing is required of you; leave it running. A session
gives up and reports the failure once it has slept `usageLimitWaitMinutes`
(default six hours), which is what a weekly limit will usually reach. That bound
is per session, so a long run can sit out more than one outage. Set it to `0` to
fail immediately instead.

The one thing that does not survive the pause is whatever the agent had running
in its worktree: the sweep that ends every session kills it, and the resumed
session is told so and starts it again.

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
