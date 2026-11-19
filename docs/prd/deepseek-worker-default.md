---
spec: spec-clarifier/v1
feature: deepseek-worker-default
title: DeepSeek V4.1 Flash as the default worker model
status: complete
prompt: inline
prompt_sha256: 7d6cb79066530d09eff38a35c6ab1a51a196fdf1bd7180f1ba049d0143bb7b21
created: 2026-11-19
---

# PRD: DeepSeek V4.1 Flash as the default worker model

## 0. Source prompt

> I want to change the worker models to run deepseek v4.1 flash for regular build tasks @spec-clarifier

## 1. Problem

Every worker session that is not admitting the light-tier rule, not a user-interface task and not climbing the escalation ladder runs on `claude-sonnet-5` at $3 per MTok input and $15 per MTok output. The worker is where the money is: one recorded run spent $65 across seventeen worker sessions against $14 across eight QA sessions (`packages/shared/src/config.ts`, the `workerLight` comment). DeepSeek V4.1 Flash lists at $0.30 input and $1.20 output per MTok at peak — a tenth of Sonnet's input rate and a twelfth of its output rate — and its API is OpenAI-compatible.

The charrette cannot use it. `packages/shared/src/providers.ts` knows three vendors (`anthropic`, `openai`, `google`) and infers the vendor from the model name; `deepseek-flash` matches no family, falls through to the Anthropic default, and is handed to the Claude Agent SDK, which rejects it. So the operator pays Sonnet's rate for every regular build task whether or not a cheaper model would clear the same QA gate. On the product's own headline figure — cost per merged task, about $2 on a small greenfield repo and about $21 on a large brownfield service (README, 2026-11-19) — the worker line is the only one that can move the total much.

## 2. Target user

- **Primary:** the operator who runs `charrette run` and pays the API bill — a solo builder or a small team — deciding one model default that applies to every regular build task.
- **Secondary:** the maintainer who reads the ledger to decide whether a model change paid for itself, and every future reader of a run's recorded routing.
- **Explicitly not for:** an operator with no DeepSeek API key. Per `DL-002` the run refuses to start rather than quietly substituting Sonnet, so that operator is served worse until a key exists.
- **Job-to-be-done:** When I start a run, I want regular build tasks to use the cheapest model that still clears QA, so I can hand off a whole feature without choosing a model per task.

## 3. Outcome and success metric

- **Outcome this moves:** worker spend per merged task.
- **Primary KPI:** worker spend per merged task — the sum of `costUsd` booked to sessions with role `worker` for a merged task, divided by the number of merged tasks. Read from `taskSpend()` in `packages/core/src/store.ts` and the run ledger.
- **Baseline:** about $2 per merged task on the small greenfield repo and about $21 on the large brownfield service (README, 2026-11-19); Sonnet worker list price $3 input and $15 output per MTok.
- **Target:** at most 50% of the baseline (about $1 on the small repo) within the first 20 merged worker tasks or 30 days after release, whichever comes first.
- **Guardrail metrics:** QA first-attempt pass rate stays at or above 40% — the PRD's stated floor, against a 60% target — and `qaIterations` per merged task does not rise above the pre-change median.

## 4. Goals and non-goals

**Goals**
1. `models.worker` and `models.workerLight` default to `deepseek-flash`, so a run started with no model override sends regular and light build tasks to DeepSeek.
2. `deepseek` is a routable provider: inferred from a `deepseek-` name, keyed by `DEEPSEEK_API_KEY`, driven by the existing OpenAI-compatible client, priced in the ledger, budgeted for context, recognised when it reports a quota wall, and documented.
3. The routing policy still refuses a pinned role on DeepSeek, and existing runs keep the config they froze.

**Non-goals**
1. `models.workerUi` stays `claude-opus-5` and `models.workerHeavy` stays `claude-fable-5-1`. Interface quality and the escalation ceiling are separate bets, and neither is re-priced by this change.
2. `qa`, `prod` and `intake` stay on Anthropic and `reviewer` stays on Google. Those pins are enforced in `providers.ts` and this change does not touch them.
3. No per-task model nomination. `modelTier.ts` remains the only rule that decides a worker tier.
4. No use of DeepSeek's Anthropic-format endpoint and no resumable DeepSeek sessions. The worker runs through the repo's stateless tool loop.
5. No change to worker prompts, injected skills or the worker's tool set.
6. No automatic fallback to Sonnet when the DeepSeek key is absent, per `DL-002`.

## 5. User stories and acceptance criteria

- **[P0]** As an operator, I want regular and light build tasks routed to DeepSeek by default, so a run costs less without a per-task model choice.
  - [ ] Given a run whose config does not override `models`, when a worker task is dispatched on the standard or light tier, then `agent.spawned` records `model: "deepseek-flash"` and the request goes to `https://api.deepseek.com/chat/completions`.
  - [ ] Given a light-tier task, when `modelTier.ts` decides the tier, then `task.tier_decided` still publishes and the ledger still records `tier: "light"` even though both tiers name the same model.
  - [ ] Given a user-interface task, when it is dispatched, then it still runs on `claude-opus-5` from `models.workerUi`.
  - [ ] Given a task that climbs the escalation ladder, when it is re-dispatched, then it runs on `claude-fable-5-1` from `models.workerHeavy`.

- **[P0]** As an operator, I want DeepSeek usage priced and capped, so the budget gate sees the real bill.
  - [ ] Given a completed DeepSeek turn reporting `prompt_tokens` and `completion_tokens`, when the ledger books it, then `costUsd` uses $0.30 input and $1.20 output per MTok, and cache-hit tokens are booked at 0.1x the input rate.
  - [ ] Given `models.worker` is `deepseek-flash`, when the run cap is checked before a turn, then the DeepSeek spend is part of the figure the gate compares.
  - [ ] Error: given a usage response with no `prompt_tokens_details.cached_tokens` field, then cache reads are booked as 0 and the input tokens are booked at full rate.

- **[P0]** As an operator without a DeepSeek key, I want to be told before any money is spent.
  - [ ] Given `DEEPSEEK_API_KEY` is unset and `models.worker` resolves to `deepseek-flash`, when `charrette run` parses the config, then it exits non-zero with `DEEPSEEK_API_KEY is not set, but worker (deepseek-flash) is routed to deepseek.`
  - [ ] Given the key is set in `.env` in the working directory, when the CLI starts, then the key is loaded before the routing check runs.
  - [ ] Error: given `DEEPSEEK_API_KEY` is set but rejected, then the first DeepSeek request fails with `deepseek API 401 Unauthorized: <response body>` and no worker task is marked complete.

- **[P0]** As a maintainer, I want DeepSeek treated like every other non-Anthropic provider.
  - [ ] Given `--model worker=deepseek-flash`, when the role is dispatched, then the repo's tool loop runs the session with Bash, Read, Write, Edit, Glob and Grep, and `qa` stays on `claude-sonnet-5`.
  - [ ] Given a DeepSeek turn that returned `reasoning_content` and a tool call, when the next request is sent, then its assistant message carries the same `reasoning_content`.
  - [ ] Given `maxOutputTokens` is set for a DeepSeek session, when the request is sent, then it carries `max_tokens` rather than `max_completion_tokens`.
  - [ ] Given a DeepSeek 429, when the tool loop receives it, then `usageLimitOf` recognises the vendor and the pool waits out the quota window instead of counting a failure.
  - [ ] Error: given a 500, 502, 503 or 504 from DeepSeek, when one request fails, then it is retried twice at 1 second and 4 seconds before the session reports failure.
  - [ ] Error: given a worker spec that requests an in-process MCP server, when the role is routed to DeepSeek, then the pool refuses before the session row is written, naming the unsupported MCP dependency.

- **[P0]** As a maintainer, I want documentation and the routing policy to match the new default.
  - [ ] Given the repo at the merge commit, when a reader opens the README requirements list, then it names `DEEPSEEK_API_KEY` and `deepseek-flash` as the default worker, beside the existing Google and OpenAI lines.
  - [ ] Given the repo at the merge commit, when a reader opens the OPERATIONS models table, then `models.worker` and `models.workerLight` show `deepseek-flash`, and the `Using other providers` section names DeepSeek as a supported vendor.
  - [ ] Error: given `models.qa = "deepseek-flash"`, when the config is parsed, then routing is refused because `qa` is pinned to Anthropic.

- **[P1]** As a maintainer, I want the rollback decided by numbers, so the default is not kept on impressions.
  - [ ] Given the first 20 merged worker tasks after release, when QA first-attempt pass rate is below 40%, then `models.worker` and `models.workerLight` revert to `claude-sonnet-5` and `claude-haiku-4-5-20251001` in one commit.
  - [ ] Given the first 20 merged worker tasks after release, when worker spend per merged task is above 50% of the $2 baseline, then the same revert commit is opened.
  - [ ] Given both figures are inside the bar when the sample closes, then the default is kept and both figures are posted in the release notes.

Priorities: **P0** release fails without it · **P1** ship-blocking unless waived · **P2** follow-up.

## 6. Experience notes

The surface is the CLI (`charrette run`, `charrette resume`, `--model`) and `charrette.config.json`; there is no new screen. The dashboard's session list already prints the model recorded by `agent.spawned`, so a DeepSeek worker appears there with no new component, empty state or loading state.

- **Error states:** a missing key is one line at `charrette run` naming `DEEPSEEK_API_KEY`; a rejected key is `deepseek API 401 Unauthorized: <body>` on the session; a quota wall is the existing `usageLimitOf` wait, capped by `usageLimitWaitMinutes`; a transient 5xx is hidden behind two retries.
- **Accessibility bar:** WCAG 2.2 AA for the existing dashboard session view. This change adds no interactive element and no new announcement.

## 7. Scope

**In scope:**
- `packages/shared/src/providers.ts`: add `deepseek` to the `Provider` union, a family rule for `deepseek-` names, a `VENDOR_NAME` entry, and a capability floor entry if one is needed.
- `packages/shared/src/config.ts`: default `worker` and `workerLight` to `deepseek-flash`.
- `packages/core/src/providerClients.ts`: `DEEPSEEK_API_KEY` in `KEY_VARS`, and a DeepSeek client built from the OpenAI-compatible request shape with base URL `https://api.deepseek.com`.
- `packages/core/src/compact.ts`: a `deepseek` entry in `BUDGETS`.
- `packages/core/src/budget.ts`: a `deepseek-flash` price row at $0.30 input and $1.20 output per MTok.
- `packages/core/src/usageLimit.ts`: recognise `deepseek API 429`.
- `apps/cli/src/env.ts`: load `DEEPSEEK_API_KEY` from `.env` beside the other vendor keys.
- Tests for provider inference, routing violations, pricing, the client request shape and the missing-key message.
- README, `docs/OPERATIONS.md`, `CHANGELOG.md` and the dashboard preview fixture.

**Out of scope:**
- The non-goals listed in §4.
- A configurable base URL per provider. DeepSeek's base URL is a constant in its client, as OpenAI's and Google's are today.
- A per-hour price table for peak and off-peak rates.

**Dependencies:** a DeepSeek API key; the vendor model id `deepseek-flash`; the existing tool loop and its tool set; the existing frozen-config behaviour in `store.ts`.

**Constraints:**
- No new SDK dependency. The client uses raw `fetch`, matching `providerClients.ts`.
- The `Provider` union is extended, so every `Record<Provider, …>` must be complete at compile time.
- Frozen run configs keep their recorded models; `resume` does not rewrite them unless `--model` is passed.
- The Anthropic SDK pin and every pinned role are untouched.

## 8. Risks and open questions

| ID | Risk or question | Type | Owner | Resolve by |
|---|---|---|---|---|
| R-001 | DeepSeek Flash's first-attempt pass rate on this repo's acceptance criteria is low enough that extra QA iterations cost more than the token price saves. | Risk | maintainers | the 20-task sample in §10 |
| R-002 | The price row uses the peak rate, so off-peak sessions are over-charged by up to 2x in the ledger. | Risk | maintainers | accepted; over-charging stops a run early, never late |
| R-003 | The stateless tool loop cannot resume a worker session, so a respawn re-explores the repo on the operator's bill. | Risk | maintainers | accepted; the pool already logs `starting cold` |
| R-004 | Operators without a DeepSeek key can no longer start a run. | Risk | operator | `DL-002`; stated in the README requirements list |

## 9. Instrumentation

| Event | Trigger | Properties | Purpose |
|---|---|---|---|
| `task.tier_decided` | a worker task is dispatched | `runId`, `taskId`, `tier`, `model` | keeps the light-tier measurement alive after both tiers name the same model |
| `agent.spawned` | a session starts | `runId`, `taskId`, `sessionId`, `role`, `model` | proves `deepseek-flash` was the model dispatched |
| `usage` row in the ledger | one assistant turn is booked | `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `costUsd` | feeds worker spend per merged task |
| `taskSpend()` query | a task closes | `taskId`, spend by role, `escalated` | feeds cost per merged task and the escalation rate |

## 10. Rollout and rollback

- **Strategy:** full release as the shipped default. There is no flag: model routing is already a config default, and `charrette.config.json` plus `--model` are the per-repo and per-run opt-outs.
- **Rollback trigger:** across the first 20 merged worker tasks or 30 days after release, whichever comes first, revert both defaults to `claude-sonnet-5` and `claude-haiku-4-5-20251001` in one commit if either QA first-attempt pass rate is below 40% or worker spend per merged task is above 50% of the $2 baseline.
- **Migration or backfill:** none. No schema change; existing runs keep their frozen configs and continue on the model they recorded.

## 11. Compliance gates

- [x] None apply: this change stores no new personal data, makes no regulated decision, and adds no user-facing disclosure. The only new credential is `DEEPSEEK_API_KEY`, held in the environment or a `.env` file as the existing vendor keys are.

## 12. Data and integrations

- **Stored:** no new tables or columns. `sessions.model` and the ledger's `usage.model` already store the model string, and `deepseek-flash` is a new value in them. Retention, ownership and personal-data handling are unchanged; no prompt text or credential is stored by this change.
- **Migration:** none. `store.ts` re-parses frozen configs on read, and `deepseek-flash` passes the extended routing schema.
- **Integrations:** DeepSeek's OpenAI-compatible endpoint at `POST https://api.deepseek.com/chat/completions`, authenticated with `Authorization: Bearer $DEEPSEEK_API_KEY`. The key is read by `apps/cli/src/env.ts` at startup and by `apiKeyFor` in `providerClients.ts` at dispatch. Tests replace the vendor with an injected `fetch`, as `providerClients.test.ts` already does for OpenAI and Google; no test makes a live DeepSeek call. The shared client carries two vendor details: requests send `max_tokens`, and every later tool turn returns the `reasoning_content` DeepSeek issued, because dropping it is a 400.

## 13. Non-functional requirements

- **Price:** $0.30 per MTok input on a cache miss and $1.20 per MTok output, at DeepSeek's peak rate; cache hits at 0.1x input, which is $0.03 per MTok. Source: DeepSeek Models and Pricing page, read 2026-11-19.
- **Context:** compaction triggers at 1,000,000 characters, a quarter of the 1M-token window at the repo's four-characters-per-token estimate.
- **Retries:** 2 retries at 1 second and 4 seconds on 500, 502, 503 and 504; a 429 is not retried and is handed to `usageLimitOf`.
- **Quota wait:** a recognised 429 waits up to `usageLimitWaitMinutes`, default 360 minutes.
- **Concurrency:** DeepSeek Flash allows 2,500 open requests, above the pool's ceiling of 16 parallel workers.
- **Cost ceiling:** the run cap `budget.runCapUsd` (default $30) is unchanged; the gate checks before every turn and now includes DeepSeek spend.
- **Cold starts:** a respawned DeepSeek worker starts from its `restartPrompt` with no transcript, bounded by `workerRespawnCap` (default 3 attempts), and each attempt publishes `starting cold` in `agent.log`.
- **Vendor wire:** a DeepSeek request sends `max_tokens`, and every later turn that carries tools returns the assistant's `reasoning_content`; a dropped field is a 400. Tested at `providerClients.ts` and `toolLoop.ts`.

## 14. Assumptions

| ID | Dimension | Assumption | Why this default | Overturn if |
|---|---|---|---|---|
| A-001 | integrations | DeepSeek is a first-class provider named `deepseek`, inferred from a `deepseek-` name, keyed by `DEEPSEEK_API_KEY`, and driven by the existing OpenAI-compatible client with base URL `https://api.deepseek.com`. | `providers.ts` infers vendors from names and has one client path for every non-Anthropic vendor; a configurable base URL would add a knob for one vendor. | DeepSeek's API stops being OpenAI-compatible, or a second vendor needs the same base-URL knob. |
| A-002 | constraints | The worker runs through the repo's stateless tool loop, not DeepSeek's Anthropic-format endpoint, so a respawned worker starts cold. | `toolLoop.ts` already carries every non-Anthropic role; the Anthropic-format route would need base-URL plumbing and would bypass the tool guards. | Resume fidelity after a respawn becomes the dominant cost of a DeepSeek run. |
| A-003 | non_functional | The price row uses the peak rate, $0.30 input and $1.20 output per MTok; off-peak sessions are over-charged by up to 2x. | `budget.ts` deliberately prices at the rate that stops a run early rather than late, and the Gemini rows do the same with standing rates. | DeepSeek makes peak pricing permanent, or a per-hour rate table is built. |
| A-004 | model_behavior | `deepseek-flash` names the V4.1-Flash-1017 checkpoint and no dated id is pinned. | DeepSeek's docs state that `deepseek-flash` always serves the current V4.1 Flash and that the dated names are legacy aliases. | Reproducibility requires a dated model id. |
| A-005 | non_functional | Compaction budgets 1,000,000 characters for DeepSeek. | `compact.ts` budgets characters well under each window; 1M characters is a quarter of the 1M-token window at four characters per token. | Workers on large repos hit compaction and lose context they need. |
| A-006 | interface | Config defaults store the bare `deepseek-flash`, not `deepseek/deepseek-flash`. | Every existing default is bare, and the provider is inferred from the name. | A model name that does not announce its family is added. |
| A-007 | errors | A DeepSeek 429 is recognised by adding `deepseek` to the `usageLimitOf` vendor regex; a 401 fails the session with the response body in the message. | Matches the OpenAI and Google handling in `providerClients.ts` and `usageLimit.ts`. | DeepSeek returns a refusal the current patterns do not recognise. |
| A-008 | model_behavior | Thinking mode stays at DeepSeek's default (enabled, effort high), and the vendor's `reasoning_content` is echoed on every later tool turn. | DeepSeek enables thinking by default and rejects a tool turn that drops the reasoning; disabling it would silently change the model being priced and evaluated. | A run's DeepSeek bill is dominated by reasoning tokens, or latency makes the 120-turn worker ceiling bind. |

## 15. Decision log

| ID | Dimension | Question | Options offered | Answer | Applied in |
|---|---|---|---|---|---|
| DL-001 | non_goals | You wrote "change the worker models to run deepseek v4.1 flash for regular build tasks". Which worker tiers does that mean? | A. Standard and light tiers (recommended) B. Standard tier only C. All four worker tiers D. Local config only, no default change | A | §2, §4, §5 |
| DL-002 | errors | DeepSeek becomes the default worker, so DEEPSEEK_API_KEY becomes mandatory for every run. What should happen when it is not set? | A. Refuse at run start (recommended) B. Fall back to Sonnet with a warning | A | §5, §7 |
| DL-003 | rollout | What number decides whether the DeepSeek worker default stays, and when? | A. Cost plus QA pass-rate gate (recommended) B. Cost-only gate C. No numeric gate | A | §3, §10 |

## Coverage

| Dimension | Status | Ref |
|---|---|---|
| purpose | specified | §1, §3 |
| actors | specified | §2, §5 |
| permissions | specified | §5, §7 |
| triggers | specified | §5 |
| inputs | specified | §5, §12 |
| outputs | specified | §5, §9 |
| states | specified | §5, §13 |
| errors | specified | §5, §13, A-007 |
| interface | specified | §6, A-006 |
| data | specified | §12 |
| integrations | specified | §12, A-001 |
| non_functional | specified | §13, A-003, A-005 |
| constraints | specified | §7, A-002 |
| non_goals | specified | §4, DL-001 |
| acceptance | specified | §5 |
| rollout | specified | §10, DL-003 |
| model_behavior | specified | §5, §13, A-004, A-008 |
