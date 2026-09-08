import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { Bus, BudgetGate, GateHandler, IntakeBridge, IntentPosture, PitStop, PitStopDecision, Store, SubscriptionChoice, SubscriptionGate, TaskGate, intentPosture, originSlug } from "@harness/core";
import { PAGE_HTML } from "./page.js";

export interface DashboardOptions {
  /** Bind exactly this port. Omitted, the dashboard takes the first free one. */
  port?: number;
  /**
   * Show finished runs too.
   *
   * A dashboard attached to a run drives itself from the open ones, so a run
   * that ends leaves the page — correct there, because the page is a view of
   * work in flight. `harness dashboard` is the opposite case: nothing is
   * executing and the finished run *is* the subject, so excluding it serves an
   * empty page for the one thing the operator opened it to read.
   */
  includeFinished?: boolean;
  /**
   * Try this port first, then fall back to the usual scan.
   *
   * The difference from `port` is who asked. `port` is the operator naming one,
   * so a busy port is an error — moving them silently would point them at some
   * other run's dashboard. This one is the harness recognising the port the
   * *previous* process served this same run on, which is a preference and
   * nothing more: something else holding it is a reason to take the next free
   * one, never a reason to refuse to resume a run.
   */
  preferPort?: number;
  /**
   * Serve on a token the operator already has, rather than a fresh one.
   *
   * Only `resume` passes this, and only from the link it recorded when the run
   * started: the point is that a run picked up after a pause is reachable at
   * the URL already open in the operator's browser. A token read back from
   * `.harness/dashboard.json` — 0600, gitignored — is no weaker than the one
   * that wrote it, because it *is* the one that wrote it.
   */
  token?: string;
}

/**
 * The controller-side receiver for mid-flight operator actions
 * (RunController.sendFeedback / RunController.raiseBudget).
 */
export interface FeedbackSink {
  sendFeedback(runId: string, taskId: string, text: string): "live" | "queued" | "revived";
  raiseBudget(runId: string, capUsd: number): string;
  requestPitStop(runId: string, question: string): string;
  pauseRun(runId: string): string;
  cancelPitStop(runId: string): string;
  rerouteModel(runId: string, role: string, model: string): string;
}

const DEFAULT_PORT = 4777;
/** How far above the default to look for a free port before giving up. */
const PORT_SCAN = 32;

/**
 * Runs that will never move again on their own. The CLI stops the dashboard as
 * soon as one of these lands, so the event announcing it is the last thing the
 * browser can ever be told — it is flushed immediately rather than on the timer.
 */
const TERMINAL_RUN_STATES = new Set(["PR_REVIEW", "BLOCKED", "FAILED", "ABORTED"]);

/**
 * The repo the issue/PR numbers belong to, so the UI can link straight to them.
 * Env wins over config, matching how GitHubAdapter is constructed by the CLI.
 * Returns null unless it really looks like `owner/repo` — a half-set value should
 * produce no link rather than a broken one.
 *
 * The `origin` remote is the last resort. A run whose config predates the persisted
 * slug still files issues, and its chips were rendering as dead plain text.
 */
async function githubSlug(configured: string | undefined, repoPath: string): Promise<string | null> {
  const slug = process.env.HARNESS_GITHUB_REPO ?? configured;
  if (slug && /^[\w.-]+\/[\w.-]+$/.test(slug)) return slug;
  // Cached because /api/state is polled every five seconds and a remote does not
  // change under a running harness — without this it is a subprocess per poll.
  const key = `${configured ?? ""}\u0000${repoPath}`;
  if (!slugCache.has(key)) slugCache.set(key, await originSlug(repoPath));
  return slugCache.get(key)!;
}
const slugCache = new Map<string, string | null>();

/**
 * Localhost dashboard backend (PRD §11.1, SEC-10..13):
 * - binds 127.0.0.1 only
 * - per-run 128-bit bearer token, header-only (SSE consumed via fetch-stream, not EventSource)
 * - state-changing endpoints are POST with Origin/Host validation
 * - SSE cursor = event seq; reconnect replays from the events table
 */
export class Dashboard implements GateHandler {
  /**
   * Random per process, unless the caller hands one back.
   *
   * A resumed run used to mint a fresh token and therefore a fresh URL, which
   * quietly broke the one thing an operator is holding: the tab they already
   * had open. The fragment *is* the credential, so a new one does not merely
   * relocate the page — it 401s the old one. `harness resume` passes back the
   * token it recorded, so pausing and picking up again lands in the same tab.
   */
  readonly token: string;
  private app = Fastify();
  private pendingPlanGate: ((r: { approved: boolean; feedback: string }) => void) | null = null;
  private planPayload: { prd: string; summary: string } | null = null;
  private pendingBudgetGate: ((capUsd: number | null) => void) | null = null;
  private budgetPayload: (BudgetGate & { suggestedUsd: number }) | null = null;
  /**
   * The open subscription gate. One slot, like the budget one: the controller
   * serialises these, so however many sessions meet the weekly limit at once,
   * exactly one question reaches the operator.
   */
  private pendingSubscriptionGate: ((choice: SubscriptionChoice) => void) | null = null;
  private subscriptionPayload: SubscriptionGate | null = null;
  /**
   * Task-escalation gates, keyed by `runId/taskId`. A Map rather than a single
   * slot: with parallel workers, two tasks can hit their caps at once, and the
   * second must not silently overwrite the first's waiting promise.
   */
  private taskGates = new Map<string, { payload: TaskGate; resolve: (guidance: string | null) => void }>();
  /**
   * The open pit stop. One slot rather than a map: a pit stop only ever opens
   * with the tree settled and nothing else in flight, so there cannot be two.
   */
  private pendingPitStop: ((d: PitStopDecision) => void) | null = null;
  private pitStopPayload: PitStop | null = null;

  /** Set by the CLI once the controller exists (it is constructed after the dashboard). */
  private feedbackSink: FeedbackSink | null = null;

  /**
   * The run's intake transport, when it has one that can be answered from here.
   *
   * Null for a run started with `--no-chat`, which holds no conversation at all
   * — and the route says so rather than reporting no open question, because
   * "nothing is being asked" and "nothing here can be asked" send a caller to
   * two different places.
   */
  private intake: IntakeBridge | null = null;

  constructor(private store: Store, private bus: Bus, private opts: DashboardOptions = {}) {
    this.token = opts.token ?? randomBytes(16).toString("hex");
  }

  /** Wire the controller in so "Send feedback" has somewhere to go. */
  attach(sink: FeedbackSink): void {
    this.feedbackSink = sink;
  }

  /** Wire the intake conversation in, so its open question can be answered from here. */
  attachIntake(intake: IntakeBridge): void {
    this.intake = intake;
  }

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

    // An action that takes no body still gets posted with a JSON content type,
    // because that is what every other call on this page sends and the header is
    // copied along with the fetch. Fastify's own parser answers that with a 400
    // before the route is ever reached, which is how the Pause button shipped
    // doing nothing at all in QA: no error in the console, no event on the run.
    // Every route here validates its own fields and has its own sentence to say
    // about what is missing, so an empty body is `{}` and the route answers.
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      const text = String(body).trim();
      if (!text) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (e) {
        // Fastify's own parser marks a malformed body 400; an error without a
        // status is a 500, which would blame the server for the caller's typo.
        done(Object.assign(e as Error, { statusCode: 400 }), undefined);
      }
    });

    app.get("/", async (_req, reply) => reply.type("text/html").send(PAGE_HTML));

    app.get("/api/state", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      const runs = await Promise.all(
        (this.opts.includeFinished ? this.store.listRuns() : this.store.listOpenRuns()).map(async (run) => ({
          ...run,
          spentUsd: this.store.spentUsd(run.id),
          // A parked task's reason is on the row for runs started after it was
          // written there, and only in the transition event for every run before
          // that — so the card falls back to the event rather than showing a red
          // NEEDS_HUMAN pill with nothing under it.
          tasks: this.store.listTasks(run.id).map((t) =>
            t.state === "NEEDS_HUMAN" && !t.errorSummary
              ? { ...t, errorSummary: this.store.taskStateReason(run.id, t.id) || null }
              : t
          ),
          sessions: this.store.listSessions(run.id),
          // How far this run is from what it was asked to build. Computed here
          // rather than in the page because the page's script is a string and
          // nothing typechecks it — see intentPosture.ts.
          intent: this.intentFor(run.id, run.config.intentFixRounds),
          // A pit stop the operator asked for that has not opened yet. Null on
          // every other run and at every other moment — the page shows the
          // waiting state, and the free cancel, only while there is something
          // to cancel.
          pitStopRequest: this.store.pendingPitStopRequest(run.id),
          githubRepo: await githubSlug(run.config.githubRepo, run.repoPath),
        }))
      );
      return {
        runs,
        planGate: this.planPayload,
        budgetGate: this.budgetPayload,
        subscriptionGate: this.subscriptionPayload,
        taskGates: [...this.taskGates.values()].map((g) => g.payload),
        pitStop: this.pitStopPayload,
        // The intake question waiting right now. Polled like every other gate,
        // because to anything watching this run that is exactly what it is: the
        // run is stopped until somebody answers.
        intake: this.intake?.pending() ?? null,
      };
    });

    app.get("/api/runs/:id/events", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      const runId = (req.params as { id: string }).id;
      // A cursor that is not a number would otherwise be NaN, and every
      // `seq > NaN` comparison is false — the reconnect would silently replay
      // nothing and the operator would see a feed that starts mid-run.
      const requestedAfter = Number((req.query as { after?: string }).after ?? 0);
      let after = Number.isSafeInteger(requestedAfter) && requestedAfter >= 0 ? requestedAfter : 0;
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // SQLite is the queue: keep a cursor instead of dropping bursts above an
      // in-memory limit. Replay every page and respect socket backpressure so
      // a slow browser neither loses events nor buffers the entire run in RAM.
      let pending = true;
      let blocked = false;
      const flushNow = () => {
        if (blocked || !pending) return;
        for (;;) {
          const batch = this.store.eventsSince(runId, after, 500);
          for (const { seq, event } of batch) {
            after = seq;
            if (!reply.raw.write(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`)) {
              blocked = true;
              return;
            }
          }
          if (batch.length < 500) {
            pending = false;
            return;
          }
        }
      };
      const drain = () => { blocked = false; flushNow(); };
      reply.raw.on("drain", drain);
      const flush = setInterval(flushNow, 100);
      const unsubscribe = this.bus.subscribe(({ event }) => {
        if (event.runId !== runId) return;
        pending = true;
        // The run ending is the one event the operator most needs and the one most
        // likely to be lost: the CLI tears the dashboard down within milliseconds of
        // it, well inside the coalescing window. Push it out synchronously.
        if (event.type === "run.state_changed" && TERMINAL_RUN_STATES.has(event.to)) flushNow();
      });
      req.raw.on("close", () => {
        clearInterval(flush);
        reply.raw.off("drain", drain);
        unsubscribe();
      });
      flushNow();
      return reply;
    });

    app.post("/api/gates/plan", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      if (!this.originOk(req)) return reply.code(403).send();
      if (!this.pendingPlanGate) return reply.code(409).send({ error: "no open plan gate" });
      const body = req.body as { approved?: unknown; feedback?: unknown } | null;
      if (typeof body?.approved !== "boolean" || (body.feedback !== undefined && typeof body.feedback !== "string")) {
        return reply.code(400).send({ error: "approved must be a boolean and feedback must be text" });
      }
      const resolve = this.pendingPlanGate;
      this.pendingPlanGate = null;
      this.planPayload = null;
      resolve({ approved: body.approved, feedback: (body.feedback as string | undefined) ?? "" });
      return { ok: true };
    });

    app.post("/api/gates/budget", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      if (!this.originOk(req)) return reply.code(403).send();
      if (!this.pendingBudgetGate || !this.budgetPayload) return reply.code(409).send({ error: "no open budget gate" });
      const body = req.body as { capUsd?: number; stop?: boolean };
      const spent = this.budgetPayload.spentUsd;
      const cap = Number(body.capUsd);
      // A cap at or below what is already spent trips again immediately, so it is
      // rejected here rather than being silently turned into a stop.
      if (!body.stop && !(Number.isFinite(cap) && cap > spent)) {
        return reply.code(400).send({ error: `capUsd must be above the $${spent.toFixed(2)} already spent` });
      }
      const resolve = this.pendingBudgetGate;
      this.pendingBudgetGate = null;
      this.budgetPayload = null;
      resolve(body.stop ? null : cap);
      return { ok: true };
    });

    app.post("/api/gates/subscription", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      if (!this.originOk(req)) return reply.code(403).send();
      if (!this.pendingSubscriptionGate || !this.subscriptionPayload) return reply.code(409).send({ error: "no open subscription gate" });
      const body = req.body as { action?: string; account?: string };
      // An account the run was never told about cannot be switched to: the
      // credentials come from the config, so a name from anywhere else would
      // resolve to nothing and the run would carry on as the exhausted account.
      if (body.action === "switch" && !this.subscriptionPayload.alternatives.includes(String(body.account))) {
        return reply.code(400).send({ error: `unknown subscription account "${body.account ?? ""}"` });
      }
      if (!["switch", "continue", "park"].includes(String(body.action))) {
        return reply.code(400).send({ error: "action must be switch, continue or park" });
      }
      const choice: SubscriptionChoice =
        body.action === "switch" ? { action: "switch", account: String(body.account) } : body.action === "continue" ? { action: "continue" } : { action: "park" };
      const resolve = this.pendingSubscriptionGate;
      this.pendingSubscriptionGate = null;
      this.subscriptionPayload = null;
      resolve(choice);
      return { ok: true };
    });

    // Moving the cap before it is ever reached, not answering a gate that
    // already opened — the header's live-edit control, at any point in the run.
    app.post("/api/runs/:id/budget", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      if (!this.originOk(req)) return reply.code(403).send();
      if (!this.feedbackSink) return reply.code(503).send({ error: "not wired up in this mode" });
      const runId = (req.params as { id: string }).id;
      const capUsd = Number((req.body as { capUsd?: number }).capUsd);
      if (!Number.isFinite(capUsd) || capUsd <= 0) return reply.code(400).send({ error: "capUsd must be a positive number" });
      const message = this.feedbackSink.raiseBudget(runId, capUsd);
      if (!message.startsWith("cap raised")) return reply.code(400).send({ error: message });
      // A gate already open on this run is the same decision asked twice — a
      // proactive raise from the header answers it too, rather than leaving the
      // paused agent waiting on a prompt the operator has already answered.
      if (this.pendingBudgetGate && this.budgetPayload && capUsd > this.budgetPayload.spentUsd) {
        const resolve = this.pendingBudgetGate;
        this.pendingBudgetGate = null;
        this.budgetPayload = null;
        resolve(capUsd);
      }
      return { ok: true, message };
    });

    // Ask for a pit stop, or call off one that has not opened yet. Both are the
    // same resource because they are the same decision seen twice, and the
    // second one has to be reachable from the moment the first is made — a
    // request the operator cannot cancel is one they will hesitate to make.
    app.post("/api/runs/:id/pitstop", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      if (!this.originOk(req)) return reply.code(403).send();
      if (!this.feedbackSink) return reply.code(503).send({ error: "not wired up in this mode" });
      const runId = (req.params as { id: string }).id;
      const body = req.body as { question?: string; cancel?: boolean };
      if (body.cancel) {
        const message = this.feedbackSink.cancelPitStop(runId);
        if (!message.startsWith("pit stop cancelled")) return reply.code(409).send({ error: message });
        return { ok: true, message };
      }
      const question = (body.question ?? "").trim();
      // A pit stop costs a demo and every reviewer lens. An empty box is a
      // misclick, and spending that on "have a look" is the one way this
      // feature wastes real money.
      if (!question) return reply.code(400).send({ error: "write the question the pit stop should answer" });
      const message = this.feedbackSink.requestPitStop(runId, question);
      if (!message.startsWith("pit stop requested") && !message.startsWith("your question replaced")) {
        return reply.code(409).send({ error: message });
      }
      return { ok: true, message };
    });

    // Stop the run and leave it resumable — the button an operator reaches for
    // when they are closing the laptop. No body: there is nothing to say about
    // a pause, and anything this endpoint asked for would be a question standing
    // between someone and the door.
    app.post("/api/runs/:id/pause", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      if (!this.originOk(req)) return reply.code(403).send();
      if (!this.feedbackSink) return reply.code(503).send({ error: "not wired up in this mode" });
      const message = this.feedbackSink.pauseRun((req.params as { id: string }).id);
      // The controller's two success sentences; everything else it can return
      // is a refusal (no such run, or a run that is not working any more).
      if (!message.startsWith("pausing") && !message.startsWith("already pausing")) {
        return reply.code(409).send({ error: message });
      }
      return { ok: true, message };
    });

    // Re-route one role's model for the rest of the run. The pinned roles are
    // refused by the controller, which re-parses the whole config — this
    // endpoint does not know which they are and must not learn.
    app.post("/api/runs/:id/models", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      if (!this.originOk(req)) return reply.code(403).send();
      if (!this.feedbackSink) return reply.code(503).send({ error: "not wired up in this mode" });
      const runId = (req.params as { id: string }).id;
      const body = req.body as { role?: string; model?: string };
      if (!body.role || !(body.model ?? "").trim()) return reply.code(400).send({ error: "role and model are required" });
      const message = this.feedbackSink.rerouteModel(runId, body.role, body.model!);
      // The controller's only success sentence starts with the role and an
      // arrow; everything else it returns is an operator-facing refusal.
      if (!message.includes(" → ")) return reply.code(400).send({ error: message });
      return { ok: true, message };
    });

    app.post("/api/gates/task", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      if (!this.originOk(req)) return reply.code(403).send();
      const body = req.body as { runId?: string; taskId?: string; guidance?: string; park?: boolean };
      const key = `${body.runId}/${body.taskId}`;
      const gate = this.taskGates.get(key);
      if (!gate) return reply.code(409).send({ error: "no open gate for that task" });
      const guidance = (body.guidance ?? "").trim();
      // An empty answer that is not an explicit park is a misclick, not a decision.
      if (!body.park && !guidance) return reply.code(400).send({ error: "write guidance for the worker, or park the task" });
      this.taskGates.delete(key);
      gate.resolve(body.park ? null : guidance);
      return { ok: true };
    });

    app.post("/api/gates/pitstop", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      if (!this.originOk(req)) return reply.code(403).send();
      if (!this.pendingPitStop) return reply.code(409).send({ error: "no open pit stop" });
      const body = req.body as { action?: string; feedback?: string };
      // No default: a request that names no action is a bug or a misclick, and
      // defaulting it to "continue" would spend the operator's one checkpoint
      // on a click they did not make.
      const action = String(body.action);
      if (!["continue", "redirect", "replan", "stop"].includes(action)) {
        return reply.code(400).send({ error: `unknown pit stop action: ${action}` });
      }
      const feedback = (body.feedback ?? "").trim();
      // Redirecting and re-planning are both "here is what I want instead" —
      // with nothing written, neither means anything, and an empty box submitted
      // by accident would silently spend a planner session on no instruction.
      if ((action === "redirect" || action === "replan") && !feedback) {
        return reply.code(400).send({ error: "write what you want changed, or choose keep going" });
      }
      const resolve = this.pendingPitStop;
      this.pendingPitStop = null;
      this.pitStopPayload = null;
      resolve({ action: action as PitStopDecision["action"], feedback });
      return { ok: true };
    });

    app.post("/api/feedback", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      if (!this.originOk(req)) return reply.code(403).send();
      if (!this.feedbackSink) return reply.code(503).send({ error: "feedback is not wired up in this mode" });
      const body = req.body as { runId?: string; taskId?: string; text?: string };
      if (!body.runId || !body.taskId) return reply.code(400).send({ error: "runId and taskId are required" });
      if (!(body.text ?? "").trim()) return reply.code(400).send({ error: "write something for the agent first" });
      try {
        return { ok: true, delivery: this.feedbackSink.sendFeedback(body.runId, body.taskId, body.text!) };
      } catch (e) {
        // Unknown task, finished task — operator-facing, not a server fault.
        return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    /**
     * Answer the intake conversation's open question.
     *
     * The route the other gates have all had and this one did not. Until it
     * existed, an intake question could only be answered by typing into the
     * process's own TTY — so a watching skill that had read the repository and
     * worked out the right answer could do nothing with it but write the words
     * out for a person to retype.
     *
     * Both `questionId` and `decidedBy` are required, and neither has a
     * default. Optional-with-a-safe-looking-default is the shape the bug this
     * route answers arrived in, and there is no legacy caller to keep working:
     *
     * `questionId` names the asking being answered. The conversation moves on
     * the moment an answer lands, so between reading a question and answering
     * it the run can already be on the next one, and an answer prepared for one
     * question would otherwise be accepted as the answer to another. The id
     * rather than the question text, because text is not an identity — a
     * specification that re-asks after a failed fold puts the identical
     * sentence up again. A stale id is refused with the question that is
     * actually open, so the caller can decide again rather than guess.
     *
     * `decidedBy` is who is answering. Without it every line of the transcript
     * says "operator", which is what made run beb799c5's postmortem unreadable:
     * four of its recorded answers were a tired person clearing a prompt and
     * nothing distinguished them from a considered decision. A caller that will
     * not say who it is does not get to write into that record.
     */
    app.post("/api/intake", async (req, reply) => {
      if (!this.authed(req)) return reply.code(401).send();
      if (!this.originOk(req)) return reply.code(403).send();
      if (!this.intake) return reply.code(503).send({ error: "this run holds no intake conversation" });
      const body = req.body as { answer?: string; decidedBy?: string; questionId?: string };
      const answer = (body.answer ?? "").trim();
      // An empty answer is a misclick. The intake agent treats a blank as an
      // answer and moves on, so letting one through would settle the question
      // with nothing — the exact failure this whole route exists to make rarer.
      if (!answer) return reply.code(400).send({ error: "write an answer for the intake agent" });
      const decidedBy = (body.decidedBy ?? "").trim();
      if (!decidedBy) return reply.code(400).send({ error: "say who is answering — decidedBy is recorded on the run" });
      const questionId = (body.questionId ?? "").trim();
      if (!questionId) return reply.code(400).send({ error: "questionId is required; read it from the open question" });
      const open = this.intake.pending();
      if (!open) return reply.code(409).send({ error: "no open intake question" });
      if (questionId !== open.id) {
        return reply
          .code(409)
          .send({ error: "that question is no longer the one being asked", id: open.id, question: open.question });
      }
      // Asked again rather than inferred from `pending()`: the transport is the
      // authority on whether the question is still open, and this is the call
      // that settles it.
      if (!this.intake.answer(questionId, answer, decidedBy)) {
        return reply.code(409).send({ error: "no open intake question" });
      }
      return { ok: true, question: open.question };
    });

    const port = await this.bind();
    return `http://127.0.0.1:${port}/#${this.token}`;
  }

  /**
   * One harness drives one repo, so several dashboards run at once and a busy
   * port is routine rather than fatal — take the next free one. A port the
   * operator asked for explicitly is honoured exactly: silently moving would
   * point them at a different run's dashboard.
   */
  /**
   * The run's standing against its own assignment, as of right now.
   *
   * Two halves. The completion half reads the milestones the plan was built
   * from and how much of each is merged; the check half reads the newest intent
   * verdict, how far the tree has moved since it was taken, and which of its
   * gaps the run actually has work against. The gap-to-task link is by title
   * rather than by round number, so a PASS in the middle of the sequence cannot
   * desynchronise the two counts.
   */
  private intentFor(runId: string, roundsAllowed: number): IntentPosture {
    const verdict = this.store.intentVerdict(runId);
    const tasks = this.store.listTasks(runId).map((t) => ({ id: t.id, title: t.title, epicId: t.epicId, state: t.state }));
    const fixes = tasks.filter((t) => t.id.startsWith("intent-fix-"));
    const rounds = new Set(fixes.map((f) => /^intent-fix-(\d+)-/.exec(f.id)?.[1]).filter(Boolean));
    return intentPosture({
      intent: verdict && { verdict: verdict.verdict, gaps: verdict.gaps },
      plan: this.store.planIntentVerdict(runId),
      fixes,
      staleMerges: verdict ? this.store.eventCountSince(runId, "git.merged", this.store.lastEventSeq(runId, "run.intent_verdict")) : 0,
      roundsUsed: rounds.size,
      roundsAllowed,
      tasks,
      epics: this.store.listEpics(runId),
    });
  }

  private async bind(): Promise<number> {
    const first = this.opts.port ?? DEFAULT_PORT;
    const last = this.opts.port === undefined ? first + PORT_SCAN : first;
    const scan: number[] = [];
    for (let port = first; port <= last; port++) scan.push(port);
    // The remembered port goes to the front of the scan, not in place of it.
    // Ahead of the range because that is the whole point — the operator's tab is
    // pointed there — and inside a scan that continues past it because a run
    // must still resume when something else has taken it since.
    const preferred = this.opts.port === undefined ? this.opts.preferPort : undefined;
    for (const port of preferred === undefined ? scan : [preferred, ...scan.filter((p) => p !== preferred)]) {
      try {
        await this.app.listen({ port, host: "127.0.0.1" });
        return port;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      }
    }
    throw new Error(
      this.opts.port !== undefined
        ? `dashboard port ${first} is already in use — another harness is probably serving there. ` +
          `Pass a different --port, or --no-dashboard.`
        : `no free dashboard port between ${first} and ${last}. Pass --port <n> or --no-dashboard.`
    );
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

  /**
   * GateHandler: a cap was reached. The agent that tripped it is paused, waiting
   * on this promise, so the UI offers a pre-filled raise as the default action.
   */
  resolveBudgetGate(gate: BudgetGate): Promise<number | null> {
    this.budgetPayload = { ...gate, suggestedUsd: Math.ceil((gate.spentUsd + gate.capUsd) * 100) / 100 };
    return new Promise((resolve) => {
      this.pendingBudgetGate = resolve;
    });
  }

  /**
   * GateHandler: the account's plan is nearly spent. Every session in flight is
   * holding on this promise, so the page shows the reading, the reset time and
   * the subscriptions this run could move to instead.
   */
  resolveSubscriptionGate(gate: SubscriptionGate): Promise<SubscriptionChoice> {
    this.subscriptionPayload = gate;
    return new Promise((resolve) => {
      this.pendingSubscriptionGate = resolve;
    });
  }

  /**
   * GateHandler: a task hit its cap. The worker's loop is paused on this promise;
   * the operator's answer becomes its next instructions, or null parks it.
   */
  resolveTaskGate(gate: TaskGate): Promise<string | null> {
    return new Promise((resolve) => {
      this.taskGates.set(`${gate.runId}/${gate.taskId}`, { payload: gate, resolve });
    });
  }

  /**
   * GateHandler: the run has stopped to show what it built. Everything else the
   * dashboard blocks on is a problem report; this one carries screenshots and a
   * running product, which is why it renders as the whole page rather than a
   * card in the corner.
   */
  resolvePitStop(stop: PitStop): Promise<PitStopDecision> {
    this.pitStopPayload = stop;
    return new Promise((resolve) => {
      this.pendingPitStop = resolve;
    });
  }
}
