---
spec: spec-clarifier/v1
feature: remote-host
title: Running Charrette securely on a remote Linux host
status: complete
prompt: inline
prompt_sha256: 8be672f6ea24b1e5532cd566f63c3d8e6f2d857dddc9ec393cc1c2908552c9b2
created: 2026-11-21
---

# PRD: Running Charrette securely on a remote Linux host

## 0. Source prompt

> I want to plan running charrette on a remote machine, like for example my mac-mini or another Linux machine come up with secure architecture, use /architect /sentinel to help. Host: any Linux machine. Claude login: support both options (API key with spend limit, subscription token). Build: env allowlist PR, provisioning script + REMOTE.md, push notifications, publish this plan as a page, and produce a full PRD markdown. Please put together a PRD for this work

## 1. Problem

Charrette runs on the operator's own laptop today. A run takes hours, holds the terminal for intake and gates, and stops when the laptop sleeps or leaves the network. The operator wants to run it on another machine, a Linux box they reach over the network, and walk away.

Moving it is not a copy-and-run, because of how agents execute. Every agent session runs with `permissionMode: "bypassPermissions"` (`packages/core/src/pool.ts:851`) and inherits charrette's whole environment: `env: { ...process.env, ... }` for Claude sessions (`pool.ts:881`) and `{ ...process.env, ...spec.env }` for the tool loop that drives Gemini, DeepSeek and OpenAI sessions (`packages/core/src/toolLoop.ts:121`). An agent reads untrusted text all day: repository files, dependency install scripts, issue bodies, CI logs. One prompt injection in any of it can run commands that read every key charrette holds and send them out. The infra guard and the worktree guard catch direct commands only, as their own comments state (`infraGuard.ts`, `worktreeGuard.ts`); they are not security boundaries.

On a laptop that risk is shared with everything else on it. On a remote host it can be designed down: a machine with nothing else on it, credentials that are cheap to lose, no inbound ports, and agents that see only the secrets they need. Two gaps in charrette block that today:

- **Agents see every secret.** A DeepSeek worker's shell can read `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GITHUB_TOKEN` and anything else exported to charrette, though only charrette's own process uses them.
- **A headless host cannot reach the operator.** Run-finished and run-stopped notices go to `osascript` or `notify-send` on the machine itself (`apps/cli/src/notify.ts`), and gates that need an answer notify nobody. On a remote host the operator learns a run is waiting only by looking.

## 2. Target user

- **Primary:** the operator who runs `charrette run` and pays the API bills, a solo builder or a small team, who wants runs to continue while their laptop is closed.
- **Secondary:** a maintainer or security reviewer deciding whether charrette is safe to run unattended next to real credentials, and the operator's GitHub organisation, whose repositories a run can push to.
- **Explicitly not for:** a multi-user or multi-tenant charrette service. One operator per host; nothing here authenticates a second person. Also not for macOS hosts: the guide and script target Linux (`DL-001`), and a Mac keeps working as today without the remote guide.
- **Job-to-be-done:** When I start a long run, I want it on a machine that keeps going without me and cannot leak more than I chose to give it, so I can close my laptop and come back to pull requests.

## 3. Outcome and success metric

- **Outcome this moves:** the share of runs the operator can leave unattended without increasing what a hijacked agent can steal.
- **Primary KPI:** secrets visible to an agent session. Measured by a test that starts a session with a known environment and lists which variables reached the agent's shell. Baseline: every variable in charrette's environment, including all four vendor keys and the GitHub token. Target: only the base allowlist in §13 plus the variables the operator names in `agentEnv.allow`, at release.
- **Secondary KPI:** time from a gate opening to the operator knowing about it. Baseline: unbounded on a headless host (no notice is sent). Target: a push notice within 60 seconds of `run.gate_opened`, `task.gate_opened`, `run.pitstop_opened`, a task entering `NEEDS_HUMAN`, run done and run stopped, when a notify URL is configured.
- **Setup KPI:** a fresh Debian 13 or Ubuntu 24.04 host goes from SSH access to a first `charrette run` by following `docs/REMOTE.md` and the provisioning script, in 60 minutes or less, measured once by a maintainer on a clean VM before release.
- **Guardrail metrics:** the full test suite stays at 100% coverage; no existing run fails because a variable it needed was withheld without the banner naming it; the dashboard still binds `127.0.0.1` only.

## 4. Goals and non-goals

**Goals**
1. Agent sessions receive an allowlisted environment instead of charrette's whole environment, with a per-repo way to add variables a task needs.
2. Charrette can push a notice to the operator's phone or any HTTPS endpoint when a run needs them or ends.
3. `docs/REMOTE.md` documents a secure remote-host architecture, and `scripts/remote/provision.sh` sets up a Linux host to that architecture.
4. Both Claude logins work on the remote host: an Anthropic API key with a workspace spend limit, and a Claude subscription token from `claude setup-token`, each with its risk stated.
5. This PRD is published as a private page for the operator to share.

**Non-goals**
1. No change to the dashboard's network posture. It keeps binding `127.0.0.1` and checking `Host` and `Origin`; remote access is an SSH tunnel.
2. No per-run container or VM sandbox in this work. It is the named next step in §10 and `docs/REMOTE.md`.
3. No outbound domain allowlist proxy built into charrette. The guide describes one as an optional hardening step.
4. No macOS provisioning script or `launchd` unit (`DL-001`).
5. No multi-user access control, no hosted charrette service, and no remote control API beyond the existing dashboard.
6. No change to how charrette itself authenticates to GitHub or the model vendors.

## 5. User stories and acceptance criteria

- **[P0]** As an operator, I want each agent session to see only the variables it needs, so a hijacked agent cannot read keys it never uses.
  - [ ] Given charrette's environment holds `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY` and `PATH`, when a DeepSeek worker session runs `env` through its Bash tool, then the output contains `PATH` and none of those six secrets.
  - [ ] Given the same environment, when a Claude worker session starts, then the SDK receives the base allowlist plus only the Claude login variables (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL` when set), and none of `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN` or `AWS_SECRET_ACCESS_KEY`.
  - [ ] Given `charrette.config.json` contains `"agentEnv": { "allow": ["STRIPE_TEST_KEY"] }` and the variable is set, when any agent session starts, then the variable reaches the agent and `run` prints `agent env   +STRIPE_TEST_KEY` in its banner.
  - [ ] Given a variable is withheld whose name matches `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL` (case-insensitive), when `charrette run` or `charrette resume` starts, then the banner lists those names under `withheld` without their values, so a task that needs one is a one-line config change.
  - [ ] Given a task's per-session variables (`spec.env`: compose project and port block) and the subscription overlay (`CLAUDE_CONFIG_DIR` or `CLAUDE_CODE_OAUTH_TOKEN` for the active account), when a session starts, then both are applied on top of the allowlisted environment exactly as today.
  - [ ] Given `"agentEnv": { "inherit": true }` in the config file, when a session starts, then it receives charrette's whole environment as before this change, and the banner prints `agent env   inherit (every variable reaches agents)`.
  - [ ] Error: given `agentEnv.allow` contains an entry that is not a valid variable name (`^[A-Za-z_][A-Za-z0-9_]*$`, or a prefix ending in `*`), when the config is loaded, then `charrette run` exits non-zero naming the entry and the rule.
  - [ ] Error: given `agentEnv.allow` names a variable that is not set, then the session starts and the banner shows it as `+NAME (not set)`.

- **[P0]** As an operator on a headless host, I want a notice on my phone when a run needs me or ends.
  - [ ] Given `CHARRETTE_NOTIFY_URL` is an `https://` URL, when a gate opens (plan, budget, task, subscription or pit stop), a task enters `NEEDS_HUMAN`, the run finishes, or the run stops on an error, then charrette sends one `POST` to that URL within 60 seconds of the event.
  - [ ] Given `CHARRETTE_NOTIFY_FORMAT=ntfy` (the default when the URL host is `ntfy.sh` or the path has one segment), when a notice is sent, then the body is the plain-text message and the headers carry `Title`, `Priority` (`high` for gates and `NEEDS_HUMAN`, `default` otherwise) and `Tags`.
  - [ ] Given `CHARRETTE_NOTIFY_FORMAT=json`, when a notice is sent, then the body is `{"event","runId","repo","title","message","ts"}` with `Content-Type: application/json`.
  - [ ] Given `CHARRETTE_NOTIFY_TOKEN` is set, when a notice is sent, then it carries `Authorization: Bearer <token>`.
  - [ ] Given a notice is sent, then it contains the repository directory name, the run id, the event and a one-line reason, and never the dashboard URL, its token, a prompt, a diff or any variable value.
  - [ ] Given `charrette notify-test` is run with the variables set, then one test notice is sent and the command prints the HTTP status.
  - [ ] Error: given the endpoint returns 5xx or does not answer within 5 seconds, then the notice is retried twice, at 2 and 10 seconds; after the last failure one `agent.log` line records it and the run continues.
  - [ ] Error: given `CHARRETTE_NOTIFY_URL` is `http://` to a host other than `localhost` or `127.0.0.1`, or not a URL, then `charrette run` exits non-zero with a message naming the variable.
  - [ ] Given the same gate is reopened by a resume, then it is notified once per opening, and a run that emits more than 20 notices in 10 minutes sends one summary notice for the rest of that window.

- **[P0]** As an operator, I want one document that tells me how to run charrette on a Linux host securely.
  - [ ] Given `docs/REMOTE.md` at the merge commit, then it covers, in order: the threat model, the architecture diagram, host preparation, access over Tailscale and SSH, the dashboard tunnel (`ssh -L 4777:127.0.0.1:4777`), credentials (scoped GitHub token, per-vendor keys with spend limits, both Claude logins), the agent environment allowlist, notifications, running in tmux, updates from npm with `npm audit signatures`, backups, and the hardening steps left to the operator.
  - [ ] Given a reader follows the Claude login section, then it gives the steps for an Anthropic API key in a workspace with a spend limit, and for `claude setup-token`, and states for each that an agent on the host can read it.
  - [ ] Given a reader follows the GitHub section, then it specifies a fine-grained token limited to the target repositories with `Contents: read and write`, `Pull requests: read and write`, `Checks: read`, `Metadata: read` and no `Workflows` permission, and branch protection with required review on the default branch.
  - [ ] Given the README and `docs/OPERATIONS.md`, then each links to `docs/REMOTE.md`, and OPERATIONS documents `agentEnv` and the notify variables in its configuration and environment tables.

- **[P1]** As an operator, I want a script that applies the guide to a fresh host.
  - [ ] Given a fresh Debian 13 or Ubuntu 24.04 host and a root or sudo shell, when `sudo scripts/remote/provision.sh --user charrette --ssh-key <path-to-public-key>` runs, then it creates the user without sudo rights, installs Node 22 LTS, pnpm, git, gh, tmux and Tailscale from their vendor repositories, installs that SSH key, disables SSH password and root login, enables unattended security upgrades, and installs an `nftables` ruleset that drops outbound traffic to RFC 1918, link-local and CGNAT ranges except the gateway, DNS and Tailscale's `100.100.100.100`.
  - [ ] Given the script finishes, then it writes `/home/<user>/.config/charrette/env` with mode `0600` and commented placeholders for every key, and `/home/<user>/bin/charrette-session` which loads that file and attaches to or creates a tmux session named `charrette`.
  - [ ] Given the script is run a second time, then it changes nothing that is already in place and exits 0.
  - [ ] Given `--dry-run`, then it prints each change it would make and changes nothing.
  - [ ] Error: given an unsupported OS, a missing `--ssh-key`, or a key file that is not a public key, then it exits non-zero before changing anything, naming the problem.
  - [ ] Given the script never reads, prints or writes a secret value, then a reviewer can run it in a shared terminal.

- **[P1]** As an operator, I want this PRD and the architecture as a private page I can share.
  - [ ] Given the PRD is merged, then a private page carries the problem, the architecture diagram, the threat model, the decisions and the rollout, and its link is in the PR description.

## 6. Experience notes

The surfaces are the CLI banner, `charrette.config.json`, environment variables, a new `charrette notify-test` command, `docs/REMOTE.md` and the provisioning script. The dashboard is unchanged.

- **Banner:** two new lines at `run` and `resume`. `agent env   12 passed · +STRIPE_TEST_KEY · withheld GEMINI_API_KEY DEEPSEEK_API_KEY GITHUB_TOKEN`, and `notify      ntfy.sh/…` with the URL path elided after the host so a topic name is not printed into a shared terminal.
- **Error states:** an invalid `agentEnv.allow` entry or notify URL stops `run` with one line naming the field; a notice that fails is one `agent.log` line; a withheld variable a task needed shows up as the task's own failure, and the banner already named it.
- **Notification text:** title `<repo> — <event>`, body one sentence: `Plan ready for approval`, `Budget gate at $30.00 of $30.00`, `Task api-auth needs you: <reason>`, `Run done: 14 merged, 1 parked`, `Run stopped: <error first line>`.
- **Accessibility bar:** WCAG 2.2 AA is unchanged for the dashboard; notices are plain text so a screen reader on the phone reads them in full.

## 7. Scope

**In scope:**
- `packages/shared/src/config.ts`: an `agentEnv` block in `RunConfig` (`allow: string[]`, `inherit: boolean`), and the base allowlist as an exported constant.
- `apps/cli/src/defaults.ts`: `agentEnv` in the `charrette.config.json` schema; `resume` applies it like `skillRouting`.
- A new `packages/core/src/agentEnv.ts` that builds a session environment from charrette's environment, the run config and the session's provider, used by `pool.ts` (Claude sessions and the subscription probe) and `toolLoop.ts` (non-Anthropic sessions).
- `apps/cli/src/notify.ts`: a push channel beside the desktop one, the event subscription, rate limit and retry, and the `notify-test` command in `cli.ts`.
- `docs/REMOTE.md`, `scripts/remote/provision.sh`, `scripts/remote/charrette-session`, and a `shellcheck` step in CI for `scripts/remote/`.
- README, `docs/OPERATIONS.md` and `CHANGELOG.md` updates.
- Tests for each P0 criterion.

**Out of scope:**
- The non-goals in §4.
- A systemd unit that resumes runs after a reboot; the guide gives the manual `charrette-session` then `charrette resume`.
- Encrypting the env file at rest beyond full-disk encryption.

**Dependencies:** a Linux host with outbound HTTPS; a Tailscale account; an ntfy topic (hosted or self-hosted) or any HTTPS endpoint for notices; the operator's vendor accounts to create scoped keys.

**Constraints:**
- Runs created before this change keep working: an absent `agentEnv` means the allowlist with the defaults, and any variable a run needs can be restored with one `allow` entry or `inherit: true`.
- The Claude Agent SDK subprocess must still receive its login; the allowlist is applied to what the SDK passes on, not to charrette's own process.
- No new runtime dependency: notices use the global `fetch`.
- The repository is public: no host name, IP, account or user name of the maintainer appears in the guide, script or tests.

## 8. Risks and open questions

| ID | Risk or question | Type | Owner | Resolve by |
|---|---|---|---|---|
| R-001 | The Claude login a Claude session needs is readable by that session's own Bash tool, whichever login is used, so the allowlist cannot protect it. | Risk | maintainers | accepted; mitigated by the workspace spend limit or by the subscription's own usage cap, stated in `docs/REMOTE.md` |
| R-002 | A git credential helper on the host lets an agent push with the operator's GitHub identity regardless of the environment. | Risk | operator | accepted; the guide makes the scoped token the only GitHub credential on the host, and branch protection blocks direct pushes to the default branch |
| R-003 | Withholding variables by default breaks a run whose tasks used a key that happened to be exported. | Risk | maintainers | the banner names withheld secret-like variables, and `allow` or `inherit` restores them; called out in `CHANGELOG.md` |
| R-004 | An ntfy topic on the public server is readable by anyone who knows its name. | Risk | operator | the guide recommends a long random topic or a self-hosted server with an access token, and notices never carry secrets |
| R-005 | Outbound traffic is unrestricted apart from private ranges, so a hijacked agent can still send what it can read to the internet. | Risk | operator | accepted for this release; the guide documents an allowlist proxy as the next hardening step |
| R-006 | The Agent SDK may need variables beyond the base allowlist on some hosts (proxy, CA bundle, locale). | Risk | maintainers | the base list carries proxy and CA variables; verified by the SDK smoke test on the clean VM in §10 |

## 9. Instrumentation

| Event | Trigger | Properties | Purpose |
|---|---|---|---|
| `run.agent_env` | a run starts or resumes | `runId`, `passed` (count), `added` (names), `withheld` (secret-like names), `inherit` | proves which variables agents could see, for the primary KPI and for audits |
| `notify.sent` | a push notice is accepted with a 2xx | `runId`, `event`, `status`, `attempts`, `latencyMs` | feeds time-to-know for the secondary KPI |
| `notify.failed` | a push notice fails after the last retry | `runId`, `event`, `status` or `error` | shows a broken endpoint before the operator misses a gate |
| `run.gate_opened`, `task.gate_opened`, `run.pitstop_opened`, `task.state_changed` to `NEEDS_HUMAN`, `run.state_changed` to a terminal state | existing events | unchanged | the triggers notices are sent for |

## 10. Rollout and rollback

- **Strategy:** ship in three pull requests. First the agent environment allowlist with its tests, then push notifications, then `docs/REMOTE.md` with the provisioning script. Release them together as 0.4.0. Before the release, a maintainer runs the provisioning script on a clean Debian 13 VM and an Ubuntu 24.04 VM, completes a small run with each Claude login, and records the setup time against the 60-minute target.
- **Rollback trigger:** if a released run fails because the allowlist withheld something the Agent SDK itself needs, switch the default to `inherit: true` in a patch release the same day and reopen R-006.
- **Migration or backfill:** none. No schema change; `agentEnv` is a new optional config block with a default.

## 11. Compliance gates

- [x] None apply: no personal data is stored or processed by this change. Notices leave the host to an endpoint the operator chooses and contain only a repository directory name, a run id and an event line, which §5 requires.

## 12. Data and integrations

- **Stored:** the run config gains `agentEnv` (`allow`, `inherit`); events gain `run.agent_env`, `notify.sent` and `notify.failed`. Variable names are stored; values never are. The env file on the host is `0600`, owned by the charrette user, and read by the session wrapper only.
- **Migration:** none. `getRun` re-parses stored configs, and an absent `agentEnv` takes its default.
- **Integrations:**
  - Push endpoint: `POST` to `CHARRETTE_NOTIFY_URL` over HTTPS, optional `Authorization: Bearer $CHARRETTE_NOTIFY_TOKEN`. ntfy's publish API (headers `Title`, `Priority`, `Tags`, plain-text body) or a JSON body. Tests use an injected `fetch`; no test sends a real notice.
  - Tailscale, OpenSSH, nftables, unattended-upgrades and tmux on the host, configured by the provisioning script and documented in the guide.
  - npm registry provenance for installs, checked with `npm audit signatures`.

## 13. Non-functional requirements

- **Base allowlist:** `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LC_*`, `TZ`, `TMPDIR`, `XDG_*`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lowercase forms, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `NODE_OPTIONS`, `GOPATH`, `GOROOT`, `GOCACHE`, `CARGO_HOME`, `RUSTUP_HOME`, `PNPM_HOME`, `NVM_DIR`, `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `CONTAINER_HOST`, `DOCKER_HOST`, `CI`, plus charrette's own `BASH_*` timeout and `CHARRETTE_*` variables except `CHARRETTE_NOTIFY_*`. Claude sessions also get the Claude login variables in §5.
- **Notice latency:** sent within 60 seconds of the triggering event; each attempt times out after 5 seconds; 2 retries at 2 and 10 seconds.
- **Notice rate:** at most 20 per run per 10 minutes, then one summary notice.
- **Provisioning time:** 60 minutes or less from SSH access to a first run, measured on a clean VM.
- **Idempotency:** the provisioning script makes no change on a second run and exits 0.
- **Coverage:** 100% statement, branch, function and line coverage stays the CI gate; the shell script passes `shellcheck` with no warnings.

## 14. Assumptions

| ID | Dimension | Assumption | Why this default | Overturn if |
|---|---|---|---|---|
| A-001 | permissions | The host runs charrette as one unprivileged user with no sudo, and that user is the only operator. | The machine is the sandbox; a second human user would need access control charrette does not have. | Two operators need to share one host. |
| A-002 | integrations | Remote access is Tailscale plus key-only SSH, and the dashboard is reached through `ssh -L`. | No inbound port is opened, and the dashboard's `Host` check already accepts a tunnelled `127.0.0.1`. | The operator cannot install Tailscale; the guide then documents plain SSH on a non-default port with key-only login. |
| A-003 | constraints | Outbound traffic to private address ranges is dropped, and public internet traffic is allowed. | Blocks lateral movement into a home or office network on day one without breaking package installs or vendor APIs. | A hosting provider needs private-range access for its metadata or DNS service; the script then allows that address explicitly. |
| A-004 | inputs | GitHub tokens are withheld from agents by default, so the `gh` CLI does not work inside agent sessions unless the operator allows `GH_TOKEN` or `GITHUB_TOKEN`. | Workers use `gh` only for read-only lookups, and the token can push. | Tasks routinely need CI logs through `gh`; the guide then suggests a second read-only token passed through `allow`. |
| A-005 | outputs | The push channel speaks ntfy's publish API and a generic JSON body, selected by `CHARRETTE_NOTIFY_FORMAT`. | ntfy runs on any phone, self-hosts, and accepts one HTTP POST; JSON covers Slack-style relays and custom endpoints. | A second push service needs a different request shape. |
| A-006 | triggers | Notices are sent for gates, `NEEDS_HUMAN`, run done and run stopped, and not for task merges. | Those are the events that need the operator or end the run; merges would flood the channel. | Operators ask for progress notices. |
| A-007 | model_behavior | The allowlist does not change what any model is told: system prompts, skills and tool sets stay the same. | The toolbelt already describes tools; a withheld variable shows up as that tool failing, which the banner explains. | Agents waste turns retrying a tool whose credential was withheld; the toolbelt then omits that tool when its variable is withheld. |
| A-008 | data | The env file is plain text protected by file mode and full-disk encryption, not a secrets manager. | It matches how charrette already reads keys from the environment or `.env`; a secrets manager adds a dependency for one host. | The operator runs more than one host or needs rotation audit trails. |

## 15. Decision log

| ID | Dimension | Question | Options offered | Answer | Applied in |
|---|---|---|---|---|---|
| DL-001 | actors | Which machine should run charrette remotely? | A. Linux VM on the Mac mini (recommended) B. Separate Linux machine C. Mac mini, dedicated macOS user | Any Linux machine | §2, §4, §5, §10 |
| DL-002 | integrations | Which Claude login should the remote box use? | A. API key with spend limit (recommended) B. Subscription token | Support both options | §4, §5, §8 |
| DL-003 | non_goals | What should be built next? | A. Env allowlist PR B. Provisioning script and REMOTE.md C. Push notifications D. Publish the plan as a page | All four, plus this PRD | §4, §5, §7, §10 |

## Coverage

| Dimension | Status | Ref |
|---|---|---|
| purpose | specified | §1, §3 |
| actors | specified | §2, DL-001 |
| permissions | specified | §5, A-001 |
| triggers | specified | §5, A-006 |
| inputs | specified | §5, A-004 |
| outputs | specified | §5, §6, A-005 |
| states | specified | §5, §13 |
| errors | specified | §5, §6 |
| interface | specified | §6 |
| data | specified | §12, A-008 |
| integrations | specified | §12, A-002, DL-002 |
| non_functional | specified | §13 |
| constraints | specified | §7, A-003 |
| non_goals | specified | §4, DL-003 |
| acceptance | specified | §5 |
| rollout | specified | §10 |
| model_behavior | specified | §5, A-007 |
