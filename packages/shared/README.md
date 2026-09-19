# @charrette/shared

**Shared types, events and run vocabulary for Charrette.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/ryabinski-labs/charrette/blob/main/LICENSE)

> **Part of [Charrette](https://github.com/ryabinski-labs/charrette).** The
> supported entry point is the `charrette` CLI — `npx charrette run`. This
> package is published so that CLI can install; its API is internal and moves
> with the CLI, without deprecation cycles, until 1.0.

## What is in here

The vocabulary every other Charrette package agrees on, and nothing that does
work:

- **Events and states** — the append-only event union the run store writes, and
  the task/run state machines folded from it.
- **Brief, spec and plan** — the shapes intake, specification and planning hand
  to each other: the agreed brief, executable acceptance criteria, the task DAG.
- **Delivery** — review mode versus production mode, and the evidence a
  production release has to produce.
- **Config and state paths** — where a repository's run state and config live,
  including the pre-rename `.harness/` layout, which is still read when that is
  the only layout a repository has.
- **Providers and runner load** — model identity and capacity accounting.

It has no runtime dependencies on the rest of Charrette, which is what lets the
CLI, the engine and the dashboard share a definition rather than three.

## Install

```bash
npm install @charrette/shared
```

## Licence

MIT © Yoni Ryabinski
