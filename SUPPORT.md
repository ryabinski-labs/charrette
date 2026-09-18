# Support

## Where to go

| You want | Go to |
|---|---|
| To understand how to run it | [docs/OPERATIONS.md](./docs/OPERATIONS.md) — install, configure, run, observe, recover |
| To report a bug | [Issues](https://github.com/ryabinski-labs/charrette/issues) |
| To ask a question or suggest something | [Discussions](https://github.com/ryabinski-labs/charrette/discussions) |
| To report a vulnerability | [SECURITY.md](./SECURITY.md) — privately, not an issue |
| To understand a run that went wrong | `charrette postmortem` before filing anything |

## What support actually is here

One maintainer, working on this alongside other things. That means:

- Issues are read. They are not necessarily answered quickly, and some will sit.
- Bugs with a reproduction get attention first, by a wide margin.
- There is no SLA, no paid support tier, and no private support channel.
- "It didn't work" without a run id, the banner output, or a postmortem is very
  hard to act on and will usually just get those questions back.

If that is too thin a guarantee for what you are doing with it: the licence
lets you fork, and that is a legitimate answer rather than a rebuke.

## Filing a bug worth acting on

Run `charrette postmortem` first and attach what it says. It answers most of
the questions a maintainer would otherwise ask: which questions went
unanswered, which verdicts were heeded, what each session cost, and — the one
that catches the most confusion — **which build each session actually ran
under**, because a fix made while a run is executing never reaches that run.

Also include:

- `charrette version` output (`version@sha`, with `+` when the checkout is dirty).
- Your Node and pnpm versions.
- The startup banner, which prints every resolved default and why.

Redact your own paths and repository names if they are sensitive. The run id
and the banner are usually enough.
