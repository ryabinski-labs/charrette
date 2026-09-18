# Checkpoints

Saved worker digests also support cold recovery: a fresh worker session can
receive the latest nonempty checkpoint for its run and task. It is bounded to
4,000 characters and labeled as prior observations to verify against the current
worktree. Checkpoint questions and recommendations do not become operator
instructions. See [the recovery implementation](../packages/core/src/taskContext.ts).

The operator's own habit, mechanised.

Working a long task by hand, the flow that works is: `/compact`, then
`/feedback-provider`, after every turn. Distil the conversation down to what is
actually established, then put the open questions up as options with a
recommendation and pick one. What makes it effective is not the summarising. It
is that both halves happen *while the work is still cheap to redirect* — on a
cadence, rather than at the end, when the only thing left to do is judge what
was built.

An autonomous run had neither half.

## What was missing

A worker gets one prompt and then runs to a hundred and twenty turns with nobody
reading it. The first checkpoint it meets is a pit stop, and pit stops fire on
epic boundaries, spend and wall clock — run-level triggers that can be tens of
thousands of tokens away from the turn where the agent quietly assumed the wrong
thing. Every expensive failure in this repo's history has the same shape: a
correct decision, made too late.

The two halves were missing in different ways.

**Compaction existed, but not this kind.** `compact.ts` keeps a session inside
its context window by eliding old tool output — digest the head and tail of a
result, then drop it outright if that was not enough. That is the right
behaviour on the pressure path, and the module says why at length: a
summarisation call on the one routine whose entire job is not to die would add
both a bill and a new way to fail. But elision keeps the *shape* of the work. It
leaves a six-hundred-character stub of a file the agent read where a sentence
saying what the file turned out to contain would have been worth more.

**Asking existed, but not from the agent.** `task.feedback` carries the
operator's words into a live session, and pit stops ask the operator to decide.
Neither is the agent raising its hand. Nothing in the run let a worker say "I am
about to build on this assumption, and I would like someone to look at it."

## What a checkpoint is

One message, pushed into a live session on a turn cadence, asking for exactly
two things:

1. **A digest.** What is established, what was decided, what is left — written
   for someone who will continue the task with only that block and the original
   assignment.
2. **Questions with options and a recommendation.** Anything the agent would
   genuinely want a human to decide, each with two to four distinct options and
   the one it recommends marked.

Then it carries on. The prompt is explicit that nobody may be watching and that
a stalled session is worse than a wrong turn that gets corrected.

## Design decisions

### It fires on turns

The thing a checkpoint protects against is an agent losing the plot, and turns
are what that is measured in. A cadence in dollars fires at different points in
the work depending on which model answered.

### It is non-blocking

The agent acts on its own recommendation. A run that stops dead every twenty
turns waiting for a human is not a run — f338b5c8's budget gate sat unanswered
for six hours and forty minutes with a worker slot idle. What the operator gets
is the question on the dashboard, in time to answer through the feedback channel
that already exists, and the agent's recommendation on the record when they do
not. `recommended` is published whether or not anyone answers, because a run
that drifted is diagnosed from the assumption it drifted on.

### There is no role list

Every role is in scope; arithmetic decides which qualify. A checkpoint costs a
turn, and on a short session that turn is a meaningful fraction of the budget —
but a hand-maintained list of "long enough" roles would be wrong the first time
anyone changed a `maxTurns`. Instead the cadence is compared against the
session's own wrap-up point, and a session that would never reach its first
checkpoint simply never has one.

At the default cadence of twenty:

| role | turn cap | wrap-up | checkpoints |
| --- | --- | --- | --- |
| worker | 120 | 96 | 20, 40, 60, 80 |
| QA | 90 | 72 | 20, 40, 60 |
| demo | 80 | 64 | 20, 40, 60 |
| planner | 40 | 32 | 20 |
| repair | 2 | 1 | none |

Nothing has to be kept in sync for the bottom row to stay empty.

### It keeps clear of the wrap-up turn

`pool.ts` already asks a session nearing its ceiling to stop and report. That
turn is the most valuable one in an expensive session, and a checkpoint racing
it would spend it describing the work instead of reporting it. `checkpointDue`
returns false at and after the wrap-up point — which is also what excludes every
short-session role for free.

### The cadence is set once per run

Seventeen call sites reach `pool.run`. A knob threaded through all of them is a
knob that is wrong at whichever one was added last. What a checkpoint costs and
what it is worth are properties of the run, not of the call site, so
`RunController` hands the pool its frozen config once and every session
dispatched afterwards inherits it. `spec.checkpointEvery` still overrides per
session.

A run created before checkpoints existed has a frozen config without the field,
and a run's config is fixed at creation — so `undefined` is a real argument, and
the pool keeps its own default rather than crashing on an older run.

## Both transports, one of them further

The push sits above the transport split in `pool.ts`, so the same message
reaches an SDK session and a charrette-run tool loop alike. What happens to the
answer differs:

- **Anthropic** (`query()`): the SDK owns its transcript. A checkpoint buys the
  record and the questions. The digest stays in the conversation as ordinary
  narration, where it is still worth having — but the charrette cannot act on it.
- **OpenAI and Google** (`toolLoop.ts`): the charrette holds the transcript, so
  the digest can *become* it. `compact.fold` replaces the earlier assistant
  narration and tool output with the agent's own account of it.

Folding is the half that pays for itself. The summary was written on a turn that
was going to happen anyway; there is nothing left to pay for and nothing left to
throw. It is the difference between a session carrying stubs of everything it
ever read and one carrying what those files turned out to say.

### What folding will not touch

`user` messages survive, digest or no digest. They are the assignment and the
operator's mid-flight corrections — the two things in the transcript that cannot
be reconstructed from an agent's summary of its own behaviour, and precisely the
things an agent paraphrases into the opposite of what they said. This is the
rule `compact.ts` was built on and folding does not get an exception to it.

Two smaller guarantees: the fold never leaves a tool result whose assistant turn
was folded away (OpenAI rejects the orphan outright, which is a dead session
rather than a degraded one), and it refuses to run when the digest is longer than
what it would replace.

## Configuration

```json
{ "checkpoint": { "every": 20, "fold": true } }
```

- `every` — turns between checkpoints. `0` turns them off. At twenty, a worker
  pays four checkpoints, under 4% of its turn budget. Lower it to steer harder
  on a run you are watching.
- `fold` — replace the older transcript with the digest. Only the charrette-run
  tool loop can honour this; on Anthropic it is not reachable.

## What the operator sees

An `agent.checkpoint` event per answered checkpoint, carrying the turn, the
digest and the questions with their options and recommendation. In the dashboard
feed the questions lead and the digest follows, because the digest is context
and the questions are the thing that can still be acted on. It renders as an
asking row when there are questions and a status row when there are none.

The dashboard is not the only place a run is watched, so each question also goes
out as its own `agent.log` line. The CLI renders `agent.log` and prints its first
line only — without this an operator at a terminal would watch
`<charrette-checkpoint>` scroll past and never learn what was asked, which is the
one thing a checkpoint is for. One event for the dashboard, one line per question
for the terminal.

Nothing blocks. By the time the row appears the agent has already carried on
with what it recommended; answering through the feedback box corrects it while
the session is still live.

### A checkpoint never becomes the answer

A checkpoint queued on the very turn an agent happens to finish buys it one more
exchange, so the session settles twice and the digest is the last thing said.
What a session returns is parsed downstream for evidence, PR numbers and
verdicts, and a digest has none of them — so a completed session would look like
it had done the work and reported nothing, which is the re-dispatch that
`wrapUpAt` exists to prevent. A result that is *nothing but* a checkpoint block
therefore does not displace an answer already given. An agent that writes its
digest and then answers properly in the same message has answered, and that
answer stands.

## Where the code is

| file | what it holds |
| --- | --- |
| `packages/core/src/checkpoint.ts` | when one is due, the prompt, and parsing the answer — all pure |
| `packages/core/src/compact.ts` | `fold`, next to the elision it is the alternative to |
| `packages/core/src/pool.ts` | the cadence, the push, and publishing the answer |
| `packages/core/src/toolLoop.ts` | folding, on the transport that can |
| `packages/shared/src/config.ts` | `CheckpointConfig` |
| `packages/shared/src/events.ts` | `agent.checkpoint` |

The parser is deliberately forgiving and never throws. A checkpoint is an extra
that the real work does not depend on: an agent that writes a good digest and
fumbles a pipe character should still have its digest recorded, and one that
ignores the instruction entirely should cost nothing more than the turn.
