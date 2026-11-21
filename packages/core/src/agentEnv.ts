import type { AgentEnvConfig, CharretteEvent, Provider } from "@charrette/shared";

/** The inputs a session environment is built from. */
export interface AgentEnvInput {
  source: NodeJS.ProcessEnv;
  config?: Partial<AgentEnvConfig>;
  provider: Provider;
  overlay?: Record<string, string>;
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

/**
 * Minimal interface for the red phase. The real filter lands once these tests
 * have been seen to fail on their assertions.
 */
export function buildAgentEnv(input: AgentEnvInput): AgentEnvState {
  return {
    env: { ...(input.source as Record<string, string>) },
    passed: 0,
    added: [],
    missing: [],
    withheld: [],
    inherit: false,
  };
}

export function summarizeAgentEnv(_source: NodeJS.ProcessEnv, _config?: Partial<AgentEnvConfig>): AgentEnvSummary {
  return { passed: 0, added: [], missing: [], withheld: [], inherit: false };
}

export function agentEnvBanner(_summary: AgentEnvSummary): string[] {
  return [];
}

export function agentEnvEvent(runId: string, _summary: AgentEnvSummary): CharretteEvent {
  return { type: "run.agent_env", runId, passed: 0, added: [], withheld: [], inherit: false, ts: Date.now() };
}
