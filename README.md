# Harness

**PRD in → reviewed pull requests, or an evidence-verified production release.**

Harness is a multi-agent development orchestrator built on the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk). Intake and specification agents turn the full brief into executable requirements; a planner builds a task DAG; you approve the plan; workers implement tasks in isolated worktrees and adversarial QA checks them. Review mode stops at reviewed PRs. Explicit production mode follows the release through merge, named deployment jobs, deployed-revision verification and production acceptance. Merging remains manual unless you explicitly authorize `--auto-merge`; GitHub protections still apply.

- **[docs/OPERATIONS.md](./docs/OPERATIONS.md)** — install, configure, run, observe, recover. Start here.
- **[docs/PRODUCTION-DELIVERY.md](./docs/PRODUCTION-DELIVERY.md)** — full PRD → deployed release, authority, evidence and resume.
- **[docs/CLAUDEFLOW-LEARNINGS.md](./docs/CLAUDEFLOW-LEARNINGS.md)** — Claude Flow comparison and adopted practices for focused context, recovery and efficient verification.
- **[PRD.md](./PRD.md)** — the full product spec: architecture, threat model, performance budget, phasing.

## Status

Pre-release walking skeleton (v0.0 per the PRD phasing) plus the v0.1 dashboard backend:

- ✅ Intake agent: repo-grounded clarifying questions with options and a recommendation → agreed brief
- ✅ Planner → PRD + validated task DAG → plan approval gate (terminal or dashboard)
- ✅ Worker → deterministic checks → QA agent loop with iteration caps
- ✅ Continuous integration into `harness/<runId>/main`, idempotent GitHub issues + PRs
- ✅ Event-sourced SQLite state (`node:sqlite`, zero native deps), crash-resume
- ✅ Budget caps enforced before every agent turn; live cost ledger; the plan gate prices the plan against the cap from what previous runs in the same repo actually cost
- ✅ Intent validator reads the merged whole against your original assignment — seams, reachability, and whether the thing could actually be deployed and would move real money — and a FAIL queues one task per gap and builds them rather than just reporting them
- ✅ An interrupted conversation is picked up where it stopped: `resume` re-asks the question nobody answered instead of planning around it
- ✅ The plan gate says which external services the plan intends to build for real and which it intends to fake, before a worker is paid — and which of deployment, sign-in, visual design and failure-visibility your brief asked for that no task owns at all
- ✅ The same intent question is asked of the **plan**, not only the result: could this plan, executed perfectly, deliver the assignment? Gaps reach you at the gate and the planner on a reject
- ✅ `harness postmortem` — why a run produced what it produced: questions nobody answered, verdicts and whether they were heeded, tasks that could pass without anything leaving the process, spend by how sessions died, and which harness build each session ran under — because a fix built while a run is executing never reaches it
- ✅ Skills discovery: lexical SKILL.md matching with SHA-256 provenance (also exposed as a stdio MCP server)
- ✅ Localhost dashboard: live activity feed (what each agent is reading, editing, running), task board, cost meter, gate approval (127.0.0.1-only, bearer token, Origin/Host checks)
- ✅ A run ends when the product is proven, not when the task list empties: the acceptance suite green, the intent check PASS (it can also answer UNKNOWN, and an abstention is not a pass), and an agent having started the finished product from a clean checkout and driven the critical path the brief was turned into before any code existed. Anything short of that parks the run in `BLOCKED` with what is unmet on the record, opens no pull request, and re-enters the gates on `harness resume`
- ✅ Pit stops: after every epic the run stops, a demo agent starts the half-built product and drives it, three named reviewers judge it, and you keep going, redirect the unbuilt tasks, re-plan them, or stop — [docs/PITSTOP.md](./docs/PITSTOP.md)
- ✅ Parallel workers over the DAG, held apart by the planner's `touchedPaths` so two of them do not edit one file into a merge conflict
- ⬜ Plan editing UI, OS sandboxing, semantic skill matching — see PRD §7

Measured across four completed runs, cost per merged task ranges from about $2
on a small greenfield repo to about $21 on a large brownfield service, and the
number of times it stops to ask you something scales with it. Size the cap, and
your own attention, against the repo rather than against the task count.

## Requirements

- Node ≥ 22 (uses built-in `node:sqlite`), pnpm
- Anthropic credentials, resolved by the Agent SDK from the environment:
  `CLAUDE_CODE_OAUTH_TOKEN` (Claude Pro/Max — run `claude setup-token`) or
  `ANTHROPIC_API_KEY`
- Optional: `GITHUB_TOKEN` (fine-grained, single repo: contents/issues/PRs write) + `HARNESS_GITHUB_REPO=owner/repo`
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) — **required**, not optional. The pit
  stop's `reviewer` is pinned to Gemini so that the agent judging the work is
  not from the family that wrote it; a run refuses to start without the key
  rather than discovering it at the first pit stop, after the epic is paid for
- Optional: `OPENAI_API_KEY`, if you point a role at OpenAI. Every other role is
  Anthropic by default; `harness run --model worker=gpt-5.6-terra` changes one,
  and the same flag on `harness resume` changes it for the rest of a run already
  in flight. `qa`, `prod` and `intake` stay on Anthropic and `reviewer` stays on
  Google; see [Using other providers](docs/OPERATIONS.md#using-other-providers)
- Any of these may go in a `.env` file in the directory you run `harness` from
  (not the repository being built — a task spec can write to that one). An
  exported variable wins over the file

## Usage

```bash
pnpm install && pnpm build
pnpm link-cli        # symlinks `harness` into ~/.local/bin

cd ~/code/my-app     # the repo you want built
harness run
```

That is the whole command — no assignment, no flags. The target repo, the
deterministic checks, the budget caps and the dashboard all resolve to safe
defaults, and the banner prints what each resolved to, and why, before anything
is spent:

```
  repo       /Users/you/code/my-app
  checks     pnpm run typecheck · pnpm run lint · pnpm run test   (auto-detected from package.json scripts via pnpm)
  budget     run $30 · task $10   (defaults)
  intake     conversation before planning   (default)
  dashboard  http://127.0.0.1:4777/#a1b2…   (the fragment is your auth token)
```

Then it asks what to build — and keeps asking until the answer is buildable:

```
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

Answer with a number, press enter for the recommendation, or type anything else
— free text always beats the options (end a line with `\` to keep typing on the
next one). The agreed brief, not your first sentence, is what the planner
receives, and it asks about the things that are expensive to change later:
scope, look and feel, stack, data, performance, security, how it ships.

Then, every epic, it stops and shows you what it actually built:

```
# Pit stop 1 — the "Sign-in" epic is finished

**It runs.** `pnpm dev` on :5173

## What it did
- ✓ **Sign in** — 302 to /home, session row written (signin.png)
- ✗ **Download a pack** — GET /v1/pack/current → 404 (pack-404.png)

## What it could NOT check
- payments — no Stripe test keys on this machine

## What the reviewers think
### product-manager — DRIFTING
- The pack screen has no content behind it
> Is the map still in scope?

What now?
  enter          keep going
  <anything>     send it to the 4 task(s) that have not run yet
  replan <words> re-plan the remaining work around what you say
  stop           park the run; `harness resume` picks it up where it is
```

Override any of it per run, or commit `harness.config.json` for per-repo defaults:

```bash
harness run "Add rate limiting"            # an assignment on the CLI skips the conversation
harness run --check "npm test" --run-cap 50 --no-dashboard
harness init                 # write harness.config.json with the resolved defaults
harness resume <runId>       # continue after any interruption; nothing re-executes
harness status               # run/task states, QA iterations, spend
harness version              # the build this binary is, and whether `dist/` is current with `src/`
```

`harness --version` prints that build on its own — `version@sha`, with a `+`
when the checkout is dirty. It is the same string every agent session is
stamped with, so a session record and a binary can be matched without
cross-referencing `git log` against process start times. `harness version`
adds the part a sha cannot answer: Node loads `dist/`, so a fix that is
committed but never compiled leaves a clean sha in front of an old build.

Full configuration reference, recovery playbook, and troubleshooting: [docs/OPERATIONS.md](./docs/OPERATIONS.md).

## Monorepo layout

| Package | What |
|---|---|
| `packages/shared` | zod contracts: states, events, plan schema, config |
| `packages/core` | store, event bus, budget, git/worktrees, agent pool, intake conversation, run controller, GitHub adapter |
| `packages/skills-mcp` | SKILL.md indexer + stdio MCP server (`search_skills`, `describe_skill`) |
| `packages/dashboard` | Fastify backend + single-file SPA (SSE via fetch-stream) |
| `apps/cli` | `harness run / resume / status / init / version`, terminal intake chat, repo-root and default resolution |

## Security model (v0 summary)

Secrets never enter agent context; pushes are confined to `harness/<runId>/*` branches; the harness has no code path that merges PRs; the dashboard binds loopback only and every state-changing endpoint requires a bearer token plus Origin/Host validation. Full threat model and requirements: PRD §12. Until OS sandboxing lands (PRD v1.0): **run repos you trust**.

## License

MIT (pending open-source release checklist — PRD §7 v1.0).
