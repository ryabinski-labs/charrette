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

- `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SUPPORT.md`, `MAINTAINERS.md`, `CODEOWNERS`, issue and pull request
  templates, Dependabot, and an OSS compliance check in CI.

### Security

- **`fast-uri` pinned to `^3.1.6`** (GHSA: host confusion via percent-encoded
  scheme normalization). It is a runtime dependency, reaching the project
  through both fastify's ajv compiler and the Agent SDK's ajv, neither of which
  has floated past the vulnerable 3.1.5 yet. The override goes away once they
  do. The remaining Dependabot alerts are development-scope or need the vitest
  3.x → 4.x migration, and are tracked separately.
- **Pull request CI no longer runs on self-hosted runners.** On a public
  repository that let any fork execute code on the project's own infrastructure.
  Pull requests now run on GitHub-hosted runners; `main` and manual dispatch
  still use self-hosted.
