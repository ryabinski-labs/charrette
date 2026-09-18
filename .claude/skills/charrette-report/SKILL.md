---
name: charrette-report
description: Produce and publish a charrette run's completion report — what the run delivered, which features are live, which are dark, and the literal steps that switch each dark one on — as a shareable Artifact. Use when a charrette run has finished and the user asks for a completion report, a delivery summary, a "what shipped" writeup, a live-versus-dark feature breakdown, or an artifact of what a run produced and what still needs turning on.
tags: charrette, reporting, artifact, delivery, activation
---

# Charrette completion report

Turns a finished run into one page a person reads: the ledger of what was built,
which half of it is switched on, and — for everything that is not — the commands
that switch it on.

The charrette generates the page. This skill's job is to verify what it claims and
publish it.

## 1. Generate

```bash
charrette report [<runId>] --repo <path>
```

Defaults to the most recent run in that repo. It writes
`.charrette/reports/<runId>.html` and prints the headline plus the live/dark
counts. Read the counts before going further — they tell you how much
verification is worth doing.

The generated page is **derived, not verified**. It says so in its own footnote.
Everything in its Dark section is a candidate read off the merged diff: the
charrette can see that `process.env.STRIPE_SECRET_KEY` appears in code the run
wrote, and cannot see whether the operator set it in production last Tuesday.

## 2. Verify before publishing

Do not publish a derived report as though it were checked. Take the Dark section
row by row and settle what you can from outside the repository:

| Kind | How to settle it |
| --- | --- |
| `secret` | Is it set where the service actually reads it? `gh secret list`, the deploy platform's env, the secret manager. A name present in CI is not the same as present at runtime. |
| `infrastructure` | Does the repo's own pipeline apply it on merge? Read the deploy workflow. If it does, the stack is probably already up — say so rather than telling the operator to run `apply`. |
| `dns` | `dig +short <name>`. A record in a template and a name that resolves are different claims. |
| `migration` | Does the deploy run migrations? If yes, did *this* deploy run them? |
| `flag` | Is it on where the running system reads it, rather than where the default is written? |

If the page carries a **Proof** section, the run had an executable specification
and its scenarios are the strongest evidence on the page — they were written
from the brief before any code existed. Read the acceptance verdict there before
you spend effort re-deriving what is proven: a requirement whose scenario is
green needs no further checking, and one listed as unproven is where your
attention is worth most.

Also attack what the report claims is **live**. A feature is only listed live
because the deploy went green and a production check passed — neither of which
looked at that specific feature. If you can reach the production URL, check the
one or two that matter most.

Three outcomes per row, and the third is a real answer:

- **confirmed dark** — leave it, and sharpen the steps with what you learned
  (the actual workflow file, the actual stack name, the actual command).
- **actually live** — the operator already did it. Say so explicitly.
- **could not check** — it goes in "Not checked". Never round an unknown up to
  a pass; that is the single failure this whole report exists to prevent.

## 3. Fold your findings back in

Edit `.charrette/reports/<runId>.html` directly. It is one self-contained file
with no build step. Keep its structure and voice; you are correcting content,
not redesigning it.

- Rewrite generic steps into repo-specific ones. `gh secret set X` is a
  placeholder; `gh secret set X --repo owner/name --env production` is a step.
- Move anything you proved live out of Dark, and say who turned it on if you can
  tell.
- Add every unsettled row to the "Not checked" section.
- Update the method paragraph in the footnote to say that a check was run,
  what it reached, and what it could not.

## 4. Publish

**Load the `artifact-design` skill first** — required before writing or
publishing any artifact.

Publish the edited file with the Artifact tool:

- `file_path`: the report HTML
- `favicon`: `💡` (the report is about what is switched on) — keep it stable
  across republishes of the same run
- `description`: one sentence naming the project and the live/dark split
- Do **not** pass `title` — the page carries its own `<title>`

Hand the user the URL.

## Updating a report later

Same file path re-publishes to the same URL. When the operator throws some of
the switches and wants the page refreshed, re-run `charrette report` (which
regenerates from current state), re-verify, and publish the same path again. If
the report was published in an earlier session, pass its `url` so it updates in
place instead of claiming a new link — find it with `action: "list"` or ask.

## What not to do

- Do not publish without reading the whole generated file first.
- Do not describe a run as "complete" when the page says `Nothing Shipped Yet`.
  The masthead is the honest reading; the summary you write for the user should
  agree with it.
- Do not invent activation steps for a switch you did not investigate. A vague
  step is worse than a listed unknown, because it looks like it was checked.
