/**
 * A worktree per task isolates the filesystem and git, and nothing else. The
 * host network and the container daemon stay shared, so concurrent tasks fight
 * over both.
 *
 * Measured in run 40da9337: all 30 worktrees shipped the same compose file
 * binding host port 8000 for DynamoDB Local, so only one container could ever
 * hold it — and because every worktree also used the same default compose
 * project name (derived from the directory), an agent running `compose up` or
 * `compose restart` was operating on *another task's* container. One did,
 * 41 minutes in, tearing the shared database out from under every in-flight
 * test run. A second task then spent three iterations and its budget debugging
 * a failure its neighbour had caused.
 *
 * This gives each task a compose project of its own and a block of host ports of
 * its own, in the session environment, so the isolation is available to an agent
 * that never thinks about it (compose reads COMPOSE_PROJECT_NAME on its own) and
 * legible to one that does (the port block is stated in the prompt).
 */

/** Ports per task: enough for a database, a cache, an app server and room to spare. */
export const PORTS_PER_TASK = 16;

/**
 * Where the blocks start. Above the well-known and common-service range (8080,
 * 5432, 6379, 8000) and a long way below the macOS ephemeral floor of 49152 —
 * the suite in 40da9337 was already colliding with Podman's SSH listener on
 * 58183, and a fixed allocation inside the ephemeral range would only move the
 * collision around.
 */
export const PORT_RANGE_START = 20000;

/** 512 blocks of 16: 20000–28191, none of it ephemeral. */
export const PORT_SLOTS = 512;

/** FNV-1a, for a stable slot that survives a resume without a table to persist. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Compose project names accept lowercase alphanumerics, dashes and underscores. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

export interface TaskIsolation {
  /** `docker compose` / `podman compose` project, so no agent can restart another's stack. */
  composeProject: string;
  /** First host port this task owns. */
  portBase: number;
  /** Last host port this task owns, inclusive. */
  portEnd: number;
}

/**
 * The ports and compose project a task owns.
 *
 * Derived from the ids rather than allocated from a table, so a resumed run
 * hands a task back the same block it had before — a container left behind by
 * the previous process is then the same task's to reuse or replace, not a
 * stranger's. Two tasks in one run can in principle hash to the same slot; with
 * 512 slots against the handful of workers running at once that is rare, and it
 * is bounded by the compose project, which never collides.
 */
export function taskIsolation(runId: string, taskId: string): TaskIsolation {
  const portBase = PORT_RANGE_START + (hash(`${runId}/${taskId}`) % PORT_SLOTS) * PORTS_PER_TASK;
  return {
    composeProject: `harness-${slug(taskId)}-${(hash(runId) % 0xffff).toString(16).padStart(4, "0")}`,
    portBase,
    portEnd: portBase + PORTS_PER_TASK - 1,
  };
}

/** The session environment that carries the isolation into every command an agent runs. */
export function isolationEnv(iso: TaskIsolation): Record<string, string> {
  return {
    COMPOSE_PROJECT_NAME: iso.composeProject,
    HARNESS_PORT_BASE: String(iso.portBase),
    HARNESS_PORT_END: String(iso.portEnd),
  };
}

/**
 * Bring down the container stacks a set of tasks own.
 *
 * Agents are told to tear down what they start, and mostly they do not: a
 * session that ends at its turn ceiling, dies mid-thought, or is killed by the
 * budget gate never reaches its own cleanup, and the stack it started keeps its
 * ports, its volumes and its share of the machine for the rest of the run. Over
 * thirty tasks that is thirty databases nobody is using, and the run gets
 * slower the longer it goes.
 *
 * Only this run's own projects are ever touched: the caller supplies the names,
 * derived from this run's task ids, and anything the runtime reports that is
 * not in that set is left exactly as it is. A stack belonging to the operator,
 * to another run, or to a task still in flight is not reachable from here.
 *
 * `-v` goes with it deliberately. The volume is the database a finished task
 * seeded; keeping it is how the next task inherits state it never created, and
 * that is the failure isolation exists to prevent.
 */
export async function composeDown(
  projects: string[],
  exec: (bin: string, args: string[]) => Promise<string>,
  clis: string[] = ["podman", "docker"]
): Promise<string[]> {
  const mine = new Set(projects);
  if (!mine.size) return [];
  const brought: string[] = [];
  for (const cli of clis) {
    // Ask what is running before tearing anything down. One cheap call decides
    // the whole sweep: a machine with no runtime fails it and is done, and a
    // run whose tasks never started a container issues no teardowns at all
    // rather than one no-op per task. It is also the only way to report what
    // actually came down — `compose down` on a project that was never up
    // succeeds exactly like one that was.
    const listed = await exec(cli, ["compose", "ls"]).catch(() => null);
    if (listed === null) continue;
    for (const project of composeProjectNames(listed)) {
      if (!mine.has(project) || brought.some((b) => b.endsWith(`:${project}`))) continue;
      const ok = await exec(cli, ["compose", "-p", project, "down", "-v", "--remove-orphans"]).then(
        () => true,
        () => false
      );
      if (ok) brought.push(`${cli}:${project}`);
    }
  }
  return brought;
}

/** The project names in `compose ls` output — the first column, minus the header. */
export function composeProjectNames(listing: string): string[] {
  return listing
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((name) => name && name !== "NAME");
}

/** What the agent is told about the block, in the prompt. Empty when there is no task. */
export function isolationBlock(iso: TaskIsolation): string {
  return [
    "## Ports and shared services",
    "",
    `Other tasks are running against this same machine at the same time. Host ports ${iso.portBase}-${iso.portEnd} are yours; every other port on this machine belongs to somebody else.`,
    "",
    `- Bind every service you start to a port in that range. If a compose file, config or test fixture hardcodes a port outside it, change it to one inside it — a hardcoded shared port is the defect, not the workaround.`,
    `- \`COMPOSE_PROJECT_NAME\` is already set to \`${iso.composeProject}\` in your environment, so \`docker compose\` / \`podman compose\` acts on your own stack. Never pass \`-p\`/\`--project-name\`, and never run \`stop\`, \`down\`, \`restart\` or \`rm\` against a container you did not start: containers with other names belong to tasks running right now, and stopping one destroys their work as well as yours.`,
    `- Tests that bind a port should ask for port 0 and read back what the OS gave them. That never collides with anything.`,
  ].join("\n");
}
