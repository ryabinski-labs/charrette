# Claude Flow adoption: QA report

Date: 2026-09-10. Scope: the [adopted practices](CLAUDEFLOW-LEARNINGS.md),
worker briefing and retry boundaries, persisted guidance, review evidence,
built CLI and skills discovery, plus the full repository regression suite.

## Method and environment

Discovered `qa-agent` using `search_skills` and read it using `describe_skill`
through the built Harness MCP server's actual **stdio** transport. Followed its
scenario-driven regression workflow and delegated independent reviews to
`performance-engineer` and `sentinel`. No TDD artifact was found by the skill's
artifact locator, so the ten scenarios below define this change's checks.

Local baseline: macOS arm64, Node v25.2.1, pnpm 9.12.0, existing dependencies,
branch `feat/agent-context-efficiency` based on `6a11bef`. The repository declares
pnpm 11.22.0 and CI uses Node 24; the local run does not substitute for that CI
matrix. No dependency or lockfile changes were needed. Podman and Docker are
available, but the repo has no container startup path; used its documented
native build/test workflow. CLI smoke tests used a newly initialized temporary
Git repository, a trivial Node assertion script, and no external remote.

## Confirmed findings and fixes

| Finding | Reproduction and fix | Durable regression |
| --- | --- | --- |
| Delivered guidance disappears after a cold retry. | Queue an operator constraint, deliver it, then reject/crash a worker whose summary omits it. Initial regressions failed for both outcomes. Restore scoped feedback events, non-parked gate answers and delivered issue bodies. A separate failing test proved count-only issue events were insufficient. Preserve author/decider attribution and operator precedence. | `taskLoop.test.ts`: previously delivered guidance and live pool retry; `taskContext.test.ts`: persisted guidance, issue bodies and isolation. |
| QA receives stale green-check evidence after a probe changes files. | A deterministic check passes, then the completion probe changes the checked file to a failing value. The initial regression reproduced QA being offered that old result. Suppress check reuse whenever a probe runs afterward, including probes with non-file side effects. | `taskLoop.test.ts`: probe changes checked files; unchanged-tree evidence and inherited failure cases. |
| An internal cold retry retains an obsolete resume handle or only a follow-up prompt. | Start a resumed Claude worker, switch to a different login, and inspect the next SDK call. The initial regression retained the old handle. Distinguish first attempts from retries; clear cold handles and call the current full-briefing factory. | `poolSubscription.test.ts`: different login; `poolLimit.test.ts`: thrown quota error; `poolTransport.test.ts`: real provider loop with mocked HTTP quota responses. |
| A crash discards a newer completed summary for an older checkpoint. | Complete an iteration after its checkpoint, reject it, then crash the next attempt before a new checkpoint. Keep the previous completed summary unless the interrupted attempt actually checkpoints newer work. | `taskLoop.test.ts`: paired cases with and without a newer checkpoint. |
| Guidance lookup scans unrelated events in a long run. | Performance review found `IN (...) ORDER BY seq` selecting the run-wide index. Use exact-type `UNION ALL` branches and existing indexes; sort only matching guidance, including issue rows. No schema/index migration. | `taskContext.test.ts`: scoped content, mixed-source ordering and actual query-plan assertions; independent synthetic comparison. |

The security review independently rechecked issue-body preservation, authority
labels, run/task isolation, cold retry reset and initial resume preservation,
and reported no remaining blocker. The performance review confirmed the paired
summary tests and closed its scan finding after verifying that both final event
branches use `idx_events_run_type`, and issue feedback uses `idx_feedback_source`.
In 51 interleaved
synthetic warm samples, its two-event-branch comparison at 400,000 events / 400
guidance rows reduced p95 from 76.38 ms to 0.738 ms with identical results.
That is a local SQL comparison, not a measured agent-token or dollar saving;
the final query additionally reads issue feedback.

All confirmed findings are fixed here. They are recorded in this PR instead of
creating separate already-fixed GitHub issues. No unresolved defect was left
as an untracked recommendation.

After the tested branch was pushed, GitHub reported **19 existing open
Dependabot alerts on the default branch: 9 high and 10 moderate**. These concern
unchanged dependencies (`fast-uri`, `nanoid`, `fastify`, `hono`, `qs`,
`vitest`/`@vitest/mocker`), not new dependencies in this change. They remain
tracked in [the repository's dependency alerts](https://github.com/ryabinski-labs/harness/security/dependabot).
This PR does **not** remediate those advisories or establish their exploitability.
An independent follow-up review confirmed the vulnerable versions are unchanged
and found no demonstrated advisory trigger introduced by this feature.
In particular, the reported Vitest fix requires moving from the current 3.x
test toolchain to 4.1.11 or later, a separate compatibility migration. The
passing functional suite and scoped security review are not a clean bill of
health for the repository's dependency supply chain.

## Scenario results

| Scenario | Expected result and evidence | Result |
| --- | --- | --- |
| QA-01: cold/provider-switch retries | Full task, criteria, recovery and feedback; OpenAI, Google and cross-provider escalation fixtures in `taskLoop.test.ts`. | Passed |
| QA-02: warm retries | Compact follow-up only when transcript is resumable; caller's first resume preserved, different-login resume cleared. Controller and pool tests. | Passed |
| QA-03: interrupted/persisted state | Worker-only scoped checkpoints survive DB reopen and >500 later events; completed-summary preference and queued/live/issue guidance survive retries. | Passed |
| QA-04: bounded hints | Explicit truncation at 2,000/3,000/4,000-character hint limits; full task, criteria, probe and guidance retained. `taskContext.test.ts`. | Passed |
| QA-05: dependency reuse | Only direct merged dependencies included, scoped by run; missing, pending and unrelated tasks excluded. | Passed |
| QA-06: review evidence | No inherited failures presented as green; no reuse after completion probe; fresh successful checks supplied otherwise. | Passed |
| QA-07: built CLI | Actual executable: read-only `status` creates no state directory; `init --run-cap 5` discovers and executes `npm run test`; `status`, `version`, root and init help succeed. | Passed |
| QA-08: stdio MCP | Actual SDK client/server subprocess: `search_skills` finds `qa-agent`, `describe_skill` returns its instructions. Rechecked after build. | Passed |
| QA-09: documentation | All 9 local links in added/changed content resolve; all 9 unique upstream source links return HTTP 200. Dependency alerts retrieved through the authenticated GitHub API. Behavior and limits checked against implementation. | Passed |
| QA-10: complete regression | `pnpm build` passed; full `pnpm test:coverage --maxWorkers=6 --reporter=dot`: 3,561 tests in 156 files passed, 100% lines/statements/functions/branches, exit 0. | Passed |

The focused QA rerun passed **21 tests in 5 files**; 105 unrelated cases were
excluded by that run's name filter, not silently skipped by the full suite.
Two additional ordering/query-plan tests were then added; the full context file
passed **9 tests**. The workspace build passed again. The final complete rerun
passed **all 3,561 tests in 156 files**, with **100% line, statement, function and
branch coverage** and exit code 0. No tests were skipped in that complete run.

The first complete run passed 3,559 tests and exposed two legacy assertions
that contradicted the new recovery contract: dropping already-delivered issue
text, and excluding all mentions of a completion probe even after amendment.
The updated tests instead verify one queued issue record with its instruction
present once in the cold retry, and the amended probe without the obsolete
command. Both affected tests passed before the complete rerun; no acceptance
criterion or coverage threshold was relaxed.

## Boundaries

Provider responses are mocked at the SDK/HTTP boundary; task-loop tests use real
SQLite stores and temporary Git worktrees. No live paid provider calls, output
quality benchmark, production deployment, or measured budget saving is claimed.
The unchanged dashboard's visual design was not manually exercised; the full
repository suite includes its automated tests. No mobile, email or payment
flows were changed. No product server, container or provider session was left
running by these smoke tests. Temporary local QA logs and fixtures are retained
outside the repository; no credentials are included in this report.
