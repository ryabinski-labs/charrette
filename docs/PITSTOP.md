# Pit stops — showing the operator what exists, while there is still budget to change it

Status: **built**. Owner: operator. Written after run `ec40b527` (icelandcopilot-companion)
and run `40da9337` (billing-app); implemented on top of that, with the three open
questions answered at the bottom.

## The problem, in two runs

**icelandcopilot-companion, `ec40b527`.** $97.19, 25 tasks, all merged, 15:51 → 19:10.
The intent validator finished with **FAIL** and named the defect exactly:

> Frontend's `ApiClient.getCurrentPack()` calls `GET /v1/pack/current` (singular)
> while the Go backend only serves `GET /v1/packs/current` (plural) — the pack
> catalogue fetch that gates the entire resumable download flow is broken
> end-to-end despite both sides' unit tests passing independently.

It went further and said, unprompted, that it had not exhaustively checked and that
further mismatches "of the same class (right endpoint name, wrong case; right shape,
wrong field)" were likely. Both statements were true. Both were found again by hand,
hours later, by a human reading the code.

The verdict was correct, specific, and volunteered. It was printed once, at the end,
to a terminal that had scrolled.

**billing-app, `40da9337`.** 27 hours, 34 of 36 tasks merged, $721 of sessions —
worker $522 across 259 sessions and 16,930 turns. The operator's question about it
was *"I am not sure what billing-app is doing either."* Answering that took a
read-only copy of the run database and four SQL queries.

## The gap

The harness has exactly two human checkpoints:

| Gate | When | What the operator sees |
| --- | --- | --- |
| Plan gate | Before any code exists | A PRD and a task list |
| Task gate | When one task is stuck | That task's failure |
| — | **While the run is building** | **nothing** |

There is no point at which the harness says *"here is what you have now — is this
what you wanted?"* while there is still budget to change course. Every signal the
harness produces mid-run is either a per-task escalation (too narrow to see the
product in) or a line in a log (too fast to read).

The plan gate is the wrong place to catch this: it fires before a single line
exists, so the operator is approving a description, not a product. The closing
report is also the wrong place: the money is spent.

## Target user and job

The operator running a multi-hour, multi-hundred-dollar run on their own machine.
Their job is not to supervise tasks — the harness does that. It is to answer one
question periodically: **is this still the thing I wanted?** Today they can only
answer it at the start, from a plan, or at the end, from a diff.

## Goals

1. The operator sees the built product, running, at intervals they choose.
2. Their reaction — "keep going", "not this, do that instead", "stop" — reaches the
   tasks that have not run yet.
3. A run's own FAIL verdict is never delivered for the first time after the run ends.

## Non-goals

- Not a replacement for the plan gate or the task gate.
- Not a per-task review. A pit stop is about the product, not the increment.
- Not automatic redirection *without a record*. The harness now decides for
  itself by default — `pitStop.decidedBy` names the skill that answers, and
  `"operator"` restores the original — but every decision is written into the
  pit stop's own `REPORT.md` and carried on `run.pitstop_resolved` with who made
  it and why. A run that redirected itself and a run the operator redirected are
  different histories, and both are readable afterwards.
- Not a deploy. A pit stop runs the product locally, the way QA already does.

## Trigger

Configured per run in `harness.config.json`:

```json
{
  "pitStop": { "every": "epic" }
}
```

`every` accepts:

| Value | Fires when |
| --- | --- |
| `"epic"` (default) | Every task in an epic has reached a terminal state |
| `"never"` | Off — today's behaviour |
| `{ "tasks": 5 }` | Every 5 merged tasks |
| `{ "usd": 100 }` | Every $100 of run spend |
| `{ "minutes": 90 }` | Every 90 minutes of wall clock |

Epic is the default because it is the only boundary that is *about the product* —
the others are about the run. A count, a budget or a clock can cut an epic in half
and demo something that was never meant to stand alone.

Whatever the trigger, a pit stop never fires while a task is mid-QA: it waits for
the in-flight tasks to reach a terminal state, so the operator sees a settled tree.

## What the harness shows

A pit stop dispatches a **demo agent** — a QA-role session with the toolbelt and
the `visual-qa-agent` skill — against the integration branch, told to:

1. Start the product the way the repo's own README says to start it.
2. Drive the journeys the merged tasks claim to deliver, end to end.
3. Capture evidence: screenshots for anything rendered, request/response pairs for
   anything served, command output for anything CLI — each one with the claim it
   backs, in a sentence.
4. Say plainly what it could not reach, and why.

Point 4 is the one that matters. The value of `ec40b527`'s validator was not that
it passed or failed — it was that it said *which* parts it had not checked.

### What counts as evidence

Run `da8325bd`'s second pit stop offered two files. One was a 1082×2202 white
rectangle — the mobile page had never painted — and the other was a screenshot of
a homepage with nothing attached saying what it was for. The demo agent had even
admitted the blank capture, four paragraphs into its summary. Nothing between it
and the operator ever opened the files.

So the harness opens them (`evidence.ts`). Every artifact the demo agent lists is
read before the report renders, and one that is not there, is empty, is an image
of a single flat colour, or arrives with no claim attached is **not evidence**.
When a retake could fix it, the demo session is resumed — the product it started
is still up, so this costs a handful of turns rather than a second demo — with
the faults named. Whatever still fails is struck from the evidence list and
reappears under *What it could NOT check*, saying what was struck and why: an
operator shown neither the file nor the failure assumes the surface was covered.

The demo agent is told the same rule and told how to satisfy it, so the usual
path is that it never reaches the gate: look at every screenshot with Read before
listing it, and a blank one means the page had not painted or the device
descriptor pinned a browser that is not installed.

The gate payload carries:

- The demo agent's evidence, and its list of what it could not exercise.
- What merged since the last pit stop, one line per task.
- Spend so far, against the cap, and the projection to the end of the plan.
- The tasks not yet started, in dispatch order — so "stop before you build X" is
  a thing the operator can actually say.
- The intent verdict so far, if one has been recorded.

## User stories

**S1 — See it running.** As an operator, when a pit stop opens, I see screenshots
or transcripts of the product actually running, not a description of it.
*Acceptance:* the gate payload contains at least one artifact produced by executing
the merged code; when the demo agent could not start the product, the payload says
so in its first line rather than showing nothing. Every artifact it lists has been
opened by the harness and carries the claim it backs; a blank capture, a file that
was never written, or one offered without a claim is struck from the evidence and
reported as something the pit stop did not check.

**S2 — Redirect the remaining work.** As an operator, I write what I want changed,
and the tasks that have not run yet receive it.
*Acceptance:* text entered at a pit stop is attached to every task not yet in a
terminal state, and appears in the worker prompt of the next task dispatched.

**S3 — Re-plan from here.** As an operator, I can send the remaining DAG back to
the planner with my words and the built tree as context, without losing what has
already merged.
*Acceptance:* re-planning at a pit stop leaves merged tasks untouched, replaces
only tasks that have not started, and records the reason on the run.

**S4 — Stop while I think.** As an operator, I can end the run at a pit stop and
resume it later.
*Acceptance:* the run reaches a state `harness resume` picks up; no worktree or
branch is discarded.

**S5 — Choose the cadence.** As an operator, I set the interval before the run and
change it on resume.
*Acceptance:* `pitStop.every` is read from `harness.config.json` at run start and
re-read on resume, like `deterministicChecks` and `qaMaxTurns` already are.

**S6 — Never learn it at the end.** As an operator, if the harness has recorded a
FAIL verdict, I have seen it at a pit stop before the run closes.
*Acceptance:* a recorded intent FAIL opens a pit stop at the next boundary
regardless of the configured interval.

## Success metrics

| Metric | Today | Target |
| --- | --- | --- |
| Spend between a divergence entering the tree and the operator seeing it | Whole run ($97 on `ec40b527`) | ≤ one epic |
| Runs whose closing report is the first sight of a FAIL verdict | 1 of 1 measured | 0 |
| Operator can answer "what is it doing?" without reading the database | No | Yes |

The second is the one to hold the feature to. The first two runs both produced
honest, accurate findings that arrived too late to act on; that is the defect.

## Risks

- **Demo cost.** A demo agent per epic is real money on top of the run. Mitigation:
  it is a QA-role session with a turn ceiling, not an open-ended investigation, and
  `"never"` is one config line away.
- **A pit stop that cannot demo anything.** Early epics are often scaffolding with
  no user-facing surface. Mitigation: the agent reports what it could not reach
  rather than inventing something; an epic with nothing runnable produces a short,
  honest pit stop.
- **Gate fatigue.** Too many pit stops and the operator stops reading them — the
  same failure as the log lines. Mitigation: epic default, never mid-task, and the
  payload leads with what changed rather than restating the run.
- **Blocking on a human who has gone to bed.** Mitigation: a pit stop is a gate
  like any other — the run parks and `harness resume` picks it up, and the wall
  clock credit that already exists for task gates applies here too.

## Open questions, answered

**1. Does a pit stop block the whole run, or only the demoed epic?**
The whole run — but nothing is interrupted to make it happen. When a stop comes
due the scheduler stops *dispatching* and lets the in-flight tasks finish, so
the tree the operator is shown is settled rather than half-written by three
workers. Blocking one epic would have shown them a moving target and made
"stop before you build X" unanswerable, because X might already be underway.

**2. May the demo agent write?**
Yes, and it is put back. It may install, build and write scratch files under its
artifact directory, because a demo that cannot `pnpm install` is a demo that
cannot start anything. The integration worktree is then hard-reset to the commit
it was on before the demo started, whatever the agent did to it — "told not to
touch the source" is not a mechanism, and the diff the operator eventually
reviews is not the demo's to edit.

**3. Where do the artifacts live?**
`.harness/<runId>/pitstops/<n>/`, holding `REPORT.md` (what the operator read),
`pitstop.json` (the whole payload) and whatever the demo captured. `.harness/`
is already in the target repo's `.gitignore`, so none of it reaches a commit.

## What was built

| Piece | Where |
| --- | --- |
| Trigger, report rendering | `packages/core/src/pitstop.ts` |
| Demo + reviewers + the report | `RunController.pitStop` |
| Who decides, and the fallback to asking | `RunController.decidePitStop` |
| Re-planning the unstarted work (S3) | `RunController.replan` |
| The prompts | `demoSystemPrompt`, `reviewerSystemPrompt`, `pitStopDeciderSystemPrompt`, `replanPrompt` |
| Terminal gate | `apps/cli/src/cli.ts` |
| Dashboard gate | `POST /api/gates/pitstop`, the `#pitstop` panel |

Two decisions worth naming, because neither is in the stories above:

- **A gate handler that cannot ask turns pit stops off.** Headless and test
  contexts have nowhere to put the question, and spending a demo session plus
  three reviewers to print a report nobody will answer is worse than not
  stopping. `resolvePitStop` is optional on `GateHandler`; its absence is off.
  This still holds with `decidedBy` set to a skill: the decider can answer the
  question, but it cannot answer the one *it* fails to answer, and a pit stop
  that has no way to fall back to a human is one that would resolve itself by
  guessing.
- **The decider is the decision, not a recommendation.** Showing the operator a
  proposed action and asking them to confirm it is the same blocking gate with
  an extra step, and it is worse: a confirmation prompt is answered "yes" by
  everyone who is tired. Either the checkpoint runs unattended or it does not.
  What the operator keeps is everything except being present — the report, the
  reasoning, the record, and `"operator"` if they want the letter back.
- **`"never"` means never, including for a FAIL verdict.** S6 says a recorded
  FAIL opens a pit stop regardless of the configured interval, and it does —
  regardless of the *cadence*. An operator who wrote `"never"` has said they do
  not want to be charged for this, and honouring that is worth more than
  enforcing the story literally. The FAIL still reaches them in the closing
  report, which is where it reached them before.
