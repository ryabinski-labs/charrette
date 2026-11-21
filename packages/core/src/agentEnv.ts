import type { AgentEnvConfig, CharretteEvent, Provider } from "@charrette/shared";

/**
 * What an agent session may see.
 *
 * An agent reads untrusted text all day — repository files, dependency install
 * scripts, issue bodies, CI logs — and runs with `bypassPermissions`. Anything
 * in charrette's environment is therefore something a prompt injection can
 * read and send out. The fix is not a better guard; it is that the secret was
 * never in the environment to begin with.
 *
 * So every session is built from this list rather than inherited, and the
 * exceptions are named: the base list below, the Claude login a Claude session
 * cannot work without, and whatever the operator adds in `agentEnv.allow`.
 *
 * The list is deliberately about *the shell an agent drives*, not about the
 * charrette's own process. The provider clients still read the real
 * environment; the agent's tools never do.
 */

/** Variables every session gets. Names, not values. */
export const BASE_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "TZ",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "GOPATH",
  "GOROOT",
  "GOCACHE",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PNPM_HOME",
  "NVM_DIR",
  "JAVA_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "CONTAINER_HOST",
  "DOCKER_HOST",
  "CI",
] as const;

const BASE_NAMES = new Set<string>(BASE_ALLOWLIST);
const BASE_PREFIXES = ["LC_", "XDG_", "BASH_", "CHARRETTE_"] as const;

/**
 * The login a Claude session needs, and nothing else.
 *
 * These are readable by that session's own Bash tool whichever login is used;
 * `docs/REMOTE.md` says so. Keeping them out of every other session at least
 * means a DeepSeek or Gemini worker cannot read the Anthropic bill.
 */
export const CLAUDE_LOGIN_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_BASE_URL",
] as const;

const CLAUDE_LOGIN = new Set<string>(CLAUDE_LOGIN_VARIABLES);

/** Anything whose name says it is worth stealing. Used for the banner only. */
const SECRET_LIKE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/** The inputs a session environment is built from. */
export interface AgentEnvInput {
  source: NodeJS.ProcessEnv;
  config?: Partial<AgentEnvConfig>;
  provider: Provider;
  /** Per-task variables — the compose project and port block (isolation.ts). */
  overlay?: Record<string, string>;
  /** The active Claude subscription's credentials, already resolved. */
  subscription?: Record<string, string>;
}

/** What the builder decided, for the session and for the banner. */
export interface AgentEnvState {
  env: Record<string, string>;
  passed: number;
  added: string[];
  missing: string[];
  withheld: string[];
  inherit: boolean;
}

export type AgentEnvSummary = Omit<AgentEnvState, "env">;

/** A variable the base list admits, with no provider-specific exception. */
function baseAllowed(name: string): boolean {
  if (BASE_NAMES.has(name)) return true;
  for (const prefix of BASE_PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    // Charrette's own settings are useful to a tool; its notification
    // credentials are not. This is the one exception inside a prefix family.
    if (prefix === "CHARRETTE_" && name.startsWith("CHARRETTE_NOTIFY_")) return false;
    return true;
  }
  return false;
}

function allowedForProvider(name: string, provider: Provider): boolean {
  return baseAllowed(name) || (provider === "anthropic" && CLAUDE_LOGIN.has(name));
}

function allowMatches(allow: readonly string[], name: string): boolean {
  for (const entry of allow) {
    if (entry.endsWith("*")) {
      if (name.startsWith(entry.slice(0, -1))) return true;
    } else if (name === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Build one session's environment.
 *
 * `overlay` and `subscription` are applied last on purpose: they are the
 * per-task and per-account variables charrette itself decided on, not
 * something an agent's shell inherited. A spec that names a variable gets it
 * whether or not it is on the allowlist — that was true before this change and
 * is how the compose project and port block reach the tools.
 */
export function buildAgentEnv(input: AgentEnvInput): AgentEnvState {
  const config = input.config ?? {};
  const allow = config.allow ?? [];
  const inherit = config.inherit ?? false;
  const env: Record<string, string> = {};
  const added: string[] = [];
  let passed = 0;

  if (inherit) {
    for (const [name, value] of Object.entries(input.source)) {
      if (value !== undefined) env[name] = value;
    }
  } else {
    for (const [name, value] of Object.entries(input.source)) {
      if (value === undefined) continue;
      if (allowedForProvider(name, input.provider)) {
        env[name] = value;
        passed++;
      } else if (allowMatches(allow, name)) {
        env[name] = value;
        added.push(name);
      }
    }
  }

  for (const [name, value] of Object.entries(input.overlay ?? {})) env[name] = value;
  for (const [name, value] of Object.entries(input.subscription ?? {})) env[name] = value;

  const missing = inherit
    ? []
    : allow.filter((entry) => !entry.endsWith("*") && input.source[entry] === undefined);

  const withheld = Object.keys(input.source).filter(
    (name) => input.source[name] !== undefined && env[name] === undefined && SECRET_LIKE.test(name)
  );

  return { env, passed, added, missing, withheld, inherit };
}

/**
 * The run-level view the banner and `run.agent_env` report.
 *
 * Deliberately not one session's view: a key withheld from a DeepSeek worker
 * is not withheld from the Claude planner, and the event exists to say what an
 * agent *could* read. So a secret-like variable is withheld only when no
 * provider gets it — base list, operator allow, or the Claude login (which a
 * Claude session does receive, and which `docs/REMOTE.md` says is readable by
 * that session).
 */
export function summarizeAgentEnv(source: NodeJS.ProcessEnv, config?: Partial<AgentEnvConfig>): AgentEnvSummary {
  const allow = config?.allow ?? [];
  const inherit = config?.inherit ?? false;
  if (inherit) return { passed: 0, added: [], missing: [], withheld: [], inherit: true };

  const added: string[] = [];
  let passed = 0;
  const present = new Set<string>();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    present.add(name);
    if (baseAllowed(name)) passed++;
    else if (allowMatches(allow, name)) added.push(name);
  }

  const missing = allow.filter((entry) => !entry.endsWith("*") && !present.has(entry));
  const withheld = [...present].filter(
    (name) => !baseAllowed(name) && !CLAUDE_LOGIN.has(name) && !allowMatches(allow, name) && SECRET_LIKE.test(name)
  );

  return { passed, added, missing, withheld, inherit: false };
}

/** The banner line an operator reads before approving a plan. */
export function agentEnvBanner(summary: AgentEnvSummary): string[] {
  if (summary.inherit) return ["agent env   inherit (every variable reaches agents)"];
  const parts = [`${summary.passed} passed`];
  parts.push(...summary.added.map((name) => `+${name}`));
  parts.push(...summary.missing.map((name) => `+${name} (not set)`));
  if (summary.withheld.length) parts.push(`withheld ${summary.withheld.join(" ")}`);
  return [`agent env   ${parts.join(" · ")}`];
}

/** The instrumentation record: names only, never a value. */
export function agentEnvEvent(runId: string, summary: AgentEnvSummary, ts = Date.now()): CharretteEvent {
  return {
    type: "run.agent_env",
    runId,
    passed: summary.passed,
    added: summary.added,
    withheld: summary.withheld,
    inherit: summary.inherit,
    ts,
  };
}
