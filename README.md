# Harness

**Assignment in → reviewed pull requests out.**

Harness is a multi-agent development orchestrator built on the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk). A planner agent turns a one-paragraph assignment into a PRD and a task DAG; you approve the plan (Gate 1); worker agents implement tasks in isolated git worktrees with locally-discovered skills injected per task; adversarial QA agents verify against acceptance criteria (max 3 iterations); accepted branches merge continuously into a run branch and each component ships as a PR linked to its GitHub issue. You merge the PRs — the harness never does (Gate 2).

- **[docs/OPERATIONS.md](./docs/OPERATIONS.md)** — install, configure, run, observe, recover. Start here.
- **[PRD.md](./PRD.md)** — the full product spec: architecture, threat model, performance budget, phasing.

## Status

Pre-release walking skeleton (v0.0 per the PRD phasing) plus the v0.1 dashboard backend:

- ✅ Planner → PRD + validated task DAG → plan approval gate (terminal or dashboard)
- ✅ Worker → deterministic checks → QA agent loop with iteration caps
- ✅ Continuous integration into `harness/<runId>/main`, idempotent GitHub issues + PRs
- ✅ Event-sourced SQLite state (`node:sqlite`, zero native deps), crash-resume
- ✅ Budget caps enforced before every agent turn; live cost ledger
- ✅ Skills discovery: lexical SKILL.md matching with SHA-256 provenance (also exposed as a stdio MCP server)
- ✅ Localhost dashboard: SSE live events, task board, cost meter, gate approval (127.0.0.1-only, bearer token, Origin/Host checks)
- ⬜ Parallel workers, plan editing UI, OS sandboxing, semantic skill matching — see PRD §7

## Requirements

- Node ≥ 22 (uses built-in `node:sqlite`), pnpm
- Anthropic credentials, resolved by the Agent SDK from the environment:
  `CLAUDE_CODE_OAUTH_TOKEN` (Claude Pro/Max — run `claude setup-token`) or
  `ANTHROPIC_API_KEY`
- Optional: `GITHUB_TOKEN` (fine-grained, single repo: contents/issues/PRs write) + `HARNESS_GITHUB_REPO=owner/repo`

## Usage

```bash
pnpm install && pnpm build
pnpm link-cli        # symlinks `harness` into ~/.local/bin

cd ~/code/my-app     # the repo you want built
harness run "Add rate limiting to the API"
```

That is the whole command. The target repo, the deterministic checks, the budget
caps and the dashboard all resolve to safe defaults, and the run banner prints
what each one resolved to — and where it came from — before anything is spent:

```
  repo       /Users/you/code/my-app
  checks     pnpm run typecheck · pnpm run lint · pnpm run test   (auto-detected from package.json scripts via pnpm)
  budget     run $30 · task $10   (defaults)
  dashboard  http://127.0.0.1:4777/#a1b2…   (the fragment is your auth token)
```

Override any of it per run, or commit `harness.config.json` for per-repo defaults:

```bash
harness run "Add rate limiting" --check "npm test" --run-cap 50 --no-dashboard
harness init                 # write harness.config.json with the resolved defaults
harness resume <runId>       # continue after any interruption; nothing re-executes
harness status               # run/task states, QA iterations, spend
```

Full configuration reference, recovery playbook, and troubleshooting: [docs/OPERATIONS.md](./docs/OPERATIONS.md).

## Monorepo layout

| Package | What |
|---|---|
| `packages/shared` | zod contracts: states, events, plan schema, config |
| `packages/core` | store, event bus, budget, git/worktrees, agent pool, run controller, GitHub adapter |
| `packages/skills-mcp` | SKILL.md indexer + stdio MCP server (`search_skills`, `describe_skill`) |
| `packages/dashboard` | Fastify backend + single-file SPA (SSE via fetch-stream) |
| `apps/cli` | `harness run / resume / status / init`, repo-root and default resolution |

## Security model (v0 summary)

Secrets never enter agent context; pushes are confined to `harness/<runId>/*` branches; the harness has no code path that merges PRs; the dashboard binds loopback only and every state-changing endpoint requires a bearer token plus Origin/Host validation. Full threat model and requirements: PRD §12. Until OS sandboxing lands (PRD v1.0): **run repos you trust**.

## License

MIT (pending open-source release checklist — PRD §7 v1.0).
