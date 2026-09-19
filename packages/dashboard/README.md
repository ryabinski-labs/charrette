# @charrette/dashboard

**Live run dashboard for Charrette.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/ryabinski-labs/charrette/blob/main/LICENSE)

> **Part of [Charrette](https://github.com/ryabinski-labs/charrette).** The
> supported entry point is the `charrette` CLI — `npx charrette run`. This
> package is published so that CLI can install; its API is internal and moves
> with the CLI, without deprecation cycles, until 1.0.

## What is in here

The localhost web UI a run serves while it works: the event feed, the task
board, the intent tracker and the cost meter, all live, plus the gates that need
an answer — plan approval, a budget raise, a blocked task.

It is local-first. The server binds `127.0.0.1` only, and the credential lives
in the URL fragment the CLI prints — the page reads it client-side and sends it
as a header, so it never appears in a request line, a proxy log or a referrer.

The exported `Dashboard` class implements the engine's gate handler, so
answering a gate in the browser and answering it in the terminal are the same
operation on the same event log.

## Install

```bash
npm install @charrette/dashboard
```

## Licence

MIT © Yoni Ryabinski
