import { describe, expect, it } from "vitest";
import { PORTS_PER_TASK, PORT_RANGE_START, PORT_SLOTS, isolationBlock, isolationEnv, taskIsolation } from "./isolation.js";

describe("per-task isolation", () => {
  it("hands a task the same block every time, so a resume reuses its own containers", () => {
    expect(taskIsolation("run-1", "settlement-hold-engine")).toEqual(taskIsolation("run-1", "settlement-hold-engine"));
  });

  it("gives different tasks different compose projects", () => {
    const a = taskIsolation("run-1", "returns-and-disputes");
    const b = taskIsolation("run-1", "settlement-hold-engine");
    // The compose project is the guarantee that never collides: it is what stops
    // one agent's `compose restart` acting on another task's containers, which is
    // what tore the shared database out from under the run.
    expect(a.composeProject).not.toBe(b.composeProject);
  });

  it("separates the same task id across two runs", () => {
    expect(taskIsolation("run-1", "api").composeProject).not.toBe(taskIsolation("run-2", "api").composeProject);
  });

  it("keeps every block clear of the ephemeral range and of well-known ports", () => {
    for (const id of ["a", "b", "web-dashboard", "rail-routing-optimizer", "x".repeat(80)]) {
      const iso = taskIsolation("run-1", id);
      expect(iso.portBase).toBeGreaterThanOrEqual(PORT_RANGE_START);
      // 49152 is the macOS ephemeral floor: a fixed allocation above it collides
      // with whatever the OS hands out next, which is the bug, not the fix.
      expect(iso.portEnd).toBeLessThan(49152);
      expect(iso.portEnd - iso.portBase).toBe(PORTS_PER_TASK - 1);
      expect(iso.portBase % PORTS_PER_TASK).toBe(PORT_RANGE_START % PORTS_PER_TASK);
    }
  });

  it("keeps blocks aligned so two tasks either share a block or never overlap", () => {
    const bases = new Set<number>();
    for (let i = 0; i < 200; i++) bases.add(taskIsolation("run-1", `task-${i}`).portBase);
    // Blocks are slot-aligned, so distinct bases are disjoint by construction.
    expect(bases.size).toBeGreaterThan(150);
    expect([...bases].every((b) => (b - PORT_RANGE_START) % PORTS_PER_TASK === 0)).toBe(true);
    expect([...bases].every((b) => b < PORT_RANGE_START + PORT_SLOTS * PORTS_PER_TASK)).toBe(true);
  });

  it("produces a compose project name compose will accept", () => {
    const iso = taskIsolation("run-1", "Weird Task/Name!!");
    expect(iso.composeProject).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });

  it("carries the block into the session environment", () => {
    const iso = taskIsolation("run-1", "api");
    expect(isolationEnv(iso)).toEqual({
      COMPOSE_PROJECT_NAME: iso.composeProject,
      HARNESS_PORT_BASE: String(iso.portBase),
      HARNESS_PORT_END: String(iso.portEnd),
    });
  });

  it("tells the agent its ports, its project, and what not to touch", () => {
    const iso = taskIsolation("run-1", "api");
    const block = isolationBlock(iso);
    expect(block).toContain(`${iso.portBase}-${iso.portEnd}`);
    expect(block).toContain(iso.composeProject);
    expect(block).toMatch(/never run `stop`, `down`, `restart` or `rm` against a container you did not start/);
  });
});
