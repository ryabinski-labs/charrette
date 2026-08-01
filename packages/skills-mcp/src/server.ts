#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { indexSkills, matchSkills } from "./indexer.js";

const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [path.join(os.homedir(), ".claude", "skills"), path.join(os.homedir(), "skills")];

const server = new McpServer({ name: "harness-skills-discovery", version: "0.0.1" });

server.tool(
  "search_skills",
  "Match local SKILL.md playbooks to a task description. Returns ranked skills with provenance hashes.",
  { taskDescription: z.string(), k: z.number().int().min(1).max(10).default(3) },
  async ({ taskDescription, k }) => {
    const matches = matchSkills(indexSkills(dirs), taskDescription, k);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            matches.map((m) => ({
              name: m.skill.name,
              path: m.skill.path,
              sha256: m.skill.sha256,
              description: m.skill.description,
              score: Number(m.score.toFixed(3)),
            })),
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "describe_skill",
  "Return the full content of one indexed skill by name.",
  { name: z.string() },
  async ({ name }) => {
    const skill = indexSkills(dirs).find((s) => s.name === name);
    return {
      content: [{ type: "text" as const, text: skill ? skill.body : `unknown skill: ${name}` }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
