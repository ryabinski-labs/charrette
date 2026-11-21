import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@charrette/shared";

const { queryMock, reapUnderMock } = vi.hoisted(() => ({ queryMock: vi.fn(), reapUnderMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("./reaper.js", () => ({ reapUnder: reapUnderMock }));

import { Bus } from "./bus.js";
import { Store } from "./store.js";
import { AgentPool, type AgentSpec } from "./pool.js";

/**
 * The environment the SDK is actually handed.
 *
 * `agentEnv.test.ts` settles what the filter returns. This is the wiring that
 * makes it true for a Claude session: the options object the pool passes to
 * `query()` is the one the spawned CLI inherits, and a filter that never
 * reaches it changes nothing an agent can read.
 */

const result = (text = "the answer") => ({
  type: "result",
  session_id: "sdk-session-1",
  subtype: "success",
  result: text,
  usage: { input_tokens: 10, output_tokens: 5 },
  total_cost_usd: 0.01,
});

const SPEC: AgentSpec = {
  runId: "run1",
  role: "worker",
  model: "claude-opus-5-5",
  systemPrompt: "you are a worker",
  prompt: "build the thing",
  cwd: "/tmp/worktree",
};

let store: Store;
let bus: Bus;
let pool: AgentPool;

beforeEach(() => {
  queryMock.mockReset();
  reapUnderMock.mockReset().mockResolvedValue([]);
  queryMock.mockImplementation(() =>
    (async function* () {
      yield result();
    })()
  );
  store = new Store(":memory:");
  store.createRun({
    id: "run1",
    repoPath: "/tmp/repo",
    assignment: "build a thing",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: "charrette/run1/main",
    config: RunConfig.parse({}),
  });
  bus = new Bus(store);
  pool = new AgentPool(store, bus);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the Claude session environment", () => {
  it("SC-002-b the pool spawns Claude sessions with the filtered environment", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
    vi.stubEnv("GEMINI_API_KEY", "gem-secret");
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    vi.stubEnv("PATH", "/usr/bin");
    // A frozen config with no block and a block with no fields both mean the
    // allowlist; the second is what the controller hands over for an old run.
    pool.configureAgentEnv(undefined);
    pool.configureAgentEnv({});

    await pool.run(SPEC);

    const options = queryMock.mock.calls[0]![0] as { options: { env?: Record<string, string> } };
    const env = options.options.env!;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    expect(env.PATH).toBe("/usr/bin");
    expect(env).not.toHaveProperty("GEMINI_API_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
  });

});
