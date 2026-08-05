import { describe, expect, it } from "vitest";
import {
  DOWN_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  PORTS_PER_TASK,
  PORT_RANGE_START,
  PORT_SLOTS,
  composeDown,
  composeProjectNames,
  isolationBlock,
  isolationEnv,
  taskIsolation,
} from "./isolation.js";

/**
 * Measured while this was being written: `podman compose ls` on the machine
 * that ran agentdraft's da8325bd still listed `harness-pitstop-9-117d` and
 * `harness-usage-endpoint-grace-field-117d` running, hours after the run
 * finished — plus a third stack from a different repository's run. Agents are
 * told to tear down what they start; the ones that die, run out of turns, or
 * are killed by the budget gate never get to.
 */
describe("giving the machine back", () => {
  /** A fake runtime: `installed` says which CLIs exist, `up` what each reports running. */
  const runtime = (installed: string[], up: string[] = []) => {
    const calls: string[][] = [];
    const waits: number[] = [];
    const exec = async (bin: string, args: string[], timeoutMs: number) => {
      calls.push([bin, ...args]);
      waits.push(timeoutMs);
      if (!installed.includes(bin)) throw new Error(`${bin}: command not found`);
      if (args[1] === "ls") {
        return ["NAME                STATUS       CONFIG FILES", ...up.map((p) => `${p}   running(2)   /somewhere/compose.yml`)].join("\n");
      }
      return "";
    };
    return { calls, waits, exec };
  };

  it("brings down the stacks that are up, with their volumes, so nothing is inherited", async () => {
    const { calls, exec } = runtime(["podman"], ["harness-a-0001", "harness-b-0001"]);

    expect(await composeDown(["harness-a-0001", "harness-b-0001"], exec)).toEqual(["podman:harness-a-0001", "podman:harness-b-0001"]);
    // Both runtimes are asked what is up — a machine can have either, or both
    // holding different stacks — but only what is actually running comes down.
    expect(calls.filter((c) => c.includes("down"))).toEqual([
      ["podman", "compose", "-p", "harness-a-0001", "down", "-v", "--remove-orphans"],
      ["podman", "compose", "-p", "harness-b-0001", "down", "-v", "--remove-orphans"],
    ]);
  });

  /**
   * The reason this lists before it tears down. `compose down` on a project
   * that was never up succeeds exactly like one that was, so issuing a
   * teardown per task would report thirty stacks swept on a run that started
   * none — and would spend thirty subprocesses saying nothing.
   */
  it("issues no teardown at all when none of this run's stacks are up", async () => {
    const { calls, exec } = runtime(["podman", "docker"], ["somebody-elses-stack"]);

    expect(await composeDown(["harness-a-0001", "harness-b-0001"], exec)).toEqual([]);
    expect(calls.every((c) => c[2] === "ls")).toBe(true);
  });

  it("never touches a stack this run does not own", async () => {
    const mine = taskIsolation("run1", "task-a").composeProject;
    const { calls, exec } = runtime(["podman"], [mine, "harness-someone-else-9999", "operators-own-db"]);

    expect(await composeDown([mine], exec)).toEqual([`podman:${mine}`]);
    const downed = calls.filter((c) => c.includes("down")).map((c) => c[3]);
    expect(downed).toEqual([mine]);
  });

  it("falls through to the runtime that is actually installed", async () => {
    const { calls, exec } = runtime(["docker"], ["harness-a-0001"]);

    expect(await composeDown(["harness-a-0001"], exec)).toEqual(["docker:harness-a-0001"]);
    expect(calls.map((c) => c[0])).toEqual(["podman", "docker", "docker"]);
  });

  /**
   * A machine with no container runtime at all is the common case, and a run on
   * one must not notice this exists.
   */
  it("says nothing and throws nothing when no runtime is installed", async () => {
    const { calls, exec } = runtime([]);

    await expect(composeDown(["harness-a-0001"], exec)).resolves.toEqual([]);
    expect(calls.every((c) => c[2] === "ls")).toBe(true);
  });

  /**
   * Found by running this: a podman machine that is installed but whose socket
   * is unreachable does not fail fast — it retried an ssh handshake for two
   * minutes and fourteen seconds before answering. The sweep runs at every pit
   * stop and asks two runtimes, so a laptop with a wedged VM was spending five
   * minutes of a run discovering there was nothing to sweep.
   */
  it("waits a moment on the question and a long time on the teardown", async () => {
    const { calls, waits, exec } = runtime(["podman"], ["harness-a-0001"]);

    await composeDown(["harness-a-0001"], exec);

    const byCall = calls.map((c, i) => [c[0], c[2], waits[i]]);
    expect(byCall).toEqual([
      ["podman", "ls", LIST_TIMEOUT_MS],
      ["podman", "-p", DOWN_TIMEOUT_MS],
      // The second runtime is asked the same question, and is the reason the
      // wait is paid twice on a machine where neither can answer.
      ["docker", "ls", LIST_TIMEOUT_MS],
    ]);
    expect(LIST_TIMEOUT_MS).toBeLessThan(DOWN_TIMEOUT_MS);
  });

  it("asks nothing when there are no projects to sweep", async () => {
    const { calls, exec } = runtime(["podman"], ["harness-a-0001"]);

    expect(await composeDown([], exec)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("reads project names out of a real listing, header and all", () => {
    const listing = [
      "NAME                                    STATUS       CONFIG FILES",
      "harness-pitstop-9-117d                  running(3)   /a/docker-compose.yml,/b/compose.override.yml",
      "harness-seed-and-demo-script-f735       running(3)   /c/docker-compose.yml",
      // Blank and whitespace-only lines are what the runtime actually prints
      // around the table, and neither of them names a project.
      "   ",
      "",
    ].join("\n");

    expect(composeProjectNames(listing)).toEqual(["harness-pitstop-9-117d", "harness-seed-and-demo-script-f735"]);
  });
});

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
