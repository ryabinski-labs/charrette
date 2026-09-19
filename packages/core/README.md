# @charrette/core

**Charrette run engine: planning, dispatch, gates and the event-sourced store.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/ryabinski-labs/charrette/blob/main/LICENSE)

> **Part of [Charrette](https://github.com/ryabinski-labs/charrette).** The
> supported entry point is the `charrette` CLI — `npx charrette run`. This
> package is published so that CLI can install; its API is internal and moves
> with the CLI, without deprecation cycles, until 1.0.

## What is in here

The parts of a run that are not the terminal and not the browser:

- **The store** — every run is an append-only event log in `node:sqlite`. State
  is a fold over events, so a run can be replayed, diagnosed and resumed rather
  than guessed at. `charrette postmortem` reads nothing else.
- **The run controller** — the task DAG, worker dispatch into isolated git
  worktrees, deterministic checks, the adversarial QA loop, and the gates that
  stop for a human (plan approval, budget raise, blocked task).
- **The agent pool** — Claude Agent SDK sessions, the tool belt they are given,
  output ceilings and the reaper that reclaims a session that stops making
  progress.
- **Budget** — a hard run cap enforced at dispatch, not reported after the fact.
- **Git and GitHub** — branch namespace, worktrees, PR creation, CI check
  settlement. It never merges; that decision stays with you.

## Install

```bash
npm install @charrette/core
```

Requires **Node ≥ 22.13** for unflagged `node:sqlite`.

## Licence

MIT © Yoni Ryabinski
