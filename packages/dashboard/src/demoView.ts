/**
 * The Demo view: everything a pit stop's demo left on disk, openable.
 *
 * Kept apart from `page.ts` and spliced in as strings, because that file is one
 * 3,000-line template that several branches edit at once. The rules here are
 * the page's own: every dynamic string reaches the DOM through textContent, and
 * the token only ever travels in a header, so files arrive through fetch and are
 * shown from blob URLs. Nothing an agent wrote is ever rendered as markup.
 *
 * `String.raw` keeps the script's backslashes as written. It therefore cannot
 * contain a backtick or a template placeholder; regexes spell a backtick \x60.
 */

export const DEMO_CSS = String.raw`
  body.demo-on main > :not(#demoview) { display:none !important; }
  #demoview[hidden], #dm-viewer[hidden], #demoview [hidden], #dm-viewer [hidden] { display:none !important; }
  #demoview { position:relative; z-index:1; flex:1; min-height:0; overflow-y:auto; padding:1rem 1.25rem;
              scrollbar-width:thin; scrollbar-color:var(--line2) transparent; }
  #dm-open.live { color:var(--green); border-color:color-mix(in srgb, var(--green) 55%, transparent); }
  #dm-open.live::before { content:""; display:inline-block; width:.45rem; height:.45rem; border-radius:50%;
                          background:var(--green); margin-right:.35rem; animation:dm-pulse 1.6s ease-in-out infinite; }
  @keyframes dm-pulse { 50% { opacity:.3; } }
  #dm-ps-open { display:block; margin:0 0 .6rem; font-weight:600; }
  #pitstop .report { overflow-wrap:anywhere; }
  .dm-bar { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; margin-bottom:.7rem; }
  .dm-bar h2 { flex:1 1 100%; margin:0; }
  .dm-bar label { display:flex; align-items:center; gap:.4rem; color:var(--mute); font-size:.8rem; min-width:0; flex:1 1 240px; }
  #dm-stop { flex:1; min-width:0; max-width:420px; background:var(--sunken); color:var(--fg); border:1px solid var(--line2);
             border-radius:6px; padding:.35rem .5rem; font-size:.82rem; }
  #dm-stop:focus-visible, #dm-q:focus-visible { outline:2px solid var(--blue); outline-offset:1px; }
  .dm-note { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:.6rem .8rem; margin:0 0 .7rem;
             color:var(--mute); font-size:.84rem; }
  .dm-note.warn { border-color:color-mix(in srgb, var(--amber) 55%, transparent); color:var(--fg); }
  .dm-note.bad { border-color:color-mix(in srgb, var(--red) 55%, transparent); color:var(--fg); }
  #dm-gate button { margin-left:.5rem; }
  #dm-live { background:var(--panel); border:1px solid color-mix(in srgb, var(--green) 40%, var(--line)); border-radius:10px;
             padding:.7rem .85rem; margin-bottom:.8rem; }
  #dm-live.stalled { border-color:color-mix(in srgb, var(--amber) 60%, transparent); }
  #dm-live-title { font-weight:700; }
  #dm-live-title::before { content:""; display:inline-block; width:.55rem; height:.55rem; border-radius:50%; background:var(--green);
                           margin-right:.45rem; animation:dm-pulse 1.6s ease-in-out infinite; }
  #dm-live.stalled #dm-live-title::before { background:var(--amber); animation:none; }
  #dm-live-sub { color:var(--mute); font-size:.8rem; font-variant-numeric:tabular-nums; }
  #dm-live-now { font-family:var(--mono); font-size:.76rem; color:var(--fg); margin:.35rem 0 0; overflow-wrap:anywhere; }
  #dm-live-stall { color:var(--amber); font-size:.84rem; margin:.35rem 0 0; }
  #dm-live ol { list-style:none; margin:.3rem 0 0; padding:0; max-height:220px; overflow:auto; font-family:var(--mono);
                font-size:.72rem; color:var(--mute); }
  #dm-live ol li { padding:.12rem 0; overflow-wrap:anywhere; }
  #dm-tools { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; margin-bottom:.7rem; }
  #dm-chips { display:flex; gap:.35rem; overflow-x:auto; scrollbar-width:none; max-width:100%; padding:2px; }
  #dm-chips button { flex:none; background:transparent; color:var(--mute); border:1px solid var(--line2); border-radius:20px;
                     padding:.22rem .7rem; font-size:.76rem; margin:0; }
  #dm-chips button[aria-pressed="true"] { color:var(--fg); background:var(--panel); border-color:var(--dim); }
  #dm-chips button b { font-weight:600; color:var(--dim); margin-left:.3rem; font-variant-numeric:tabular-nums; }
  #dm-q { flex:1 1 200px; min-width:0; max-width:340px; background:var(--sunken); color:var(--fg); border:1px solid var(--line2);
          border-radius:6px; padding:.34rem .55rem; font-size:.82rem; }
  .dm-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  .dm-group { margin-bottom:.7rem; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.25rem .7rem .55rem; }
  .dm-group > summary { font-family:var(--mono); font-size:.76rem; color:var(--mute); padding:.4rem 0; overflow-wrap:anywhere; }
  .dm-group > summary b { color:var(--dim); font-weight:500; margin-left:.4rem; }
  .dm-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(170px, 1fr)); gap:.55rem; margin-bottom:.45rem; }
  .dm-item { position:relative; background:var(--sunken); color:var(--fg); border:1px solid var(--line); border-radius:7px;
             margin:0; padding:0; text-align:left; font-weight:400; cursor:pointer; min-width:0; transition:border-color .15s; }
  .dm-item:hover { filter:none; border-color:var(--dim); }
  .dm-thumb { display:flex; flex-direction:column; overflow:hidden; }
  .dm-pic { display:flex; align-items:center; justify-content:center; aspect-ratio:16/10; background:var(--bg); overflow:hidden;
            color:var(--dim); font-size:.7rem; text-align:center; padding:0; }
  .dm-pic img { width:100%; height:100%; object-fit:cover; object-position:top; display:block; }
  .dm-thumb .dm-name { padding:.3rem .45rem; font-size:.72rem; }
  .dm-list { display:flex; flex-direction:column; gap:.25rem; }
  .dm-row { display:flex; align-items:center; gap:.55rem; padding:.34rem .55rem; font-size:.8rem; width:100%; }
  .dm-glyph { flex:none; width:1.5rem; text-align:center; color:var(--teal); font-family:var(--mono); font-size:.72rem; }
  .dm-size { flex:none; margin-left:auto; color:var(--dim); font-size:.72rem; font-variant-numeric:tabular-nums; }
  .dm-name { display:flex; min-width:0; flex:1; font-family:var(--mono); font-size:.76rem; }
  .dm-name .h { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  .dm-name .t { flex:none; white-space:pre; }
  .dm-item.dm-new { border-color:var(--green); }
  .dm-new-tag { position:absolute; top:.25rem; right:.25rem; background:var(--green); color:#04210f; font-size:.6rem; font-weight:700;
                border-radius:4px; padding:0 .3rem; letter-spacing:.04em; }
  .dm-row .dm-new-tag { position:static; flex:none; }
  button.dm-cite { display:inline; background:none; border:0; border-radius:3px; padding:0 .1rem; margin:0; color:var(--blue);
                   font:inherit; font-family:var(--mono); font-size:.92em; text-decoration:underline; cursor:pointer;
                   overflow-wrap:anywhere; text-align:left; }
  .dm-code { font-family:var(--mono); font-size:.92em; color:var(--mute); overflow-wrap:anywhere; }
  .dm-missing { font-family:var(--mono); font-size:.92em; color:var(--mute); overflow-wrap:anywhere; }
  .dm-missing i { font-style:normal; color:var(--amber); font-family:inherit; margin-left:.3rem; font-size:.9em; }

  #dm-viewer { position:fixed; inset:2.5vh 2.5vw; z-index:40; display:flex; flex-direction:column; background:var(--panel);
               border:1px solid var(--line2); border-radius:12px; box-shadow:0 0 0 100vmax rgba(3,5,9,.78); outline:none; min-height:0; }
  .dm-v-head { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; padding:.6rem .8rem; border-bottom:1px solid var(--line); }
  .dm-v-title { flex:1 1 260px; min-width:0; }
  #dm-v-name { display:block; font-family:var(--mono); font-size:.86rem; overflow-wrap:anywhere; }
  #dm-v-meta { display:block; color:var(--mute); font-size:.74rem; overflow-wrap:anywhere; }
  #dm-v-pos { color:var(--mute); font-size:.76rem; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .dm-v-actions { display:flex; gap:.3rem; flex-wrap:wrap; }
  .dm-v-actions button { padding:.2rem .6rem; font-size:.76rem; }
  #dm-v-variants { display:flex; gap:.3rem; flex-wrap:wrap; padding:.35rem .8rem; border-bottom:1px solid var(--line); }
  #dm-v-variants button { padding:.15rem .55rem; font-size:.72rem; }
  #dm-v-note { margin:0; padding:.3rem .8rem; color:var(--mute); font-size:.76rem; border-bottom:1px solid var(--line); }
  #dm-v-body { flex:1; min-height:0; overflow:auto; padding:.7rem .8rem; outline-offset:-2px; }
  #dm-v-body:focus-visible { outline:2px solid var(--blue); }
  #dm-v-body.dm-fit { display:flex; align-items:center; justify-content:center; }
  #dm-v-body.dm-fit img { max-width:100%; max-height:100%; object-fit:contain; }
  #dm-v-body img { display:block; background:#fff; }
  #dm-v-body video { max-width:100%; max-height:100%; display:block; margin:auto; }
  #dm-v-body pre { margin:0; font:12px/1.55 var(--mono); white-space:pre-wrap; overflow-wrap:anywhere; color:var(--fg); }
  #dm-v-body .report h3 { color:var(--amber); font-size:1rem; margin:.9rem 0 .3rem; }
  #dm-v-body .report h4, #dm-v-body .report h5, #dm-v-body .report h6 { color:var(--fg); font-size:.9rem; margin:.7rem 0 .2rem; }
  #dm-v-body .report p { margin:.3rem 0; }
  #dm-v-body .report ul { margin:.2rem 0 .5rem; padding-left:1.1rem; }
  #dm-v-body .report blockquote { margin:.35rem 0; padding-left:.6rem; border-left:2px solid var(--amber); color:var(--mute); }
  .dm-table { border-collapse:collapse; font:12px/1.45 var(--mono); }
  .dm-table th, .dm-table td { border:1px solid var(--line); padding:.2rem .45rem; text-align:left; vertical-align:top; }
  .dm-table th { background:var(--sunken); position:sticky; top:-.7rem; }
  .dm-card { max-width:460px; margin:1.5rem auto; background:var(--sunken); border:1px solid var(--line); border-radius:10px; padding:1rem; }
  .dm-card dl { display:grid; grid-template-columns:auto 1fr; gap:.2rem .8rem; margin:0 0 .7rem; font-size:.82rem; }
  .dm-card dt { color:var(--mute); }
  .dm-card dd { margin:0; overflow-wrap:anywhere; }
  .dm-err { max-width:460px; margin:1.5rem auto; text-align:center; color:var(--fg); }
  .dm-err p { margin:0 0 .6rem; }
  .dm-busy { color:var(--mute); text-align:center; margin:2rem 0; }

  @media (max-width:900px) {
    #demoview { overflow:visible; padding:1rem; }
    #dm-viewer { inset:0; border-radius:0; border:0; box-shadow:none; }
    .dm-bar label { flex-basis:100%; }
    #dm-stop { max-width:none; min-height:44px; }
    #dm-q { max-width:none; flex-basis:100%; min-height:44px; }
    #dm-open, #dm-back { min-height:44px; }
    #dm-chips { flex-wrap:nowrap; width:100%; }
    #dm-chips button { min-height:44px; }
    .dm-row { min-height:44px; }
    .dm-group > summary { min-height:44px; display:flex; align-items:center; }
    .dm-grid { grid-template-columns:repeat(2, minmax(0, 1fr)); }
    .dm-v-head { padding:.5rem .6rem; gap:.35rem; }
    .dm-v-title { flex:1 1 0; }
    .dm-v-actions { width:100%; flex-wrap:nowrap; }
    .dm-v-actions button { flex:1 1 0; min-height:44px; min-width:44px; padding:0; font-size:.95rem; }
    .dm-v-actions .dm-l { display:none; }
    #dm-v-fit { font-size:.72rem; }
    #dm-v-variants { flex-wrap:nowrap; overflow-x:auto; scrollbar-width:none; padding:.3rem .6rem; }
    #dm-v-variants button { flex:none; min-height:44px; }
    button.dm-cite { padding:.2rem .1rem; }
    #dm-ps-open { width:100%; min-height:44px; }
  }
  @media (prefers-reduced-motion: reduce) {
    #dm-open.live::before, #dm-live-title::before { animation:none; }
    .dm-item { transition:none; }
  }
`;

/** Goes next to the Pause button. */
export const DEMO_BUTTON_HTML = String.raw`<button id="dm-open" class="ghost" type="button" hidden aria-pressed="false" aria-controls="demoview">Demo</button>`;

/** Goes at the top of the pit stop panel, where the operator decides. */
export const DEMO_PITSTOP_HTML = String.raw`<button id="dm-ps-open" type="button" hidden>View demo artifacts</button>`;

/** The browse view: a sibling of the run layout inside the main landmark. */
export const DEMO_VIEW_HTML = String.raw`
<section id="demoview" aria-labelledby="dm-h" hidden>
  <div class="dm-bar">
    <h2 id="dm-h" tabindex="-1">Demo artifacts</h2>
    <label>Pit stop <select id="dm-stop"></select></label>
    <button id="dm-back" class="ghost" type="button">Back to run</button>
  </div>
  <div id="dm-gate" class="dm-note warn" hidden>The run is waiting on your decision.<button id="dm-gate-go" class="ghost" type="button">Go to the decision</button></div>
  <div id="dm-live" hidden>
    <div id="dm-live-title"></div>
    <div id="dm-live-sub"></div>
    <p id="dm-live-now" hidden></p>
    <p id="dm-live-stall" hidden></p>
    <details id="dm-live-more" hidden><summary>Recent agent activity</summary><ol id="dm-live-log"></ol></details>
  </div>
  <p id="dm-msg" class="dm-note" hidden></p>
  <div id="dm-tools" hidden>
    <div id="dm-chips" role="group" aria-label="Filter by type"></div>
    <input id="dm-q" type="search" placeholder="Search filenames&hellip;" aria-label="Search filenames" autocomplete="off">
  </div>
  <p id="dm-count" class="dm-sr" aria-live="polite"></p>
  <div id="dm-groups"></div>
</section>`;

/** Outside <main>, so the whole page behind it can be made inert while it is open. */
export const DEMO_VIEWER_HTML = String.raw`
<div id="dm-viewer" role="dialog" aria-modal="true" aria-labelledby="dm-v-name" tabindex="-1" hidden>
  <div class="dm-v-head">
    <div class="dm-v-title"><strong id="dm-v-name"></strong><span id="dm-v-meta"></span></div>
    <span id="dm-v-pos"></span>
    <div class="dm-v-actions">
      <button id="dm-v-prev" class="ghost" type="button" aria-label="Previous file"><span aria-hidden="true">&larr;</span><span class="dm-l"> Prev</span></button>
      <button id="dm-v-next" class="ghost" type="button" aria-label="Next file"><span class="dm-l">Next </span><span aria-hidden="true">&rarr;</span></button>
      <button id="dm-v-fit" class="ghost" type="button" aria-pressed="false" hidden>100%</button>
      <button id="dm-v-tab" class="ghost" type="button" aria-label="Open in new tab"><span aria-hidden="true">&nearr;</span><span class="dm-l"> Open in new tab</span></button>
      <button id="dm-v-dl" class="ghost" type="button" aria-label="Download"><span aria-hidden="true">&darr;</span><span class="dm-l"> Download</span></button>
      <button id="dm-v-close" class="ghost" type="button" aria-label="Close"><span aria-hidden="true">&times;</span><span class="dm-l"> Close</span></button>
    </div>
  </div>
  <div id="dm-v-variants" role="group" aria-label="Other captures of this screen" hidden></div>
  <p id="dm-v-note" role="status" hidden></p>
  <div id="dm-v-body" tabindex="0" role="region" aria-label="File contents"></div>
</div>`;

export const DEMO_JS = String.raw`
/* ---------- demo artifacts ---------- */

const DM_POLL_MS = 3000;
const DM_STALL_MS = 10 * 60000;
const DM_THUMBS = 6;
const DM_DECODE_TRIES = 4;
const DM_DECODE_WAIT_MS = 1500;
const DM_CSV_ROWS = 500;
const DM_ANNOUNCE_MS = 20000;
const DM_CHIPS = [["all", "All"], ["screens", "Screenshots"], ["reports", "Reports"], ["data", "Data"], ["logs", "Logs"], ["other", "Other"]];
const DM_GLYPH = { image: "▣", video: "▶", markdown: "¶", json: "{}", csv: "☷", text: "≡", source: "</>", file: "◇" };
const DM_STATE = { running: "running", open: "waiting on you", finished: "finished", unfinished: "unfinished" };

const dm = {
  open: false, pushed: false, follow: true, booted: false, stop: null, status: null, statusErr: "", listErr: "",
  lists: new Map(), order: new Map(), stateOf: new Map(), filter: "all", query: "", closed: new Set(),
  cards: new Map(), groups: new Map(), thumbs: new Map(), queue: [], active: 0, io: null,
  fresh: new Set(), unsaid: 0, saidAt: 0, viewer: null, polling: false, retry: null,
};

const dmRunId = () => (runs.length ? runs[0].id : null);
const dmBase = (stop) => "/api/runs/" + encodeURIComponent(dmRunId()) + "/pitstops/" + stop;
const dmFileUrl = (stop, p, download) => dmBase(stop) + "/file?path=" + encodeURIComponent(p) + (download ? "&download=1" : "");

function dmSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

async function dmError(res) {
  let said = "";
  try { said = (await res.json()).error || ""; } catch (e) {}
  if (res.status === 401 || res.status === 403) return said || "not authorised — reopen the URL printed by the CLI";
  return said || "the charrette answered HTTP " + res.status;
}

async function dmJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(await dmError(res));
  return res.json();
}

/* ---------- address bar: the fragment is the token, so state lives in the query ---------- */

function dmUrl(stop, file) {
  const q = new URLSearchParams(location.search);
  q.delete("stop");
  q.delete("file");
  if (stop !== null && stop !== undefined) q.set("stop", String(stop));
  if (file) q.set("file", file);
  const s = q.toString().replace(/%2F/g, "/");
  return location.pathname + (s ? "?" + s : "") + location.hash;
}

function dmUrlState() {
  const q = new URLSearchParams(location.search);
  const raw = q.get("stop");
  const stop = raw && /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw) : null;
  return { stop: stop, file: stop === null ? null : q.get("file") };
}

function dmFromUrl() {
  const s = dmUrlState();
  if (s.file) {
    if (!dm.open) dmShow(s.stop, false);
    if (!dm.viewer || dm.viewer.path !== s.file || dm.viewer.stop !== s.stop) dmOpenFile(s.stop, s.file, null, { history: false });
    return;
  }
  if (dm.viewer) dmCloseViewer({ history: false });
  if (s.stop === null) { if (dm.open) dmHide(false); return; }
  if (!dm.open) dmShow(s.stop, false);
  else if (dm.stop !== s.stop) dmSelect(s.stop);
}

/* ---------- opening and closing the view ---------- */

function dmShow(stop, push) {
  dm.open = true;
  document.body.classList.add("demo-on");
  $("demoview").hidden = false;
  $("dm-open").setAttribute("aria-pressed", "true");
  if (stop !== null && stop !== undefined) { dm.follow = false; dmSelect(stop); }
  if (push) { history.pushState({ dm: 1 }, "", dmUrl(dm.stop, null)); dm.pushed = true; }
  dmRender();
  dmPoll();
}

function dmHide(goBack) {
  dm.open = false;
  document.body.classList.remove("demo-on");
  $("demoview").hidden = true;
  $("dm-open").setAttribute("aria-pressed", "false");
  if (goBack) {
    if (dm.pushed) history.back();
    else history.replaceState(null, "", dmUrl(null, null));
  }
  dm.pushed = false;
  $("dm-open").focus();
}

function dmSelect(stop) {
  if (stop === dm.stop) return;
  dmDropStop();
  dm.stop = stop;
  dm.filter = "all";
  dm.listErr = "";
  dmLoadList(stop).catch(() => {}).then(dmRender);
}

/** Everything held for the stop being left: its cards, queue and blob URLs. */
function dmDropStop() {
  if (dm.io) dm.io.disconnect();
  dm.io = null;
  for (const t of dm.thumbs.values()) { if (t.url) URL.revokeObjectURL(t.url); t.dead = true; }
  dm.thumbs.clear();
  dm.queue = [];
  dm.cards.clear();
  dm.groups.clear();
  dm.fresh.clear();
  $("dm-groups").textContent = "";
}

/* ---------- data ---------- */

async function dmLoadList(stop) {
  try {
    const list = await dmJson(dmBase(stop) + "/artifacts");
    dm.lists.set(stop, list);
    if (stop === dm.stop) dm.listErr = "";
    return list;
  } catch (e) {
    if (stop === dm.stop) dm.listErr = e.message;
    throw e;
  }
}

async function dmPoll() {
  if ((!dm.open && !dm.viewer) || dm.polling || !dmRunId()) return;
  dm.polling = true;
  try {
    try {
      dm.status = await dmJson("/api/runs/" + encodeURIComponent(dmRunId()) + "/demo");
      dm.statusErr = "";
    } catch (e) {
      dm.statusErr = e.message;
    }
    const stops = dm.status ? dm.status.stops : [];
    if (dm.follow && stops.length && stops[0].number !== dm.stop) {
      dmSelect(stops[0].number);
      if (dm.open && !dm.viewer) history.replaceState(history.state, "", dmUrl(dm.stop, null));
    }
    const here = stops.find((s) => s.number === dm.stop);
    const moved = here && dm.stateOf.get(here.number) !== here.state;
    if (here) dm.stateOf.set(here.number, here.state);
    if (dm.stop !== null && (moved || !dm.lists.has(dm.stop) || (here && here.state === "running"))) {
      await dmLoadList(dm.stop).catch(() => {});
    }
  } finally {
    dm.polling = false;
  }
  dmRender();
}

const dmSort = (a, b) => {
  const rank = (f) => (f.path === "REPORT.md" ? 0 : f.dir === "" ? 1 : 2);
  return rank(a) - rank(b) || a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name);
};

/**
 * Files in a stable order. Sorted the first time; after that a new file goes at
 * the end, so nothing the operator is looking at moves when a demo writes more.
 */
function dmOrdered(stop) {
  const list = dm.lists.get(stop);
  if (!list) return [];
  const byPath = new Map(list.files.map((f) => [f.path, f]));
  let order = dm.order.get(stop);
  if (!order) {
    order = list.files.slice().sort(dmSort).map((f) => f.path);
    dm.order.set(stop, order);
  } else {
    const known = new Set(order);
    const added = list.files.filter((f) => !known.has(f.path)).sort(dmSort);
    for (const f of added) {
      order.push(f.path);
      if (stop === dm.stop) dmMarkFresh(f.path);
    }
    if (added.length && stop === dm.stop) dmAnnounce(added.length);
  }
  return order.filter((p) => byPath.has(p)).map((p) => byPath.get(p));
}

function dmMarkFresh(p) {
  dm.fresh.add(p);
  setTimeout(() => { dm.fresh.delete(p); dmPaintFresh(p); }, 12000);
}

function dmPaintFresh(p) {
  const card = dm.cards.get(p);
  if (!card) return;
  const on = dm.fresh.has(p);
  card.classList.toggle("dm-new", on);
  const tag = card.querySelector(".dm-new-tag");
  if (on && !tag) card.append(el("span", "dm-new-tag", "new"));
  if (!on && tag) tag.remove();
}

/** Polite and throttled: a burst of screenshots is one sentence, not thirty. */
function dmAnnounce(n) {
  dm.unsaid += n;
  const wait = dm.saidAt + DM_ANNOUNCE_MS - Date.now();
  if (wait > 0) { if (!dm.sayTimer) dm.sayTimer = setTimeout(dmSay, wait); return; }
  dmSay();
}

function dmSay() {
  dm.sayTimer = null;
  if (!dm.unsaid) return;
  $("dm-count").textContent = dm.unsaid + (dm.unsaid === 1 ? " new file" : " new files") + " from the demo";
  dm.unsaid = 0;
  dm.saidAt = Date.now();
}

function dmMatches(f) {
  return !dm.query || f.path.toLowerCase().indexOf(dm.query) >= 0;
}

function dmVisible(stop) {
  return dmOrdered(stop).filter((f) => (dm.filter === "all" || f.category === dm.filter) && dmMatches(f));
}

/** Folder sections in first-seen order, each with its pictures before its list. */
function dmGroups(files) {
  const groups = new Map();
  for (const f of files) {
    if (!groups.has(f.dir)) groups.set(f.dir, { dir: f.dir, pics: [], rows: [] });
    (f.render === "image" ? groups.get(f.dir).pics : groups.get(f.dir).rows).push(f);
  }
  return [...groups.values()];
}

/** The order Prev and Next walk: exactly what is on screen under the current filter. */
function dmSequence(stop, path) {
  const shown = dmGroups(dmVisible(stop)).flatMap((g) => g.pics.concat(g.rows));
  if (shown.some((f) => f.path === path)) return shown;
  return dmGroups(dmOrdered(stop)).flatMap((g) => g.pics.concat(g.rows));
}

/* ---------- rendering the browse view ---------- */

function dmRender() {
  if (dm.open) {
    dmRenderStops();
    dmRenderGate();
    dmRenderLive();
    dmRenderBrowse();
  }
  if (dm.viewer) dmViewerChrome();
}

function dmStopLabel(s) {
  const count = s.files === 1 ? "1 file" : s.files + " files";
  const state = s.state !== "running" && s.files === 0 ? "no artifacts" : DM_STATE[s.state];
  return "Stop " + s.number + " · " + state + " · " + count;
}

function dmRenderStops() {
  const select = $("dm-stop");
  const stops = dm.status ? dm.status.stops : [];
  const opts = stops.map((s) => { const o = el("option", null, dmStopLabel(s)); o.value = String(s.number); return o; });
  if (dm.stop !== null && !stops.some((s) => s.number === dm.stop)) {
    const o = el("option", null, "Stop " + dm.stop);
    o.value = String(dm.stop);
    opts.unshift(o);
  }
  const sig = opts.map((o) => o.value + o.textContent).join("|");
  if (select.dataset.sig !== sig) {
    select.dataset.sig = sig;
    select.textContent = "";
    select.append(...opts);
  }
  if (dm.stop !== null) select.value = String(dm.stop);
  select.disabled = !opts.length;
}

function dmRenderGate() {
  const waiting = ["gate", "taskgates", "pitstop", "budget", "sub"].some((id) => $(id).style.display === "block");
  $("dm-gate").hidden = !waiting;
}

function dmStopInfo() {
  return dm.status ? dm.status.stops.find((s) => s.number === dm.stop) : null;
}

function dmActivityLine(a) {
  return a.kind === "tool" ? toolLine({ tool: a.tool, summary: a.text }) : clip(a.text, 220);
}

function dmRenderLive() {
  const active = dm.status && dm.status.active && dm.status.active.stop === dm.stop ? dm.status.active : null;
  const box = $("dm-live");
  box.hidden = !active;
  if (!active) return;
  const list = dm.lists.get(dm.stop);
  const none = !list || !list.files.length;
  const title = active.phase === "demo" ? (none ? "Demo running. No files yet" : "Demo running")
    : active.phase === "review" ? "Demo finished. Reviewers are reading it"
    : "Demo finished. Checking its evidence";
  $("dm-live-title").textContent = title;
  $("dm-live-sub").textContent = "Pit stop " + active.stop + " · running for " + dur(Date.now() - active.startedAt) +
    (list ? " · " + list.files.length + (list.files.length === 1 ? " file" : " files") : "");
  const last = active.activity[active.activity.length - 1];
  $("dm-live-now").hidden = !last;
  if (last) $("dm-live-now").textContent = last.role + ": " + dmActivityLine(last);
  const silent = Date.now() - active.lastEventAt;
  const stalled = silent >= DM_STALL_MS;
  box.classList.toggle("stalled", stalled);
  $("dm-live-stall").hidden = !stalled;
  if (stalled) {
    const mins = Math.floor(silent / 60000);
    $("dm-live-stall").textContent = "No activity for " + mins + " minutes; a command may be waiting on a server.";
  }
  $("dm-live-more").hidden = !active.activity.length;
  const lines = active.activity.slice().reverse().map((a) => el("li", null, new Date(a.ts).toLocaleTimeString() + "  " + a.role + "  " + dmActivityLine(a)));
  $("dm-live-log").replaceChildren(...lines);
}

function dmRenderChips(files) {
  const box = $("dm-chips");
  if (!box.children.length) {
    for (const c of DM_CHIPS) {
      const b = el("button");
      b.type = "button";
      b.dataset.chip = c[0];
      b.append(document.createTextNode(c[1]), el("b"));
      b.addEventListener("click", () => { dm.filter = c[0]; dmRender(); });
      box.append(b);
    }
  }
  const matching = files.filter(dmMatches);
  for (const b of box.children) {
    const key = b.dataset.chip;
    b.lastChild.textContent = String(key === "all" ? matching.length : matching.filter((f) => f.category === key).length);
    b.setAttribute("aria-pressed", String(key === dm.filter));
  }
}

function dmMessage(text, cls) {
  const m = $("dm-msg");
  m.hidden = !text;
  m.className = "dm-note" + (cls ? " " + cls : "");
  m.textContent = text || "";
}

function dmEmptyText(info, list) {
  if (!info) return dm.status ? "This stop has no artifacts folder." : "Loading…";
  if (info.state === "running") return "";
  if (info.state === "unfinished") return list.files.length
    ? "This stop never opened, so it has no report. These are the files its demo wrote before it stopped."
    : "This stop never opened and its demo wrote no files.";
  if (list.files.length) return info.demoStarted ? "" : "The product was not started for this stop, so this is the report and nothing it captured.";
  return info.demoStarted ? "This demo produced no files." : "No demo ran for this stop, so there is nothing to show.";
}

function dmRenderBrowse() {
  const stop = dm.stop;
  const stops = dm.status ? dm.status.stops : [];
  const list = stop === null ? null : dm.lists.get(stop);
  $("dm-tools").hidden = !list || !list.files.length;
  if (stop === null) {
    if (dm.statusErr) dmMessage("Could not load this run's demos: " + dm.statusErr, "bad");
    else dmMessage(dm.status && !stops.length ? "This run has not reached a pit stop yet. When it does, whatever its demo captures appears here." : "Loading…");
    return;
  }
  if (!list) {
    const info = dmStopInfo();
    if (dm.listErr && info && info.state === "running") dmMessage("");
    else if (dm.listErr) dmMessage(info && !info.files ? dmEmptyText(info, { files: [] }) : "Could not list this stop: " + dm.listErr, info && !info.files ? "" : "bad");
    else dmMessage("Loading…");
    return;
  }
  const files = dmOrdered(stop);
  dmRenderChips(files);
  const shown = files.filter((f) => (dm.filter === "all" || f.category === dm.filter) && dmMatches(f));
  const notes = [];
  const said = dmEmptyText(dmStopInfo(), list);
  if (said) notes.push(said);
  if (files.length && !shown.length) notes.push("No files match this filter.");
  if (list.unlisted) notes.push(list.unlisted + (list.unlisted === 1 ? " item" : " items") + " on disk not shown (symbolic links, sockets or unsafe names).");
  if (list.truncated) notes.push("This stop has more files than the viewer lists.");
  if (dm.statusErr) notes.push("Live status is unavailable: " + dm.statusErr);
  dmMessage(notes.join(" "), dm.statusErr ? "bad" : "");
  const nodes = dmGroups(shown).map(dmGroupNode);
  syncChildren($("dm-groups"), nodes, 0);
  for (const f of shown) if (f.render === "image") dmThumbUpdate(f);
}

function dmGroupNode(g) {
  let node = dm.groups.get(g.dir);
  if (!node) {
    const root = el("details", "dm-group");
    root.open = !dm.closed.has(g.dir);
    const sum = el("summary");
    const label = el("span", null, g.dir || "Top level");
    const count = el("b");
    sum.append(label, count);
    const grid = el("div", "dm-grid");
    const rows = el("div", "dm-list");
    root.append(sum, grid, rows);
    root.addEventListener("toggle", () => { if (root.open) dm.closed.delete(g.dir); else dm.closed.add(g.dir); });
    node = { root: root, count: count, grid: grid, rows: rows };
    dm.groups.set(g.dir, node);
  }
  const total = g.pics.length + g.rows.length;
  node.count.textContent = total === 1 ? "1 file" : total + " files";
  node.grid.hidden = !g.pics.length;
  node.rows.hidden = !g.rows.length;
  syncChildren(node.grid, g.pics.map(dmCard), 0);
  syncChildren(node.rows, g.rows.map(dmCard), 0);
  return node.root;
}

/** Both halves are spans, so the extension survives whatever width truncates the rest. */
function dmName(name) {
  const box = el("span", "dm-name");
  const cut = Math.max(0, name.length - 14);
  box.append(el("span", "h", name.slice(0, cut)), el("span", "t", name.slice(cut)));
  return box;
}

function dmCard(f) {
  let card = dm.cards.get(f.path);
  if (!card) {
    const pic = f.render === "image";
    card = el("button", "dm-item " + (pic ? "dm-thumb" : "dm-row"));
    card.type = "button";
    card.dataset.path = f.path;
    card.title = f.path;
    card.setAttribute("aria-label", "Open " + f.path + ", " + dmSize(f.size));
    if (pic) {
      const box = el("span", "dm-pic", "…");
      card.append(box, dmName(f.name));
      dmThumbWatch(card, f);
    } else {
      card.append(el("span", "dm-glyph", DM_GLYPH[f.render]), dmName(f.name), el("span", "dm-size", dmSize(f.size)));
    }
    card.addEventListener("click", () => dmOpenFile(dm.stop, f.path, card));
    dm.cards.set(f.path, card);
  } else if (f.render !== "image") {
    card.querySelector(".dm-size").textContent = dmSize(f.size);
  }
  dmPaintFresh(f.path);
  return card;
}

/* ---------- thumbnails: lazy, at most six in flight, every blob URL revoked ---------- */

function dmThumbWatch(card, f) {
  const t = { path: f.path, stop: dm.stop, mtime: f.mtimeMs, state: "idle", url: null, tries: 0, card: card, seen: false, dead: false };
  dm.thumbs.set(f.path, t);
  if (typeof IntersectionObserver !== "function") { t.seen = true; dmThumbQueue(t); return; }
  if (!dm.io) {
    dm.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        dm.io.unobserve(e.target);
        const seen = dm.thumbs.get(e.target.dataset.path);
        if (seen) { seen.seen = true; dmThumbQueue(seen); }
      }
    }, { rootMargin: "300px" });
  }
  dm.io.observe(card);
}

function dmThumbQueue(t) {
  if (t.state !== "idle" || t.dead) return;
  t.state = "queued";
  dm.queue.push(t);
  dmThumbPump();
}

function dmThumbPump() {
  while (dm.active < DM_THUMBS && dm.queue.length) {
    const t = dm.queue.shift();
    if (t.dead) continue;
    dm.active++;
    dmThumbFetch(t).finally(() => { dm.active--; dmThumbPump(); });
  }
}

function dmThumbFail(t) {
  t.tries++;
  t.state = "failed";
  const box = t.card.querySelector(".dm-pic");
  const writing = (dmStopInfo() || {}).state === "running";
  box.replaceChildren(document.createTextNode(writing ? "still being written…" : "no preview"));
  if (t.tries < DM_DECODE_TRIES) {
    setTimeout(() => { if (!t.dead && t.state === "failed") { t.state = "idle"; dmThumbQueue(t); } }, DM_DECODE_WAIT_MS);
  }
}

async function dmThumbFetch(t) {
  t.state = "loading";
  try {
    const res = await fetch(dmFileUrl(t.stop, t.path), { headers });
    if (t.dead) return;
    if (!res.ok) { dmThumbFail(t); return; }
    const blob = await res.blob();
    if (t.dead) return;
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.alt = "Screenshot: " + t.path;
    await new Promise((done) => {
      img.onload = () => {
        if (t.dead) { URL.revokeObjectURL(url); done(); return; }
        if (t.url) URL.revokeObjectURL(t.url);
        t.url = url;
        t.state = "done";
        t.card.querySelector(".dm-pic").replaceChildren(img);
        done();
      };
      img.onerror = () => { URL.revokeObjectURL(url); if (!t.dead) dmThumbFail(t); done(); };
      img.src = url;
    });
  } catch (e) {
    if (!t.dead) dmThumbFail(t);
  }
}

/** A screenshot rewritten or finished since it was drawn gets drawn again. */
function dmThumbUpdate(f) {
  const t = dm.thumbs.get(f.path);
  if (!t || t.mtime === f.mtimeMs) return;
  t.mtime = f.mtimeMs;
  if (t.seen && (t.state === "failed" || t.state === "done")) { t.state = "idle"; t.tries = 0; dmThumbQueue(t); }
}

/* ---------- the viewer ---------- */

function dmEntry(stop, p) {
  const list = dm.lists.get(stop);
  return list ? list.files.find((f) => f.path === p) || null : null;
}

async function dmOpenFile(stop, p, opener, opts) {
  opts = opts || {};
  const wasOpen = Boolean(dm.viewer);
  const back = wasOpen ? dm.viewer.opener : opener;
  if (wasOpen) dmReleaseViewer();
  dm.viewer = { stop: stop, path: p, opener: back, gen: 0, fit: true, url: null, tries: 0, render: null, withheld: "", pushed: wasOpen ? dm.viewer.pushed : false };
  if (!wasOpen) {
    $("dm-viewer").hidden = false;
    for (const n of [document.querySelector("header"), document.querySelector("main")]) n.inert = true;
  }
  if (opts.history !== false) {
    if (wasOpen) history.replaceState(history.state, "", dmUrl(stop, p));
    else { history.pushState({ dm: 2 }, "", dmUrl(stop, p)); dm.viewer.pushed = true; }
  }
  dmViewerChrome();
  if (!wasOpen) $("dm-viewer").focus();
  const v = dm.viewer;
  if (!dm.lists.has(stop)) await dmLoadList(stop).catch(() => {});
  if (dm.viewer !== v) return;
  dmViewerChrome();
  dmViewerLoad();
}

function dmReleaseViewer() {
  const v = dm.viewer;
  if (!v) return;
  v.gen++;
  if (v.timer) clearTimeout(v.timer);
  if (v.url) URL.revokeObjectURL(v.url);
  v.url = null;
  $("dm-v-body").replaceChildren();
}

function dmCloseViewer(opts) {
  const v = dm.viewer;
  if (!v) return;
  dmReleaseViewer();
  dm.viewer = null;
  $("dm-viewer").hidden = true;
  for (const n of [document.querySelector("header"), document.querySelector("main")]) n.inert = false;
  if (!opts || opts.history !== false) {
    if (v.pushed) history.back();
    else history.replaceState(null, "", dmUrl(dm.open ? v.stop : null, null));
  }
  const again = v.opener && v.opener.isConnected ? v.opener : dm.cards.get(v.path);
  const target = again || (dm.open ? $("dm-h") : $("dm-open"));
  if (target && !target.hidden) target.focus();
}

function dmViewerChrome() {
  const v = dm.viewer;
  const f = dmEntry(v.stop, v.path);
  const name = v.path.split("/").pop();
  const folder = v.path.indexOf("/") >= 0 ? v.path.slice(0, v.path.lastIndexOf("/")) : "top level";
  $("dm-v-name").textContent = name;
  $("dm-v-name").title = v.path;
  $("dm-v-meta").textContent = "Stop " + v.stop + " · " + folder +
    (f ? " · " + dmSize(f.size) + " · " + new Date(f.mtimeMs).toLocaleString() : "");
  const seq = dmSequence(v.stop, v.path);
  const at = seq.findIndex((x) => x.path === v.path);
  $("dm-v-pos").textContent = at >= 0 ? (at + 1) + " of " + seq.length : "";
  $("dm-v-prev").disabled = at <= 0;
  $("dm-v-next").disabled = at < 0 || at >= seq.length - 1;
  const image = (f && f.render === "image") || v.render === "image";
  $("dm-v-fit").hidden = !image;
  $("dm-v-fit").textContent = v.fit ? "100%" : "Fit";
  $("dm-v-fit").setAttribute("aria-pressed", String(!v.fit));
  $("dm-v-tab").hidden = v.render === "binary";
  $("dm-v-dl").disabled = Boolean(v.withheld);
  dmViewerRelated(v);
}

function dmStem(name) {
  return name.replace(/\.design\.json$/i, "").replace(/\.[^.]+$/, "");
}

function dmVariantBase(stem) {
  return stem.replace(/-full$/i, "").replace(/-(desktop|mobile|tablet)$/i, "");
}

function dmVariantLabel(name) {
  const stem = dmStem(name);
  const size = /-mobile(-full)?$/i.test(stem) ? "Mobile" : /-tablet(-full)?$/i.test(stem) ? "Tablet" : /-desktop(-full)?$/i.test(stem) ? "Desktop" : "Screen";
  return size + (/-full$/i.test(stem) ? " full" : "");
}

/** Other captures of the same screen, and the text or design facts saved beside it. */
function dmViewerRelated(v) {
  const box = $("dm-v-variants");
  const f = dmEntry(v.stop, v.path);
  const files = dmOrdered(v.stop).filter((x) => f && x.dir === f.dir);
  const items = [];
  if (f && f.render === "image") {
    const base = dmVariantBase(dmStem(f.name));
    const shots = files.filter((x) => x.render === "image" && dmVariantBase(dmStem(x.name)) === base);
    if (shots.length > 1) for (const x of shots) items.push([dmVariantLabel(x.name), x.path]);
    const stem = dmStem(f.name);
    for (const x of files) {
      if (x.render === "image" || dmStem(x.name) !== stem) continue;
      items.push([/\.design\.json$/i.test(x.name) ? "Design facts" : x.render === "json" ? "Data" : "Page text", x.path]);
    }
  }
  const sig = items.map((i) => i[1]).join("|") + "@" + v.path;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.hidden = !items.length;
  box.replaceChildren(...items.map((item) => {
    const b = el("button", "ghost", item[0]);
    b.type = "button";
    b.title = item[1];
    b.setAttribute("aria-pressed", String(item[1] === v.path));
    b.addEventListener("click", () => dmOpenFile(v.stop, item[1], null));
    return b;
  }));
}

function dmViewerNote(text) {
  $("dm-v-note").hidden = !text;
  $("dm-v-note").textContent = text || "";
}

function dmViewerError(v, text) {
  const box = el("div", "dm-err");
  box.setAttribute("role", "alert");
  box.append(el("p", null, text));
  const retry = el("button", "ghost", "Retry");
  retry.type = "button";
  retry.addEventListener("click", () => { v.tries = 0; dmViewerLoad(); });
  box.append(retry);
  $("dm-v-body").replaceChildren(box);
  dmViewerNote("");
}

async function dmViewerLoad() {
  const v = dm.viewer;
  if (!v) return;
  const gen = ++v.gen;
  const body = $("dm-v-body");
  body.className = "";
  body.replaceChildren(el("div", "dm-busy", "Loading…"));
  dmViewerNote("");
  try {
    const res = await fetch(dmFileUrl(v.stop, v.path), { headers });
    if (gen !== v.gen) return;
    if (!res.ok) { dmViewerError(v, "Could not open this file: " + (await dmError(res))); return; }
    v.render = res.headers.get("x-charrette-render") || "text";
    v.withheld = res.headers.get("x-charrette-withheld") || "";
    if (v.render === "image" || v.render === "video") {
      const blob = await res.blob();
      if (gen !== v.gen) return;
      dmViewerMedia(v, blob, gen);
    } else if (v.render === "binary") {
      dmViewerBinary(v, res);
    } else {
      const text = await res.text();
      if (gen !== v.gen) return;
      dmViewerText(v, text, res);
    }
    dmViewerChrome();
  } catch (e) {
    if (gen === v.gen) dmViewerError(v, "Could not open this file: the charrette did not answer.");
  }
}

function dmViewerMedia(v, blob, gen) {
  const body = $("dm-v-body");
  if (v.url) URL.revokeObjectURL(v.url);
  v.url = URL.createObjectURL(blob);
  if (v.render === "video") {
    const video = el("video");
    video.controls = true;
    video.setAttribute("aria-label", "Video: " + v.path);
    video.onerror = () => { if (gen === v.gen) dmViewerError(v, "This video could not be played in this browser. Download it instead."); };
    video.src = v.url;
    body.replaceChildren(video);
    return;
  }
  body.className = v.fit ? "dm-fit" : "";
  const img = new Image();
  img.alt = "Screenshot: " + v.path;
  img.onerror = () => {
    if (gen !== v.gen) return;
    const writing = (dmStopInfo() || {}).state === "running";
    if (writing && v.tries < DM_DECODE_TRIES) {
      v.tries++;
      body.replaceChildren(el("div", "dm-busy", "This screenshot is still being written…"));
      v.timer = setTimeout(dmViewerLoad, DM_DECODE_WAIT_MS);
      return;
    }
    dmViewerError(v, "This image could not be decoded. It may be incomplete.");
  };
  img.src = v.url;
  body.replaceChildren(img);
}

function dmViewerBinary(v, res) {
  const f = dmEntry(v.stop, v.path);
  const size = Number(res.headers.get("x-charrette-size") || (f ? f.size : 0));
  const card = el("div", "dm-card");
  const dl = el("dl");
  const ext = v.path.indexOf(".") >= 0 ? v.path.split(".").pop() : "none";
  for (const pair of [["Name", v.path.split("/").pop()], ["Size", dmSize(size)], ["Type", "binary (." + ext + ")"]]) {
    dl.append(el("dt", null, pair[0]), el("dd", null, pair[1]));
  }
  card.append(dl);
  card.append(el("p", null, v.withheld ? "Download is withheld: " + v.withheld + "." : "This file is not text, so it cannot be previewed here."));
  $("dm-v-body").replaceChildren(card);
}

function dmCsv(text) {
  const sep = text.slice(0, 2000).indexOf("\t") >= 0 && text.slice(0, 2000).indexOf(",") < 0 ? "\t" : ",";
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length && rows.length < DM_CSV_ROWS; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if ((cell || row.length) && rows.length < DM_CSV_ROWS) { row.push(cell); rows.push(row); }
  return rows;
}

function dmViewerText(v, text, res) {
  const body = $("dm-v-body");
  const notes = [];
  const masked = Number(res.headers.get("x-charrette-masked") || 0);
  if (masked) notes.push(masked + (masked === 1 ? " value" : " values") + " masked");
  const cut = Number(res.headers.get("x-charrette-truncated") || 0);
  if (cut) notes.push("Showing the first " + Math.round(cut / 1024) + " KB of " + dmSize(Number(res.headers.get("x-charrette-size"))) + ". Download for the rest");
  if (v.render === "source") notes.push("Shown as source, never rendered");
  if (v.render === "markdown") {
    const box = el("div", "report");
    renderReport(box, text);
    body.replaceChildren(box);
    dmLinkCitations(box, v.stop);
  } else if (v.render === "csv") {
    const rows = dmCsv(text);
    if (!rows.length) body.replaceChildren(el("pre", null, "(empty file)"));
    else {
      const table = el("table", "dm-table");
      rows.forEach((r, i) => {
        const tr = el("tr");
        for (const c of r) tr.append(el(i ? "td" : "th", null, c));
        table.append(tr);
      });
      body.replaceChildren(table);
      if (rows.length >= DM_CSV_ROWS) notes.push("Showing the first " + DM_CSV_ROWS + " rows. Download for the rest");
    }
  } else {
    let shown = text;
    if (v.render === "json") { try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {} }
    body.replaceChildren(el("pre", null, shown || "(empty file)"));
  }
  dmViewerNote(notes.join(" · "));
}

function dmStep(delta) {
  const v = dm.viewer;
  if (!v) return;
  const seq = dmSequence(v.stop, v.path);
  const at = seq.findIndex((x) => x.path === v.path);
  const next = at < 0 ? null : seq[at + delta];
  if (next) dmOpenFile(v.stop, next.path, null);
}

function dmToggleFit() {
  const v = dm.viewer;
  if (!v) return;
  v.fit = !v.fit;
  $("dm-v-body").className = v.fit ? "dm-fit" : "";
  dmViewerChrome();
}

/** The whole masked file, with a type that can never execute in a tab. */
async function dmFullBlob(v) {
  const res = await fetch(dmFileUrl(v.stop, v.path, true), { headers });
  if (!res.ok) throw new Error(await dmError(res));
  const blob = await res.blob();
  const media = res.headers.get("x-charrette-render");
  if (media === "image" || media === "video") return blob;
  return new Blob([blob], { type: media === "binary" ? "application/octet-stream" : "text/plain;charset=utf-8" });
}

function dmNewTab() {
  const v = dm.viewer;
  if (!v) return;
  /* Opened now, inside the click, or the browser calls it a popup. */
  const tab = window.open("", "_blank");
  if (!tab) { dmViewerNote("Your browser blocked the new tab."); return; }
  tab.opener = null;
  dmFullBlob(v).then((blob) => {
    const url = URL.createObjectURL(blob);
    tab.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }).catch((e) => { tab.close(); dmViewerNote("Could not open it: " + e.message); });
}

async function dmDownload() {
  const v = dm.viewer;
  if (!v) return;
  try {
    const blob = await dmFullBlob(v);
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = v.path.split("/").pop();
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    dmViewerNote("Could not download it: " + e.message);
  }
}

function dmFocusable() {
  return [...$("dm-viewer").querySelectorAll("button, a[href], video, [tabindex='0']")]
    .filter((n) => !n.disabled && !n.closest("[hidden]"));
}

function dmKeys(e) {
  if (!dm.viewer) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dmCloseViewer(); return; }
  if (e.key === "Tab") {
    const items = dmFocusable();
    const first = items[0], last = items[items.length - 1];
    const here = document.activeElement;
    if (e.shiftKey && (here === first || here === $("dm-viewer"))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && here === last) { e.preventDefault(); first.focus(); }
    return;
  }
  if (e.target && e.target.tagName === "VIDEO") return;
  if (e.key === "ArrowRight") { e.preventDefault(); dmStep(1); }
  if (e.key === "ArrowLeft") { e.preventDefault(); dmStep(-1); }
}

/* ---------- the report's citations become links into the viewer ---------- */

function dmResolveCite(token, stop, known) {
  const t = token.trim().replace(/^\.\//, "");
  if (known.has(t)) return t;
  const marker = "/pitstops/" + stop + "/";
  const at = t.indexOf(marker);
  if (at >= 0 && known.has(t.slice(at + marker.length))) return t.slice(at + marker.length);
  if (t.indexOf("/") >= 0) return null;
  const same = [...known].filter((p) => p.split("/").pop() === t);
  return same.length === 1 ? same[0] : null;
}

function dmCiteNode(token, stop, known, mark) {
  const hit = dmResolveCite(token, stop, known);
  if (hit) {
    const b = el("button", "dm-cite", token);
    b.type = "button";
    b.title = "Open " + hit;
    b.addEventListener("click", () => dmOpenFile(stop, hit, b));
    return b;
  }
  if (mark && !/\s/.test(token.trim())) {
    const s = el("span", "dm-missing", token);
    s.append(el("i", null, "(missing)"));
    return s;
  }
  return el("code", "dm-code", token);
}

function dmLinkText(node, stop, known, mark) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  let first = mark;
  for (const t of texts) {
    const parts = t.nodeValue.split(/\x60([^\x60\n]+)\x60/);
    if (parts.length < 2) continue;
    const out = [];
    parts.forEach((part, i) => {
      if (i % 2) { out.push(dmCiteNode(part, stop, known, first)); first = false; }
      else if (part) out.push(document.createTextNode(part));
    });
    t.replaceWith(...out);
  }
}

/**
 * Only the Evidence list names files the demo promised. A path mentioned in
 * prose is usually one in the repository, and calling that "missing" is wrong.
 */
function dmLinkCitations(box, stop) {
  const list = dm.lists.get(stop);
  const known = new Set(list ? list.files.map((f) => f.path) : []);
  let evidence = false;
  for (const node of [...box.children]) {
    if (/^H[1-6]$/.test(node.tagName)) evidence = node.textContent.trim() === "Evidence";
    else if (node.tagName === "P" && /^Re-run by/.test(node.textContent)) evidence = false;
    if (node.tagName === "UL") for (const li of [...node.children]) dmLinkText(li, stop, known, evidence);
    else dmLinkText(node, stop, known, false);
  }
}

/** The decision is made at the pit stop, so the evidence is offered right there. */
async function dmPitStop(ps) {
  const b = $("dm-ps-open");
  b.hidden = false;
  b.textContent = "View demo artifacts";
  b.dataset.stop = String(ps.number);
  try {
    const list = await dmLoadList(ps.number);
    if (b.dataset.stop !== String(ps.number)) return;
    b.textContent = "View demo artifacts (" + list.files.length + ")";
    dmLinkCitations($("pitstop-report"), ps.number);
  } catch (e) {
    /* The button still opens the view, which says what went wrong. */
  }
}

/** Runs on every state poll. Costs no request while the view is closed. */
function dmTick() {
  const run = runs.length ? runs[0] : null;
  const btn = $("dm-open");
  btn.hidden = !run;
  if (!run) return;
  const live = run.sessions.some((s) => s.role === "demo" && s.state === "running");
  btn.classList.toggle("live", live);
  btn.textContent = live ? "Demo running" : "Demo";
  if (!dm.booted) {
    dm.booted = true;
    const s = dmUrlState();
    if (s.stop !== null) {
      if (s.file) history.replaceState(null, "", dmUrl(s.stop, null));
      dmShow(s.stop, false);
      if (s.file) dmOpenFile(s.stop, s.file, null);
    }
  }
}

$("dm-open").addEventListener("click", () => { if (dm.open) dmHide(true); else { dmShow(null, true); $("dm-h").focus(); } });
$("dm-back").addEventListener("click", () => dmHide(true));
$("dm-gate-go").addEventListener("click", () => dmHide(true));
$("dm-ps-open").addEventListener("click", (e) => {
  dmShow(Number(e.currentTarget.dataset.stop), true);
  $("dm-h").focus();
});
$("dm-stop").addEventListener("change", (e) => {
  dm.follow = false;
  dmSelect(Number(e.target.value));
  if (dm.open) history.replaceState(history.state, "", dmUrl(dm.stop, null));
  dmPoll();
});
$("dm-q").addEventListener("input", (e) => { dm.query = e.target.value.trim().toLowerCase(); dmRender(); });
$("dm-v-prev").addEventListener("click", () => dmStep(-1));
$("dm-v-next").addEventListener("click", () => dmStep(1));
$("dm-v-fit").addEventListener("click", dmToggleFit);
$("dm-v-tab").addEventListener("click", dmNewTab);
$("dm-v-dl").addEventListener("click", dmDownload);
$("dm-v-close").addEventListener("click", () => dmCloseViewer());
document.addEventListener("keydown", dmKeys, true);
window.addEventListener("popstate", dmFromUrl);
setInterval(dmPoll, DM_POLL_MS);
`;
