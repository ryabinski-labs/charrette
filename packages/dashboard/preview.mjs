// Throwaway visual-QA charrette: seeds a store with a realistic event stream and
// serves the dashboard so the layout can be inspected in a browser.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Bus, Store } from "@charrette/core";
import { Dashboard } from "./dist/index.js";

const dir = mkdtempSync(path.join(tmpdir(), "charrette-preview-"));
const store = new Store(path.join(dir, "h.db"));
const bus = new Bus(store);
const runId = "313e2512";
const repo = "/tmp/example-repo";

store.createRun({
  id: runId,
  repoPath: repo,
  assignment:
    "# Add per-user rate limiting to the public API\n\n" +
    "## Decisions already made with the operator (treat as settled)\n" +
    "- Where should the limit be enforced? → **Fastify plugin, in-process** (no new infra)\n" +
    "- What happens on breach? → **429 with Retry-After**\n",
  state: "CREATED",
  prdPath: null,
  planHash: null,
  integrationBranch: `charrette/${runId}/main`,
  config: {
    maxParallelWorkers: 1, qaIterationCap: 3, workerRespawnCap: 3, taskWallClockMinutes: 45,
    models: { intake: "claude-opus-5", planner: "claude-opus-5", worker: "claude-sonnet-5", qa: "claude-sonnet-5", integrator: "claude-sonnet-5" },
    budget: { runCapUsd: 30, taskCapUsd: 10 },
    githubRepo: "acme/blog", skillsDirs: [], deterministicChecks: ["pnpm run typecheck", "pnpm run lint", "pnpm run test"],
  },
});

const t0 = Date.now() - 9 * 60_000;
let t = t0;
const at = (s) => (t += s * 1000);
const intake = "s-intake", planner = "s-planner", worker = "s-worker";

store.transitionRun(runId, "INTAKE");
bus.publish({ type: "agent.spawned", runId, sessionId: intake, role: "intake", model: "claude-opus-5", ts: at(1) });
bus.publish({ type: "agent.tool_use", runId, sessionId: intake, tool: "Read", summary: JSON.stringify({ file_path: `${repo}/package.json` }), ts: at(2) });
bus.publish({ type: "agent.tool_use", runId, sessionId: intake, tool: "Grep", summary: JSON.stringify({ pattern: "fastify.register", path: `${repo}/src` }), ts: at(3) });
bus.publish({ type: "agent.log", runId, sessionId: intake, text: "Fastify 5 with no middleware layer, and the deploy config shows a single instance. Two things worth pinning down before planning.", ts: at(4) });
bus.publish({ type: "intake.question", runId, sessionId: intake, question: "Where should the rate limit be enforced?", options: ["Fastify plugin, in-process", "Redis-backed, shared across instances", "Reverse proxy"], ts: at(2) });
bus.publish({ type: "intake.answered", runId, sessionId: intake, question: "Where should the rate limit be enforced?", answer: "Fastify plugin, in-process", ts: at(14) });
bus.publish({ type: "intake.question", runId, sessionId: intake, question: "What should happen when a client exceeds the limit?", options: ["429 + Retry-After", "Silent drop", "Queue and delay"], ts: at(3) });
bus.publish({ type: "intake.answered", runId, sessionId: intake, question: "What should happen when a client exceeds the limit?", answer: "429 + Retry-After", ts: at(9) });
bus.publish({ type: "intake.brief_ready", runId, goal: "Add per-user rate limiting to the public API", decisions: 2, ts: at(6) });
bus.publish({ type: "agent.usage", runId, sessionId: intake, model: "claude-opus-5", inputTokens: 41200, outputTokens: 3100, cacheReadTokens: 88000, cacheWriteTokens: 12000, costUsd: 0.612, ts: at(1) });
bus.publish({ type: "agent.ended", runId, sessionId: intake, outcome: "done", detail: "", ts: at(1) });
store.transitionRun(runId, "PLANNING", "brief agreed");

bus.publish({ type: "agent.spawned", runId, sessionId: planner, role: "planner", model: "claude-opus-5", ts: at(2) });
bus.publish({ type: "agent.log", runId, sessionId: planner, text: "I'll survey the repository to understand the routing layer and the existing test conventions.", ts: at(3) });
for (const [tool, args] of [
  ["Glob", { pattern: "src/**/*.ts" }],
  ["Read", { file_path: `${repo}/src/server.ts` }],
  ["Read", { file_path: `${repo}/src/routes/posts.ts` }],
  ["Grep", { pattern: "onRequest|preHandler", path: `${repo}/src` }],
  ["Read", { file_path: `${repo}/test/routes.test.ts` }],
  ["Bash", { command: "git log --oneline -12" }],
  ["Read", { file_path: `${repo}/src/plugins/auth.ts` }],
  ["Glob", { pattern: "test/**/*.test.ts" }],
]) bus.publish({ type: "agent.tool_use", runId, sessionId: planner, tool, summary: JSON.stringify(args), ts: at(4) });
bus.publish({ type: "agent.log", runId, sessionId: planner, text: "The auth plugin already decorates request.user, so the limiter can key off that directly instead of the client IP. Drafting the task DAG now.", ts: at(5) });
bus.publish({ type: "agent.usage", runId, sessionId: planner, model: "claude-opus-5", inputTokens: 96000, outputTokens: 9400, cacheReadTokens: 210000, cacheWriteTokens: 31000, costUsd: 1.207, ts: at(20) });
bus.publish({ type: "agent.ended", runId, sessionId: planner, outcome: "done", detail: "", ts: at(1) });

store.insertTasks(
  runId,
  [{ id: "limiter", title: "Rate limiter" }],
  [
    { id: "token-bucket", epicId: "limiter", title: "Token-bucket store with per-user keys", spec: "An in-process token bucket keyed on request.user.id, refilled from a monotonic clock so a system clock change cannot hand out free requests.", acceptanceCriteria: ["Refill is driven by process.hrtime, not Date.now", "Two concurrent requests cannot both spend the last token", "Keys are evicted once idle for longer than the window"], dependsOn: [], state: "MERGED", branch: `charrette/${runId}/token-bucket`, worktreePath: null, githubIssueNumber: 41, prNumber: 118, qaIterations: 1, respawns: 0, assignedSkills: [{ name: "testing-node", sha256: "a".repeat(64), mode: "full" }], errorSummary: null, touchedPaths: [], estimatedSize: "M" },
    { id: "fastify-plugin", epicId: "limiter", title: "Fastify plugin wiring the limiter into the request lifecycle", spec: "", acceptanceCriteria: [], dependsOn: ["token-bucket"], state: "WORKING", branch: `charrette/${runId}/fastify-plugin`, worktreePath: null, githubIssueNumber: 42, prNumber: null, qaIterations: 2, respawns: 0, assignedSkills: [], errorSummary: null, touchedPaths: [], estimatedSize: "M" },
    { id: "metrics", epicId: "limiter", title: "Counter for throttled requests", spec: "Increment a per-route counter whenever the limiter rejects a request, exposed on the existing /metrics endpoint.", acceptanceCriteria: ["The counter carries the route as a label", "No allocation on the hot path when the request is allowed"], dependsOn: ["token-bucket"], state: "ACCEPTED", branch: `charrette/${runId}/metrics`, worktreePath: null, githubIssueNumber: 45, prNumber: 119, qaIterations: 1, respawns: 0, assignedSkills: [], errorSummary: null, touchedPaths: [], estimatedSize: "M" },
    { id: "429-response", epicId: "limiter", title: "429 response with Retry-After header", spec: "", acceptanceCriteria: [], dependsOn: ["fastify-plugin"], state: "PENDING", branch: null, worktreePath: null, githubIssueNumber: 43, prNumber: null, qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null, touchedPaths: [], estimatedSize: "M" },
    { id: "docs", epicId: "limiter", title: "Document the limits in the API reference", spec: "", acceptanceCriteria: [], dependsOn: ["429-response"], state: "NEEDS_HUMAN", branch: null, worktreePath: null, githubIssueNumber: 44, prNumber: null, qaIterations: 3, respawns: 1, assignedSkills: [], errorSummary: "QA iteration cap: the reference page has no section for per-endpoint limits and the worker kept inventing one.", touchedPaths: [], estimatedSize: "M" },
  ]
);
store.transitionRun(runId, "PLAN_REVIEW");
store.transitionRun(runId, "EXECUTING", "plan approved");
bus.publish({ type: "github.issue_created", runId, taskId: "token-bucket", issueNumber: 41, url: "", ts: at(2) });
bus.publish({ type: "git.worktree_created", runId, taskId: "token-bucket", path: "", branch: `charrette/${runId}/token-bucket`, ts: at(1) });
bus.publish({ type: "skills.injected", runId, taskId: "token-bucket", skills: [{ name: "testing-node", sha256: "a".repeat(64), mode: "full" }], ts: at(1) });
bus.publish({ type: "task.qa_verdict", runId, taskId: "token-bucket", verdict: "PASS", iteration: 1, detail: { verdict: "PASS", notes: "Bucket refill is monotonic-clock based and the concurrency test passes." }, ts: at(30) });
bus.publish({ type: "git.merged", runId, taskId: "token-bucket", branch: `charrette/${runId}/token-bucket`, sha: "9f31c0aa77", ts: at(2) });
bus.publish({ type: "github.pr_opened", runId, taskId: "token-bucket", prNumber: 118, url: "", ts: at(1) });

bus.publish({ type: "agent.spawned", runId, taskId: "fastify-plugin", sessionId: worker, role: "worker", model: "claude-sonnet-5", ts: at(2) });
bus.publish({ type: "task.qa_verdict", runId, taskId: "fastify-plugin", verdict: "FAIL", iteration: 1, detail: { verdict: "FAIL", reasons: ["the plugin is registered after the routes, so it never runs for /posts"], mustFix: [] }, ts: at(40) });
bus.publish({ type: "agent.log", runId, taskId: "fastify-plugin", sessionId: worker, text: "QA is right — registration order matters in Fastify. Moving the register call above the route plugins and adding a test that asserts the hook fires for /posts.", ts: at(6) });
for (const [tool, args] of [
  ["Read", { file_path: `${repo}/src/server.ts` }],
  ["Edit", { file_path: `${repo}/src/server.ts` }],
  ["Write", { file_path: `${repo}/test/rate-limit.test.ts` }],
  ["Bash", { command: "pnpm vitest run test/rate-limit.test.ts" }],
]) bus.publish({ type: "agent.tool_use", runId, taskId: "fastify-plugin", sessionId: worker, tool, summary: JSON.stringify(args), ts: at(7) });

// keep this session "running" so the Now panel has something live to show
store.db.prepare("INSERT INTO sessions (id, runId, taskId, role, model, state, startedAt, turns) VALUES (?,?,?,?,?,?,?,?)")
  .run(worker, runId, "fastify-plugin", "worker", "claude-sonnet-5", "running", Date.now() - 154_000, 23);
store.db.prepare("INSERT INTO sessions (id, runId, taskId, role, model, state, startedAt, endedAt, turns, costUsd) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run(planner, runId, null, "planner", "claude-opus-5", "done", t0, t0 + 300_000, 31, 1.207);

store.recordUsage({ runId, sessionId: intake, model: "claude-opus-5", inputTokens: 41200, outputTokens: 3100, cacheReadTokens: 88000, cacheWriteTokens: 12000, costUsd: 0.612 });
store.recordUsage({ runId, sessionId: planner, model: "claude-opus-5", inputTokens: 96000, outputTokens: 9400, cacheReadTokens: 210000, cacheWriteTokens: 31000, costUsd: 1.207 });
store.recordUsage({ runId, taskId: "token-bucket", sessionId: "s-tb", model: "claude-sonnet-5", inputTokens: 120000, outputTokens: 18000, cacheReadTokens: 400000, cacheWriteTokens: 40000, costUsd: 3.9 });

const dash = new Dashboard(store, bus, { port: 4788 });
console.log(await dash.start());
if (process.env.GATE) {
  void dash.resolvePlanGate(
    "# Per-user rate limiting\n\n## Problem\nThe public API has no per-user throttle...\n\n## Approach\nA token-bucket keyed on request.user.id, enforced by a Fastify onRequest hook registered before the route plugins.\n",
    "- [token-bucket] Token-bucket store with per-user keys (deps: none)\n- [fastify-plugin] Fastify plugin wiring the limiter (deps: token-bucket)\n- [429-response] 429 response with Retry-After header (deps: fastify-plugin)\n- [docs] Document the limits in the API reference (deps: 429-response)"
  );
}
setInterval(() => {
  bus.publish({ type: "agent.tool_use", runId, taskId: "fastify-plugin", sessionId: worker, tool: "Bash", summary: JSON.stringify({ command: "pnpm vitest run --reporter dot" }), ts: Date.now() });
}, 4000);
