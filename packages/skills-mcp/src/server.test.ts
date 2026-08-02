import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { McpServerMock, StdioServerTransportMock, connectMock, toolMock, indexSkillsMock, matchSkillsMock } = vi.hoisted(
  () => {
    const connectMock = vi.fn(async () => undefined);
    const toolMock = vi.fn();
    return {
      connectMock,
      toolMock,
      McpServerMock: vi.fn(() => ({ tool: toolMock, connect: connectMock })),
      StdioServerTransportMock: vi.fn(() => ({ kind: "stdio" })),
      indexSkillsMock: vi.fn(),
      matchSkillsMock: vi.fn(),
    };
  }
);

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: McpServerMock }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: StdioServerTransportMock }));
vi.mock("./indexer.js", () => ({ indexSkills: indexSkillsMock, matchSkills: matchSkillsMock }));

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

/**
 * Boots `server.ts` against the mocked SDK. The module connects a stdio
 * transport at import time, so it can only be exercised this way — importing it
 * for real would bind the test process's stdin and hang the suite.
 */
async function bootServer(argv: string[]): Promise<Map<string, ToolHandler>> {
  vi.resetModules();
  McpServerMock.mockClear();
  StdioServerTransportMock.mockClear();
  connectMock.mockClear();
  toolMock.mockClear();
  process.argv = ["node", "/path/to/server.js", ...argv];
  await import("./server.js");
  const tools = new Map<string, ToolHandler>();
  for (const call of toolMock.mock.calls) {
    const [name, , , handler] = call as [string, string, unknown, ToolHandler];
    tools.set(name, handler);
  }
  return tools;
}

const SKILL = {
  name: "visual-qa-agent",
  path: "/Users/x/.claude/skills/visual-qa-agent/SKILL.md",
  sha256: "abc123",
  description: "Reviews rendered screens",
  body: "# Visual QA\nFull text of the playbook.",
};

const realArgv = process.argv;

describe("skills MCP server", () => {
  beforeEach(() => {
    indexSkillsMock.mockReset();
    matchSkillsMock.mockReset();
    indexSkillsMock.mockReturnValue([SKILL]);
    matchSkillsMock.mockReturnValue([{ skill: SKILL, score: 0.87654 }]);
  });

  afterEach(() => {
    process.argv = realArgv;
  });

  it("connects a stdio transport and registers both tools", async () => {
    const tools = await bootServer([]);

    expect(McpServerMock).toHaveBeenCalledWith({ name: "harness-skills-discovery", version: "0.0.1" });
    expect(StdioServerTransportMock).toHaveBeenCalledOnce();
    expect(connectMock).toHaveBeenCalledWith({ kind: "stdio" });
    expect([...tools.keys()].sort()).toEqual(["describe_skill", "search_skills"]);
  });

  it("indexes the two default skill directories when given no arguments", async () => {
    const tools = await bootServer([]);
    await tools.get("describe_skill")!({ name: SKILL.name });

    expect(indexSkillsMock).toHaveBeenCalledWith([
      path.join(os.homedir(), ".claude", "skills"),
      path.join(os.homedir(), "skills"),
    ]);
  });

  it("indexes the directories passed on the command line instead", async () => {
    const tools = await bootServer(["/opt/skills", "/srv/more-skills"]);
    await tools.get("describe_skill")!({ name: SKILL.name });

    expect(indexSkillsMock).toHaveBeenCalledWith(["/opt/skills", "/srv/more-skills"]);
  });

  it("search_skills returns ranked matches with their provenance hash", async () => {
    const tools = await bootServer([]);

    const result = await tools.get("search_skills")!({ taskDescription: "review the login screen", k: 3 });

    expect(matchSkillsMock).toHaveBeenCalledWith([SKILL], "review the login screen", 3);
    expect(result.content[0]!.type).toBe("text");
    expect(JSON.parse(result.content[0]!.text)).toEqual([
      {
        name: SKILL.name,
        path: SKILL.path,
        sha256: SKILL.sha256,
        description: SKILL.description,
        // Rounded, so a float's tail does not leak into the tool output.
        score: 0.877,
      },
    ]);
  });

  it("describe_skill returns the full playbook body", async () => {
    const tools = await bootServer([]);

    const result = await tools.get("describe_skill")!({ name: "visual-qa-agent" });

    expect(result.content).toEqual([{ type: "text", text: SKILL.body }]);
  });

  it("describe_skill says so plainly when the name matches nothing", async () => {
    const tools = await bootServer([]);

    const result = await tools.get("describe_skill")!({ name: "no-such-skill" });

    expect(result.content).toEqual([{ type: "text", text: "unknown skill: no-such-skill" }]);
  });
});
