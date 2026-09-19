# @charrette/skills-mcp

**MCP server that exposes local skills to Charrette agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/ryabinski-labs/charrette/blob/main/LICENSE)

> **Part of [Charrette](https://github.com/ryabinski-labs/charrette).** The
> supported entry point is the `charrette` CLI — `npx charrette run`. This
> package is published so that CLI can install; its API is internal and moves
> with the CLI, without deprecation cycles, until 1.0.

## What is in here

An [MCP](https://modelcontextprotocol.io) server that indexes the `SKILL.md`
playbooks on your machine and offers them to a run's agents, so a task is
matched to the way *you* build rather than to a generic default.

Charrette starts it for you; the binary is exposed for anything else that speaks
MCP:

```bash
npx -p @charrette/skills-mcp charrette-skills-mcp
```

## Install

```bash
npm install @charrette/skills-mcp
```

## Licence

MIT © Yoni Ryabinski
