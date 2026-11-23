import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statePaths } from "@charrette/shared";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { lockPathFor, runLockHolder } from "./runLock.js";
import { Store } from "./store.js";

/**
 * `charrette resume` asks about the lock before it starts a dashboard. In run
 * 614e06d5 a refused resume found out only after it had overwritten and cleared
 * the live run's dashboard record.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function controllerIn(): { controller: RunController; dir: string; state: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-hold-"));
  made.push(dir);
  const state = statePaths(dir).dir;
  mkdirSync(state, { recursive: true });
  const store = new Store(":memory:");
  const gates: GateHandler = {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
  };
  return { controller: new RunController(store, new Bus(store), {} as AgentPool, new GitHubAdapter(undefined, undefined), gates, dir), dir, state };
}

/** A lock held by pid 1: always alive, never this process. */
function heldByAnother(state: string, runId: string): void {
  const file = lockPathFor(state, runId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: 1, runId, startedAt: Date.now(), heartbeatAt: Date.now(), host: "here" }));
}

describe("asking about a run's lock", () => {
  it("says nothing when nobody holds it, and takes nothing", () => {
    const { controller, state } = controllerIn();
    expect(() => controller.assertNotHeld("r1")).not.toThrow();
    expect(runLockHolder(state, "r1")).toBeNull();
  });

  it("refuses when another live process holds it, and leaves its lock alone", () => {
    const { controller, state } = controllerIn();
    heldByAnother(state, "r1");

    expect(() => controller.assertNotHeld("r1")).toThrow(/already being driven by charrette pid 1/);
    expect(runLockHolder(state, "r1")?.pid).toBe(1);
  });

  it("does not refuse this process its own lock", () => {
    const { controller } = controllerIn();
    const release = controller.holdRun("r1");

    expect(() => controller.assertNotHeld("r1")).not.toThrow();
    release();
  });
});

describe("holding a run ahead of resuming it", () => {
  it("takes the lock, and gives it back", () => {
    const { controller, state } = controllerIn();

    const release = controller.holdRun("r1");
    expect(runLockHolder(state, "r1")?.pid).toBe(process.pid);

    release();
    expect(runLockHolder(state, "r1")).toBeNull();
  });

  it("is re-entrant: an inner hold does not free the outer one", () => {
    const { controller, state } = controllerIn();
    const outer = controller.holdRun("r1");

    controller.holdRun("r1")();

    expect(runLockHolder(state, "r1")?.pid).toBe(process.pid);
    outer();
  });

  it("is refused when another process got there first", () => {
    const { controller, state } = controllerIn();
    heldByAnother(state, "r1");

    expect(() => controller.holdRun("r1")).toThrow(/already being driven/);
  });
});
