# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0.0
on. Before then, minor versions may break things.

## [Unreleased]

### Changed

- **Old models are retired.** Claude Fable 5 and 5.1, Opus 5, Sonnet 5,
  Haiku 4.5, and Gemini 3.6 and 3.7 Flash now run as their current
  replacement from the same vendor and tier: Fable 5.2, Opus 5.5, Sonnet 5.5,
  Haiku 5.5 and Gemini 3.8 Flash. That applies to `charrette.config.json`,
  `--model`, the dashboard and the models an existing run recorded when it
  started. A run created under the old defaults was still sending interface
  tasks to `claude-opus-5` after Opus 5.5 became the default; it now moves at
  its next `charrette resume`, which prints a `retired` line for each role that
  moved. The dashboard no longer offers retired models.

### Fixed

- **A product's own name no longer makes every task interface work.** The
  interface rule and the skill router matched the repository's name inside
  each task, so in a repository called `sales_dashboard` nearly every task,
  including the repo scaffold, went to `workerUi` on Opus with the design
  skills. Words from the repository's directory name are now ignored for that
  match. A task about the product's charts, pages or forms is still interface
  work.
- **`charrette resume` no longer re-routes a run to the model it is already
  on** when `charrette.config.json` still names a retired id.

## [0.3.0] - 2026-11-21

### Changed

- **New default models, across three vendors.** DeepSeek Flash now runs every
  role that builds or drives tools (`worker`, `workerLight`, `integrator`,
  `advisor`, `demo`, `live`, `repair`, `skillsmith`). Gemini 3.8 Flash runs the
  roles that read and decide (`planner`, `spec`, `pm`, `workerHeavy`). The
  Anthropic roles move to the current generation: `intake`, `prod` and
  `workerUi` to `claude-opus-5-5`, and `qa` to `claude-sonnet-5-5`. Runs
  already recorded keep the models they froze.
- **The pinned roles can be changed from the dashboard.** `intake`, `qa`,
  `prod` and `reviewer` were shown as locked text. Each now has a dropdown that
  offers only the models its pin allows, so a judge can move to a newer model
  from the same vendor but not to another vendor or that vendor's small tier.

### Added

- **A startup check for newer models.** `charrette run` and `charrette resume`
  list what each vendor in use serves and print a `newer` line for any role
  whose model has a newer release in the same family, with the flag and
  config line that would switch it. It recommends and never applies, stays
  within a family, and says when the newer model is not priced yet. A vendor
  that cannot be reached is skipped quietly. `CHARRETTE_MODEL_CHECK=0` turns
  it off.
- **Claude Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5** are priced
  ($8/$40, $4/$20, $2/$10 and $0.50/$2.50 per MTok) and offered in the
  dashboard. Haiku 5.5 is billed at its rate for prompts over 100K tokens,
  so the ledger can only over-charge it.

### Fixed

- **A non-Anthropic `repair` model could have invented a QA verdict.** Repair
  resumes the QA session to restate a verdict it did not format. Gemini,
  DeepSeek and OpenAI sessions cannot be resumed, so a repair on one of them
  started with nothing in front of it and was asked for "the conclusion you
  already reached". The re-ask now runs on `models.qa` whenever the repair
  model cannot resume.
- **A non-Anthropic planner lost the PRD after its first message.** When a
  plan took more than one message, a planner with no session to resume was
  asked for "the NEXT tasks" holding only the titles emitted so far. Each
  continuation now re-sends the briefing to a planner that cannot resume.
- **The output-ceiling warning no longer names the Agent SDK for a planner
  that does not run through it.**

## [0.2.0] - 2026-11-21

### Added

- **`spec-clarifier` is part of the run.** Intake carries it as its
  questioning method, and the spec agent writes the clarified PRD to
  `docs/prd/<feature>.md` with `spec_clarifier.py` (`validate --strict`)
  before deriving the `prd-to-tdd` artifact from it.
- **Routing for 13 more of the operator's skills**: `stripe-setup-specialist`,
  `accountant`, `app-store-publisher`, `play-store-publisher`,
  `lifecycle-email-engineer`, `legal-page-reviewer`, `technical-translator`,
  `sre`, `k8s-optimizer`, `cost-optimizer`, `sentinel` (security and auth),
  `human-writer` (docs, worker only), and `prod-validator` pinned to the
  `prod` role.
- **Sibling playbooks.** The indexer reads `aliases`, `tags` and
  `delegates_to`. Each carried skill's installed siblings are listed by path in
  the session's skills block, hash-checked like the skills themselves.

### Fixed

- **The security route named a skill that no longer exists.**
  `security-engineer` is now `sentinel`; the old name had been dropped without
  a word on every run.
- **A routed skill can answer to another name.** `skillRouting` now resolves a
  name through a skill's `aliases:` frontmatter when no skill has that exact
  name, so a DNS skill installed under its own name can still take the
  `dns-iac-engineer` route by listing it as an alias.
- **The acceptance gate could pass an unimplemented scenario.** `prd-to-tdd`
  stubs carry strict expected-failure markers, which a runner reports as ✓.
  The gate now runs the suite with `TDD_RED_CHECK=1`, which switches them off,
  and the spec agent scaffolds with `stubs --no-xfail` and proves the red bar
  with `lint-tests` and `verify-red`.
- **`roles` on a `skillRouting` rule in `charrette.config.json`** no longer
  makes the strict config schema reject the whole file.

### Changed

- **Regular build tasks now default to DeepSeek V4.1 Flash.** `models.worker`
  and `models.workerLight` are `deepseek-flash` at $0.30 input and $1.20 output
  per MTok at peak, roughly a tenth of Sonnet's input rate. `DEEPSEEK_API_KEY`
  is required for every run, and a run refuses to start without it. Interface
  tasks (`workerUi`, Opus 5) and the escalation ceiling (`workerHeavy`, Fable
  5.1) stay where they were. The DeepSeek client is OpenAI-compatible with two
  vendor differences the shared client now carries: `max_tokens` instead of
  `max_completion_tokens`, and the return of `reasoning_content` on every later
  tool turn. Runs already recorded keep the models they froze.

### Security

- **The operator's skills-discovery MCP is switched off inside run sessions.**
  Updated skills tell an agent to query it and read whatever `SKILL.md` it
  ranks, which bypassed routing and the injection-time hash check. Every
  session's skills block also says that a playbook's live-account steps
  (Stripe, app stores, DNS, monitors, email) are left to the operator.

- **All 23 dependency advisories reported by `pnpm audit` are closed** — 15 of
  them mirrored as open Dependabot alerts — including the critical
  `proxy-addr` IP-spoofing alert and the high `zod`, `body-parser`,
  `happy-dom`, `source-map-js`, `vite` and `nanoid` advisories. Overrides lift
  `fast-uri` to 3.1.9, `vite` to 7.3.7, `hono` to 4.13.14, `ip-address` to
  10.7.5, `source-map-js` to 1.2.2, `proxy-addr` to 2.0.8, `body-parser` to
  2.4.0 and `nanoid` to 3.3.18.

  `zod` moves to 4.6.7 across every package, the version the Agent SDK's own
  peer range asks for. Zod 4 applies a field's default even after `.partial()`,
  so config-file parsing now explicitly returns only the keys the file
  declared; without that, `init --force` would persist every default as if the
  operator had chosen it. A lockfile test fails the build if any security floor
  slips.

## [0.1.0] - 2026-09-18

First public release. `charrette` and the `@charrette/*` packages are on npm
from here; everything below happened before any of them was published, so it is
the starting state rather than a set of changes from something people were
running.

### Changed — BREAKING

- **The project is now called Charrette.** The working name "Harness" collided
  with Harness.io, a CI/CD company in the same goods class. See PRD §9 for the
  decision and the evidence behind it.

  What this renames:

  | Was | Now |
  |---|---|
  | `harness` (CLI) | `charrette` |
  | `@harness/*` (packages) | `@charrette/*` |
  | `HARNESS_*` (environment) | `CHARRETTE_*` |
  | `harness/<runId>/*` (branches) | `charrette/<runId>/*` |
  | `.harness/` (run state) | `.charrette/` |
  | `harness.config.json` | `charrette.config.json` |

  **Existing runs keep working.** A repository that has `.harness/` and no
  `.charrette/` is read exactly as before, legacy filenames included, and
  `harness.config.json` is still loaded when `charrette.config.json` is absent.
  Nothing migrates on its own — moving a live ledger is yours to decide, and
  both layouts stay readable until you do.

  **Environment variables do not have a fallback.** Rename `HARNESS_*` to
  `CHARRETTE_*` in your shell or `.env`. They were never read from a repository,
  so nothing on disk depends on them.

- **Minimum Node is now 22.13**, up from the previously documented 22.0.
  `node:sqlite` is only available without `--experimental-sqlite` from 22.13 and
  23.4 on, so the old floor did not actually work.

### Added

- **Releases publish from CI with no stored npm credential.**
  `.github/workflows/release.yml` runs on a `v*` tag and authenticates to npm
  through OIDC — a token minted for that one run and useless afterwards. It
  re-runs build and the full suite, refuses to publish if any package version
  disagrees with the tag, and attaches provenance so the npm page states which
  commit and which run produced the tarball. `docs/RELEASING.md` covers the
  registry-side setup, which lives on npmjs.com and is therefore invisible from
  the tree until it breaks.
- Publish metadata on every shipped package: `description`, `license`,
  `repository` (with `directory`), `homepage`, `bugs`, and
  `publishConfig.access: public` — without the last of those a scoped package's
  first publish is private by default.

- `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SUPPORT.md`, `MAINTAINERS.md`, `CODEOWNERS`, issue and pull request
  templates, Dependabot, and an OSS compliance check in CI.

### Changed

- Published tarballs no longer carry compiled tests. `files` is `dist` minus
  `dist/**/*.test.*`: the tests are still built, because `pnpm build` is what
  typechecks them, they simply are not part of what anyone installs. They were
  more than half the bytes — `@charrette/core` went from 1.4 MB to 716 KB.

- **The coverage gate is counts, not percentages, and two files sit above zero.**
  Vitest 4 made AST-aware remapping unconditional for the V8 provider, so a
  `.catch(() => fallback)` that never ran is no longer credited because the line
  it sits on did. Nothing regressed — the repository was never at 100% in the
  sense the number claimed — and all 54 statements, 52 functions, 27 branches
  and 14 lines of it are in `git.ts` and `runController.ts`, whose git and merge
  failure paths have never been exercised. The thresholds are now maximum
  uncovered *counts*, globally and per file, because a percentage floor absorbs
  new debt as a repository grows and a count does not: every other file is at
  zero, so an uncovered line anywhere else fails the build. Tracked in
  [#5](https://github.com/ryabinski-labs/charrette/issues/5); the numbers only
  move down.

- **`vitest.config.ts` is typechecked.** It belongs to no package, so
  `pnpm -r build` never saw it, and vitest loads it by stripping types rather
  than checking them — the one file that decides CI's exit code was the only
  unchecked TypeScript in the repository. `pnpm build` now runs
  `tsconfig.tools.json` over it.

### Security

- **No long-lived registry token exists for this project.** npm releases go
  through the OIDC trusted publisher above; the PyPI name reservations were
  placed with a token that was revoked immediately afterwards, and the
  revocation was confirmed by a rejected upload rather than by the tokens page.

- **`fast-uri` pinned to `^3.1.6`** (GHSA: host confusion via percent-encoded
  scheme normalization). It is a runtime dependency, reaching the project
  through both fastify's ajv compiler and the Agent SDK's ajv, neither of which
  has floated past the vulnerable 3.1.5 yet. The override goes away once they
  do.

- **`qs` lifted to `^6.16.0` and `hono` to `^4.13.5`** (GHSA-x5fp-wj9c-mxmx,
  GHSA-4mjr-xmp4-gh2g, GHSA-gqvv-2mrq-wpjv, GHSA-g6gw-c38x-mqfc,
  GHSA-crvj-82cr-hjcx). Both arrive through `@modelcontextprotocol/sdk` — express
  for its HTTP transport, `@hono/node-server` for its Hono one — and the SDK is
  driven over stdio here, so neither parser is on a path this project calls. They
  are installed, though, which is what an advisory scan sees, and nothing in the
  repository declares either package, so only a `pnpm-workspace.yaml` override
  could move the pin.

- **`vitest` upgraded to 4.1.11** (GHSA-82fw-gwwq-j7x9: arbitrary file read via
  `@vitest/mocker` redirect mocks). Reachable without authentication only
  through the standalone `mockerPlugin`/`interceptorPlugin` exports, which this
  project does not use — but there is no 3.x patch, so the fix is the major.
  Note for anyone with their own reporter: `onFinished` was **removed** from the
  reporter interface rather than deprecated, and an unrecognised key on a
  reporter object is silently never called.
- **Pull request CI no longer runs on self-hosted runners.** On a public
  repository that let any fork execute code on the project's own infrastructure.
  Pull requests now run on GitHub-hosted runners; `main` and manual dispatch
  still use self-hosted.
