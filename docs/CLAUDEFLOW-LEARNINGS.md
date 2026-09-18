# Claude Flow practices adopted by Charrette

Reviewed on 2026-09-10 against
[`kennyjpowers/claude-flow` at `9ac902f`](https://github.com/kennyjpowers/claude-flow/tree/9ac902fd28c65ca5bb0c441a922a3d9829ff3987).
This is the repository supplied for the comparison.

The [website](https://www.claudeflow.dev/) advertises an agent and hook bundle.
The [current repository README](https://github.com/kennyjpowers/claude-flow/blob/9ac902fd28c65ca5bb0c441a922a3d9829ff3987/README.md)
describes v2 as standalone workflow commands, with ClaudeKit and STM removed.
The shipped commands are the basis for this comparison. They prescribe how an
assistant should work; they do not implement a token ledger or enforce a dollar
cap. Their likely cost benefit is avoiding rediscovery and repeated work. We
have not measured dollar savings from these practices in Charrette.

## What transfers

| Practice and upstream evidence | Charrette treatment |
| --- | --- |
| Resume using implementation history and completed dependencies: [execute](https://github.com/kennyjpowers/claude-flow/blob/9ac902fd28c65ca5bb0c441a922a3d9829ff3987/.claude/commands/spec/execute.md) and [design rationale](https://github.com/kennyjpowers/claude-flow/blob/9ac902fd28c65ca5bb0c441a922a3d9829ff3987/docs/DESIGN_RATIONALE.md). | Added bounded worker recovery notes from existing checkpoints or the previous iteration's summary. Cold starts retain the complete assignment. |
| Give workers a concrete task, criteria, files and dependency context: [execute](https://github.com/kennyjpowers/claude-flow/blob/9ac902fd28c65ca5bb0c441a922a3d9829ff3987/.claude/commands/spec/execute.md). | Added planned files, the completion probe and direct merged dependencies to fresh worker briefings. |
| Preserve completed and in-progress tasks; decompose only new requirements: [decompose](https://github.com/kennyjpowers/claude-flow/blob/9ac902fd28c65ca5bb0c441a922a3d9829ff3987/.claude/commands/spec/decompose.md). | Already covered by persisted task state, incremental replanning, duplicate-work detection and scope checks. Kept these mechanisms. |
| Parallelize independent work after checking dependencies and shared files: [decompose](https://github.com/kennyjpowers/claude-flow/blob/9ac902fd28c65ca5bb0c441a922a3d9829ff3987/.claude/commands/spec/decompose.md). | Already covered by the DAG scheduler, path conflict exclusion and isolated worktrees. No increase to agent concurrency. |
| Save feedback decisions immediately, and process pending items: [feedback resolution](https://github.com/kennyjpowers/claude-flow/blob/9ac902fd28c65ca5bb0c441a922a3d9829ff3987/.claude/commands/feedback/resolve.md). | Reused SQLite as the source of truth; cold recovery now restores already-delivered task feedback, issue comments and gate decisions. |
| Keep documentation aligned with what was implemented: [doc-update](https://github.com/kennyjpowers/claude-flow/blob/9ac902fd28c65ca5bb0c441a922a3d9829ff3987/.claude/commands/spec/doc-update.md). | Added a scoped worker instruction to update affected behavior, configuration and command documentation. |
| Diagnose prerequisites before spending effort: [doctor](https://github.com/kennyjpowers/claude-flow/blob/9ac902fd28c65ca5bb0c441a922a3d9829ff3987/lib/doctor.js). | Charrette already resolves configuration, checks credentials and build provenance, and detects checks before work begins. No second setup system added. |

## Runtime changes

The implementation is in [taskContext.ts](../packages/core/src/taskContext.ts),
[prompts.ts](../packages/core/src/prompts.ts) and
[runController.ts](../packages/core/src/runController.ts), with pool-internal
retry handling in [pool.ts](../packages/core/src/pool.ts).

**Recover useful state without another model call.** On a fresh worker session,
Charrette reads the latest nonempty checkpoint for that run and task, from a
session recorded as a worker. It ignores QA and other tasks' checkpoints. The
query reads persisted events directly, so it works after a process restart and
does not depend on the first page of the event log. During an uninterrupted
retry, a completed worker summary takes precedence over its older checkpoint.
After a worker crash, a checkpoint emitted during the interrupted attempt takes
precedence; otherwise the previous completed summary is retained. After a
process restart, the persisted checkpoint is available even without that
in-memory summary.

**Keep cold retries self-contained.** OpenAI and Google sessions in the current
Charrette transport cannot reattach to an earlier conversation. Previously,
their synthetic session IDs could cause a retry to receive only the rejection
message. They now receive the task and acceptance criteria again, plus recovery
context and current feedback. Resumable Anthropic retries keep the compact
follow-up. This is a correctness fix as well as an efficiency improvement.
Pool-internal quota retries and account switches also rebuild the briefing if
the transcript cannot be resumed, explicitly clearing obsolete session handles.

**Preserve decisions after their first delivery.** Cold briefings replay scoped
task feedback and non-parked gate answers, including guidance previously
delivered live. Issue comment bodies and authors come from the persisted
feedback table, not the count-only event. Gate answers retain the deciding
operator or skill's identity. Entries are ordered by recorded timestamp, with
issue context before direct feedback on ties; event sequence and feedback IDs
break remaining ties. Issue context and agent notes cannot override operator
decisions. Exact-type queries use existing indexes rather than scanning all
tool and log events in a long run.

**Bound hints, preserve requirements.** Derived context is limited to 2,000
characters for planned files, 2,000 for dependency descriptions, and either
4,000 for a checkpoint or 3,000 for a prior summary, plus labels. Truncation is
explicit. Task specifications, acceptance criteria, completion probes and
operator feedback are preserved. Dependency hints include only directly
required, merged tasks. Their paths are planner estimates, so the worker must
inspect the implementation. Recovery text is labeled as an agent's prior
observations; it cannot authorize changes or establish completion.

**Reuse observed check results during review.** As a Charrette-specific extension
of avoiding repeated work, QA now sees which configured deterministic checks
just passed in its worktree. Commands that initially failed are not listed as
green, including failures excused as inherited or flaky. No check reuse is
offered if a completion probe runs afterward: even a successful probe can
change files, services or the environment. The reviewer must
verify uncovered criteria, exercise the product and rerun affected checks after
edits or environment changes, or when investigating flakiness. No acceptance
gate is bypassed and no cross-revision test cache is introduced.

Workers also receive instructions to start with relevant files, read bounded
ranges, keep command output focused, and use focused tests during iteration.

## Budget and verification

Existing model tiers, escalation, dollar caps, approval authority, scope checks
and independent QA remain in force. Claude Flow's broad expert consultations
and mandatory parallel groups are not a reason to add agents to every task:
each extra session has context and coordination costs. Likewise, its numbered
Markdown lifecycle is useful organization, but duplicating Charrette's task state
into a second editable tracking system would create synchronization work.

Regression tests exercise cold retries on both stateless providers, warm
Anthropic retries, recovery after a worker crash, checkpoint persistence across
a database reopen, run/task/role isolation, bounded hints with intact
requirements, and the successful-check evidence handed to QA.
The follow-up [QA report](CLAUDEFLOW-QA.md) records adversarial regressions,
specialist review and end-to-end transport checks.

To evaluate actual savings, compare matched workloads with the same models,
caps and acceptance criteria. Use the existing session and ledger records to
compare input tokens, cache reads, turns, respawns, QA iterations and total
cost per merged task. Check completion and unresolved criteria alongside cost;
a cheaper unfinished task is not an efficiency gain. The changes require no
new service, dependency, configuration flag or paid summarization call.
