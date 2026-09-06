import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { McpServerMock, StdioServerTransportMock, toolMock } = vi.hoisted(() => {
  const toolMock = vi.fn();
  return {
    toolMock,
    McpServerMock: vi.fn(() => ({ tool: toolMock, connect: vi.fn(async () => undefined) })),
    StdioServerTransportMock: vi.fn(() => ({ kind: "stdio" })),
  };
});

// Only the transport is faked — importing the real module would bind this
// process's stdin and hang the suite. The indexer is deliberately NOT mocked:
// the property under test is what the server does with the actual filesystem.
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: McpServerMock }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: StdioServerTransportMock }));

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

const realArgv = process.argv;
let dir: string;

const addSkill = (name: string, description: string, body: string) => {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
};

async function bootServer(): Promise<Map<string, ToolHandler>> {
  vi.resetModules();
  toolMock.mockClear();
  process.argv = ["node", "/path/to/server.js", dir];
  await import("./server.js");
  const tools = new Map<string, ToolHandler>();
  for (const call of toolMock.mock.calls) {
    const [name, , , handler] = call as [string, string, unknown, ToolHandler];
    tools.set(name, handler);
  }
  return tools;
}

/**
 * A skill collection is not a static thing. The operator adds one mid-session,
 * `skillForge` writes one into `<repo>/.harness/skills/` when a task matches
 * nothing, and either way the next question asked over this stdio connection
 * has to be able to find it — the server is long-lived and nothing restarts it
 * between tool calls.
 *
 * The tests beside this one mock the indexer, which means they would all still
 * pass if someone lifted `indexSkills(dirs)` out of the handlers and into
 * module scope for the obvious performance reason. That change would cost live
 * discovery in total silence, so this file reads the real filesystem.
 */
describe("skills appearing after the server booted", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "skills-live-"));
    addSkill("ledger-reconciler", "Reconciles invoices against the ledger", "Reconcile invoices.");
  });

  afterEach(() => {
    process.argv = realArgv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("search_skills finds a skill written after the connection opened", async () => {
    const tools = await bootServer();
    const search = async (q: string) =>
      JSON.parse((await tools.get("search_skills")!({ taskDescription: q, k: 5 })).content[0]!.text) as { name: string }[];

    const query = "repair the github actions workflow cache";
    expect((await search(query)).map((s) => s.name)).not.toContain("pipeline-whisperer");

    addSkill("pipeline-whisperer", "Design and repair GitHub Actions workflows, runners and caches", "Tune Actions caching.");

    // Same server, same handlers, no restart.
    expect((await search(query)).map((s) => s.name)).toContain("pipeline-whisperer");
  });

  it("describe_skill reads one that did not exist a moment ago", async () => {
    const tools = await bootServer();
    const describe_ = async (name: string) => (await tools.get("describe_skill")!({ name })).content[0]!.text;

    expect(await describe_("pipeline-whisperer")).toBe("unknown skill: pipeline-whisperer");

    addSkill("pipeline-whisperer", "Design and repair GitHub Actions workflows", "Tune Actions caching.");

    expect(await describe_("pipeline-whisperer")).toContain("Tune Actions caching.");
  });

  it("notices a skill whose body changed on disk, rather than serving the first read forever", async () => {
    const tools = await bootServer();
    const describe_ = async (name: string) => (await tools.get("describe_skill")!({ name })).content[0]!.text;

    expect(await describe_("ledger-reconciler")).toContain("Reconcile invoices.");

    addSkill("ledger-reconciler", "Reconciles invoices against the ledger", "Reconcile invoices, then post the journal.");

    expect(await describe_("ledger-reconciler")).toContain("post the journal");
  });
});
