/**
 * Single-file dashboard SPA (v0.1 skeleton; React/Vite planned per PRD §11.1).
 * Auth token arrives in the URL fragment and is sent as a header on every request;
 * SSE is consumed via fetch-stream because EventSource cannot set headers (SEC-11).
 *
 * Layout intent: the operator's top task is "what are the agents doing right now,
 * and do I need to step in?", so the event stream owns the viewport and everything
 * else is a fixed-width sidebar. The plan gate is the one thing that outranks it —
 * it blocks the run, so it takes over the full width until resolved.
 *
 * Rendering rule: every dynamic string reaches the DOM through textContent, never
 * innerHTML — agent output and repository contents are untrusted input here.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness</title>
<style>
  :root {
    color-scheme: dark;
    --bg:#0d1117; --panel:#11161d; --sunken:#010409; --line:#242c38;
    --fg:#e6edf3; --mute:#9aa4b0; --dim:#7d8590; --faint:#59626e;
    --green:#3fb950; --amber:#d29922; --red:#f85149; --blue:#58a6ff;
    --purple:#bc8cff; --teal:#39c5cf;
  }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body { font:14px/1.55 -apple-system, system-ui, sans-serif; background:var(--bg); color:var(--fg);
         margin:0; display:flex; flex-direction:column; overflow:hidden; }

  header { display:flex; align-items:center; gap:.75rem; padding:.7rem 1.25rem;
           border-bottom:1px solid var(--line); flex:none; flex-wrap:wrap; }
  header h1 { font-size:.95rem; margin:0; letter-spacing:.02em; }
  .meter { margin-left:auto; text-align:right; min-width:200px; }
  .meter b { font-variant-numeric:tabular-nums; }
  .meter small { color:var(--dim); font-size:.72rem; display:block; }
  .bar { height:3px; background:var(--sunken); border-radius:3px; overflow:hidden; margin:.25rem 0; }
  .bar i { display:block; height:100%; width:0; background:var(--green); transition:width .4s; }
  .bar.warn i { background:var(--amber); } .bar.hot i { background:var(--red); }

  .shell { flex:1; min-height:0; display:grid; grid-template-columns:340px minmax(0,1fr);
           gap:1.1rem; padding:1rem 1.25rem; }
  .side { overflow-y:auto; min-height:0; }
  .feed { display:flex; flex-direction:column; min-height:0; }

  h2 { font-size:.7rem; text-transform:uppercase; letter-spacing:.09em; color:var(--dim);
       margin:0 0 .5rem; font-weight:600; display:flex; align-items:baseline; gap:.5rem; }
  h2 .count { color:var(--faint); font-weight:400; letter-spacing:0; text-transform:none; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:.8rem; margin-bottom:.9rem; }
  .empty { color:var(--dim); font-size:.84rem; }

  .pill { font-size:.68rem; font-weight:600; letter-spacing:.04em; padding:.1rem .45rem;
          border-radius:20px; border:1px solid currentColor; white-space:nowrap; }
  .s-MERGED,.s-ACCEPTED,.s-PR_REVIEW { color:var(--green); }
  .s-WORKING,.s-QA,.s-EXECUTING,.s-INTEGRATING,.s-PLANNING,.s-INTAKE { color:var(--amber); }
  .s-NEEDS_HUMAN,.s-QA_FAILED,.s-FAILED { color:var(--red); }
  .s-PLAN_REVIEW { color:var(--blue); }
  .s-PENDING,.s-READY,.s-CREATED,.s-CANCELLED,.s-PAUSED { color:var(--dim); }

  .agent { display:flex; gap:.55rem; align-items:flex-start; padding:.5rem 0; border-top:1px solid var(--line); }
  .agent:first-child { border-top:0; padding-top:0; }
  .agent .dot { width:7px; height:7px; border-radius:50%; margin-top:.45rem; flex:none; background:var(--green); }
  .agent .dot { animation:pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity:.2; } }
  @media (prefers-reduced-motion:reduce) { .agent .dot { animation:none; } }
  .agent .body { min-width:0; flex:1; }
  .agent .who { font-weight:600; }
  .agent .meta { color:var(--faint); font-size:.75rem; }
  .agent .doing { color:var(--mute); font-size:.8rem; font-family:ui-monospace,monospace;
                  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:.1rem; }
  .r-intake { color:var(--purple); } .r-planner { color:var(--blue); }
  .r-worker { color:var(--teal); } .r-qa { color:var(--amber); } .r-integrator { color:var(--green); }

  .task { border:1px solid var(--line); border-radius:6px; padding:.45rem .55rem; margin-bottom:.4rem; background:var(--sunken); }
  .task .top { display:flex; justify-content:space-between; gap:.5rem; align-items:flex-start; }
  .task .title { font-size:.87rem; }
  .task .sub { color:var(--faint); font-size:.73rem; margin-top:.2rem; display:flex; gap:.6rem; flex-wrap:wrap; }
  .task .sub a { color:var(--blue); text-decoration:none; }
  .task .sub a:hover, .task .sub a:focus-visible { text-decoration:underline; }
  .task .why { color:var(--amber); font-size:.76rem; margin-top:.25rem; }

  .feedbar { display:flex; align-items:center; gap:.35rem; flex-wrap:wrap; margin-bottom:.5rem; }
  .feedbar button { background:transparent; color:var(--dim); border:1px solid var(--line);
                    border-radius:20px; padding:.12rem .6rem; font-size:.73rem; cursor:pointer; margin:0; }
  .feedbar button[aria-pressed="true"] { color:var(--fg); border-color:var(--dim); background:var(--panel); }
  .feedbar .spacer { margin-left:auto; }
  #latest { display:none; background:var(--blue); color:#04121f; border:0; font-weight:600; }

  #log { flex:1; min-height:0; background:var(--sunken); border:1px solid var(--line); border-radius:8px;
         padding:.55rem .7rem; overflow-y:auto; font:12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .ev { display:flex; gap:.6rem; padding:.06rem 0; align-items:baseline; }
  .ev time { color:var(--faint); flex:none; font-variant-numeric:tabular-nums; }
  .ev .tag { flex:none; width:96px; text-align:right; color:var(--dim); overflow:hidden;
             text-overflow:ellipsis; white-space:nowrap; }
  .ev .msg { white-space:pre-wrap; word-break:break-word; min-width:0; }
  a.msg { color:inherit; text-decoration:none; }
  a.msg:hover, a.msg:focus-visible { text-decoration:underline; }
  .ev.k-tool .msg { color:var(--mute); }
  .ev.k-say .msg { color:var(--fg); }
  .ev.k-state .msg { color:var(--blue); }
  .ev.k-cost .msg { color:var(--teal); }
  .ev.k-git .msg { color:var(--purple); }
  .ev.k-you .msg { color:var(--green); font-weight:600; }
  .ev.k-bad .msg { color:var(--red); }
  .hide-tool .k-tool, .hide-say .k-say, .hide-state .k-state,
  .hide-cost .k-cost, .hide-git .k-git { display:none; }

  #gate { display:none; flex:none; border-bottom:1px solid var(--amber); background:#1a1409; padding:.9rem 1.25rem; }
  #gate h2 { color:var(--amber); }
  #gate .plan { display:flex; gap:.4rem; flex-wrap:wrap; margin-bottom:.6rem; max-height:26vh; overflow-y:auto; }
  #gate .plan div { border:1px solid var(--line); border-radius:6px; padding:.25rem .55rem;
                    background:var(--sunken); font-size:.82rem; }
  #gate pre { max-height:32vh; overflow:auto; background:var(--sunken); padding:.6rem; border-radius:6px;
              font:12px/1.55 ui-monospace,monospace; white-space:pre-wrap; margin:.4rem 0; }
  button { background:#238636; color:#fff; border:0; border-radius:6px; padding:.42rem 1rem;
           cursor:pointer; margin-right:.5rem; font:inherit; }
  button.reject { background:#5a1e1c; }
  button:focus-visible, summary:focus-visible { outline:2px solid var(--blue); outline-offset:2px; }
  textarea { width:100%; max-width:640px; background:var(--sunken); color:var(--fg); border:1px solid var(--line);
             border-radius:6px; padding:.5rem; font:inherit; margin:.4rem 0; display:block; }
  details summary { cursor:pointer; color:var(--dim); font-size:.8rem; }
  details pre { background:var(--sunken); padding:.55rem; border-radius:6px; overflow:auto; max-height:26vh;
                font:12px/1.5 ui-monospace,monospace; white-space:pre-wrap; }

  /* Below the split, the viewport-locked layout stops helping: let the page scroll. */
  @media (max-width:900px) {
    html, body { height:auto; }
    body { display:block; overflow:auto; }
    .shell { display:block; padding:1rem; }
    .side { overflow:visible; }
    .feed { margin-top:1rem; }
    #log { flex:none; height:65vh; }
  }
</style>
</head>
<body>
<header>
  <h1>Harness</h1>
  <span id="runpills"></span>
  <div class="meter">
    <b id="spend">$0.00</b> <span id="cap" style="color:var(--dim)"></span>
    <div class="bar" id="bar"><i></i></div>
    <small id="spendnote">no runs yet</small>
  </div>
</header>

<section id="gate" aria-labelledby="gate-h">
  <h2 id="gate-h">Gate 1 — approve the plan?</h2>
  <div class="plan" id="gate-tasks"></div>
  <details><summary>Full PRD</summary><pre id="gate-prd"></pre></details>
  <textarea id="gate-feedback" rows="2" aria-label="Feedback for the planner"
            placeholder="What should change? (sent to the planner on reject)"></textarea>
  <button onclick="resolveGate(true)">Approve &amp; build</button>
  <button class="reject" onclick="resolveGate(false)">Reject with feedback</button>
</section>

<div class="shell">
  <div class="side">
    <div class="panel">
      <h2>Now <span class="count" id="nowcount"></span></h2>
      <div id="now"></div>
    </div>
    <div class="panel">
      <h2>Tasks <span class="count" id="taskcount"></span></h2>
      <div id="board"></div>
    </div>
    <div class="panel">
      <h2>Run</h2>
      <div id="runinfo"></div>
    </div>
  </div>

  <div class="feed">
    <div class="feedbar" id="feedbar">
      <h2 style="margin:0 .4rem 0 0">Activity</h2>
      <button id="latest" class="spacer" onclick="toBottom()">Jump to latest</button>
    </div>
    <div id="log" role="log" aria-label="Live agent activity" tabindex="0"></div>
  </div>
</div>

<script>
const token = location.hash.slice(1);
const headers = { authorization: "Bearer " + token };
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

const streaming = new Set();
const sessionRole = {};   // sessionId -> role
const lastAction = {};    // sessionId -> newest formatted tool line
let runs = [];
let repoPath = "";

/* ---------- formatting ---------- */

function rel(p) {
  if (!p) return "";
  let s = String(p);
  if (repoPath && s.indexOf(repoPath) === 0) s = s.slice(repoPath.length).replace(/^\\//, "");
  const parts = s.split("/");
  return parts.length > 4 ? ".../" + parts.slice(-3).join("/") : s;
}

function clip(s, n) {
  s = String(s === undefined || s === null ? "" : s).replace(/\\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "\\u2026" : s;
}

function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m < 60 ? m + "m " + (s % 60) + "s" : Math.floor(m / 60) + "h " + (m % 60) + "m";
}

function tokens(n) { return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }

/** Turn a tool_use event into a line that says what the agent actually did. */
function toolLine(ev) {
  let a = {};
  try { a = JSON.parse(ev.summary) || {}; } catch (e) { a = {}; }
  const t = ev.tool || "?";
  if (t === "Read") return "read " + rel(a.file_path);
  if (t === "Write") return "wrote " + rel(a.file_path);
  if (t === "Edit" || t === "MultiEdit") return "edited " + rel(a.file_path);
  if (t === "Glob") return "glob " + clip(a.pattern, 60) + (a.path ? " in " + rel(a.path) : "");
  if (t === "Grep") return "grep " + clip(a.pattern, 60) + (a.path ? " in " + rel(a.path) : "");
  if (t === "Bash") return "$ " + clip(a.command, 120);
  if (t === "TodoWrite") return "updated its checklist";
  if (t === "Task") return "delegated: " + clip(a.description, 70);
  if (t.indexOf("ask_user") >= 0) return "asked you: " + clip(a.question, 90);
  const first = Object.keys(a)[0];
  return t + (first ? " " + clip(a[first], 80) : "");
}

/** [kind, tag, message] for one event; kind drives colour and filtering. */
function describe(ev) {
  const role = ev.sessionId ? sessionRole[ev.sessionId] : null;
  switch (ev.type) {
    case "run.created":
      return ["state", "run", "created \\u2014 " + clip(ev.assignment, 100)];
    case "run.state_changed":
      return ["state", "run", ev.from + " \\u2192 " + ev.to + (ev.reason ? "  (" + ev.reason + ")" : "")];
    case "task.state_changed":
      return ["state", ev.taskId, ev.from + " \\u2192 " + ev.to + (ev.reason ? "  (" + ev.reason + ")" : "")];
    case "task.qa_verdict": {
      const d = ev.detail || {};
      const why = ev.verdict === "PASS" ? (d.notes || "") : (d.reasons || []).join("; ");
      return [ev.verdict === "PASS" ? "state" : "bad", ev.taskId,
        "QA iteration " + ev.iteration + ": " + ev.verdict + (why ? " \\u2014 " + clip(why, 140) : "")];
    }
    case "agent.spawned":
      sessionRole[ev.sessionId] = ev.role;
      return ["state", ev.role, "started on " + ev.model];
    case "agent.log":
      return ["say", role || "agent", clip(ev.text, 400)];
    case "agent.tool_use": {
      const line = toolLine(ev);
      lastAction[ev.sessionId] = line;
      return ["tool", role || "agent", line];
    }
    case "agent.usage":
      return ["cost", role || "agent", "$" + ev.costUsd.toFixed(3) + "  \\u00b7  " +
        tokens(ev.inputTokens + ev.cacheReadTokens + ev.cacheWriteTokens) + " in / " +
        tokens(ev.outputTokens) + " out"];
    case "agent.ended":
      return [ev.outcome === "done" ? "state" : "bad", role || "agent",
        "finished (" + ev.outcome + ")" + (ev.detail ? " " + clip(ev.detail, 140) : "")];
    case "run.plan_attempt_failed":
      return ["bad", "planner", "attempt " + ev.attempt + " rejected \\u2014 " + ev.reason + "  (raw: " + ev.rawPath + ")"];
    case "intake.question":
      return ["say", "intake", "Q: " + clip(ev.question, 220) +
        (ev.options && ev.options.length ? "   [" + ev.options.join(" | ") + "]" : "")];
    case "intake.answered":
      return ["you", "you", clip(ev.answer, 220)];
    case "intake.brief_ready":
      return ["state", "intake", "brief agreed (" + ev.decisions + " decisions): " + clip(ev.goal, 120)];
    case "git.worktree_created":
      return ["git", ev.taskId, "worktree on " + ev.branch];
    case "git.merged":
      return ["git", ev.taskId, "merged " + ev.branch + " @ " + String(ev.sha).slice(0, 8)];
    case "git.merge_conflict":
      return ["bad", ev.taskId, "merge conflict: " + ev.files.join(", ")];
    case "github.issue_created":
      return ["git", ev.taskId || "run", "issue #" + ev.issueNumber];
    case "github.pr_opened":
      return ["git", ev.taskId, "PR #" + ev.prNumber + " opened \\u2014 yours to merge"];
    case "skills.injected":
      return ["tool", ev.taskId, "skills: " + ev.skills.map((s) => s.name + " (" + s.mode + ")").join(", ")];
    default:
      return ["tool", "", ev.type];
  }
}

/* ---------- feed ---------- */

const KINDS = [["say", "agent output"], ["tool", "tool calls"], ["state", "state"],
               ["cost", "cost"], ["git", "git"]];
const hidden = new Set();

function buildFilters() {
  const bar = $("feedbar");
  const latest = $("latest");
  for (const pair of KINDS) {
    const b = el("button", null, pair[1]);
    b.setAttribute("aria-pressed", "true");
    b.onclick = () => {
      const off = hidden.has(pair[0]);
      if (off) hidden.delete(pair[0]); else hidden.add(pair[0]);
      b.setAttribute("aria-pressed", off ? "true" : "false");
      $("log").className = [...hidden].map((k) => "hide-" + k).join(" ");
    };
    bar.insertBefore(b, latest);
  }
}

function pinned() {
  const log = $("log");
  return log.scrollTop + log.clientHeight >= log.scrollHeight - 48;
}

function toBottom() {
  const log = $("log");
  log.scrollTop = log.scrollHeight;
  $("latest").style.display = "none";
}

function append(ev) {
  const parts = describe(ev);
  const row = el("div", "ev k-" + parts[0]);
  row.append(el("time", null, new Date(ev.ts).toLocaleTimeString()));
  const tag = el("span", "tag" + (parts[1] && sessionRole[ev.sessionId] === parts[1] ? " r-" + parts[1] : ""), parts[1] || "");
  row.append(tag);
  // github.* events carry the canonical URL — make those lines clickable.
  if (typeof ev.url === "string" && ev.url.indexOf("https://") === 0) {
    const a = el("a", "msg", parts[2]);
    a.href = ev.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    row.append(a);
  } else {
    row.append(el("span", "msg", parts[2]));
  }
  const log = $("log");
  const wasPinned = pinned();
  log.append(row);
  while (log.childNodes.length > 2000) log.removeChild(log.firstChild);
  if (wasPinned) toBottom();
  else $("latest").style.display = "inline-block";
}

/* ---------- panels ---------- */

function renderHeader() {
  const pills = $("runpills");
  pills.textContent = "";
  let spent = 0, cap = 0, running = 0;
  for (const run of runs) {
    spent += run.spentUsd;
    cap += run.config.budget.runCapUsd;
    running += run.sessions.filter((s) => s.state === "running").length;
    const p = el("span", "pill s-" + run.state, run.id + " \\u00b7 " + run.state);
    p.style.marginRight = ".4rem";
    pills.append(p);
  }
  $("spend").textContent = "$" + spent.toFixed(2);
  $("cap").textContent = cap ? "/ $" + cap.toFixed(0) : "";
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
  const bar = $("bar");
  bar.className = "bar" + (pct > 85 ? " hot" : pct > 60 ? " warn" : "");
  bar.firstChild.style.width = pct + "%";
  $("spendnote").textContent = running
    ? running + " agent" + (running > 1 ? "s" : "") + " running \\u2014 cost books when each finishes"
    : "priced at API list rates";
}

function renderNow() {
  const box = $("now");
  box.textContent = "";
  const live = [];
  for (const run of runs) for (const s of run.sessions) if (s.state === "running") live.push(s);
  $("nowcount").textContent = live.length ? "" : "idle";
  if (!live.length) {
    box.append(el("div", "empty", "No agent is running \\u2014 the harness is waiting on you, on git, or between tasks."));
    return;
  }
  for (const s of live) {
    const row = el("div", "agent");
    row.append(el("span", "dot"));
    const body = el("div", "body");
    const head = el("div");
    head.append(el("span", "who r-" + s.role, s.role + (s.taskId ? " \\u00b7 " + s.taskId : "")));
    head.append(el("span", "meta", "  " + dur(Date.now() - s.startedAt) + " \\u00b7 " + s.turns + " turns"));
    body.append(head);
    body.append(el("div", "meta", s.model));
    body.append(el("div", "doing", lastAction[s.id] || "thinking\\u2026"));
    row.append(body);
    box.append(row);
  }
}

function renderBoard() {
  const box = $("board");
  box.textContent = "";
  let total = 0, done = 0;
  for (const run of runs) {
    total += run.tasks.length;
    done += run.tasks.filter((t) => t.state === "MERGED").length;
    if (!run.tasks.length) { box.append(el("div", "empty", phaseHint(run.state))); continue; }
    for (const t of run.tasks) {
      const card = el("div", "task");
      const top = el("div", "top");
      top.append(el("span", "title", t.title));
      top.append(el("span", "pill s-" + t.state, t.state));
      card.append(top);
      const sub = el("div", "sub");
      sub.append(el("span", null, t.id));
      if (t.dependsOn.length) sub.append(el("span", null, "after " + t.dependsOn.join(", ")));
      if (t.qaIterations) sub.append(el("span", null, "QA \\u00d7" + t.qaIterations));
      if (t.assignedSkills.length) sub.append(el("span", null, "skills: " + t.assignedSkills.map((s) => s.name).join(", ")));
      if (t.githubIssueNumber) sub.append(gh(run.githubRepo, "issues", t.githubIssueNumber, "issue #" + t.githubIssueNumber));
      if (t.prNumber) sub.append(gh(run.githubRepo, "pull", t.prNumber, "PR #" + t.prNumber));
      card.append(sub);
      if (t.errorSummary) card.append(el("div", "why", clip(t.errorSummary, 220)));
      box.append(card);
    }
  }
  $("taskcount").textContent = total ? done + " of " + total + " merged" : "";
}

/** An issue/PR chip: a real link when we know the repo, plain text when we don't. */
function gh(slug, kind, number, label) {
  if (!slug) return el("span", null, label);
  const a = el("a", null, label);
  a.href = "https://github.com/" + slug + "/" + kind + "/" + number;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = "Open " + label + " in " + slug;
  return a;
}

function phaseHint(state) {
  if (state === "INTAKE") return "The intake agent is interviewing you in the terminal. Answer there and planning follows.";
  if (state === "PLANNING") return "The planner is reading the repository and drafting a PRD. Tasks appear once you approve the plan.";
  if (state === "PLAN_REVIEW") return "The plan is waiting for your approval at the top of this page.";
  return "No tasks yet.";
}

function renderRunInfo() {
  const box = $("runinfo");
  box.textContent = "";
  if (!runs.length) { box.append(el("div", "empty", "No active runs.")); return; }
  for (const run of runs) {
    const meta = el("div", "empty", run.repoPath);
    meta.style.fontSize = ".76rem";
    box.append(meta);
    const line2 = el("div", "empty", run.integrationBranch + " \\u00b7 started " + dur(Date.now() - run.createdAt) + " ago");
    line2.style.fontSize = ".76rem";
    line2.style.marginBottom = ".4rem";
    box.append(line2);
    const d = el("details");
    d.append(el("summary", null, "Assignment the planner received"));
    d.append(el("pre", null, run.assignment));
    box.append(d);
    const cfg = el("div", "empty", "checks: " + (run.config.deterministicChecks.join(" \\u00b7 ") || "none") +
      "  \\u00b7  QA cap " + run.config.qaIterationCap + "  \\u00b7  task cap $" + run.config.budget.taskCapUsd);
    cfg.style.fontSize = ".76rem";
    cfg.style.marginTop = ".4rem";
    box.append(cfg);
  }
}

/* ---------- data ---------- */

async function refresh() {
  const res = await fetch("/api/state", { headers });
  if (!res.ok) { $("now").textContent = "auth failed \\u2014 reopen the URL printed by the CLI"; return; }
  const data = await res.json();
  runs = data.runs;
  repoPath = runs.length ? runs[0].repoPath : "";
  for (const run of runs) for (const s of run.sessions) sessionRole[s.id] = s.role;

  $("gate").style.display = data.planGate ? "block" : "none";
  if (data.planGate) {
    $("gate-prd").textContent = data.planGate.prd;
    const list = $("gate-tasks");
    list.textContent = "";
    for (const line of data.planGate.summary.split("\\n")) {
      if (line.trim()) list.append(el("div", null, line.replace(/^- /, "")));
    }
  }
  renderHeader(); renderNow(); renderBoard(); renderRunInfo();
  for (const run of runs) stream(run.id);
}

async function stream(runId) {
  if (streaming.has(runId)) return;
  streaming.add(runId);
  try {
    const res = await fetch("/api/runs/" + runId + "/events", { headers });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      const frames = buf.split("\\n\\n");
      buf = frames.pop();
      for (const frame of frames) {
        const data = frame.split("\\n").find((l) => l.indexOf("data: ") === 0);
        if (!data) continue;
        const ev = JSON.parse(data.slice(6));
        append(ev);
        if (ev.type.indexOf("state_changed") >= 0 || ev.type === "agent.spawned" ||
            ev.type === "agent.ended" || ev.type === "agent.usage") refresh();
      }
    }
  } finally {
    streaming.delete(runId);
  }
}

async function resolveGate(approved) {
  await fetch("/api/gates/plan", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers),
    body: JSON.stringify({ approved: approved, feedback: $("gate-feedback").value }),
  });
  refresh();
}

buildFilters();
refresh();
setInterval(refresh, 5000);
setInterval(renderNow, 1000);   // keep the elapsed clocks moving between refreshes
</script>
</body>
</html>`;
