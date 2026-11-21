# Running Charrette on a remote Linux host

A run can take hours, hold a terminal for intake and gates, and stop when a
laptop sleeps. This guide moves it to a Linux machine you reach over the
network, so you can close the laptop and come back to pull requests.

It is written for one operator per host. Nothing here authenticates a second
person, and nothing here turns charrette into a hosted service. The target is a
fresh Debian 13 or Ubuntu 24.04 machine; macOS hosts keep working as they do
today and are not covered by the provisioning script.

## 1. Threat model

An agent session runs with `permissionMode: "bypassPermissions"`. It reads
untrusted text all day — repository files, dependency install scripts, issue
bodies, CI logs — and one prompt injection in any of it can run commands. The
infra and worktree guards catch direct commands; they are not security
boundaries. The question is therefore not "can an agent be tricked?" but "what
can a tricked agent reach?"

| Asset | Why an agent can reach it | Control here |
|---|---|---|
| Vendor API keys | They were exported into charrette's environment | The agent environment allowlist gives a session only the keys it needs |
| The GitHub token | It was exported into charrette's environment | Withheld from agents by default; the token is scoped to named repositories |
| The Claude login | The session cannot authenticate without it | Accepted residual risk, bounded by a workspace spend limit or the plan's usage cap (R-001) |
| Other machines on your home or office network | The host sits on that network | Outbound nftables rules drop RFC 1918, link-local and CGNAT ranges except the gateway |
| The dashboard and its token | It is a local HTTP server | It keeps binding `127.0.0.1`; you reach it through SSH, never a public port |
| The host itself | An agent has a shell on it | One unprivileged user, no sudo, nothing else on the machine worth taking |

Trust boundaries:

- **Agent shell vs charrette process.** The charrette holds the GitHub token,
  the provider clients and the dashboard token. A session gets an environment
  built for it, not charrette's own; the provider client still reads the real
  environment so the charrette can call the model, but the agent's Bash tool
  cannot.
- **Host vs network.** No inbound port is opened. Tailscale carries SSH and the
  dashboard tunnel; outbound HTTPS reaches the vendors and your notify endpoint.
- **Host vs your other machines.** Private address ranges are dropped outbound,
  so a hijacked agent cannot scan the laptop, the NAS or the router.

Residual risks you are accepting:

- **R-001:** whichever Claude login you use, an agent on this host can read it
  from the session it is in. The allowlist cannot protect the credential the
  session needs. A workspace spend limit or the subscription's own usage cap is
  the bound.
- **R-002:** a git credential helper would let an agent push as you. On this
  host the scoped token is the only GitHub credential; branch protection with a
  required review blocks direct pushes to the default branch.
- **R-004:** an ntfy topic on the public server is readable by anyone who knows
  its name. Use a long random topic or a self-hosted server with a token, and
  remember that notices never carry secrets.
- **R-005:** outbound traffic is unrestricted apart from private ranges, so a
  hijacked agent can still send what it can read to the internet. The allowlist
  keeps the list of what it can read short; a domain allowlist proxy is the next
  hardening step, listed in §12.

This is not a per-run container or VM sandbox. It is a dedicated host with a
small attack surface. The sandbox is the next step, not this one.

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

The pieces and why they are shaped this way:

- **One unprivileged user (`charrette`), no sudo.** The machine is the sandbox.
  A second human user would need access control charrette does not have.
- **Tailscale plus key-only SSH, no inbound port.** The dashboard's `Host` check
  already accepts a tunnelled `127.0.0.1`, so nothing on the dashboard changes.
- **tmux** keeps the run alive across SSH disconnects and gives you a second
  window for `charrette status` or the dashboard tunnel.
- **A dedicated host** makes the blast radius one machine. Do not run this on
  the box that holds your personal keys, browser profile or other services.

The full product requirements and decision log live in
[`docs/prd/remote-host.md`](./prd/remote-host.md).

## 3. Host preparation

Use a fresh Debian 13 or Ubuntu 24.04 machine with outbound HTTPS. From your
laptop, copy the repository (or clone it) and run the provisioning script as
root or with sudo:

```bash
sudo scripts/remote/provision.sh --user charrette --ssh-key ~/.ssh/id_ed25519.pub
```

The script:

- creates the `charrette` user without sudo rights and installs the public key;
- disables SSH password login and root login;
- installs Node 22 LTS, pnpm, git, gh, tmux and Tailscale from their vendor
  repositories;
- enables unattended security upgrades;
- installs an `nftables` ruleset that drops outbound traffic to RFC 1918,
  link-local and CGNAT ranges except the gateway, DNS and Tailscale's
  `100.100.100.100`;
- writes `/home/charrette/.config/charrette/env` with mode `0600` and commented
  placeholders, and `/home/charrette/bin/charrette-session`.

Run it with `--dry-run` first to see every change. It exits before changing
anything on an unsupported OS, a missing `--ssh-key`, or a file that is not a
public key. Running it a second time changes nothing and exits 0. It never
reads, prints or writes a secret value, so it is safe to run in a shared
terminal.

The setup target is 60 minutes from SSH access to a first run. A maintainer
measures that once on a clean VM of each distribution before a release.

## 4. Access over Tailscale and SSH

Install Tailscale on the host (the script does) and on your laptop, then join
both to the same tailnet. Reach the host by its Tailscale name:

```bash
ssh charrette@charrette-host
```

Use key-only authentication. The script disables password and root login; do
not re-enable either to "make it easier". If you cannot use Tailscale, the
fallback is plain SSH on a non-default port with key-only login — worse,
because the port is exposed to the internet, but still no password.

Verify from the host that nothing is listening on a public interface:

```bash
ss -lntp
```

You should see `127.0.0.1` and Tailscale addresses only. There is no inbound
port for charrette to open.

## 5. The dashboard tunnel

The dashboard binds `127.0.0.1` and checks `Host` and `Origin`. That posture is
unchanged. From your laptop:

```bash
ssh -L 4777:127.0.0.1:4777 charrette@charrette-host
```

Then open `http://127.0.0.1:4777` in your browser. The fragment in the URL is
the dashboard's auth token; treat it like a password and do not paste it into a
shared terminal or an issue. Closing the SSH session closes the tunnel. No
public dashboard URL exists to leak, and notices never contain one.

## 6. Credentials

Everything the host needs goes in `/home/charrette/.config/charrette/env`, mode
`0600`, owned by `charrette`. `charrette-session` loads it. It is plain text
protected by file mode and full-disk encryption, not a secrets manager — see
A-008 in the PRD. Keep it out of git.

### GitHub: a fine-grained token for named repositories

Create a **fine-grained personal access token** limited to the repositories
this host will work on. Give it exactly:

- `Contents: read and write`
- `Pull requests: read and write`
- `Checks: read`
- `Metadata: read`
- **no Workflows permission**

Put it in the env file as `GITHUB_TOKEN`, or let `gh auth login` store the same
token. On this host it must be the only GitHub credential: a git credential
helper that still holds your personal token defeats the scoping. Turn on branch
protection for the default branch with a required review, so a token that can
push still cannot push to `main` directly.

Agents do **not** get `GITHUB_TOKEN` by default. A worker that needs `gh` for a
read-only lookup can be given a second, read-only token through `agentEnv.allow`
(see §7) rather than the write token.

### Model vendors: one key per vendor, each with a spend limit

Create a separate key per vendor the run uses — Anthropic, Google, DeepSeek,
OpenAI — and set a spend limit on each account or workspace. Put the keys in the
env file. Only the provider client reads them; the agent shell does not. A
DeepSeek worker cannot read the Anthropic bill, and a Claude planner cannot read
the DeepSeek one.

### Claude: both logins work, and both have a residual risk

**Option A — Anthropic API key in a workspace with a spend limit.** Create a
workspace for this host, set a monthly spend limit, and put its key in the env
file as `ANTHROPIC_API_KEY`. The limit is the bound on a hijacked session,
because an agent on the host can read this key from its own session — the
allowlist cannot protect the login the session needs.

**Option B — a Claude subscription token from `claude setup-token`.** On a
machine where you are logged in, run:

```bash
claude setup-token
```

and put the result in the env file as `CLAUDE_CODE_OAUTH_TOKEN`. The
subscription's own usage cap bounds the damage, and an agent on the host can
read this token from its own session for the same reason as Option A. Use a
separate account if you want the remote runs to stop before your daily work
does.

Both options are supported; you choose per run with the account block in
`charrette.config.json` or `--account`. Whichever you choose, write down that an
agent can read it. That is R-001, accepted and bounded, not solved.

## 7. The agent environment allowlist

Every agent session is built from an allowlist, not inherited from charrette's
environment. The base list covers a working shell and the toolchains charrette
drives: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `TZ`,
`TMPDIR`, `LC_*`, `XDG_*`, proxy and CA-bundle variables, Node/Go/Rust/JDK and
Android/Docker variables, `CI`, and charrette's own `BASH_*` and `CHARRETTE_*`
settings except `CHARRETTE_NOTIFY_*`. A Claude session also gets the Claude
login variables it cannot work without.

A task that needs one more variable gets it from the repository's
`charrette.config.json`:

```json
{
  "agentEnv": {
    "allow": ["STRIPE_TEST_KEY"],
    "inherit": false
  }
}
```

- An exact name adds that variable; a trailing `*` adds a prefix family, e.g.
  `"STRIPE_*"`.
- An entry that is not set still starts the session and is printed as
  `+STRIPE_TEST_KEY (not set)` — a one-line diagnosis instead of a task that
  fails later.
- An entry that is not a valid name or prefix (`^[A-Za-z_][A-Za-z0-9_]*$`, or a
  prefix ending in `*`) stops `charrette run` before the run exists.
- `"inherit": true` hands sessions charrette's whole environment, which is what
  every run did before this feature. It is the escape hatch, not the default,
  and the banner says `agent env   inherit (every variable reaches agents)` so
  nobody can leave it on by accident.

The `run` and `resume` banners print what happened:

```text
agent env   12 passed · +STRIPE_TEST_KEY · withheld GEMINI_API_KEY DEEPSEEK_API_KEY GITHUB_TOKEN
```

`withheld` names the secret-like variables no agent receives; their values are
never printed. If a task fails because a key it needed was withheld, the banner
already named it, and the fix is one `allow` entry or `inherit: true`. The
`run.agent_env` event records the same names for an audit.

## 8. Notifications

On a headless host the operator learns a run is waiting only by looking. Point
charrette at an HTTPS endpoint and it sends a notice when a gate opens (plan,
budget, task, subscription or pit stop), a task enters `NEEDS_HUMAN`, the run
finishes, or the run stops on an error.

```bash
CHARRETTE_NOTIFY_URL=https://ntfy.sh/a-long-random-topic
CHARRETTE_NOTIFY_FORMAT=ntfy
CHARRETTE_NOTIFY_TOKEN=tk_optional_topic_token
```

- **ntfy** is the default when the host is `ntfy.sh` or the path is one segment.
  The body is the plain-text message; `Title`, `Priority` and `Tags` are
  headers, with `high` for gates and `NEEDS_HUMAN`.
- **json** sends `{"event","runId","repo","title","message","ts"}` with
  `Content-Type: application/json`, for a relay or a custom endpoint. Set
  `CHARRETTE_NOTIFY_FORMAT=json` explicitly for a path that does not look like
  ntfy.
- `CHARRETTE_NOTIFY_TOKEN`, when set, is sent as `Authorization: Bearer …`.
- `http://` is refused except for `localhost` and `127.0.0.1`, and a bad URL
  stops `charrette run` with a message naming the variable.
- A 5xx or a timeout past five seconds is retried twice, at two and ten seconds.
  If the last attempt fails, one `agent.log` line records it and the run carries
  on.
- At most 20 notices are sent per run per ten minutes; the twenty-first is one
  summary and the rest of the window is silent.
- A notice carries the repository directory name, the run id, the event and a
  one-line reason. It never carries the dashboard URL, its token, a prompt, a
  diff or a variable value. That is what makes a long random ntfy topic safe
  enough.

Diagnose an endpoint without starting a run:

```bash
charrette notify-test
```

It prints the HTTP status, e.g. `HTTP 200`, and exits non-zero when the notice
did not land.

## 9. Running in tmux

`charrette-session` loads the env file and attaches to (or creates) a tmux
session named `charrette`:

```bash
~/bin/charrette-session
```

Then, inside tmux:

```bash
cd /srv/your-repo    # or wherever the repository lives
charrette run --no-chat "the assignment"
```

Detach with `Ctrl-b d` and close the laptop. Reattach with
`~/bin/charrette-session`. The run keeps going, because tmux is not the SSH
connection.

There is deliberately no systemd unit that resumes a run after a reboot. After
a reboot, start the tmux session and run `charrette resume`; the run's state is
in the repository's `.charrette/` directory, not in the process.

## 10. Updates from npm

Install charrette from the registry, not from a tarball someone sent you, and
check provenance before running an updated build:

```bash
npm audit signatures
npm install -g charrette@latest
```

Do this inside a maintenance window: a run in flight is using the old binary
until it exits, and a resume after the install uses the new one. Read
[`CHANGELOG.md`](../CHANGELOG.md) for behaviour changes; the agent environment
allowlist is one, and it is called out there.

## 11. Backups

Two things are worth backing up:

1. **The repository and its `.charrette/` directory.** That directory is the
   run ledger, the task state and the reports. A run resumed on a host without
   it is a different run. Back it up with the repository, not instead of it.
2. **The env file.** Losing it costs a key rotation, not a run, but losing it
   while the host is the only copy is a bad afternoon. Store it in your password
   manager, not in the repository.

A snapshot of the whole host is a reasonable monthly backup; the repository and
env file are the parts you actually need. Test a restore on a spare machine
before you need one.

## 12. Hardening left to the operator

These are deliberately not in the script or the release:

- **A per-run container or VM sandbox.** The named next step. It turns the
  allowlist from "the secrets are not in this process" into "this process cannot
  see the other repositories, the network or the host's kernel". Until then,
  run repositories you trust.
- **An outbound domain allowlist proxy.** Today the nftables rules block private
  ranges, not the public internet. A proxy that permits only the vendor APIs,
  GitHub and your notify endpoint closes R-005. It is a real project; do it
  before you run a repository you do not trust.
- **The `gh` CLI inside agent sessions.** Agents are not given
  `GITHUB_TOKEN`. If a workflow needs `gh` for CI logs, create a second
  read-only token and add it to `agentEnv.allow`; do not hand out the write
  token.
- **Full-disk encryption and host patching.** The script enables unattended
  upgrades; it cannot turn on disk encryption for you. Do that at install time.
- **A second operator.** Not supported. One host, one operator. A second person
  would need access control that charrette does not have.
- **Backups and key rotation.** The script does not rotate anything. Put a
  rotation date on the GitHub token and the vendor keys, and keep the env file
  in your password manager as the source of truth.
