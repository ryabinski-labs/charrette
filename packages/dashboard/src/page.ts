/**
 * Single-file dashboard SPA (v0.1 skeleton; React/Vite planned per PRD §11.1).
 * Auth token arrives in the URL fragment and is sent as a header on every request;
 * SSE is consumed via fetch-stream because EventSource cannot set headers (SEC-11).
 */
export const PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Harness</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; background:#0d1117; color:#e6edf3; margin:0; padding:1.5rem; }
  h1 { font-size:1.2rem; } h2 { font-size:1rem; margin:1.2rem 0 .4rem; }
  .cols { display:grid; grid-template-columns: 1fr 1fr; gap:1.5rem; }
  .task { padding:.4rem .6rem; border:1px solid #30363d; border-radius:6px; margin:.3rem 0; display:flex; justify-content:space-between; gap:.6rem; }
  .state { font-weight:600; }
  .state.MERGED { color:#3fb950; } .state.WORKING, .state.QA { color:#d29922; }
  .state.NEEDS_HUMAN { color:#f85149; } .state.PENDING { color:#8b949e; }
  #log { background:#010409; border:1px solid #30363d; border-radius:6px; padding:.6rem; height:50vh; overflow-y:auto; font: 12px ui-monospace, monospace; white-space:pre-wrap; }
  #meter { font-weight:700; }
  #gate { border:1px solid #d29922; border-radius:6px; padding:1rem; margin:1rem 0; display:none; }
  #gate pre { max-height:40vh; overflow-y:auto; background:#010409; padding:.6rem; }
  button { background:#238636; color:#fff; border:0; border-radius:6px; padding:.5rem 1rem; cursor:pointer; margin-right:.5rem; }
  button.reject { background:#da3633; }
  textarea { width:100%; background:#010409; color:#e6edf3; border:1px solid #30363d; border-radius:6px; }
</style>
</head>
<body>
<h1>Harness <span id="meter"></span></h1>
<div id="gate">
  <h2>Gate 1 — approve plan?</h2>
  <pre id="gate-prd"></pre>
  <pre id="gate-summary"></pre>
  <textarea id="gate-feedback" rows="3" placeholder="rejection feedback (optional)"></textarea><br><br>
  <button onclick="resolveGate(true)">Approve</button>
  <button class="reject" onclick="resolveGate(false)">Reject</button>
</div>
<div class="cols">
  <div><h2>Tasks</h2><div id="board"></div></div>
  <div><h2>Live events</h2><div id="log"></div></div>
</div>
<script>
const token = location.hash.slice(1);
const headers = { authorization: "Bearer " + token };
const $ = (id) => document.getElementById(id);
let streaming = new Set();

async function refresh() {
  const res = await fetch("/api/state", { headers });
  if (!res.ok) { $("board").textContent = "auth failed — reopen the URL printed by the CLI"; return; }
  const { runs, planGate } = await res.json();
  $("gate").style.display = planGate ? "block" : "none";
  if (planGate) { $("gate-prd").textContent = planGate.prd; $("gate-summary").textContent = planGate.summary; }
  let board = "", spent = 0, cap = 0;
  for (const run of runs) {
    spent += run.spentUsd; cap += run.config.budget.runCapUsd;
    board += '<h2>run ' + run.id + ' — ' + run.state + '</h2>';
    for (const t of run.tasks) {
      board += '<div class="task"><span>' + t.id + ' · ' + t.title + (t.prNumber ? ' · PR#' + t.prNumber : '') +
               '</span><span class="state ' + t.state + '">' + t.state + '</span></div>';
    }
    stream(run.id);
  }
  $("board").innerHTML = board || "no active runs";
  $("meter").textContent = "$" + spent.toFixed(2) + (cap ? " / $" + cap.toFixed(0) : "");
}

async function stream(runId) {
  if (streaming.has(runId)) return;
  streaming.add(runId);
  const res = await fetch("/api/runs/" + runId + "/events", { headers });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\\n\\n"); buf = frames.pop();
    for (const frame of frames) {
      const data = frame.split("\\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const ev = JSON.parse(data.slice(6));
      const line = new Date(ev.ts).toLocaleTimeString() + " " + ev.type +
        (ev.taskId ? " [" + ev.taskId + "]" : "") +
        (ev.type === "agent.log" ? " " + ev.text.split("\\n")[0].slice(0, 100) : "") +
        (ev.type === "agent.usage" ? " $" + ev.costUsd.toFixed(3) : "");
      const log = $("log");
      log.append(line + "\\n");
      while (log.childNodes.length > 2000) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
      if (ev.type.endsWith("state_changed") || ev.type === "run.gate_opened") refresh();
    }
  }
  streaming.delete(runId);
}

async function resolveGate(approved) {
  await fetch("/api/gates/plan", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ approved, feedback: $("gate-feedback").value }),
  });
  refresh();
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
