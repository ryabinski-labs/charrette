import { describe, expect, it } from "vitest";
import type { LocalTool } from "./agentTools.js";
import type { ProviderClient, ProviderTurn } from "./providerClients.js";
import { toolLoop, type PromptSource } from "./toolLoop.js";
import { agentEnvBanner, agentEnvEvent, buildAgentEnv, summarizeAgentEnv } from "./agentEnv.js";

/**
 * What an agent session can read.
 *
 * The whole point of the remote-host work is that the environment a session
 * receives is a decision, not an inheritance. These cases pin the decision at
 * the two places it is made — the pure builder and the transport that hands it
 * to the tools — and deliberately supply the environment rather than mutating
 * `process.env`, so nothing here can pass because of the machine it ran on.
 */

const VENDOR_KEYS = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
] as const;

describe("the base allowlist", () => {
  it("SC-001-a the base allowlist keeps the shell working and drops every vendor key", () => {
    const source = {
      PATH: "/usr/bin",
      TERM: "xterm",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      GEMINI_API_KEY: "gem-secret",
      DEEPSEEK_API_KEY: "deepseek-secret",
      OPENAI_API_KEY: "openai-secret",
      GITHUB_TOKEN: "ghp_secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    };

    const state = buildAgentEnv({ source, provider: "deepseek" });

    expect(state.env.PATH).toBe("/usr/bin");
    expect(state.env.TERM).toBe("xterm");
    for (const name of VENDOR_KEYS) expect(state.env).not.toHaveProperty(name);
  });

  it("SC-001-b prefix families are matched exactly as the base list documents", () => {
    const source = {
      LC_ALL: "C.UTF-8",
      XDG_CONFIG_HOME: "/home/charrette/.config",
      BASH_MAX_TIMEOUT_MS: "1800000",
      CHARRETTE_RUN_ID: "run1",
      CHARRETTE_NOTIFY_TOKEN: "tk_secret",
      CHARRETTE_NOTIFY_URL: "https://ntfy.sh/topic",
      http_proxy: "http://proxy.example:3128",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    };

    const state = buildAgentEnv({ source, provider: "openai" });

    expect(state.env.LC_ALL).toBe("C.UTF-8");
    expect(state.env.XDG_CONFIG_HOME).toBe("/home/charrette/.config");
    expect(state.env.BASH_MAX_TIMEOUT_MS).toBe("1800000");
    expect(state.env.CHARRETTE_RUN_ID).toBe("run1");
    expect(state.env.http_proxy).toBe("http://proxy.example:3128");
    expect(state.env.SSL_CERT_FILE).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(state.env).not.toHaveProperty("CHARRETTE_NOTIFY_TOKEN");
    expect(state.env).not.toHaveProperty("CHARRETTE_NOTIFY_URL");
  });

  it("SC-001-c a non-Anthropic session's tool context receives the filtered environment", async () => {
    const captured: Record<string, string>[] = [];
    const capture: LocalTool = {
      name: "Bash",
      description: "capture the tool context",
      parameters: { type: "object", properties: {} },
      run: async (_input, ctx) => {
        captured.push({ ...ctx.env });
        return "captured";
      },
    };
    const sessionEnv = buildAgentEnv({
      source: { PATH: "/usr/bin", DEEPSEEK_API_KEY: "deepseek-secret", GITHUB_TOKEN: "ghp_secret" },
      provider: "deepseek",
    }).env;

    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const turns: ProviderTurn[] = [
      { text: "", toolCalls: [{ id: "c1", name: "Bash", input: {} }], usage },
      { text: "done", toolCalls: [], usage },
    ];
    let turn = 0;
    const client: ProviderClient = async () => turns[Math.min(turn++, turns.length - 1)]!;
    let sent = false;
    const prompts: PromptSource = {
      next: async () => {
        if (sent) return null;
        sent = true;
        return "inspect the environment";
      },
      drain: () => [],
    };

    const messages: Record<string, unknown>[] = [];
    for await (const message of toolLoop({
      spec: { model: "deepseek-flash", systemPrompt: "worker", cwd: process.cwd() },
      prompts,
      signal: new AbortController().signal,
      client,
      toolsOverride: [capture],
      sessionEnv,
    })) {
      messages.push(message);
    }

    expect(messages.at(-1)).toMatchObject({ type: "result" });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.PATH).toBe("/usr/bin");
    expect(captured[0]).not.toHaveProperty("DEEPSEEK_API_KEY");
    expect(captured[0]).not.toHaveProperty("GITHUB_TOKEN");
  });
});

describe("a Claude session's login", () => {
  it("SC-002-a a Claude session receives its login and no other vendor key", () => {
    const state = buildAgentEnv({
      source: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        CLAUDE_CONFIG_DIR: "/home/charrette/.claude",
        ANTHROPIC_BASE_URL: "https://anthropic.example",
        GEMINI_API_KEY: "gem-secret",
        GITHUB_TOKEN: "ghp_secret",
      },
      provider: "anthropic",
    });

    expect(state.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    expect(state.env.CLAUDE_CONFIG_DIR).toBe("/home/charrette/.claude");
    expect(state.env.ANTHROPIC_BASE_URL).toBe("https://anthropic.example");
    expect(state.env.PATH).toBe("/usr/bin");
    expect(state.env).not.toHaveProperty("GEMINI_API_KEY");
    expect(state.env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("SC-002-c task and subscription overlays apply on top of the allowlist", () => {
    const state = buildAgentEnv({
      source: { PATH: "/usr/bin" },
      provider: "anthropic",
      overlay: { COMPOSE_PROJECT_NAME: "charrette-task1" },
      subscription: { CLAUDE_CODE_OAUTH_TOKEN: "oat-work" },
    });

    expect(state.env.COMPOSE_PROJECT_NAME).toBe("charrette-task1");
    expect(state.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-work");
  });
});

describe("agentEnv.allow", () => {
  it("SC-003-a a configured allow entry reaches the session and is reported", () => {
    const state = buildAgentEnv({
      source: { PATH: "/usr/bin", STRIPE_TEST_KEY: "sk_test_123" },
      provider: "deepseek",
      config: { allow: ["STRIPE_TEST_KEY"], inherit: false },
    });

    expect(state.env.STRIPE_TEST_KEY).toBe("sk_test_123");
    expect(state.added).toEqual(["STRIPE_TEST_KEY"]);
  });

  it("SC-003-b an allow entry that is not set is reported and absent", () => {
    const state = buildAgentEnv({
      source: { PATH: "/usr/bin" },
      provider: "deepseek",
      config: { allow: ["STRIPE_TEST_KEY"], inherit: false },
    });

    expect(state.env).not.toHaveProperty("STRIPE_TEST_KEY");
    expect(state.missing).toEqual(["STRIPE_TEST_KEY"]);
  });

  it("adds every variable a wildcard entry matches", () => {
    const state = buildAgentEnv({
      source: { PATH: "/usr/bin", STRIPE_TEST_KEY: "one", STRIPE_LIVE_KEY: "two", OTHER_KEY: "three" },
      provider: "deepseek",
      config: { allow: ["STRIPE_*"], inherit: false },
    });

    expect(state.env.STRIPE_TEST_KEY).toBe("one");
    expect(state.env.STRIPE_LIVE_KEY).toBe("two");
    expect(state.env).not.toHaveProperty("OTHER_KEY");
    expect(state.added.sort()).toEqual(["STRIPE_LIVE_KEY", "STRIPE_TEST_KEY"]);
  });
});

describe("what the banner says", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/charrette",
    USER: "charrette",
    LOGNAME: "charrette",
    SHELL: "/bin/bash",
    TERM: "xterm",
    LANG: "C.UTF-8",
    TZ: "UTC",
    TMPDIR: "/tmp",
    CI: "1",
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    NODE_OPTIONS: "--no-warnings",
    GEMINI_API_KEY: "gem-secret",
    GITHUB_TOKEN: "ghp_secret",
    STRIPE_SECRET_KEY: "sk_live_secret",
    STRIPE_TEST_KEY: "sk_test_123",
  };

  it("SC-004-a withheld names are the secret-like variables no agent receives", () => {
    const summary = summarizeAgentEnv(source, { allow: [], inherit: false });

    expect(summary.withheld).toEqual(["GEMINI_API_KEY", "GITHUB_TOKEN", "STRIPE_SECRET_KEY"]);
    expect(summary.withheld).not.toContain("PATH");
  });

  it("SC-004-b inherit returns the whole environment", () => {
    const state = buildAgentEnv({
      source: { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_x" },
      provider: "deepseek",
      config: { allow: [], inherit: true },
    });

    expect(state.env.GITHUB_TOKEN).toBe("ghp_x");
    expect(state.env.PATH).toBe("/usr/bin");
    expect(state.inherit).toBe(true);
  });

  it("SC-004-c the banner names what passed, what was added and what was withheld", () => {
    const summary = summarizeAgentEnv(source, { allow: ["STRIPE_TEST_KEY"], inherit: false });

    expect(agentEnvBanner(summary)).toEqual([
      "agent env   12 passed · +STRIPE_TEST_KEY · withheld GEMINI_API_KEY GITHUB_TOKEN STRIPE_SECRET_KEY",
    ]);
  });

  it("SC-004-d the run.agent_env event records the summary", () => {
    const summary = summarizeAgentEnv(source, { allow: ["STRIPE_TEST_KEY"], inherit: false });

    const event = agentEnvEvent("run1", summary);

    expect(event.type).toBe("run.agent_env");
    expect(event.runId).toBe("run1");
    expect(event.type === "run.agent_env" && event.passed).toBe(12);
    expect(event.type === "run.agent_env" && event.added).toContain("STRIPE_TEST_KEY");
    expect(event.type === "run.agent_env" && event.withheld).toHaveLength(3);
    expect(event.type === "run.agent_env" && event.inherit).toBe(false);
  });

  it("says inherit in words when every variable reaches agents", () => {
    expect(agentEnvBanner({ passed: 0, added: [], missing: [], withheld: [], inherit: true })).toEqual([
      "agent env   inherit (every variable reaches agents)",
    ]);
  });

  it("marks an allow entry that is not set", () => {
    expect(
      agentEnvBanner({ passed: 3, added: [], missing: ["STRIPE_TEST_KEY"], withheld: [], inherit: false })
    ).toEqual(["agent env   3 passed · +STRIPE_TEST_KEY (not set)"]);
  });
});
