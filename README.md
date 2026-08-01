# Harness

**Assignment in → reviewed pull requests out.**

Harness is a multi-agent development orchestrator built on the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk). A planner agent turns a one-paragraph assignment into a PRD and a task DAG; you approve the plan (Gate 1); worker agents implement tasks in isolated git worktrees with locally-discovered skills injected per task; adversarial QA agents verify against acceptance criteria (max 3 iterations); accepted branches merge continuously into a run branch and each component ships as a PR linked to its GitHub issue. You merge the PRs — the harness never does (Gate 2).

Full product spec: [PRD.md](./PRD.md).

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
- `ANTHROPIC_API_KEY` (used by the Claude Agent SDK)
- Optional: `GITHUB_TOKEN` (fine-grained, single repo: contents/issues/PRs write) + `HARNESS_GITHUB_REPO=owner/repo`

## Usage

```bash
pnpm install && pnpm build

# start a run against a target repo, with the dashboard
node apps/cli/dist/main.js run "Add rate limiting to the API" \
  --repo ~/code/my-app \
  --check "npm test" --check "npm run lint" \
  --run-cap 30 --task-cap 10 \
  --dashboard

# resume after any interruption — completed tasks never re-execute
node apps/cli/dist/main.js resume <runId> --repo ~/code/my-app

# inspect run/task states and spend
node apps/cli/dist/main.js status --repo ~/code/my-app
```

The dashboard URL is printed at start; the URL fragment is your auth token.

## Monorepo layout

| Package | What |
|---|---|
| `packages/shared` | zod contracts: states, events, plan schema, config |
| `packages/core` | store, event bus, budget, git/worktrees, agent pool, run controller, GitHub adapter |
| `packages/skills-mcp` | SKILL.md indexer + stdio MCP server (`search_skills`, `describe_skill`) |
| `packages/dashboard` | Fastify backend + single-file SPA (SSE via fetch-stream) |
| `apps/cli` | `harness run / resume / status` |

## Security model (v0 summary)

Secrets never enter agent context; pushes are confined to `harness/<runId>/*` branches; the harness has no code path that merges PRs; the dashboard binds loopback only and every state-changing endpoint requires a bearer token plus Origin/Host validation. Full threat model and requirements: PRD §12. Until OS sandboxing lands (PRD v1.0): **run repos you trust**.

## License

MIT (pending open-source release checklist — PRD §7 v1.0).
