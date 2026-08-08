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
<!-- Inline, so the browser never requests /favicon.ico and logs a 404 into the
     one console an operator might open to find out why a run stalled. -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%230b0d10'/%3E%3Cpath d='M4 4v8M12 4v8M4 8h8' stroke='%237aa2f7' stroke-width='2' fill='none'/%3E%3C/svg%3E">
<style>
  :root {
    color-scheme: dark;
    --bg:#0a0d13; --panel:#10151e; --sunken:#05070b; --line:#1d2634; --line2:#28344a;
    --fg:#e8edf4; --mute:#9aa7b8; --dim:#7b8798; --faint:#566274;
    --green:#4bd583; --amber:#e3b341; --red:#f8615c; --blue:#66b2ff;
    --purple:#c49bff; --teal:#41cfd8;
    --mono:ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body { font:14px/1.55 "Avenir Next", -apple-system, "Segoe UI", system-ui, sans-serif;
         background:var(--bg); color:var(--fg);
         margin:0; display:flex; flex-direction:column; overflow:hidden; }
  /* The room: a faint ceiling glow and CRT scanlines. Decorative, near-invisible,
     fixed and inert so it costs nothing on scroll. */
  body::before { content:""; position:fixed; inset:0; pointer-events:none; z-index:0;
    background:
      radial-gradient(1100px 420px at 72% -12%, rgba(102,178,255,.055), transparent 70%),
      radial-gradient(900px 380px at 8% 108%, rgba(75,213,131,.03), transparent 70%),
      repeating-linear-gradient(0deg, transparent 0 2px, rgba(232,237,244,.012) 2px 3px); }
  header, .shell, #gate, #budget, #taskgates, #pitstop { position:relative; z-index:1; }
  ::selection { background:rgba(102,178,255,.28); }

  header { display:flex; align-items:center; gap:.75rem; padding:.65rem 1.25rem;
           border-bottom:1px solid var(--line); flex:none; flex-wrap:wrap;
           background:linear-gradient(180deg, rgba(232,237,244,.02), transparent); }
  header h1 { font-size:.95rem; margin:0; display:flex; align-items:baseline; gap:.55rem; }
  header h1 .mark { color:var(--faint); font-weight:600; font-size:.72rem; letter-spacing:.14em;
                    text-transform:uppercase; font-family:var(--mono); }
  header h1 .mark::before { content:"\\258c\\258a\\2588"; letter-spacing:-.08em; margin-right:.5rem;
                            color:var(--green); font-size:.65rem; }
  body.offline header h1 .mark::before { color:var(--red); }
  header h1 .repo { font-weight:700; letter-spacing:.01em; }
  .ghost { background:transparent; color:var(--dim); border:1px solid var(--line2); border-radius:20px;
           padding:.12rem .6rem; font-size:.73rem; cursor:pointer; margin:0; transition:color .15s, border-color .15s; }
  .ghost:hover { color:var(--mute); border-color:var(--dim); }
  .ghost[aria-pressed="true"] { color:var(--fg); border-color:var(--dim); background:var(--panel); }
  .ghost[disabled] { opacity:.45; cursor:default; }
  .meter { margin-left:auto; text-align:right; min-width:210px; }
  .meter b { font-variant-numeric:tabular-nums; font-family:var(--mono); font-size:.95rem; }
  .meter small { color:var(--dim); font-size:.72rem; display:block; }
  .bar { height:4px; background:var(--sunken); border-radius:4px; overflow:hidden; margin:.28rem 0;
         box-shadow:inset 0 0 0 1px var(--line); }
  .bar i { display:block; height:100%; width:0; background:var(--green); transition:width .4s;
           box-shadow:0 0 8px color-mix(in srgb, var(--green) 60%, transparent); }
  .bar.warn i { background:var(--amber); box-shadow:0 0 8px color-mix(in srgb, var(--amber) 60%, transparent); }
  .bar.hot i { background:var(--red); box-shadow:0 0 8px color-mix(in srgb, var(--red) 60%, transparent); }

  .shell { flex:1; min-height:0; display:grid; grid-template-columns:352px minmax(0,1fr);
           gap:1.1rem; padding:1rem 1.25rem; }
  .side { overflow-y:auto; min-height:0; scrollbar-width:thin; scrollbar-color:var(--line2) transparent; }
  .feed { display:flex; flex-direction:column; min-height:0; }

  h2 { font-size:.68rem; text-transform:uppercase; letter-spacing:.12em; color:var(--dim);
       margin:0 0 .55rem; font-weight:600; display:flex; align-items:baseline; gap:.5rem;
       font-family:var(--mono); }
  h2::after { content:""; flex:1; height:1px; align-self:center;
              background:linear-gradient(90deg, var(--line), transparent); }
  h2 .count { color:var(--faint); font-weight:400; letter-spacing:0; text-transform:none; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.85rem; margin-bottom:.9rem; }
  .empty { color:var(--dim); font-size:.84rem; }
  .apierr { color:var(--red); }

  .pill { font-size:.66rem; font-weight:600; letter-spacing:.05em; padding:.1rem .5rem;
          border-radius:20px; border:1px solid color-mix(in srgb, currentColor 55%, transparent);
          background:color-mix(in srgb, currentColor 9%, transparent);
          white-space:nowrap; font-family:var(--mono); }
  .s-MERGED,.s-ACCEPTED,.s-PR_REVIEW,.s-DONE { color:var(--green); }
  .s-WORKING,.s-QA,.s-EXECUTING,.s-INTEGRATING,.s-PLANNING,.s-INTAKE,.s-VERIFYING { color:var(--amber); }
  .s-NEEDS_HUMAN,.s-QA_FAILED,.s-FAILED,.s-BUDGET_HOLD { color:var(--red); }
  .s-PLAN_REVIEW { color:var(--blue); }
  .s-PENDING,.s-READY,.s-CREATED,.s-CANCELLED,.s-PAUSED,.s-ABORTED { color:var(--dim); }

  .agent { display:flex; gap:.55rem; align-items:flex-start; padding:.5rem 0; border-top:1px solid var(--line); }
  .agent:first-child { border-top:0; padding-top:0; }
  .agent .dot { width:7px; height:7px; border-radius:50%; margin-top:.45rem; flex:none; background:var(--green);
                box-shadow:0 0 6px currentColor; color:var(--green); }
  .agent .dot { animation:pulse 1.8s ease-in-out infinite; }
  .agent .dot.r-intake { background:var(--purple); color:var(--purple); }
  .agent .dot.r-planner { background:var(--blue); color:var(--blue); }
  .agent .dot.r-worker { background:var(--teal); color:var(--teal); }
  .agent .dot.r-qa { background:var(--amber); color:var(--amber); }
  .agent .dot.r-integrator { background:var(--green); color:var(--green); }
  @keyframes pulse { 50% { opacity:.2; } }
  @media (prefers-reduced-motion:reduce) { .agent .dot { animation:none; } }
  .agent .body { min-width:0; flex:1; }
  .agent .who { font-weight:600; }
  .agent .meta { color:var(--faint); font-size:.75rem; font-variant-numeric:tabular-nums; }
  .agent .doing { color:var(--mute); font-size:.8rem; font-family:var(--mono);
                  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:.1rem; }
  .r-intake { color:var(--purple); } .r-planner { color:var(--blue); }
  .r-worker { color:var(--teal); } .r-qa { color:var(--amber); } .r-integrator { color:var(--green); }

  /* Done / in flight / blocked, as a share of every task the plan named. */
  .tbar { display:flex; height:3px; background:var(--sunken); border-radius:3px;
          overflow:hidden; margin:0 0 .6rem; }
  .tbar i { display:block; height:100%; width:0; transition:width .4s; }
  .tbar .k-done { background:var(--green); }
  .tbar .k-live { background:var(--amber); }
  .tbar .k-blocked { background:var(--red); }

  .grp { margin-bottom:.45rem; }
  .grp > summary { list-style:none; display:flex; align-items:baseline; gap:.35rem; cursor:pointer;
                   font-size:.7rem; font-weight:600; text-transform:uppercase; letter-spacing:.08em;
                   color:var(--dim); padding:.3rem 0 .25rem; }
  .grp > summary::-webkit-details-marker { display:none; }
  .grp > summary::before { content:"\\25b8"; color:var(--faint); font-size:.65rem; }
  .grp[open] > summary::before { content:"\\25be"; }
  .grp > summary .n { color:var(--faint); font-weight:400; letter-spacing:0; text-transform:none; }
  .g-done > summary { color:var(--green); }
  .g-blocked > summary { color:var(--red); }
  .g-live > summary { color:var(--amber); }

  .task { border:1px solid var(--line); border-left:2px solid var(--line2); border-radius:7px;
          padding:.5rem .6rem; margin-bottom:.4rem; background:var(--sunken); overflow:hidden; }
  .task.st-WORKING, .task.st-QA, .task.st-QA_FAILED { border-left-color:var(--amber); }
  .task.st-NEEDS_HUMAN { border-left-color:var(--red); }
  .task.done { border-left-color:var(--green); }
  .task.done .title::before { content:"\\2713\\00a0"; color:var(--green); }
  /* The title may hold an unbreakable identifier wider than the card; without
     min-width:0 it shoves the state pill out through the card edge, where the
     sidebar's scroll box clips it mid-word ("MER…"). */
  .task .top { display:flex; justify-content:space-between; gap:.5rem; align-items:flex-start; }
  .task .title { font-size:.87rem; min-width:0; overflow-wrap:anywhere; }
  .task .top .pill { flex:none; }
  .task .sub { color:var(--faint); font-size:.72rem; margin-top:.2rem; display:flex; gap:.6rem; flex-wrap:wrap;
               font-family:var(--mono); min-width:0; }
  .task .sub span { overflow-wrap:anywhere; }
  .task .sub a { color:var(--blue); text-decoration:none; }
  .task .sub a:hover, .task .sub a:focus-visible { text-decoration:underline; }
  .task .why { color:var(--amber); font-size:.76rem; margin-top:.25rem; }
  .task .skills { display:flex; gap:.5rem .7rem; flex-wrap:wrap; margin-top:.3rem; }
  .task .skills .sg { display:inline-flex; gap:.25rem; align-items:center; flex-wrap:wrap; min-width:0; }
  .task .skills .sg b { font-size:.62rem; font-weight:600; letter-spacing:.1em; text-transform:uppercase;
                        font-family:var(--mono); }
  .task .skills .sg-worker b { color:var(--teal); }
  .task .skills .sg-qa b { color:var(--amber); }
  .task .skills .chip { font-size:.68rem; font-family:var(--mono); color:var(--mute);
                        border:1px solid var(--line2); border-radius:5px; padding:.02rem .32rem;
                        overflow-wrap:anywhere; }
  .task .skills .chip.full { background:color-mix(in srgb, var(--fg) 6%, transparent); color:var(--fg); }
  .task .what { margin-top:.3rem; }
  .task .what > summary { font-size:.73rem; }
  .task .what .spec { color:var(--mute); font-size:.78rem; margin:.25rem 0 0; }
  .task .what ul { margin:.25rem 0 0; padding-left:1.1rem; color:var(--mute); font-size:.78rem; }
  .task .what li { margin:.1rem 0; }

  .pr { display:flex; gap:.5rem; align-items:baseline; padding:.18rem 0; font-size:.8rem; }
  .pr a { color:var(--blue); text-decoration:none; font-variant-numeric:tabular-nums; flex:none; }
  .pr a:hover, .pr a:focus-visible { text-decoration:underline; }
  .pr .t { color:var(--mute); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  .feedbar { display:flex; align-items:center; gap:.35rem; flex-wrap:wrap; margin-bottom:.5rem; }
  .feedbar button { background:transparent; color:var(--dim); border:1px solid var(--line);
                    border-radius:20px; padding:.12rem .6rem; font-size:.73rem; cursor:pointer; margin:0; }
  .feedbar button[aria-pressed="true"] { color:var(--fg); border-color:var(--dim); background:var(--panel); }
  .feedbar .spacer { margin-left:auto; }
  #latest { display:none; background:var(--blue); color:#04121f; border:0; font-weight:600; }

  #log { flex:1; min-height:0; background:var(--sunken); border:1px solid var(--line); border-radius:10px;
         padding:.55rem .7rem; overflow-y:auto; font:12.5px/1.62 var(--mono);
         scrollbar-width:thin; scrollbar-color:var(--line2) transparent; }
  .ev { display:flex; gap:.6rem; padding:.07rem .3rem; align-items:baseline; border-radius:4px; }
  .ev:hover { background:rgba(232,237,244,.03); }
  .ev time { color:var(--faint); flex:none; font-variant-numeric:tabular-nums; font-size:11.5px; }
  .ev .tag { flex:none; width:104px; text-align:right; color:var(--dim); overflow:hidden;
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

  #gate, #budget, #taskgates, #pitstop { display:none; flex:none; border-bottom:1px solid var(--amber);
    background:linear-gradient(180deg, #191307, #140f06); border-left:3px solid var(--amber);
    padding:.9rem 1.25rem; }
  #gate h2, #budget h2, #taskgates h2, #pitstop h2 { color:var(--amber); }
  #taskgates .tg { border:1px solid var(--line); border-radius:6px; background:var(--sunken); padding:.6rem .8rem; margin:.5rem 0; }
  #taskgates .tg b { font-size:.9rem; }
  #taskgates .tg .why { color:var(--mute); font-size:.82rem; white-space:pre-wrap; margin:.3rem 0;
                        max-height:18vh; overflow:auto; }
  #taskgates .tg small { color:var(--dim); display:block; margin-bottom:.2rem; }
  #taskgates .tg .rec { font-size:.82rem; border-left:2px solid var(--amber); padding:.15rem 0 .15rem .5rem;
    margin:.3rem 0; white-space:pre-wrap; }
  #budget p { margin:.35rem 0 .6rem; font-size:.88rem; }
  /* The pit stop is the one gate whose payload is worth reading in full, so it
     gets the height a report needs rather than the height a notice needs. */
  #pitstop .report { max-height:52vh; overflow:auto; background:var(--sunken); border-radius:6px;
                     padding:.7rem 1rem; margin:.4rem 0 .7rem; font-size:.88rem; line-height:1.55; }
  #pitstop .report h3 { color:var(--amber); font-size:1rem; margin:.9rem 0 .3rem; }
  #pitstop .report h4, #pitstop .report h5, #pitstop .report h6 { color:var(--fg); font-size:.9rem; margin:.7rem 0 .2rem; }
  #pitstop .report p { margin:.3rem 0; }
  #pitstop .report ul { margin:.2rem 0 .5rem; padding-left:1.1rem; }
  #pitstop .report li { margin:.12rem 0; }
  #pitstop .report blockquote { margin:.35rem 0; padding-left:.6rem; border-left:2px solid var(--amber);
                                color:var(--mute); }
  #pitstop textarea { width:100%; }
  #capinput { background:var(--sunken); color:var(--fg); border:1px solid var(--blue); border-radius:6px;
              padding:.1rem .35rem; font:inherit; font-weight:600; width:6rem; }
  #cap.editable { cursor:pointer; border-bottom:1px dotted var(--dim); }
  #cap.editable:hover, #cap.editable:focus-visible { color:var(--fg); border-bottom-color:var(--fg); }
  #cap.flash { transition:color .15s; color:var(--green); }
  #gate .plan { display:flex; gap:.4rem; flex-wrap:wrap; margin-bottom:.6rem; max-height:26vh; overflow-y:auto; }
  #gate .plan div { border:1px solid var(--line); border-radius:6px; padding:.25rem .55rem;
                    background:var(--sunken); font-size:.82rem; }
  #gate pre { max-height:32vh; overflow:auto; background:var(--sunken); padding:.6rem; border-radius:6px;
              font:12px/1.55 ui-monospace,monospace; white-space:pre-wrap; margin:.4rem 0; }
  button { background:#238636; color:#fff; border:0; border-radius:6px; padding:.42rem 1rem;
           cursor:pointer; margin-right:.5rem; font:inherit; font-weight:600; transition:filter .15s; }
  button:hover { filter:brightness(1.12); }
  button.reject { background:#5a1e1c; }
  button:focus-visible, summary:focus-visible { outline:2px solid var(--blue); outline-offset:2px; }
  ::-webkit-scrollbar { width:9px; height:9px; }
  ::-webkit-scrollbar-thumb { background:var(--line2); border-radius:5px; border:2px solid var(--bg); }
  ::-webkit-scrollbar-track { background:transparent; }
  textarea { width:100%; max-width:640px; background:var(--sunken); color:var(--fg); border:1px solid var(--line);
             border-radius:6px; padding:.5rem; font:inherit; margin:.4rem 0; display:block; }
  #fb { margin-top:.6rem; border-top:1px solid var(--line); padding-top:.6rem; }
  #fb select { background:var(--sunken); color:var(--fg); border:1px solid var(--line); border-radius:6px;
               padding:.3rem .4rem; font:inherit; font-size:.82rem; max-width:100%; }
  #fb textarea { margin:.4rem 0 .3rem; font-size:.85rem; }
  #fb button { font-size:.82rem; padding:.32rem .8rem; }
  #fb small { color:var(--dim); font-size:.75rem; }
  /* .15rem of padding takes the row from 20px to the 24px WCAG 2.2 asks of a
     pointer target, which matters most on the phone layout where these are the
     only things on the panel worth tapping. */
  details summary { cursor:pointer; color:var(--dim); font-size:.8rem; padding:.15rem 0; }
  details pre { background:var(--sunken); padding:.55rem; border-radius:6px; overflow:auto; max-height:26vh;
                font:12px/1.5 ui-monospace,monospace; white-space:pre-wrap; }
  details pre:focus-visible { outline:2px solid var(--blue); outline-offset:2px; }

  /* Below the split, the viewport-locked layout stops helping: let the page scroll. */
  @media (max-width:900px) {
    html, body { height:auto; }
    body { display:block; overflow:auto; }
    .shell { display:block; padding:1rem; }
    .side { overflow:visible; }
    .feed { margin-top:1rem; }
    #log { flex:none; height:65vh; }
    /* The cap earns its keep only while the panel is pinned to the viewport. Once
       the page itself scrolls, it just buries a long assignment in a 219px window
       nested inside a scrolling page — two scrollbars to read one paragraph. */
    details pre { max-height:none; }
  }
</style>
</head>
<body>
<header>
  <h1><span class="mark">harness</span><span class="repo" id="repo">&hellip;</span></h1>
  <span id="runpills"></span>
  <button id="notify" class="ghost" aria-pressed="false" onclick="toggleNotify()">Notify me</button>
  <div class="meter">
    <b id="spend">$0.00</b> <span id="cap" style="color:var(--dim)" tabindex="-1"></span><input id="capinput" type="number" step="1" min="0" aria-label="New run budget cap in USD" hidden>
    <div class="bar" id="bar"><i></i></div>
    <small id="spendnote">no runs yet</small>
  </div>
</header>

<section id="gate" aria-labelledby="gate-h">
  <h2 id="gate-h">Gate 1 — approve the plan?</h2>
  <div class="plan" id="gate-tasks"></div>
  <!-- tabindex on the scroller for the same reason as the assignment below: it is
       the only way a keyboard reaches a scroll region with nothing focusable in it. -->
  <details><summary>Full PRD</summary>
    <pre id="gate-prd" tabindex="0" role="group" aria-label="Full PRD"></pre></details>
  <textarea id="gate-feedback" rows="2" aria-label="Feedback for the planner"
            placeholder="What should change? (sent to the planner on reject)"></textarea>
  <button onclick="resolveGate(true)">Approve &amp; build</button>
  <button class="reject" onclick="resolveGate(false)">Reject with feedback</button>
</section>

<section id="taskgates" aria-labelledby="taskgates-h">
  <h2 id="taskgates-h">A task hit its cap &mdash; your answer keeps it moving</h2>
  <div id="taskgate-list"></div>
</section>

<section id="pitstop" aria-labelledby="pitstop-h">
  <h2 id="pitstop-h">Pit stop &mdash; here is what exists so far</h2>
  <div id="pitstop-report" class="report"></div>
  <textarea id="pitstop-feedback" rows="3" aria-label="What you want changed"
            placeholder="What should change? (goes to every task that has not run yet)"></textarea>
  <button onclick="resolvePitStop('continue')">Looks right &mdash; keep going</button>
  <button onclick="resolvePitStop('redirect')">Send this to the remaining tasks</button>
  <button onclick="resolvePitStop('replan')">Re-plan the rest around this</button>
  <button class="reject" onclick="resolvePitStop('stop')">Stop &mdash; I want to think</button>
  <p id="pitstop-error" style="color:var(--red)" role="alert"></p>
</section>

<section id="budget" aria-labelledby="budget-h">
  <h2 id="budget-h">Budget cap reached</h2>
  <p id="budget-detail"></p>
  <button class="reject" onclick="resolveBudget(true)">Stop &amp; park the run</button>
  <p id="budget-error" style="color:var(--red)" role="alert"></p>
</section>

<div class="shell">
  <div class="side">
    <div class="panel">
      <h2>Now <span class="count" id="nowcount"></span></h2>
      <div id="now"></div>
      <form id="fb" style="display:none">
        <select id="fb-task" aria-label="Which agent or task the feedback is for"></select>
        <textarea id="fb-text" rows="2" aria-label="Feedback for the agent"
                  placeholder="Tell the agent something mid-flight &mdash; course-correct, descope, point at the real problem"></textarea>
        <button type="submit">Send feedback</button>
        <small id="fb-note"></small>
      </form>
    </div>
    <div class="panel">
      <h2>Tasks <span class="count" id="taskcount"></span></h2>
      <div class="tbar" id="tbar" style="display:none" role="img" aria-label="Task progress">
        <i class="k-done"></i><i class="k-live"></i><i class="k-blocked"></i>
      </div>
      <div id="board"></div>
    </div>
    <div class="panel">
      <h2>Pull requests <span class="count" id="prcount"></span></h2>
      <div id="prs"></div>
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

/**
 * Puts nodes in order as the children of parent that follow its first "keep"
 * children, touching only what is actually out of place.
 *
 * The naive version — wipe the parent and append everything — is what used to
 * destroy a selection on the task board every 5 seconds. Re-appending a node
 * that is already in the right place is not a no-op either: to the browser it
 * is a remove followed by an insert, and it takes the selection, the focus and
 * the scroll position with it. So compare first, move only on a mismatch.
 */
const syncChildren = (parent, nodes, keep) => {
  for (let i = 0; i < nodes.length; i++) {
    const have = parent.childNodes[keep + i];
    if (have !== nodes[i]) parent.insertBefore(nodes[i], have || null);
  }
  while (parent.childNodes.length > keep + nodes.length) parent.removeChild(parent.lastChild);
};

const streaming = new Set();
const sessionRole = {};   // sessionId -> role
const lastAction = {};    // sessionId -> newest formatted tool line
let runs = [];
let repoPath = "";
/* Sticky until a poll succeeds — the 1s clock tick re-renders the "now" box and
   would otherwise erase an error before anyone can read it. */
let apiError = "";

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

/**
 * The folder the agents are working in — the one word that tells the operator which
 * of several open dashboards this is. A run id is the resume handle, not a name you
 * can say out loud; the repository is.
 */
function repoName() {
  const parts = String(repoPath || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

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
    case "task.feedback":
      return ["you", "you", "\\u2192 " + ev.taskId + " (" + ev.delivery + "): " + clip(ev.text, 220)];
    // A task's definition of done changing mid-run is the loudest thing in this
    // feed that is not a failure: everything judged after it was judged against
    // something the plan did not say.
    case "task.probe_amended":
      return [ev.by === "operator" ? "you" : "state", ev.taskId,
        (ev.by === "operator" ? "you" : ev.by) +
        (ev.to ? " changed the completion probe to: " + clip(ev.to, 160) : " withdrew the completion probe \\u2014 QA alone judges this task") +
        (ev.why ? "   (" + clip(ev.why, 120) + ")" : "")];
    case "intake.brief_ready":
      return ["state", "intake", "brief agreed (" + ev.decisions + " decisions): " + clip(ev.goal, 120)];
    case "git.worktree_created":
      return ["git", ev.taskId, "worktree on " + ev.branch];
    case "task.deps_seeded":
      return [ev.ok ? "git" : "bad", ev.taskId, (ev.dir ? ev.dir + "/ " : "") + (ev.ok
        ? "deps seeded (" + ev.manager + ", " + ev.seconds + "s)"
        : "deps seeding failed (" + ev.manager + ", " + ev.seconds + "s) \\u2014 the worker installs them itself")];
    case "git.merged":
      return ["git", ev.taskId, "merged " + ev.branch + " @ " + String(ev.sha).slice(0, 8)];
    case "git.merge_conflict":
      return ["bad", ev.taskId, "merge conflict: " + ev.files.join(", ")];
    case "github.issue_created":
      return ["git", ev.taskId || "run", "issue #" + ev.issueNumber];
    case "github.pr_opened":
      return ["git", ev.taskId, "PR #" + ev.prNumber + " opened \\u2014 yours to merge"];
    case "skills.injected":
      return ["tool", ev.taskId, "skills" + (ev.role ? " \\u2192 " + ev.role : "") + ": " + ev.skills.map((s) => s.name + " (" + s.mode + ")").join(", ")];
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
  const name = repoName();
  $("repo").textContent = name || "no repository";
  // Several repos can be running at once on adjacent ports; the tab title is how
  // the operator tells those tabs apart without opening them.
  if (!titleOverride) document.title = name ? name + " \\u00b7 Harness" : "Harness";
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
  // Editable only when there is exactly one run to point the raise at \\u2014
  // an aggregate spread across several runs has no single cap to move.
  const editable = runs.length === 1 && cap > 0;
  if ($("capinput").hidden) {
    $("cap").textContent = cap ? "/ $" + cap.toFixed(0) : "";
    $("cap").classList.toggle("editable", editable);
    $("cap").tabIndex = editable ? 0 : -1;
    $("cap").title = editable ? "Click to change the run's budget cap" : "";
    // A screen reader has no use for "button" on a figure that does nothing
    // when activated \\u2014 only claim the role while it actually is one.
    if (editable) $("cap").setAttribute("role", "button");
    else $("cap").removeAttribute("role");
  }
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
  const bar = $("bar");
  bar.className = "bar" + (pct > 85 ? " hot" : pct > 60 ? " warn" : "");
  bar.firstChild.style.width = pct + "%";
  $("spendnote").textContent = running
    ? running + " agent" + (running > 1 ? "s" : "") + " running \\u2014 cost books when each finishes"
    : "priced at API list rates";
}

/** When the last running session stopped being reported; 0 while one is. */
let idleSince = 0;

function renderNow() {
  const box = $("now");
  box.textContent = "";
  document.body.classList.toggle("offline", !!apiError);
  if (apiError) {
    $("nowcount").textContent = "";
    box.append(el("div", "empty apierr", apiError));
    return;
  }
  const live = [];
  for (const run of runs) for (const s of run.sessions) if (s.state === "running") live.push(s);
  if (!live.length) {
    /*
     * No session is running, which is not the same thing as nothing happening.
     * A session row is written when the agent starts and closed when it ends,
     * so every handover — worker to QA, QA back to worker, one task to the
     * next — has a gap with a task plainly in progress and nobody reported on
     * it. Saying "the harness is waiting on you" there sends the operator
     * hunting for a gate that does not exist, while the feed scrolls past.
     *
     * So name the gap, and time it: a handover is a second or two, and one
     * that has lasted minutes is the thing actually worth looking at.
     */
    if (!idleSince) idleSince = Date.now();
    const busy = [];
    for (const run of runs) for (const t of run.tasks) if (groupOf[t.state] === "live") busy.push(t.id);
    const waited = Date.now() - idleSince;
    $("nowcount").textContent = busy.length ? "between agents" : "idle";
    box.append(el("div", "empty", !busy.length
      ? "No agent is running \\u2014 the harness is waiting on you, on git, or between tasks."
      : waited > 90_000
      ? "Nothing has been running on " + busy.join(", ") + " for " + dur(waited) +
        ", which is longer than a handover takes \\u2014 worth a look at the feed."
      : "Between agents on " + busy.join(", ") + " \\u2014 one finished and the next has not started. Nothing is waiting on you."));
    return;
  }
  idleSince = 0;
  $("nowcount").textContent = "";
  for (const s of live) {
    const row = el("div", "agent");
    row.append(el("span", "dot r-" + s.role));
    const body = el("div", "body");
    const head = el("div");
    head.append(el("span", "who r-" + s.role, s.role + (s.taskId ? " \\u00b7 " + s.taskId : "")));
    // "replies", not "turns": this counts assistant messages, which runs ahead
    // of the SDK's own turn accounting that qaMaxTurns is measured in (a
    // validator capped at 60 ended showing 66). Calling both of them "turns"
    // invites tuning the cap against a number in a different scale.
    head.append(el("span", "meta", "  " + dur(Date.now() - s.startedAt) + " \\u00b7 " + s.turns + " replies"));
    body.append(head);
    body.append(el("div", "meta", s.model));
    body.append(el("div", "doing", lastAction[s.id] || "thinking\\u2026"));
    row.append(body);
    box.append(row);
  }
}

/* The feedback composer is static HTML so the refresh cycle never eats a
   half-typed message; only the <select> options are rebuilt, and only when the
   set of open tasks (or who is working them) changes. */
let fbSig = "";
/* The target the operator last chose, tracked apart from the <select> because
   the option can vanish while they are still typing: a task merges, the poll
   rebuilds the list, and a browser whose selected option no longer exists falls
   back to whichever one sorts first. The note then goes to a different agent
   under a "Delivered" confirmation, which is worse than not sending it. */
let fbChosen = "";

/* Which option should stay selected once the list is rebuilt. Never another
   task's id: if the chosen one is gone and there is a note in the box, this
   returns "" so the operator is asked rather than guessed at. */
function keepTarget(previous, values, hasText) {
  if (previous && values.indexOf(previous) !== -1) return previous;
  if (previous && hasText) return "";
  return values[0] || "";
}
function renderFeedback() {
  const open = [];
  for (const run of runs) {
    const liveRole = {};
    for (const s of run.sessions) {
      if (s.state !== "running") continue;
      if (s.taskId) liveRole[s.taskId] = s.role;
      else if (s.role !== "advisor")
        open.push({ runId: run.id, taskId: "@" + s.role, live: true, label: s.role + " \\u00b7 running now" });
    }
    for (const t of run.tasks) {
      if (t.state === "MERGED" || t.state === "CANCELLED") continue;
      const live = liveRole[t.id];
      open.push({ runId: run.id, taskId: t.id, live: !!live, label: t.id + " \\u00b7 " + (live ? live + " running now" : t.state.toLowerCase()) });
    }
  }
  open.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0));
  $("fb").style.display = open.length ? "block" : "none";
  const sig = open.map((o) => o.runId + "/" + o.taskId + ":" + o.label).join(",");
  if (sig === fbSig) return;
  fbSig = sig;
  const sel = $("fb-task");
  const wanted = fbChosen || sel.value;
  sel.textContent = "";
  for (const o of open) {
    const opt = document.createElement("option");
    opt.value = o.runId + "/" + o.taskId;
    opt.textContent = o.label;
    sel.append(opt);
  }
  const keep = keepTarget(wanted, open.map((o) => o.runId + "/" + o.taskId), $("fb-text").value.trim() !== "");
  if (keep === "" && wanted) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = wanted.split("/").slice(1).join("/") + " \\u00b7 finished \\u2014 choose who gets this";
    sel.prepend(opt);
    $("fb-note").style.color = "var(--red)";
    $("fb-note").textContent = "That task finished while you were writing. Your note is still here \\u2014 pick who should get it.";
  }
  sel.value = keep;
  fbChosen = keep;
}

async function sendFeedback(e) {
  e.preventDefault();
  const raw = $("fb-task").value;
  const target = raw.split("/");
  const text = $("fb-text").value.trim();
  const note = $("fb-note");
  // Two different failures, and telling them apart matters: an empty box is the
  // operator's own omission, an empty target means the task they wrote it for
  // finished and nobody has said where it should go instead.
  if (!raw) { note.style.color = "var(--red)"; note.textContent = "choose who this is for \\u2014 the task you wrote it for has finished"; return; }
  if (!text) { note.style.color = ""; note.textContent = "write something for the agent first"; return; }
  const res = await fetch("/api/feedback", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers),
    body: JSON.stringify({ runId: target[0], taskId: target.slice(1).join("/"), text: text }),
  });
  const body = await res.json().catch(() => ({}));
  note.style.color = res.ok ? "" : "var(--red)";
  if (res.ok) {
    $("fb-text").value = "";
    note.textContent = body.delivery === "live"
      ? "Delivered \\u2014 the running agent sees it as its next message."
      : body.delivery === "revived"
      ? "Reopened \\u2014 this task was parked; your note is the guidance the next worker starts from."
      : "Queued \\u2014 the next agent on this task starts with it, including after a resume.";
  } else {
    note.textContent = body.error || "could not send feedback";
  }
}

/**
 * Task buckets, in the order the operator needs them: what is stuck on them, what is
 * moving, what is finished, what has not started. Thirty-six task cards in one flat
 * list answer none of those questions; five headed groups answer all of them.
 *
 * ACCEPTED counts as done — the work passed QA and only the integrator is left. It
 * keeps its own pill inside the group so "done" and "merged" stay distinguishable.
 */
const GROUPS = [
  { key: "blocked", label: "Needs you", states: ["NEEDS_HUMAN"] },
  { key: "live", label: "In progress", states: ["WORKING", "QA", "QA_FAILED"] },
  { key: "done", label: "Done", states: ["ACCEPTED", "MERGED"] },
  { key: "todo", label: "Queued", states: ["PENDING", "READY"] },
  { key: "gone", label: "Cancelled", states: ["CANCELLED"] },
];

const groupOf = {};
for (const g of GROUPS) for (const s of g.states) groupOf[s] = g.key;

/** Groups the operator closed, and task details they opened. A card is rebuilt whenever
 *  its facts change, so without this their disclosure snaps shut under them. */
const closedGroups = new Set();
const openTasks = new Set();

/**
 * The cards on screen, keyed run/task, each with the facts it was built from.
 *
 * The board is re-rendered on every poll and every agent event — several times
 * a minute — but the great majority of cards are identical between two of
 * those. Handing back the same node instead of an equal one is what lets a
 * selection, a focus ring or an open "what it did" survive the next tick; only
 * the card that actually changed flickers.
 */
let cards = new Map();
/** Group sections, kept across renders for the same reason the cards are. */
const groups = new Map();

function cardSig(t, run, isDone) {
  return JSON.stringify([
    t.state, t.title, t.id, t.dependsOn, t.qaIterations, t.githubIssueNumber, t.prNumber,
    t.assignedSkills, t.errorSummary, t.spec, t.acceptanceCriteria, run.githubRepo, isDone,
  ]);
}

function cardFor(t, run, isDone, kept) {
  const key = run.id + "/" + t.id;
  const sig = cardSig(t, run, isDone);
  const had = cards.get(key);
  const entry = had && had.sig === sig ? had : { sig: sig, node: taskCard(t, run, isDone) };
  kept.set(key, entry);
  return entry.node;
}

function groupFor(g, count) {
  let sec = groups.get(g.key);
  if (!sec) {
    sec = el("details", "grp g-" + g.key);
    sec.open = !closedGroups.has(g.key);
    sec.addEventListener("toggle", () => {
      if (sec.open) closedGroups.delete(g.key);
      else closedGroups.add(g.key);
    });
    const head = el("summary", null, g.label);
    head.append(el("span", "n"));
    sec.append(head);
    groups.set(g.key, sec);
  }
  sec.querySelector("summary .n").textContent = " " + count;
  return sec;
}

function renderBoard() {
  const box = $("board");

  const buckets = {};
  for (const g of GROUPS) buckets[g.key] = [];
  let total = 0;
  for (const run of runs) {
    total += run.tasks.length;
    for (const t of run.tasks) (buckets[groupOf[t.state]] ?? buckets.todo).push({ t, run });
  }

  if (!total) {
    box.textContent = "";
    cards = new Map();
    for (const run of runs) box.append(el("div", "empty", phaseHint(run.state)));
    if (!runs.length) box.append(el("div", "empty", "No tasks yet."));
    $("taskcount").textContent = "";
    $("tbar").style.display = "none";
    return;
  }

  // Rebuilt from what is on the board now, so a task that goes away takes its
  // cached node with it rather than waiting to be handed back to a later run.
  const kept = new Map();
  const sections = [];
  for (const g of GROUPS) {
    const items = buckets[g.key];
    if (!items.length) continue;
    const sec = groupFor(g, items.length);
    // Past the summary, which groupFor owns.
    syncChildren(sec, items.map((item) => cardFor(item.t, item.run, g.key === "done", kept)), 1);
    sections.push(sec);
  }
  syncChildren(box, sections, 0);
  cards = kept;

  const done = buckets.done.length;
  $("taskcount").textContent = done + " of " + total + " done";
  const bar = $("tbar");
  bar.style.display = "flex";
  const pct = (n) => (n / total) * 100 + "%";
  bar.children[0].style.width = pct(done);
  bar.children[1].style.width = pct(buckets.live.length);
  bar.children[2].style.width = pct(buckets.blocked.length);
}

/**
 * The skills a task's agents carried, one chip each, grouped by the role that
 * carried them. Deduped by (role, name): runs recorded before the indexer
 * learned about symlinked skill dirs hold each skill twice, and a card reading
 * "qa-agent, qa-agent" looks like a bug even when the injection was fine.
 */
function skillsRow(assigned) {
  const groups = { worker: [], qa: [], "": [] };
  const seen = new Set();
  for (const s of assigned) {
    const role = s.role || "";
    if (seen.has(role + "/" + s.name)) continue;
    seen.add(role + "/" + s.name);
    (groups[role] || groups[""]).push(s);
  }
  const row = el("div", "skills");
  for (const role of ["worker", "qa", ""]) {
    if (!groups[role].length) continue;
    const grp = el("span", "sg" + (role ? " sg-" + role : ""));
    if (role) grp.append(el("b", null, role));
    for (const s of groups[role]) {
      const chip = el("span", "chip" + (s.mode === "full" ? " full" : ""), s.name);
      chip.title = role
        ? (s.mode === "full" ? "Injected in full into the " + role + "'s prompt" : "Referenced by path for the " + role)
        : "Recorded before skills were tagged per role";
      grp.append(chip);
    }
    row.append(grp);
  }
  return row;
}

function taskCard(t, run, isDone) {
  const card = el("div", "task st-" + t.state + (isDone ? " done" : ""));
  const top = el("div", "top");
  top.append(el("span", "title", t.title));
  top.append(el("span", "pill s-" + t.state, t.state));
  card.append(top);
  const sub = el("div", "sub");
  sub.append(el("span", null, t.id));
  if (t.dependsOn.length) sub.append(el("span", null, "after " + t.dependsOn.join(", ")));
  if (t.qaIterations) sub.append(el("span", null, "QA \\u00d7" + t.qaIterations));
  if (t.githubIssueNumber) sub.append(gh(run.githubRepo, "issues", t.githubIssueNumber, "issue #" + t.githubIssueNumber));
  if (t.prNumber) sub.append(gh(run.githubRepo, "pull", t.prNumber, "PR #" + t.prNumber));
  card.append(sub);
  if (t.assignedSkills.length) card.append(skillsRow(t.assignedSkills));
  if (t.errorSummary) card.append(el("div", "why", clip(t.errorSummary, 220)));

  // A title alone does not say what "done" meant. The acceptance criteria are exactly
  // what QA signed off against, so they are the honest answer to "what did it do?".
  const ac = t.acceptanceCriteria || [];
  if (t.spec || ac.length) {
    const key = run.id + "/" + t.id;
    const what = el("details", "what");
    what.open = openTasks.has(key);
    what.addEventListener("toggle", () => {
      if (what.open) openTasks.add(key);
      else openTasks.delete(key);
    });
    what.append(el("summary", null, isDone ? "what it did" : "what it should do"));
    if (t.spec) what.append(el("p", "spec", clip(t.spec, 400)));
    if (ac.length) {
      const list = el("ul");
      for (const c of ac) list.append(el("li", null, clip(c, 180)));
      what.append(list);
    }
    card.append(what);
  }
  return card;
}

/**
 * Every pull request the run has opened, in one place.
 *
 * The task board carries a PR chip per card, but that only helps if you already know
 * which of thirty cards to look at. The one question at the end of a run is "what do
 * I review?", and this is the whole answer to it — including when the answer is none.
 */
let prsSig = "";

function renderPrs() {
  const rows = [];
  let ended = false;
  for (const run of runs) {
    ended = ended || ["PR_REVIEW", "INTEGRATING", "VERIFYING", "DONE"].includes(run.state);
    for (const t of run.tasks) if (t.prNumber) rows.push({ t, run });
  }
  // This list is the answer to "what do I review?", so it is read and copied
  // out of. Nothing in it ticks, and PRs arrive a handful at a time at the end
  // of a run — redrawing it on a poll that changed nothing here only costs the
  // operator their selection.
  const sig = JSON.stringify([ended, rows.map((r) => [r.t.prNumber, r.t.title, r.run.githubRepo])]);
  if (sig === prsSig) return;
  prsSig = sig;

  const box = $("prs");
  box.textContent = "";
  $("prcount").textContent = rows.length ? String(rows.length) : "";
  if (!rows.length) {
    box.append(el("div", "empty", ended
      ? "None. No task got far enough to open one \\u2014 see what is parked above."
      : "None yet. They open together at the end, one per merged task, once the run passes the intent check."));
    return;
  }
  for (const r of rows) {
    const row = el("div", "pr");
    row.append(gh(r.run.githubRepo, "pull", r.t.prNumber, "#" + r.t.prNumber));
    row.append(el("span", "t", r.t.title));
    box.append(row);
  }
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

/**
 * The run panel is the one place on this page meant to be read at length: the
 * assignment is a paragraph the operator opens, scrolls, and copies out of.
 * Nothing in it actually moves except the elapsed clock, so rebuilding it on
 * every 5s poll could only ever take something away — the disclosure snapped
 * shut, the <pre> jumped back to the top, and a selection made it about two
 * words before being wiped mid-drag. So: rebuild on the facts, tick the clock.
 */
/* null, not "": no run at all signs as the empty string, and starting there
   would make the first paint of "No active runs." look like a no-op poll. */
let runInfoSig = null;
/** Elapsed-clock nodes from the last build, retargeted in place by the poll. */
let runAges = [];
/** Assignments the operator opened. Survives the rare rebuild, for the same
 *  reason openTasks does on the board. */
const openAssignments = new Set();

function tickRunAges() {
  for (const a of runAges) a.node.textContent = dur(Date.now() - a.createdAt) + " ago";
}

function renderRunInfo() {
  // Every field this panel prints, so a real change still redraws it and a
  // poll that changed only the spend does not.
  const sig = runs.map((run) => [
    run.id, run.repoPath, run.integrationBranch, run.createdAt, run.assignment,
    run.config.deterministicChecks.join(","), run.config.qaIterationCap,
    run.config.budget.runCapUsd,
  ].join("\\u0000")).join("\\u0001");
  if (sig === runInfoSig) { tickRunAges(); return; }
  runInfoSig = sig;

  const box = $("runinfo");
  box.textContent = "";
  runAges = [];
  if (!runs.length) { box.append(el("div", "empty", "No active runs.")); return; }
  for (const run of runs) {
    const meta = el("div", "empty", run.repoPath);
    meta.style.fontSize = ".76rem";
    box.append(meta);
    const line2 = el("div", "empty", run.integrationBranch + " \\u00b7 started ");
    const age = el("span", null, dur(Date.now() - run.createdAt) + " ago");
    line2.append(age);
    runAges.push({ node: age, createdAt: run.createdAt });
    line2.style.fontSize = ".76rem";
    line2.style.marginBottom = ".4rem";
    box.append(line2);
    const d = el("details");
    d.open = openAssignments.has(run.id);
    d.addEventListener("toggle", () => {
      if (d.open) openAssignments.add(run.id);
      else openAssignments.delete(run.id);
    });
    const sum = el("summary", null, "Assignment the planner received");
    // The run panel is the last thing in the sidebar, so opening it unfolds a
    // block mostly below the fold — half the assignment and the whole checks
    // line. Scrolled from the click rather than the toggle event: a rebuild
    // that restores an open disclosure fires toggle too, and must not move
    // the page under someone who is reading somewhere else.
    sum.addEventListener("click", () => {
      requestAnimationFrame(() => { if (d.open) d.scrollIntoView({ block: "nearest" }); });
    });
    d.append(sum);
    const pre = el("pre", null, run.assignment);
    // A scroll region with no focusable content is reachable by keyboard in
    // Chrome and Firefox and nowhere else, so the assignment is unreadable
    // without a mouse in Safari unless it is in the tab order itself.
    pre.tabIndex = 0;
    pre.setAttribute("role", "group");
    pre.setAttribute("aria-label", "Assignment the planner received");
    d.append(pre);
    box.append(d);
    const cfg = el("div", "empty", "checks: " + (run.config.deterministicChecks.join(" \\u00b7 ") || "none") +
      "  \\u00b7  QA cap " + run.config.qaIterationCap);
    cfg.style.fontSize = ".76rem";
    cfg.style.marginTop = ".4rem";
    box.append(cfg);
  }
}

/* ---------- notifications ---------- */

/**
 * The operator starts a run and walks away — that is the whole point of the budget
 * caps and the gates. These are the states worth interrupting them for: the run is
 * over, or it has stopped and cannot continue without them. Everything else belongs
 * in the feed, where it costs nothing to miss.
 */
const NOTIFY = {
  PR_REVIEW:   ["done", "Every accepted task is merged and its pull request is open for review."],
  // Merged, but the cycle did not close: the deploy went red, or production
  // disagreed. Both need the operator, and neither is visible from the repo.
  VERIFYING:   ["waiting", "The pull request is merged, but the deploy or the production check has not passed. The activity feed has the reason."],
  DONE:        ["done", "Merged, deployed, and verified against production."],
  FAILED:      ["failed", "The run stopped on an error. The activity feed has the reason."],
  ABORTED:     ["aborted", "The run was cancelled."],
  PAUSED:      ["paused", "The run is parked and will not continue on its own."],
  BUDGET_HOLD: ["waiting", "The budget cap was reached. Raise it or stop the run."],
  PLAN_REVIEW: ["waiting", "The plan is ready and needs your approval before any work starts."],
};

const canNotify = typeof Notification !== "undefined";
let notifyOn = canNotify && localStorage.getItem("harness-notify") === "on";
/** Set once a run ends, so the 5s refresh cannot overwrite the tab title back. */
let titleOverride = "";

function renderNotifyButton() {
  const b = $("notify");
  if (!canNotify) {
    b.disabled = true;
    b.textContent = "No notifications";
    b.title = "This browser does not support desktop notifications.";
    return;
  }
  if (Notification.permission === "denied") {
    b.disabled = true;
    b.textContent = "Notifications blocked";
    b.title = "Allow notifications for this site in your browser settings, then reload.";
    return;
  }
  b.setAttribute("aria-pressed", notifyOn ? "true" : "false");
  b.textContent = notifyOn ? "Notifying" : "Notify me";
  b.title = notifyOn
    ? "You will get a desktop notification when the run finishes or stops."
    : "Get a desktop notification when the run finishes or needs you.";
}

/**
 * Permission is requested from the click, never on load: Safari only grants it
 * from a user gesture, and asking unprompted is how a page gets blocked for good.
 */
async function toggleNotify() {
  if (!canNotify) return;
  if (!notifyOn) {
    const granted = await Notification.requestPermission();
    if (granted !== "granted") { renderNotifyButton(); return; }
  }
  notifyOn = !notifyOn;
  localStorage.setItem("harness-notify", notifyOn ? "on" : "off");
  renderNotifyButton();
}

/** When this page opened. Everything older than it is replayed history, not news. */
const openedAt = Date.now();

/**
 * Task-escalation gates. A worker's loop is paused on each of these — the
 * operator's sentence restarts it with a fresh iteration budget, or parks it.
 *
 * The list is rebuilt only when the set of open gates changes: it holds a
 * textarea the operator is typing into, and the 5s refresh must not wipe a
 * half-written answer.
 */
let taskGateSig = "";
/** The last pit stop rendered, so the 5s refresh does not redraw it under you. */
let pitStopShown = 0;
const notifiedGates = new Set();

function renderTaskGates(gates) {
  const box = $("taskgate-list");
  box.textContent = "";
  for (const g of gates) {
    const card = el("div", "tg");
    const head = el("div", null, "");
    head.append(el("b", null, g.title));
    head.append(el("span", "pill s-NEEDS_HUMAN", " " + g.taskId));
    card.append(head);
    card.append(el("div", "why", clip(g.why, 1200)));
    if (g.branch) card.append(el("small", null, "its work so far is on " + g.branch));
    if (g.recommendation) {
      const rec = el("div", "rec", "");
      rec.append(el("b", null, "Suggested answer: "));
      rec.append(document.createTextNode(clip(g.recommendation, 1200)));
      card.append(rec);
    }
    const input = el("textarea");
    input.rows = 2;
    input.placeholder = "Tell the worker what to do differently \\u2014 it continues with your words and a fresh iteration budget";
    input.setAttribute("aria-label", "Guidance for task " + g.taskId);
    // Prefilled, not just displayed: accepting the suggestion is one click on
    // Send. The list only re-renders when the set of open gates changes, so
    // edits survive the refresh cycle.
    if (g.recommendation) input.value = g.recommendation;
    card.append(input);
    const err = el("p", null, "");
    err.style.color = "var(--red)";
    err.setAttribute("role", "alert");
    const send = el("button", null, "Send & continue");
    send.onclick = () => resolveTask(g, input.value, false, err);
    const park = el("button", "reject", "Park it for later");
    park.onclick = () => resolveTask(g, "", true, err);
    card.append(send, park, err);
    box.append(card);
  }
}

async function resolveTask(gate, guidance, park, errBox) {
  const res = await fetch("/api/gates/task", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers),
    body: JSON.stringify({ runId: gate.runId, taskId: gate.taskId, guidance: guidance, park: park }),
  });
  errBox.textContent = res.ok ? "" : ((await res.json().catch(() => ({}))).error || "could not resolve the gate");
  refresh();
}

/** A gate opening is exactly the interruption the Notify button promises. */
function notifyTaskGates(gates) {
  for (const g of gates) {
    const key = g.runId + "/" + g.taskId;
    if (notifiedGates.has(key)) continue;
    notifiedGates.add(key);
    const where = repoName() || "harness";
    titleOverride = where + " \\u00b7 needs you";
    document.title = titleOverride;
    if (!notifyOn || Notification.permission !== "granted") continue;
    try {
      const note = new Notification(where + " \\u2014 a task needs you", {
        body: g.title + ": " + clip(g.why, 120) + " Answer it and the run continues.",
        tag: "harness-gate-" + key,
      });
      note.onclick = () => window.focus();
    } catch (e) {}
  }
}

/**
 * Render the pit stop report.
 *
 * A deliberately small markdown subset — headings, bullets, quotes, bold — put
 * on the page as text nodes rather than innerHTML. Every word of it was written
 * by an agent reading a repository this dashboard has no reason to trust, and a
 * report is not worth a script injection.
 */
function renderReport(box, md) {
  box.textContent = "";
  let list = null;
  for (const raw of (md || "").split("\\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { list = null; continue; }
    const bullet = /^[-*] (.*)$/.exec(line);
    if (bullet) {
      if (!list) { list = el("ul"); box.append(list); }
      list.append(bold(el("li"), bullet[1]));
      continue;
    }
    list = null;
    const head = /^(#{1,4}) (.*)$/.exec(line);
    if (head) { box.append(bold(el("h" + Math.min(head[1].length + 2, 6)), head[2])); continue; }
    const quote = /^> (.*)$/.exec(line);
    if (quote) { box.append(bold(el("blockquote"), quote[1])); continue; }
    box.append(bold(el("p"), line));
  }
}

/** Split on **bold** runs, appending each as its own text node or <b>. */
function bold(node, text) {
  const parts = text.split(/\\*\\*/);
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    node.append(i % 2 ? el("b", null, parts[i]) : document.createTextNode(parts[i]));
  }
  return node;
}

async function resolvePitStop(action) {
  const res = await fetch("/api/gates/pitstop", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers),
    body: JSON.stringify({ action: action, feedback: $("pitstop-feedback").value }),
  });
  if (res.ok) { $("pitstop-feedback").value = ""; $("pitstop-error").textContent = ""; }
  else $("pitstop-error").textContent = (await res.json().catch(() => ({}))).error || "could not resolve the pit stop";
  refresh();
}

/** The one interruption that is not about something going wrong. */
function notify(title, body) {
  const where = repoName() || "harness";
  titleOverride = where + " \\u00b7 pit stop";
  document.title = titleOverride;
  if (!notifyOn || Notification.permission !== "granted") return;
  try {
    const note = new Notification(where + " \\u2014 " + title, { body: body, tag: "harness-" + title });
    note.onclick = () => window.focus();
  } catch (e) {}
}

function notifyRunState(ev) {
  const n = NOTIFY[ev.to];
  if (!n) return;
  // The stream replays a run's whole history on connect and on every reconnect.
  // Without this the page announces a plan gate you approved an hour ago, and does
  // it again each time the connection drops.
  if (ev.ts < openedAt) return;
  const where = repoName() || "harness";
  titleOverride = where + " \\u00b7 " + n[0];
  document.title = titleOverride;
  if (!notifyOn || Notification.permission !== "granted") return;
  try {
    // Tagged per run and state so a reconnect that replays the event re-uses the
    // same notification instead of stacking a second copy of it.
    const note = new Notification(where + " \\u2014 run " + n[0], { body: n[1], tag: "harness-" + ev.runId + "-" + ev.to });
    note.onclick = () => { window.focus(); note.close(); };
  } catch (e) {
    // Some browsers only allow notifications from a service worker; the tab title
    // above is already updated, so there is nothing further to do here.
  }
}

/* ---------- data ---------- */

async function refresh() {
  let res;
  try {
    res = await fetch("/api/state", { headers });
  } catch (e) {
    apiError = "can't reach the harness \\u2014 did the process exit? retrying\\u2026";
    renderNow();
    return;
  }
  if (!res.ok) {
    // Only a 401/403 is an auth problem; anything else is the harness hiccuping
    // and calling it "auth failed" sends the operator hunting for the wrong bug.
    apiError = res.status === 401 || res.status === 403
      ? "auth failed \\u2014 reopen the URL printed by the CLI"
      : "the harness answered HTTP " + res.status + " \\u2014 retrying\\u2026";
    renderNow();
    return;
  }
  apiError = "";
  const data = await res.json();
  runs = data.runs;
  // Sticky: a finished run drops out of the open list, and the page should keep
  // saying which repository it was rather than blanking its own title.
  if (runs.length) repoPath = runs[0].repoPath;
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
  const tg = data.taskGates || [];
  $("taskgates").style.display = tg.length ? "block" : "none";
  const sig = tg.map((g) => g.runId + "/" + g.taskId).join(",");
  if (sig !== taskGateSig) {
    taskGateSig = sig;
    renderTaskGates(tg);
    notifyTaskGates(tg);
  }
  const ps = data.pitStop;
  $("pitstop").style.display = ps ? "block" : "none";
  if (ps && ps.number !== pitStopShown) {
    pitStopShown = ps.number;
    renderReport($("pitstop-report"), ps.markdown);
    notify("Pit stop " + ps.number, ps.reason + " \\u2014 come and look");
  }
  const bg = data.budgetGate;
  $("budget").style.display = bg ? "block" : "none";
  if (bg) {
    $("budget-detail").textContent =
      "The run cap of $" + bg.capUsd.toFixed(2) + " was reached: $" + bg.spentUsd.toFixed(2) + " spent. " +
      "The agent is paused, not cancelled — raise the cap in the header above to continue.";
  }
  renderHeader(); renderNow(); renderFeedback(); renderBoard(); renderPrs(); renderRunInfo();
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
        if (ev.type === "run.state_changed") notifyRunState(ev);
        if (ev.type.indexOf("state_changed") >= 0 || ev.type.indexOf("gate_") >= 0 ||
            ev.type === "agent.spawned" || ev.type === "agent.ended" || ev.type === "agent.usage") refresh();
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

async function resolveBudget(stop) {
  const res = await fetch("/api/gates/budget", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers),
    body: JSON.stringify({ stop: Boolean(stop) }),
  });
  $("budget-error").textContent = res.ok ? "" : ((await res.json().catch(() => ({}))).error || "could not resolve the gate");
  refresh();
}

/**
 * The header's "/ $500" is itself the affordance: a run at a time, one cap to
 * move, so clicking straight on the figure the operator is already watching
 * beats a separate pencil icon competing for the same few pixels.
 */
function openCapEdit() {
  if (runs.length !== 1) return;
  const input = $("capinput");
  input.value = runs[0].config.budget.runCapUsd;
  $("cap").hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

function closeCapEdit() {
  $("capinput").hidden = true;
  $("cap").hidden = false;
}

async function saveCapEdit() {
  if ($("capinput").hidden) return;
  const run = runs[0];
  const capUsd = Number($("capinput").value);
  closeCapEdit();
  if (!run) return;
  // Untouched or unchanged: nothing to send, and nothing to flash.
  if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd === run.config.budget.runCapUsd) return;
  const res = await fetch("/api/runs/" + run.id + "/budget", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers),
    body: JSON.stringify({ capUsd: capUsd }),
  });
  if (res.ok) {
    $("cap").classList.add("flash");
    setTimeout(() => $("cap").classList.remove("flash"), 600);
  } else {
    // Next poll's renderHeader() overwrites this, which is the point \\u2014 a
    // rejected raise gets one visible beat, not a sticky error widget.
    $("spendnote").textContent = (await res.json().catch(() => ({}))).error || "could not raise the cap";
  }
  refresh();
}

$("cap").addEventListener("click", openCapEdit);
$("cap").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCapEdit(); } });
$("capinput").addEventListener("blur", saveCapEdit);
$("capinput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("capinput").blur();
  if (e.key === "Escape") closeCapEdit();
});

buildFilters();
renderNotifyButton();
$("fb").addEventListener("submit", sendFeedback);
/* An explicit pick is the only thing that re-aims a note; the refresh cycle
   must never do it silently. */
$("fb-task").addEventListener("change", () => {
  fbChosen = $("fb-task").value;
  if (fbChosen) { $("fb-note").style.color = ""; $("fb-note").textContent = ""; }
});
refresh();
setInterval(refresh, 5000);
setInterval(renderNow, 1000);   // keep the elapsed clocks moving between refreshes
</script>
</body>
</html>`;
