# Security Policy

## Reporting a vulnerability

Report privately — do not open a public issue.

- Preferred: [GitHub private vulnerability reporting](https://github.com/ryabinski-labs/charrette/security/advisories/new)
- Or email: cigan1@gmail.com

Please include what you did, what happened, and what you expected. A proof of
concept helps; a working exploit is not required.

### What to expect

This is a small project maintained by one person, so the honest commitment is
narrow and real rather than broad and aspirational:

- **Acknowledgement within 7 days.** If you have not heard back in 7 days,
  assume the mail went astray and send it again.
- **An assessment, or a status update, within 30 days.**
- Credit in the advisory and the changelog unless you ask otherwise.

There is no bug bounty.

## Supported versions

Pre-1.0. Only `main` is supported — fixes land there, and there are no
backports to earlier tags.

## What is in scope

Anything that breaks the boundaries the project claims to hold:

- Secrets reaching agent context, prompts, logs, the event store, or GitHub.
- A push or merge outside `charrette/<runId>/*`. The orchestrator has no code
  path that merges a pull request; one would be a finding.
- Dashboard authentication and authorization: it binds loopback only, and every
  state-changing endpoint requires a bearer token plus `Origin`/`Host`
  validation. A bypass of any of those is a finding.
- Budget caps not holding before an agent turn.
- Escape from the per-task git worktree into the rest of the machine, beyond
  what is documented below.

## What is out of scope — by design, for now

**Agents run with broad local permissions and the project says so.** Until OS
sandboxing lands (PRD §7, v1.0), a worker agent can run arbitrary commands in
the repository it is pointed at, because that is what building software in a
repository requires. This is documented in the README and PRD §12, not a
vulnerability:

- An agent running a destructive command inside the target repository.
- An agent reading files outside the repository it was pointed at.
- A malicious or compromised target repository causing agent code execution.
  **Run repositories you trust.**
- Prompt injection from repository contents steering an agent, where the result
  stays within the permissions above.

Prompt injection that crosses one of the in-scope boundaries — reaching a
secret, pushing outside the run's branch namespace, moving past a human gate,
or defeating a budget cap — **is** in scope. Report it.

## Third-party services

The project calls the Anthropic, Google, OpenAI and GitHub APIs. Report issues
in those services to those vendors. Report our *handling* of their credentials
here.
