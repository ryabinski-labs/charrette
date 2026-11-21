# Running Charrette securely on a remote Linux host

**Status:** implemented in 0.4.0 · **Source of truth:** [the PRD](./prd/remote-host.md) · **Operator guide:** [docs/REMOTE.md](./REMOTE.md)

This is the shareable plan behind the remote-host work: why a run leaves the
laptop, what the secure architecture looks like, what an attacker can still do,
the decisions that shaped it, and how it ships.

## 1. Problem

Charrette runs on the operator's laptop today. A run takes hours, holds a
terminal for intake and gates, and stops when the laptop sleeps or leaves the
network. Moving it to a dedicated Linux host is not a copy-and-run, because of
how agents execute:

- Every agent session runs with `permissionMode: "bypassPermissions"` and used
  to inherit charrette's whole environment. An agent reads untrusted text all
  day — repository files, dependency install scripts, issue bodies, CI logs —
  and one **prompt injection** in any of it could run commands that read every
  key charrette holds.
- The infra and worktree guards catch direct commands only; they are not
  security boundaries.
- A headless host could not reach the operator: run-finished and run-stopped
  notices went to `osascript` or `notify-send` on the machine itself, and gates
  notified nobody.

On a laptop that risk is shared with everything else on it. On a dedicated host
it can be designed down: a machine with nothing else on it, credentials that are
cheap to lose, no inbound ports, and agents that see only the secrets they need.

The outcome this moves: the share of runs the operator can leave unattended
without increasing what a hijacked agent can steal.

## 2. Architecture

```text
  laptop                            Linux host (Debian 13 / Ubuntu 24.04)
  ┌──────────┐   Tailscale + SSH    ┌──────────────────────────────────────┐
  │ browser  │ ───────────────────▶ │ sshd (key only, no root, no password)│
  │ terminal │                      │                                      │
  └──────────┘                      │  tmux session "charrette"            │
        │                           │   └─ charrette run / resume          │
        │  ssh -L 4777:127.0.0.1:4777│        ├─ agent sessions (sandboxed  │
        └──────────────────────────▶│        │   environment, no secrets  │
                                    │        │   they do not need)        │
                                    │        └─ dashboard on 127.0.0.1:4777 │
                                    │                                      │
                                    │  nftables: no inbound; outbound      │
                                    │  HTTPS only except gateway/DNS/      │
                                    │  Tailscale 100.100.100.100           │
                                    └───────────────┬──────────────────────┘
                                                    │ HTTPS
                                    ┌───────────────▼──────────────────────┐
                                    │ model vendors, GitHub, ntfy endpoint │
                                    └──────────────────────────────────────┘
```

Design choices and their reasons:

- **One unprivileged user, no sudo.** The machine is the sandbox. A second
  human user would need access control charrette does not have.
- **Tailscale plus key-only SSH, no inbound port.** The dashboard's `Host` check
  already accepts a tunnelled `127.0.0.1`, so the dashboard's network posture is
  unchanged: it keeps binding loopback and is reached through
  `ssh -L 4777:127.0.0.1:4777`.
- **tmux** keeps the run alive across SSH disconnects and gives the operator a
  second window for `charrette status` or the dashboard tunnel.
- **An allowlisted environment.** Every agent session is built from a base list
  of shell and toolchain variables, plus the Claude login a Claude session needs,
  plus whatever the operator adds in `agentEnv.allow`. The provider client still
  reads charrette's own environment for the API key; the agent's shell does not.
- **A dedicated host** makes the blast radius one machine. It is not a per-run
  container or VM sandbox; that is the named next step.

## 3. Threat model

| Asset | Why an agent can reach it | Control |
|---|---|---|
| Vendor API keys | They were exported into charrette's environment | The allowlist gives a session only the keys it needs |
| The GitHub token | It was exported into charrette's environment | Withheld from agents by default; scoped to named repositories |
| The Claude login | The session cannot authenticate without it | Accepted residual risk, bounded by a workspace spend limit or the plan's usage cap |
| Other machines on the network | The host sits on that network | Outbound nftables drops RFC 1918, link-local and CGNAT except the gateway |
| The dashboard and its token | It is a local HTTP server | Keeps binding `127.0.0.1`; reached through SSH, never a public port |
| The host itself | An agent has a shell on it | One unprivileged user, no sudo, nothing else on the machine |

Trust boundaries:

- **Agent shell vs charrette process.** The charrette holds the GitHub token, the
  provider clients and the dashboard token. A session gets an environment built
  for it, not charrette's own.
- **Host vs network.** No inbound port is opened. Tailscale carries SSH and the
  dashboard tunnel; outbound HTTPS reaches the vendors and the notify endpoint.
- **Host vs the operator's other machines.** Private address ranges are dropped
  outbound, so a hijacked agent cannot scan the laptop, the NAS or the router.

Residual risks, accepted and bounded:

- **R-001:** whichever Claude login is used, an agent on the host can read it from
  the session it is in. A workspace spend limit or the subscription's usage cap
  is the bound; the guide says so next to each login.
- **R-002:** a git credential helper would let an agent push as the operator. On
  this host the scoped token is the only GitHub credential; branch protection
  with a required review blocks direct pushes to the default branch.
- **R-004:** an ntfy topic on the public server is readable by anyone who knows
  its name. The guide recommends a long random topic or a self-hosted server
  with a token, and notices never carry secrets.
- **R-005:** outbound traffic is unrestricted apart from private ranges, so a
  hijacked agent can still send what it can read to the internet. A domain
  allowlist proxy is the next hardening step.

This is not a per-run sandbox. It is a dedicated host with a small attack
surface, and the guide is explicit about what it does not protect.

## 4. Decisions

| ID | Decision | Why |
|---|---|---|
| DL-001 | Any Linux machine, not a macOS host | The script and guide target Debian 13 and Ubuntu 24.04; a Mac keeps working as today |
| DL-002 | Support both Claude logins | An API key with a workspace spend limit, or a `claude setup-token` subscription token; each has its risk stated |
| DL-003 | Ship the allowlist, notifications, provisioning and this page | All four, plus the PRD |
| A-001 | One unprivileged operator per host | The machine is the sandbox; multi-user needs access control charrette does not have |
| A-002 | Tailscale plus key-only SSH, dashboard through a tunnel | No inbound port, and the dashboard's `Host` check already accepts a tunnelled loopback |
| A-003 | Drop outbound private ranges, allow the public internet | Blocks lateral movement day one without breaking installs or vendor APIs |
| A-004 | GitHub tokens are withheld from agents by default | A worker gets `gh` only through an explicit allow entry, and preferably with a read-only token |
| A-005 | ntfy plus a generic JSON body | ntfy runs on any phone and self-hosts; JSON covers relays and custom endpoints |
| A-006 | Notify on gates, `NEEDS_HUMAN`, run done and run stopped | Those need the operator or end the run; merges would flood the channel |
| A-007 | The allowlist changes no prompt, skill or tool set | A withheld variable shows up as that tool failing, which the banner explains |
| A-008 | The env file is plain text at mode 0600 | It matches how charrette already reads keys; a secrets manager is a dependency for one host |

The two consequences worth stating plainly:

- **The allowlist is a behavior change.** A task whose key happened to be
  exported now fails until the key is allowed or `inherit: true` is set; the
  banner names the withheld variable. The changelog calls this out.
- **The Claude login is not protected.** It is readable by the session that
  needs it. That is R-001, not a bug.

## 5. Rollout

- **Strategy:** the work ships as three logical changes — the agent environment
  allowlist with its tests, push notifications, and the guide plus provisioning
  script — and is released together as **0.4.0**.
- **Before release:** a maintainer runs the provisioning script on a clean
  Debian 13 VM and a clean Ubuntu 24.04 VM, completes a small run with each
  Claude login, and records the setup time against the 60-minute target. The
  dry-run, refusal and idempotency-by-construction checks run in CI; the real
  package-install path does not.
- **Rollback trigger:** if a released run fails because the allowlist withheld
  something the Agent SDK itself needs, switch the default to `inherit: true` in
  a patch release the same day and reopen R-006.
- **Migration:** none. `agentEnv` is an optional config block with a default;
  an absent block means the allowlist, and an old frozen config parses with the
  same default.
- **Next hardening:** a per-run container or VM sandbox, and an outbound domain
  allowlist proxy. Both are listed in the guide as work left to the operator.

## 6. Where to read more

- [The PRD](./prd/remote-host.md) — full requirements, acceptance criteria,
  instrumentation, assumptions and decision log.
- [docs/REMOTE.md](./REMOTE.md) — the operator guide: threat model, host
  preparation, Tailscale and SSH, the dashboard tunnel, scoped credentials, the
  `agentEnv` allowlist, notifications, tmux, updates, backups and hardening.
- `scripts/remote/provision.sh` — the idempotent host setup with `--dry-run`.
- `scripts/remote/charrette-session` — loads the 0600 env file and attaches to
  the `charrette` tmux session.
- `tdd/remote-host.tdd.yaml` — the TDD artifact: every requirement mapped to the
  scenarios and tests that prove it.
