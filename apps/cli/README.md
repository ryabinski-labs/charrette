# charrette

**A PRD in. Reviewed pull requests out — or a production release with the
evidence to prove it shipped.**

[![CI](https://github.com/ryabinski-labs/charrette/actions/workflows/ci.yml/badge.svg)](https://github.com/ryabinski-labs/charrette/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/ryabinski-labs/charrette/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-brightgreen.svg)](https://nodejs.org)

A *charrette* is an intense, deadline-bound work session that has to end in a
reviewed deliverable. That is what this does: it staffs a fleet of Claude agents
against your assignment, holds them to acceptance criteria, and stops at exactly
two decision points that are yours — approve the plan, and merge the pull
request. It never merges for you.

This package is the CLI, and it is the supported way to use Charrette. The
`@charrette/*` packages it depends on are published so the CLI can install, not
as a stable API.

## Install

```bash
npm install -g charrette   # or: npx charrette run

cd ~/code/my-app           # the repo you want built
charrette run
```

Requires **Node ≥ 22.13** — `node:sqlite` backs the run store, and it is only
available unflagged from 22.13 (and 23.4) on.

## What `charrette run` does

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

Then it asks what to build — and keeps asking until the answer is buildable.
Intake and specification agents turn the brief into executable requirements; a
planner builds a task DAG; **you approve the plan**; workers implement tasks in
isolated git worktrees and adversarial QA checks them. Review mode stops at
reviewed PRs. Explicit production mode follows the release through merge, named
deployment jobs, deployed-revision verification and production acceptance.

Merging remains manual unless you explicitly authorize `--auto-merge`; GitHub
protections still apply.

## Who it's for

Solo builders and small teams already living in Claude Code, who want to hand
off whole features rather than functions, and would rather supervise a board
than babysit a terminal.

**Do not use it** if you need a framework for *building* agents — that is
LangGraph, CrewAI or the Agent SDK directly. Also skip it if you cannot run
repositories you trust: until OS sandboxing lands, agents run with broad local
permissions. See [SECURITY.md](https://github.com/ryabinski-labs/charrette/blob/main/SECURITY.md).

Cost, measured: ~$2 per merged task on a small greenfield repo, ~$21 on a large
brownfield service. A hard run budget cap means it cannot run away with your
money.

## Status

Pre-release (v0.0 walking skeleton + v0.1 dashboard). Usable; not yet 1.0.

## Documentation

- **[README](https://github.com/ryabinski-labs/charrette#readme)** — screenshots of the dashboard and the plan gate
- **[docs/OPERATIONS.md](https://github.com/ryabinski-labs/charrette/blob/main/docs/OPERATIONS.md)** — install, configure, run, observe, recover. Start here.
- **[docs/PRODUCTION-DELIVERY.md](https://github.com/ryabinski-labs/charrette/blob/main/docs/PRODUCTION-DELIVERY.md)** — full PRD → deployed release
- **[PRD.md](https://github.com/ryabinski-labs/charrette/blob/main/PRD.md)** — architecture, threat model, performance budget, phasing

Built on the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk).

## Licence

MIT © Yoni Ryabinski
