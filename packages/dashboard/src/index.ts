import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { Bus, GateHandler, Store } from "@harness/core";
import { PAGE_HTML } from "./page.js";

export interface DashboardOptions {
  port?: number;
}

/**
 * The repo the issue/PR numbers belong to, so the UI can link straight to them.
 * Env wins over config, matching how GitHubAdapter is constructed by the CLI.
 * Returns null unless it really looks like `owner/repo` — a half-set value should
 * produce no link rather than a broken one.
 */
function githubSlug(configured: string | undefined): string | null {
  const slug = process.env.HARNESS_GITHUB_REPO ?? configured;
  return slug && /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : null;
}

/**
 * Localhost dashboard backend (PRD §11.1, SEC-10..13):
 * - binds 127.0.0.1 only
 * - per-run 128-bit bearer token, header-only (SSE consumed via fetch-stream, not EventSource)
 * - state-changing endpoints are POST with Origin/Host validation
 * - SSE cursor = event seq; reconnect replays from the events table
 */
export class Dashboard implements GateHandler {
  readonly token = randomBytes(16).toString("hex");
  private app = Fastify();
  private pendingPlanGate: ((r: { approved: boolean; feedback: string }) => void) | null = null;
  private planPayload: { prd: string; summary: string } | null = null;

  constructor(private store: Store, private bus: Bus, private opts: DashboardOptions = {}) {}

  private authed(req: { headers: Record<string, unknown> }): boolean {
    return req.headers["authorization"] === `Bearer ${this.token}`;
  }

  private originOk(req: { headers: Record<string, unknown> }): boolean {
    const host = String(req.headers["host"] ?? "");
    const origin = req.headers["origin"] as string | undefined;
    const hostOk = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    const originOk = origin === undefined || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    return hostOk && originOk;
  }

  async start(): Promise<string> {
    const app = this.app;

    app.get("/", async (_req, reply) => reply.type("text/html").send(PAGE_HTML));

    app.get("/api/state", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      const runs = this.store.listOpenRuns().map((run) => ({
        ...run,
        spentUsd: this.store.spentUsd(run.id),
        tasks: this.store.listTasks(run.id),
        sessions: this.store.listSessions(run.id),
        githubRepo: githubSlug(run.config.githubRepo),
      }));
      return { runs, planGate: this.planPayload };
    });

    app.get("/api/runs/:id/events", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      const runId = (req.params as { id: string }).id;
      const after = Number((req.query as { after?: string }).after ?? 0);
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // replay from cursor, then live-tail (coalescing: flush at most every 100ms)
      for (const { seq, event } of this.store.eventsSince(runId, after, 1000)) {
        reply.raw.write(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      let buffer: string[] = [];
      const flush = setInterval(() => {
        if (buffer.length) {
          reply.raw.write(buffer.join(""));
          buffer = [];
        }
      }, 100);
      const unsubscribe = this.bus.subscribe(({ seq, event }) => {
        if (event.runId !== runId) return;
        if (buffer.length < 500) buffer.push(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      req.raw.on("close", () => {
        clearInterval(flush);
        unsubscribe();
      });
      return reply;
    });

    app.post("/api/gates/plan", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      if (!this.originOk(req)) return reply.code(403).send();
      const body = req.body as { approved: boolean; feedback?: string };
      if (!this.pendingPlanGate) return reply.code(409).send({ error: "no open plan gate" });
      const resolve = this.pendingPlanGate;
      this.pendingPlanGate = null;
      this.planPayload = null;
      resolve({ approved: Boolean(body.approved), feedback: body.feedback ?? "" });
      return { ok: true };
    });

    const port = this.opts.port ?? 4777;
    await app.listen({ port, host: "127.0.0.1" });
    return `http://127.0.0.1:${port}/#${this.token}`;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  /** GateHandler: expose the plan to the UI and block until the operator resolves it. */
  resolvePlanGate(prdMarkdown: string, planSummary: string): Promise<{ approved: boolean; feedback: string }> {
    this.planPayload = { prd: prdMarkdown, summary: planSummary };
    return new Promise((resolve) => {
      this.pendingPlanGate = resolve;
    });
  }
}
