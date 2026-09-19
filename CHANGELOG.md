# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0.0
on. Before then, minor versions may break things.

## [Unreleased]

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
