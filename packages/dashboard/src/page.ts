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
import { PINNED_ROLES } from "@harness/shared";

/**
 * What the model dropdowns offer.
 *
 * The priced tiers from `budget.ts` — a model absent from that table is billed
 * at the top tier, so offering one here would be offering the operator a saving
 * the ledger cannot see. Anthropic first because it is where the roles this
 * dropdown can actually move still live: the pinned roles are rendered without
 * a control at all (see `LOCKED_ROLES`), so nothing here is offered for
 * `reviewer` even though it now runs on Gemini. A run whose key for a vendor is
 * not exported is refused by `missingKeys` before the config is touched.
 *
 * Exported for the test that holds the first sentence to its word: nothing
 * here may be missing from `PRICES`.
 */
export const MODEL_CHOICES = [
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.8-flash",
];

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

  /*
   * The second meter: how far the run is from the thing it was asked to build.
   *
   * The money meter answers "what has this cost". An operator four days into a
   * run is asking two questions and the header only ever answered one of them,
   * which is how run bc691359 sat at "EXECUTING $1538 of $3000" for twenty
   * three merges with four unowned gaps standing against its assignment and
   * nowhere on the page saying so.
   *
   * It sits immediately left of the spend and shares its type scale, so the
   * pair reads as one instrument: how close, then how much.
   */
  .imeter { margin-left:auto; text-align:right; min-width:200px; border:1px solid transparent;
            border-radius:6px; padding:0 .4rem; margin-right:-.4rem; }
  .imeter:not([hidden]) + .meter { margin-left:1.5rem; }
  /* Inline, not stacked: the spend beside it is number-then-bar-then-note, and a
     label on its own line would put the two meters on different baselines and
     stop them reading as one instrument. */
  .imeter .lbl { color:var(--faint); font-weight:600; font-size:.6rem; letter-spacing:.16em;
                 text-transform:uppercase; font-family:var(--mono); margin-right:.35rem; }
  .imeter b { font-variant-numeric:tabular-nums; font-family:var(--mono); font-size:.9rem;
              color:var(--mute); }
  .imeter small { color:var(--dim); font-size:.72rem; display:block; }
  .imeter[data-stance="met"] b { color:var(--green); }
  .imeter[data-stance="closing"] b { color:var(--amber); }
  .imeter[data-stance="unowned"] b { color:var(--red); }
  /* Unmeasured is not a score. It gets the same faint treatment as every other
     "nobody has looked" state on this page, and never a colour that grades it. */
  .imeter[data-stance="unjudged"] b, .imeter[data-stance="plan-only"] b { color:var(--dim); }
  .imeter[role="button"] { cursor:pointer; }
  .imeter[role="button"]:hover, .imeter[role="button"]:focus-visible { border-color:var(--line2); outline:none; }

  /*
   * The completion bar shares .bar's shape with the spend beside it, and none
   * of its colouring. For money a full bar is bad; for delivery a full bar is
   * the goal, so it stays green the whole way up rather than warming to red.
   */
  .imeter .bar i { background:var(--green); box-shadow:0 0 8px color-mix(in srgb, var(--green) 55%, transparent); }
  .imeter .bar.idle i { background:repeating-linear-gradient(135deg, var(--line2) 0 2px, transparent 2px 5px);
                        box-shadow:none; width:100%; }
  /* The check's count sits beside the bar, never inside it \u2014 a gap the run is
     not closing is not a smaller percentage, it is a different fact. */
  .imeter small.bad { color:var(--red); }
  .imeter small.warn { color:var(--amber); }

  /* One row per thing the assignment asked for. */
  #intent .ms { display:flex; align-items:baseline; gap:.5rem; font-size:.72rem; padding:.24rem 0; }
  #intent .ms .t { flex:1; min-width:0; color:var(--mute); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #intent .ms.full .t { color:var(--dim); }
  #intent .ms .b { flex:none; width:72px; height:4px; background:var(--sunken); border-radius:3px;
                   overflow:hidden; box-shadow:inset 0 0 0 1px var(--line); align-self:center; }
  #intent .ms .b i { display:block; height:100%; background:var(--green); transition:width .4s; }
  #intent .ms .n { flex:none; font-family:var(--mono); font-size:.66rem; color:var(--dim);
                   font-variant-numeric:tabular-nums; min-width:2.6rem; text-align:right; }
  #intent .ms.held .n { color:var(--red); }
  /* The check's half of the panel, ruled off from the work's half. The two
     answer different questions and a reader must not run one into the other. */
  #intentgapbox { border-top:1px solid var(--line); margin-top:.7rem; padding-top:.1rem; }
  #intent h3 { font-size:.62rem; text-transform:uppercase; letter-spacing:.12em; color:var(--faint);
               margin:.7rem 0 .35rem; font-weight:600; }
  #intent h3 .n { color:var(--red); font-family:var(--mono); letter-spacing:0; }

  /* The gap list behind the meter. */
  #intent .lead { color:var(--mute); font-size:.78rem; line-height:1.5; margin:0 0 .5rem; }
  #intent .gap { display:flex; gap:.5rem; align-items:baseline; padding:.4rem 0;
                 border-top:1px solid var(--line); font-size:.76rem; line-height:1.45; }
  #intent .gap:first-of-type { border-top:none; }
  #intent .gap .chip { flex:none; font-family:var(--mono); font-size:.6rem; letter-spacing:.08em;
                       text-transform:uppercase; border:1px solid var(--line2); border-radius:3px;
                       padding:.05rem .3rem; color:var(--dim); }
  #intent .gap.g-closed .chip { color:var(--green); border-color:color-mix(in srgb, var(--green) 45%, transparent); }
  #intent .gap.g-live .chip { color:var(--amber); border-color:color-mix(in srgb, var(--amber) 45%, transparent); }
  #intent .gap.g-parked .chip, #intent .gap.g-open .chip { color:var(--red); border-color:color-mix(in srgb, var(--red) 45%, transparent); }
  #intent .gap.g-closed .txt { color:var(--dim); }
  #intent .gap .txt { min-width:0; }
  #intent .gap .who { color:var(--faint); font-family:var(--mono); font-size:.66rem; }

  /* The landmark <main> sits between body's flex column and .shell, so it is
     the flex item now — and a block box at flex:0 1 auto sizes to its content,
     which makes .shell's flex:1 resolve against nothing. body is
     overflow:hidden, so everything past the fold was clipped with no scrollbar
     anywhere: 3,498px of board in a 900px viewport, unreachable. main has to
     carry the chain it interrupted. */
  main { flex:1; min-height:0; display:flex; flex-direction:column; }
  .shell { flex:1; min-height:0; display:grid; grid-template-columns:352px minmax(0,1fr);
           gap:1.1rem; padding:1rem 1.25rem; }
  .side { overflow-y:auto; min-height:0; scrollbar-width:thin; scrollbar-color:var(--line2) transparent; }
  .feed { display:flex; flex-direction:column; min-height:0; }

  /*
   * Past 1400px the 352px column stops being a reasonable share.
   *
   * Measured on run 7ef8fb4d at 1512px: the board held 14,707px of cards in a
   * 323px-wide column while the activity feed had 1102px and was empty — the
   * feed only fills while an agent is talking, and a run spends a lot of its
   * life idle or between agents. Below this width the single column is right
   * and the wrapping is already tuned for it; above it there is simply spare
   * room, so the board takes some and lays its cards out two-up rather than
   * one 323px card at a time. The feed still gets more than half at 1512px.
   */
  @media (min-width:1400px) {
    .shell { grid-template-columns:minmax(560px, 44%) minmax(0,1fr); }
    /* .cards, not the <details> itself: a details element wraps its content
       in an anonymous box, so its cards are not grid items and every one of
       them lands in column one. #board.flat is the same layout for search
       results, which are a flat list with no group around them. */
    .grp .cards, #board.flat { display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr));
                               gap:0 .5rem; align-items:start; }
  }

  h2 { font-size:.68rem; text-transform:uppercase; letter-spacing:.12em; color:var(--dim);
       margin:0 0 .55rem; font-weight:600; display:flex; align-items:baseline; gap:.5rem;
       font-family:var(--mono); }
  h2::after { content:""; flex:1; height:1px; align-self:center;
              background:linear-gradient(90deg, var(--line), transparent); }
  /* --dim, not --faint: "4 of 10 done" and "between agents" are the readouts
     these panels exist for, and --faint measures 2.95:1 on the panel — under
     the 4.5:1 floor at this size. --faint stays for the labels that carry no
     reading of their own. */
  h2 .count { color:var(--dim); font-weight:400; letter-spacing:0; text-transform:none; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.85rem; margin-bottom:.9rem; }
  .empty { color:var(--dim); font-size:.84rem; }
  .apierr { color:var(--red); }

  .pill { font-size:.66rem; font-weight:600; letter-spacing:.05em; padding:.1rem .5rem;
          border-radius:20px; border:1px solid color-mix(in srgb, currentColor 55%, transparent);
          background:color-mix(in srgb, currentColor 9%, transparent);
          white-space:nowrap; font-family:var(--mono); }
  .s-MERGED,.s-ACCEPTED,.s-PR_REVIEW,.s-DONE { color:var(--green); }
  .s-WORKING,.s-QA,.s-EXECUTING,.s-INTEGRATING,.s-PLANNING,.s-INTAKE,.s-VERIFYING { color:var(--amber); }
  .s-NEEDS_HUMAN,.s-QA_FAILED,.s-FAILED,.s-BUDGET_HOLD,.s-LIMIT_HOLD,.s-BLOCKED { color:var(--red); }
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

  /* The board can hold sixty tasks under four collapsed groups, which is more
     than anyone reads to answer "is this already a task?". */
  .search { display:flex; gap:.35rem; align-items:center; margin:.1rem 0 .45rem; }
  .search input { flex:1; min-width:0; font:inherit; font-size:.78rem; color:var(--fg);
                  background:var(--sunken); border:1px solid var(--line); border-radius:6px;
                  padding:.28rem .5rem; }
  .search input::placeholder { color:var(--faint); }
  .search input:focus-visible { outline:none; border-color:var(--blue); }
  /* The browser's own clear button, next to ours, is two of the same control
     side by side. Ours stays: it is keyboard-reachable, it matches the page,
     and it exists in every browser. */
  .search input::-webkit-search-cancel-button { display:none; }
  .search button { flex:none; padding:.2rem .45rem; line-height:1; font-size:.95rem; }
  .searchnote { color:var(--faint); font-size:.72rem; margin:-.25rem 0 .45rem; }
  .searchnote b { color:var(--fg); font-weight:600; }
  /* Same chip as the activity feed's kind filters — the operator has already
     learned that a dimmed pill means "hidden" once. */
  .gfilter { display:flex; align-items:center; gap:.3rem; flex-wrap:wrap; margin:0 0 .5rem; }
  .gfilter button { background:transparent; color:var(--faint); border:1px solid var(--line);
                    border-radius:20px; padding:.1rem .5rem; font-size:.7rem; cursor:pointer; margin:0; }
  .gfilter button[aria-pressed="true"] { color:var(--fg); border-color:var(--dim); background:var(--panel); }
  .gfilter button .n { color:var(--faint); margin-left:.3rem; }
  .gfilter button[aria-pressed="true"] .n { color:var(--dim); }
  .gfilter .g-blocked[aria-pressed="true"] { border-color:var(--red); }
  .gfilter .g-live[aria-pressed="true"] { border-color:var(--amber); }
  .gfilter .g-done[aria-pressed="true"] { border-color:var(--green); }

  .task { border:1px solid var(--line); border-left:2px solid var(--line2); border-radius:7px;
          padding:.5rem .6rem; margin-bottom:.4rem; background:var(--sunken); overflow:hidden; }
  /* Where a match landed when it did not land in the title — the whole reason
     the search reads the spec at all. */
  .task .hit { color:var(--dim); font-size:.72rem; margin-top:.3rem; overflow-wrap:anywhere; }
  .task .hit b { color:var(--fg); font-weight:600; }
  .task .hit em { color:var(--faint); font-style:normal; text-transform:uppercase;
                  letter-spacing:.08em; font-size:.62rem; margin-right:.35rem; }
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
  /* Same reason: the task id here is how the operator names the task to
     \`harness probe\`, and it measured 3.25:1 on the card. */
  .task .sub { color:var(--dim); font-size:.72rem; margin-top:.2rem; display:flex; gap:.6rem; flex-wrap:wrap;
               font-family:var(--mono); min-width:0; }
  .task .sub span { overflow-wrap:anywhere; }
  .task .sub a { color:var(--blue); text-decoration:none; }
  .task .sub a:hover, .task .sub a:focus-visible { text-decoration:underline; }
  .task .why { color:var(--amber); font-size:.76rem; margin-top:.25rem; }
  .task .whymore { margin-top:.15rem; }
  .task .whymore summary { color:var(--dim); font-size:.72rem; cursor:pointer; }
  .task .whymore .why { white-space:pre-wrap; margin-top:.2rem; }
  /* On the one card that is addressed to the operator, so it reads as the thing
     to do next rather than as another chip. */
  .task button.answer { margin-top:.45rem; font-size:.76rem; padding:.2rem .6rem; }
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

  #gate, #budget, #sub, #taskgates, #pitstop, #paused { display:none; flex:none; border-bottom:1px solid var(--amber);
    background:linear-gradient(180deg, #191307, #140f06); border-left:3px solid var(--amber);
    padding:.9rem 1.25rem; }
  #gate h2, #budget h2, #sub h2, #taskgates h2, #pitstop h2, #paused h2 { color:var(--amber); }
  /* Nothing is waiting on the operator here — the run already stopped — so this
     one states a fact rather than asking a question, and is coloured for it. */
  #paused { border-color:var(--line); border-left-color:var(--dim);
            background:linear-gradient(180deg, #131313, #0f0f0f); }
  #paused h2 { color:var(--fg); }
  #paused p { margin:.35rem 0 .2rem; font-size:.88rem; }
  #paused code { background:var(--sunken); border-radius:4px; padding:.08rem .35rem; }
  #taskgates .tg { border:1px solid var(--line); border-radius:6px; background:var(--sunken); padding:.6rem .8rem; margin:.5rem 0; }
  #taskgates .tg b { font-size:.9rem; }
  #taskgates .tg .why { color:var(--mute); font-size:.82rem; white-space:pre-wrap; margin:.3rem 0;
                        max-height:18vh; overflow:auto; }
  #taskgates .tg small { color:var(--dim); display:block; margin-bottom:.2rem; }
  #taskgates .tg .rec { font-size:.82rem; border-left:2px solid var(--amber); padding:.15rem 0 .15rem .5rem;
    margin:.3rem 0; white-space:pre-wrap; }
  #budget p, #sub p { margin:.35rem 0 .6rem; font-size:.88rem; }
  #sub-accounts { display:flex; flex-wrap:wrap; gap:.4rem; margin:.1rem 0 .6rem; }
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

  /* The summon control. Deliberately NOT the green submit next to it: green in
     this page means approve/commit/cheap, and this one spends a demo and every
     reviewer lens. The loud button here is the free one. */
  #summon { margin-top:.55rem; border-top:1px solid var(--line); padding-top:.5rem; }
  #summon .lead { color:var(--dim); font-size:.75rem; display:block; margin-bottom:.35rem; }
  /* The scope line, not the invitation: it is the answer to "does this go to the
     task in the dropdown?", so it sits with the button and reads brighter. */
  #summon .scope { color:var(--mute); font-size:.75rem; display:block; margin:-.2rem 0 .35rem; }
  #summon .scope b { color:var(--fg); font-weight:600; }
  #summon .why { color:var(--mute); font-size:.75rem; display:block; margin-bottom:.4rem; line-height:1.45; }
  #summon .price { color:var(--faint); font-size:.72rem; display:block; margin-top:.3rem;
                   font-family:var(--mono); }
  #summon .row { display:flex; gap:.4rem; flex-wrap:wrap; }
  #summon button { font-size:.8rem; }
  #summon .go { border-color:var(--amber); color:var(--amber); }
  #summon .go:hover { border-color:var(--amber); color:var(--fg); background:color-mix(in srgb, var(--amber) 12%, transparent); }
  #summon .err { color:var(--red); }
  /* A pit stop the operator asked for that has not opened yet: pinned above the
     live agents, hollow and still, because nothing is running for it yet. */
  .queued { display:flex; gap:.5rem; align-items:baseline; padding:.3rem 0; border-bottom:1px solid var(--line); }
  .queued .dot { color:var(--amber); font-size:.7rem; }
  .queued .what { flex:1; min-width:0; }
  .queued .what b { color:var(--amber); font-weight:600; font-size:.82rem; }
  .queued .what small { display:block; color:var(--dim); font-size:.74rem; line-height:1.4; }
  .queued .q { display:block; color:var(--mute); font-size:.76rem; margin-top:.15rem;
               overflow-wrap:anywhere; font-style:italic; }

  /* Live model routing, in the Run panel next to the other frozen-config facts. */
  #models summary { cursor:pointer; color:var(--dim); font-size:.76rem; }
  #models .note { color:var(--faint); font-size:.72rem; display:block; margin:.2rem 0 .35rem; }
  #models .row { display:flex; gap:.5rem; align-items:baseline; padding:.12rem 0; font-size:.76rem;
                 font-family:var(--mono); }
  #models .row .role { color:var(--dim); min-width:6.6rem; }
  #models .row .val { color:var(--fg); }
  #models .row .val.editable { border-bottom:1px dotted var(--dim); cursor:pointer; }
  #models .row .val.editable:hover { color:var(--blue); border-bottom-color:var(--blue); }
  #models .row .lock { color:var(--faint); margin-left:auto; font-size:.7rem; }
  #models .row select { background:var(--sunken); color:var(--fg); border:1px solid var(--line);
                        border-radius:4px; padding:.1rem .2rem; font:inherit; font-size:.74rem; }
  #models .said { display:block; color:var(--dim); font-size:.72rem; margin:.1rem 0 .25rem 7.1rem; }
  #models .said.bad { color:var(--red); }
  #models .locked { border-top:1px solid var(--line); margin-top:.35rem; padding-top:.3rem; }
  #models .locked .why { color:var(--faint); font-size:.72rem; display:block; margin-top:.25rem;
                         line-height:1.45; }
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
    main { display:block; }
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
  <!-- Shown only while there is one run still working. Two clicks, because the
       first one stops every agent in the run and an operator reaching for
       "Notify me" should not be able to do that by missing. -->
  <button id="pause" class="ghost" hidden>Pause</button>
  <!-- Left of the spend, because the order the operator reads them in is the
       order the question comes in: how close is this, and what is it costing. -->
  <div class="imeter" id="intentmeter" hidden>
    <span class="lbl">intent</span>
    <b id="intentnum">&hellip;</b>
    <div class="bar" id="intentbar" role="img" aria-label="Work delivered against the assignment"><i></i></div>
    <small id="intentnote"></small>
  </div>
  <div class="meter">
    <b id="spend">$0.00</b> <span id="cap" style="color:var(--dim)" tabindex="-1"></span><input id="capinput" type="number" step="1" min="0" aria-label="New run budget cap in USD" hidden>
    <div class="bar" id="bar"><i></i></div>
    <small id="spendnote">no runs yet</small>
  </div>
</header>

<!-- Everything below the masthead, in one landmark. Without it axe reports
     \`landmark-one-main\` and 31 nodes under \`region\` — every panel on the page
     outside any landmark, so a screen reader offers no way to jump to the
     content and "skip to main" has nothing to skip to. The gates belong inside
     it too: a plan gate is the most important thing on the page while it is
     open, not an aside to it. -->
<main>

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
  <div id="gate-error" class="apierr" role="alert"></div>
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

<!--
  The other ceiling: the Claude plan behind the run rather than its dollar cap.
  The buttons for other subscriptions are rendered rather than written, because
  only the run's own config knows what they are called.
-->
<section id="sub" aria-labelledby="sub-h">
  <h2 id="sub-h">Subscription nearly spent</h2>
  <p id="sub-detail"></p>
  <div id="sub-accounts"></div>
  <button onclick="resolveSubscription('continue')">Carry on with this one</button>
  <button class="reject" onclick="resolveSubscription('park')">Stop &amp; park the run</button>
  <p id="sub-error" style="color:var(--red)" role="alert"></p>
</section>

<!--
  Not a gate: there is nothing here to answer. The run has stopped and the page
  is about to lose the process serving it, so this is the last thing it can say
  — and what it has to say is the one command that brings both back.
-->
<section id="paused" aria-labelledby="paused-h">
  <h2 id="paused-h">Paused &mdash; nothing is running</h2>
  <div id="paused-detail"></div>
  <p id="paused-note" style="color:var(--dim)">This page comes back at this same address. Leave the tab open and reload it after the resume.</p>
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
      <!--
        The question above the button says "the agent"; this one is about the
        whole run, and it reads the same textarea. Nothing said so, so the only
        project-level control on the page looked like a third thing to do to the
        task named in the dropdown.
      -->
      <div id="summon" style="display:none" aria-live="polite">
        <small class="lead">Not sure it&rsquo;s building the right thing?</small>
        <small class="scope">Asks about <b>the whole run</b>, not the task selected above.</small>
        <div id="summon-armed" style="display:none">
          <small class="why">The demo agent starts the half-built product and drives what you asked
            about, every reviewer lens reads it, then the PM answers you and recommends what to do
            next. You still make the call.</small>
        </div>
        <div class="row">
          <button type="button" class="ghost" id="summon-ask">Ask the PM&hellip;</button>
          <button type="button" class="ghost go" id="summon-go" style="display:none">Spend it &mdash; start the pit stop</button>
        </div>
        <small class="price" id="summon-price"></small>
        <small class="price err" id="summon-note"></small>
      </div>
    </div>
    <!--
      What the header meter is a summary of. Collapsed by default: it is the
      answer to a question the meter has already stated, and an operator whose
      run is on intent should not have to scroll past the reasons it is not.
    -->
    <div class="panel" id="intent" style="display:none">
      <h2>Against your intent <span class="count" id="intentcount"></span></h2>
      <p class="lead" id="intentline"></p>
      <div id="intentms"></div>
      <div id="intentgapbox" style="display:none">
        <h3 id="intentgaphead">The intent check</h3>
        <p class="lead" id="intentgapline"></p>
        <details id="intentdetails"><summary id="intentsummary">The gaps</summary>
          <div id="intentgaps"></div>
        </details>
      </div>
    </div>
    <div class="panel">
      <h2>Tasks <span class="count" id="taskcount"></span></h2>
      <div class="tbar" id="tbar" style="display:none" role="img" aria-label="Task progress">
        <i class="k-done"></i><i class="k-live"></i><i class="k-blocked"></i>
      </div>
      <div class="search" id="searchbar" style="display:none">
        <input type="search" id="tasksearch" placeholder="Search tasks&hellip;"
               aria-label="Search tasks by title, spec, acceptance criteria, files or id" autocomplete="off">
        <button type="button" class="ghost" id="searchclear" style="display:none" title="Clear (Esc)">&times;</button>
      </div>
      <div class="gfilter" id="gfilter" style="display:none" role="group" aria-label="Show or hide task groups"></div>
      <div class="searchnote" id="searchnote" style="display:none"></div>
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
</main>

<script>
const token = location.hash.slice(1);
const headers = { authorization: "Bearer " + token };
/* The roles the server refuses to move off a strong model, inlined from
   PINNED_ROLES at build time so the page and the config cannot drift. Their rows
   are rendered without any control at all — preventing the edit is better than
   validating it, and the server refuses it either way. */
const LOCKED_ROLES = ${JSON.stringify(Object.keys(PINNED_ROLES))};
/* Models the operator may route a role to. Not free text: a model id is not
   typeable from memory, and a typo surfaces as a spawn failure minutes later,
   in the log, a long way from the cause. */
const MODEL_CHOICES = ${JSON.stringify(MODEL_CHOICES)};
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
const streamCursors = new Map();
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
    // The one row in this feed that is asking rather than reporting. Questions
    // lead, because the digest is context and the questions are the thing the
    // operator can still act on — through the same feedback box they already
    // use, while the session is live. Nothing here blocks: the agent has
    // already carried on with what it recommended.
    case "agent.checkpoint": {
      const qs = (ev.questions || []).map(function (q) {
        return "Q: " + clip(q.question, 160) +
          (q.options && q.options.length ? "   [" + q.options.join(" | ") + "]" : "") +
          (q.recommended ? "   \\u2192 going with: " + clip(q.recommended, 80) : "");
      });
      const head = "checkpoint at turn " + ev.turn +
        (qs.length ? " \\u2014 " + qs.length + " open question" + (qs.length === 1 ? "" : "s") : " \\u2014 nothing open");
      return [qs.length ? "you" : "state", role || "agent",
        [head].concat(qs).concat(ev.digest ? ["state: " + clip(ev.digest, 300)] : []).join("\\n")];
    }
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
    // The operator's own actions, said back to them in the feed. Without these
    // the log shows a bare run.pitstop_requested — which is the default case
    // below, and reads as a harness internal rather than as the thing they just
    // clicked and are now waiting on.
    case "run.pitstop_requested":
      return ["state", "pitstop", "you asked for a pit stop: " + clip(ev.question, 160) +
        "   (it opens when the running tasks settle; nothing new is dispatched until it does)"];
    case "run.pitstop_cancelled":
      return ["state", "pitstop", "you called off the pit stop you asked for \\u2014 nothing was spent" +
        (ev.question ? "   (" + clip(ev.question, 120) + ")" : "")];
    // Neither of these had a case either, so the two most consequential lines in
    // a run's history — it stopped to show you something, and here is what was
    // decided on it — rendered as their own event names.
    case "run.pitstop_opened":
      return ["state", "pitstop", "pit stop " + ev.stop + (ev.summoned ? " (you asked for it)" : "") + " \\u2014 " + ev.reason +
        (ev.demoStarted ? "; the product started" : "; the product did not start")];
    case "run.pitstop_resolved":
      return [ev.action === "continue" ? "state" : "bad", "pitstop",
        "pit stop " + ev.stop + ": " + ev.action + " (" + ev.decidedBy + ")" +
        (ev.blockedOn ? ", blocked on " + ev.blockedOn : "") + (ev.why ? " \\u2014 " + clip(ev.why, 160) : "")];
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
    /* Ruling a flake out before spending a fix task on it. Falling through
       to the default printed the bare type while the harness quietly re-ran
       jobs — a feed gap exactly where the operator wonders what it is doing. */
    case "run.ci_retry":
      return ["git", "integrator", ev.reran
        ? "re-ran the failed checks on PR #" + ev.prNumber + " in case they were flakes"
        : "could not re-run the failed checks on PR #" + ev.prNumber + " \u2014 treating the failure as real"];
    /* The run's own branch against the branch it has to merge into. Falling
       through to the default here printed the bare event type, which is the
       least useful possible rendering of the one fact that decides whether the
       pull request this run produced can be merged by anybody. */
    case "run.merge_status":
      return [ev.state === "mergeable" ? "git" : "bad", "integrator",
        ev.state === "conflicting"
          ? "CANNOT MERGE into " + (ev.baseBranch || "the base branch") +
            (ev.conflicts.length ? " \u2014 " + ev.conflicts.join(", ") : "")
          : ev.state === "behind"
            ? "BEHIND " + (ev.baseBranch || "the base branch") + " \u2014 no conflict, but the base moved; bringing the branch up to date"
          : ev.state === "unknown"
            ? "mergeability unconfirmed \u2014 GitHub did not settle whether this branch merges"
            : "merges into " + (ev.baseBranch || "the base branch") +
              (ev.resolvedBy === "agent" ? " (an agent resolved the conflict)"
                : ev.resolvedBy === "merge" ? " (the base was merged in to keep it that way)" : "")];
    /* The green hold letting a red pull request have another go. Without a
       case the feed printed the bare type at the one moment an operator wants
       to know why the run is still working on a branch it already published. */
    case "run.ci_rounds_granted":
      return ["git", "integrator", (ev.by === "resume" ? "resumed: " : "pit stop: ") +
        "granted up to " + ev.rounds + " CI fix round(s) on PR #" + ev.prNumber + " \u2014 the run stays out of review until it is green"];
    case "github.issue_created":
      return ["git", ev.taskId || "run", "issue #" + ev.issueNumber];
    case "github.pr_opened":
      return ["git", ev.taskId, "PR #" + ev.prNumber + " opened \\u2014 yours to merge"];
    case "skills.injected":
      return ["tool", ev.taskId, "skills" + (ev.role ? " \\u2192 " + ev.role : "") + ": " + ev.skills.map((s) => s.name + " (" + s.mode + ")").join(", ")];
    case "skills.unresolved":
      return ["bad", ev.role, "pinned skill \\u201c" + ev.skill + "\\u201d " +
        (ev.reason === "missing" ? "is in none of this run's skillsDirs" : "changed on disk since it was indexed") +
        " \\u2014 " + (ev.role === "spec"
          ? "the spec phase is inventing its own scenarios, and the acceptance gate will hold this run to them"
          : "the " + ev.role + " agent runs without it")];
    case "run.spec_ready":
      return [
        "state",
        "spec",
        "specification ready \\u2014 " + ev.spec.requirements.length + " requirement(s), " + ev.spec.scenarios.length + " scenario(s)" +
          (ev.spec.openQuestions.length ? ", " + ev.spec.openQuestions.length + " open question(s)" : ""),
      ];
    case "run.acceptance_verdict":
      // "bad" rather than "error": the stylesheet paints k-bad red and knows
      // nothing about k-error, so a failing acceptance verdict — the loudest
      // negative signal the run has — was printing in the ordinary body colour
      // while a merge conflict beside it printed in red.
      // "no-opinion" is painted red too: it is the gate saying it proved
      // nothing, and a run that reads that as green is the one issue #115 is
      // about. Older events carry only "passed", which was true for both.
      return [(ev.verdict ? ev.verdict === "green" : ev.passed) ? "state" : "bad", "spec", "acceptance: " + ev.line];
    case "run.live_verdict":
      // The one event in a run written by something that used the product.
      return [ev.verdict === "worked" ? "state" : "bad", "live",
        ev.verdict === "worked" ? "live exercise: the critical path works \u2014 " + ev.why
        : ev.verdict === "broken" ? "live exercise: CRITICAL PATH BROKEN \u2014 " + ev.why
        : "live exercise: the product was never exercised \u2014 " + ev.why];
    case "run.closing_proof":
      return [ev.proven ? "state" : "bad", "run",
        ev.proven ? "closing gate: proven \\u2014 the run may report itself in review"
                  : "closing gate: NOT proven \\u2014 " + ev.unmet.join("; ") + (ev.held ? "" : " (holdUntilProven is off, so the run reports in review anyway)")];
    case "run.release_evidence":
      return [ev.verdict === "passed" ? "state" : "bad", "release",
        "release " + ev.releaseId + " / " + ev.phase + ": " + ev.verdict +
        (ev.sha ? " at " + ev.sha : "") + (ev.unmet.length ? " — " + ev.unmet.join("; ") : "") +
        (ev.evidencePath ? " · evidence: " + ev.evidencePath : "")];
    case "run.deploy_status":
      return [ev.state === "passing" ? "state" : "bad", "release", "deployment checks: " + ev.state + " at " + ev.sha + (ev.failing.length ? " — " + ev.failing.join(", ") : "")];
    case "run.prod_verdict":
      return [ev.verdict === "PASS" ? "state" : "bad", "release", "production validation: " + ev.verdict + " — " + ev.summary + (ev.findings.length ? " — " + ev.findings.join("; ") : "")];
    case "skills.forged":
      return ["tool", ev.taskId, ev.action + " skill \\u201c" + ev.name + "\\u201d (~" + ev.tokensApprox + " tokens) \\u2014 " + ev.path];
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

/* ---------- intent ---------- */

/*
 * How much of what was asked for is built, and what the check says is still
 * missing from it \u2014 two numbers side by side, neither one moving the other.
 *
 * Every figure here is computed in intentPosture.ts and arrives on /api/state
 * already decided. That is deliberate: this script is a string inside a
 * template literal, so nothing typechecks it and no coverage reaches it, and
 * arithmetic that has to be right does not belong in it. The page's only jobs
 * are to draw the answer and to never overstate it.
 */
const GAP_CHIP = { closed: "closed", "in-flight": "in flight", parked: "parked", unowned: "no owner" };
const GAP_CLASS = { closed: "g-closed", "in-flight": "g-live", parked: "g-parked", unowned: "g-open" };

/* Rebuilt only when it changed \u2014 a re-render several times a minute would
   otherwise take the operator's selection out of a gap they were reading. */
let intentSig = "";

function intentRun() {
  // One run, one assignment. An aggregate across runs would be a claim about no
  // particular intent, which is the same reason the cap is only editable at one.
  return runs.length === 1 && runs[0].intent ? runs[0] : null;
}

/* The count beside the bar. Never a percentage: a gap the run is not closing is
   not a smaller number, it is a different fact about the same tree. */
function intentGapNote(it) {
  if (it.judged === "nothing") return { text: "not judged yet", tone: "" };
  if (it.judged === "plan") {
    return it.gaps.length
      ? { text: "plan: " + it.gaps.length + " not covered", tone: "warn" }
      : { text: "plan covers it", tone: "" };
  }
  if (it.verdict === "UNKNOWN") return { text: "the check ran out of turns", tone: "warn" };
  const parts = [];
  if (!it.gaps.length) parts.push(it.stance === "met" ? "no gaps open" : "checked, and it disagreed");
  else parts.push(it.gaps.length + (it.gaps.length === 1 ? " gap open" : " gaps open"));
  if (it.unowned && !it.roundsLeft) parts.push("no rounds left");
  if (it.staleMerges) parts.push(it.staleMerges + " merges since");
  // Red is "nothing is happening to this"; amber is "something is, and it needs
  // you". A run closing its gaps properly should not read like one that stopped.
  return { text: parts.join(" \u00b7 "), tone: it.unowned ? "bad" : it.parked ? "warn" : "" };
}

function renderIntent() {
  const run = intentRun();
  const meter = $("intentmeter");
  const panel = $("intent");
  if (!run) {
    meter.hidden = true;
    panel.style.display = "none";
    intentSig = "";
    return;
  }
  const it = run.intent;
  const sig = JSON.stringify(it);
  meter.hidden = false;
  meter.dataset.stance = it.stance;
  if (sig === intentSig) return;
  intentSig = sig;

  // The bar is the work; nothing the check says is allowed to move it.
  const pct = it.percent;
  $("intentnum").textContent = pct === null ? "no plan yet" : pct + "% delivered";
  const bar = $("intentbar");
  bar.className = "bar" + (pct === null ? " idle" : "");
  bar.firstChild.style.width = (pct === null ? 0 : pct) + "%";
  bar.setAttribute("aria-label", it.deliveryHeadline);

  const note = intentGapNote(it);
  const noteBox = $("intentnote");
  noteBox.textContent = note.text;
  noteBox.className = note.tone;
  // Both sentences, for anyone who hovers rather than clicks.
  meter.title = it.deliveryHeadline + "\\n\\n" + it.headline;

  const openable = it.milestones.length > 0 || it.gaps.length > 0;
  if (openable) {
    meter.setAttribute("role", "button");
    meter.tabIndex = 0;
  } else {
    meter.removeAttribute("role");
    meter.tabIndex = -1;
  }
  panel.style.display = openable ? "" : "none";
  if (!openable) return;

  $("intentcount").textContent = pct === null ? "" : pct + "%";
  $("intentline").textContent = it.deliveryHeadline;

  const box = $("intentms");
  box.textContent = "";
  for (const m of it.milestones) {
    const done = m.done === m.total;
    const row = el("div", "ms" + (done ? " full" : "") + (m.parked ? " held" : ""));
    row.append(el("span", "t", m.title));
    const track = el("div", "b");
    const fill = el("i");
    fill.style.width = m.percent + "%";
    track.append(fill);
    row.append(track);
    row.append(el("span", "n", m.done + "/" + m.total));
    row.title = m.parked
      ? m.parked + " task(s) here are parked and waiting on you"
      : m.title + " \u2014 " + m.done + " of " + m.total + " merged";
    box.append(row);
  }

  // The check's half, below the work's half and visibly separate from it.
  const gapbox = $("intentgapbox");
  gapbox.style.display = it.gaps.length ? "" : "none";
  if (!it.gaps.length) return;
  $("intentgaphead").textContent =
    it.judged === "plan" ? "What the plan gate said" : "What the last check said";
  $("intentgapline").textContent = it.headline;
  $("intentsummary").textContent =
    it.judged === "plan" ? "What the plan did not cover" : "What the last check said is missing";
  const gaps = $("intentgaps");
  gaps.textContent = "";
  for (const g of it.gaps) {
    const row = el("div", "gap " + GAP_CLASS[g.status]);
    row.append(el("span", "chip", GAP_CHIP[g.status]));
    const txt = el("span", "txt", g.text);
    if (g.taskId) {
      txt.append(document.createTextNode(" "));
      txt.append(el("span", "who", g.taskId));
    }
    row.append(txt);
    gaps.append(row);
  }
}

/* The meter is the summary; this is the rest of it. Scrolling the panel into
   view matters more than opening the gap list \u2014 the sidebar is long and the
   panel is above the fold only on a short run. */
function openIntent() {
  const panel = $("intent");
  if (panel.style.display === "none") return;
  if ($("intentgapbox").style.display !== "none") $("intentdetails").open = true;
  panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** When the last running session stopped being reported; 0 while one is. */
let idleSince = 0;

/**
 * The row for a pit stop that has been asked for and has not opened yet.
 *
 * It carries the cancel, and the cancel is not a courtesy: it is the cheapest
 * undo in the product — a request that has not opened has spent nothing — and
 * it is what makes asking a low-stakes click rather than a commitment.
 */
function queuedPitStopRow(run) {
  const working = run.tasks.filter((t) => groupOf[t.state] === "live").map((t) => t.id);
  const row = el("div", "queued");
  row.append(el("span", "dot", "\\u25c7"));
  const what = el("div", "what");
  what.append(el("b", null, "pit stop \\u00b7 requested"));
  what.append(el("small", null, working.length
    ? "Starts when " + working.join(", ") + " settle" + (working.length === 1 ? "s" : "") +
      ". No new task starts until it is done."
    : "Starting now. No new task starts until it is done."));
  what.append(el("span", "q", "\\u201c" + run.pitStopRequest.question + "\\u201d"));
  row.append(what);
  const cancel = el("button", "ghost", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => postPitStop({ cancel: true }));
  row.append(cancel);
  return row;
}

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
  // Pinned above the live agents, and above the idle copy too: a run that stops
  // dispatching because a pit stop is queued would otherwise read as "between
  // agents — nothing is waiting on you", which is the opposite of true.
  for (const run of runs) if (run.pitStopRequest) box.append(queuedPitStopRow(run));
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
    // A paused run leaves its tasks in the state their sessions died in, so the
    // "live" ones above are real rows about work that has stopped. Narrating
    // them as a handover — "one finished and the next has not started" — tells
    // the operator the run is still moving, which is the one thing they clicked
    // Pause to make untrue.
    if (runs.length && runs.every((r) => r.state === "PAUSED")) {
      $("nowcount").textContent = "paused";
      box.append(el("div", "empty", busy.length
        ? "Paused. " + busy.join(", ") + " stopped mid-task and pick up from their own commits on resume."
        : "Paused. Nothing is running."));
      return;
    }
    /*
     * Say which tasks, when the answer is known.
     *
     * "The harness is waiting on you, on git, or between tasks" offers three
     * possibilities to the operator's first question, and the store has
     * already settled it: a parked task carries the reason it stopped and the
     * button that revives it. On run 7ef8fb4d that sentence sat at the top of
     * the page while two named tasks waited five hundred pixels below it. The
     * three-way hedge is right only when nothing is parked, which is when
     * nobody knows why the run is quiet.
     */
    const parked = [];
    for (const run of runs) for (const t of run.tasks) if (t.state === "NEEDS_HUMAN") parked.push(t.id);
    if (!busy.length && parked.length) {
      $("nowcount").textContent = parked.length === 1 ? "1 waiting on you" : parked.length + " waiting on you";
      const line = el("div", "empty");
      line.append(el("b", null, parked.length === 1 ? "One task is waiting on you" : parked.length + " tasks are waiting on you"));
      line.append(document.createTextNode(": " + parked.join(", ") + ". Each one is on the board below with the reason it stopped and the button that revives it."));
      box.append(line);
      return;
    }
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

/*
 * Point the composer at one task and put the cursor in it.
 *
 * The board and the composer are separate panels with no relationship the page
 * ever stated, which left the parked card — the only card on the board addressed
 * to the operator — with nothing to act with. This is the relationship: the card
 * carries the request, the composer carries the answer, and the button between
 * them says which task the answer is about.
 *
 * It scrolls rather than moving the composer, because the composer is also the
 * pit stop's question box: two of them would be two ways to spend money on a
 * page whose whole layout is built around there being one.
 */
function aimFeedbackAt(runId, taskId) {
  fbChosen = runId + "/" + taskId;
  const sel = $("fb-task");
  sel.value = fbChosen;
  // A dropdown that does not contain the option refuses the assignment silently
  // and leaves the previous target selected, which would aim the answer at the
  // wrong task. Rebuilt targets arrive on the next poll, so say so instead.
  const note = $("fb-note");
  if (sel.value !== fbChosen) {
    note.style.color = "var(--red)";
    note.textContent = "that task is not open for feedback any more \\u2014 reload the page";
    return;
  }
  note.style.color = "";
  // What the answer will actually do, which is not the same on a run that has
  // stopped: the controller only reopens a parked task while the scheduler is
  // still looping. Promising a reopen on a paused run would be a promise the
  // operator watches not happen.
  const run = runs.find((r) => r.id === runId);
  note.textContent = run && run.state === "EXECUTING"
    ? "Answering reopens " + taskId + ": your note is the guidance the next worker starts from."
    : "This run is not executing, so your note waits with the task \\u2014 the resume puts it in front of the next worker.";
  $("fb").scrollIntoView({ block: "nearest" });
  $("fb-text").focus();
}

/* ---------- summoning a pit stop ---------- */

/* Armed means the operator has clicked once and the second, spending click is
   showing. Held here rather than read off the DOM so that a poll rebuilding the
   sidebar cannot silently disarm — or, far worse, silently re-arm — the control. */
let summonArmed = false;

/* Which run the summon control acts on. There is one composer for the sidebar
   and runs are effectively one at a time, so this is the first open run — the
   same run every other control in this panel acts on. */
function summonRun() {
  return runs.length ? runs[0] : null;
}

/**
 * What a pit stop costs this run, from this run's own history rather than a
 * guess.
 *
 * A figure the operator can check beats a range they have to trust, and the
 * only honest source is what the last stop actually cost. Before there has been
 * one, the range is stated as a range and said to be an estimate — this page
 * does not know how many lenses this operator configured or how long their
 * product takes to start.
 */
function summonPrice(run) {
  const lenses = ((run.config.pitStop || {}).reviewers || []).length;
  return "a demo + " + lenses + " reviewer lens" + (lenses === 1 ? "" : "es") + " + the PM" +
    " \\u00b7 a few minutes \\u00b7 no new task starts until it is done";
}

function disarmSummon() {
  summonArmed = false;
  $("summon-armed").style.display = "none";
  $("summon-go").style.display = "none";
  $("summon-ask").textContent = "Ask the PM\\u2026";
}

/**
 * The summon control's three states: idle, armed, and a request already waiting.
 *
 * Rebuilt from the poll like everything else in this panel, and it must not
 * stamp on the operator mid-interaction — so the armed state is only ever
 * cleared here when the thing it would have bought already exists.
 */
function renderSummon() {
  const run = summonRun();
  const box = $("summon");
  if (!run || (run.state !== "EXECUTING" && run.state !== "INTEGRATING")) {
    box.style.display = "none";
    disarmSummon();
    return;
  }
  box.style.display = "block";
  const price = $("summon-price");
  const ask = $("summon-ask");
  if (run.pitStopRequest) {
    // Already waiting. Arming again would offer to buy a second one, and the
    // controller would only replace the question — so the button says what the
    // free action is instead, and the queued row above carries the cancel.
    disarmSummon();
    ask.disabled = true;
    ask.textContent = "Ask the PM\\u2026";
    price.textContent = "A pit stop is already queued \\u2014 cancel it above to change the question.";
    return;
  }
  ask.disabled = false;
  price.textContent = summonArmed ? summonPrice(run) : "";
}

/** First click: arm. Second click on the same button: stand down. */
function armSummon() {
  if (summonArmed) { disarmSummon(); $("summon-price").textContent = ""; return; }
  const note = $("summon-note");
  note.textContent = "";
  // Requiring the question before arming, not after: a pit stop asking "is this
  // fine?" is the single most likely way to waste one, and the cheapest moment
  // to stop it is before the spending button has ever been shown.
  if (!$("fb-text").value.trim()) {
    note.textContent = "write the question the PM should answer in the box above";
    $("fb-text").focus();
    return;
  }
  summonArmed = true;
  $("summon-armed").style.display = "block";
  $("summon-go").style.display = "inline-block";
  // Cancel takes the slot the first click was at, so a double-click lands on
  // standing down rather than on spending.
  $("summon-ask").textContent = "Cancel";
  $("summon-price").textContent = summonPrice(summonRun());
  $("summon-go").focus();
}

async function postPitStop(payload) {
  const run = summonRun();
  if (!run) return;
  const note = $("summon-note");
  const res = await fetch("/api/runs/" + encodeURIComponent(run.id) + "/pitstop", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers),
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  note.className = "price" + (res.ok ? "" : " err");
  note.textContent = res.ok ? body.message || "" : body.error || "could not reach the run";
  if (res.ok && !payload.cancel) $("fb-text").value = "";
  disarmSummon();
  refresh();
}

/* ---------- pausing the run ---------- */

/*
 * The run this page can stop: exactly one, and still working.
 *
 * Several runs at once is the standalone dashboard browsing a repository's
 * history, and a single Pause button there would be choosing between them on
 * the operator's behalf. One is the case the button exists for.
 */
function pausableRun() {
  const working = runs.filter((r) => r.state === "EXECUTING" || r.state === "INTEGRATING");
  return working.length === 1 ? working[0] : null;
}

/* Clicked once and waiting for the second. */
let pauseArmed = false;
/* The run the pause has already been asked for, so the button keeps saying so
   for the seconds it takes the agents to reach their next message. */
let pauseSentFor = "";
let pauseDisarm = 0;
/* What the server said about it, and whether that was a refusal.
 *
 * It goes in the panel below rather than in the header's status line, which is
 * rebuilt by renderHeader() on the very next poll — and the pause triggers one
 * immediately, so a sentence put there was gone before it was read.
 */
let pauseSaid = "";
let pauseRefused = false;

function disarmPause() {
  pauseArmed = false;
  clearTimeout(pauseDisarm);
}

function renderPause() {
  const btn = $("pause");
  const run = pausableRun();
  if (!run) {
    // The run stopped, finished, or there is more than one. Either way the
    // authorisation the armed button was carrying is about nothing now.
    btn.hidden = true;
    disarmPause();
    pauseSentFor = "";
    pauseSaid = "";
    return;
  }
  btn.hidden = false;
  const sent = pauseSentFor === run.id;
  btn.disabled = sent;
  btn.className = pauseArmed ? "reject" : "ghost";
  btn.textContent = sent ? "Pausing\\u2026" : pauseArmed ? "Stop the run?" : "Pause";
}

/* First click arms, second stops the run. */
async function clickPause() {
  const run = pausableRun();
  if (!run || pauseSentFor === run.id) return;
  if (!pauseArmed) {
    pauseArmed = true;
    // It stands down on its own: an armed button left on screen becomes an
    // ordinary-looking button again by the time anyone comes back to it.
    pauseDisarm = setTimeout(() => { disarmPause(); renderPause(); }, 6000);
    renderPause();
    return;
  }
  disarmPause();
  /* No content-type: there is no content. The other posts on this page all
     carry a body, and copying their headers here is what made this button
     answer 400 instead of stopping the run. */
  const res = await fetch("/api/runs/" + encodeURIComponent(run.id) + "/pause", {
    method: "POST",
    headers: headers,
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) pauseSentFor = run.id;
  pauseRefused = !res.ok;
  pauseSaid = res.ok ? body.message || "pausing" : body.error || "could not reach the run";
  renderPause();
  renderPaused();
  refresh();
}

/* What the page says while the run is stopping, and once it has stopped. */
function renderPaused() {
  const paused = runs.filter((r) => r.state === "PAUSED");
  const box = $("paused-detail");
  $("paused").style.display = paused.length || pauseSaid ? "block" : "none";
  // Only the stopped run gets the resume instruction. Saying it while agents
  // are still finishing their turn would be telling the operator to start a
  // second harness against a repository this one still holds worktrees in.
  $("paused-h").textContent = paused.length ? "Paused \\u2014 nothing is running" : "Stopping the run\\u2026";
  $("paused-note").style.display = paused.length ? "block" : "none";
  box.textContent = "";
  if (!paused.length) {
    if (pauseSaid) {
      const p = el("p", null, pauseSaid);
      if (pauseRefused) p.style.color = "var(--red)";
      box.append(p);
    }
    return;
  }
  for (const run of paused) {
    const p = el("p", null, null);
    p.append("Run " + run.id + " is paused. Pick it up with ");
    p.append(el("code", null, "harness resume " + run.id));
    p.append(" \\u2014 every commit its agents made is still in their worktrees.");
    box.append(p);
  }
}

/* ---------- live model routing ---------- */

/* The role whose row is currently an open <select>, so a rebuild can leave it
   alone. Same problem the feedback target has, and the same shape of answer. */
let editingRole = "";
/* What the server said about the last edit, keyed by role, so the sentence sits
   under the row that produced it rather than in a shared status line. */
const modelSaid = {};

async function saveModel(run, role, model) {
  const res = await fetch("/api/runs/" + encodeURIComponent(run.id) + "/models", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers),
    body: JSON.stringify({ role: role, model: model }),
  });
  const body = await res.json().catch(() => ({}));
  // The server is the authority on what the next agent will actually run, so a
  // refusal reverts the row rather than leaving the operator's choice showing.
  modelSaid[role] = { text: res.ok ? body.message : body.error || "could not re-route", ok: res.ok };
  editingRole = "";
  modelSig = "";
  refresh();
}

let modelSig = "";

/**
 * The run's model-per-role table, editable for the rest of the run.
 *
 * The four pinned roles are rendered as text with no control at all. Refusing
 * the edit at the server and never offering it are both correct; doing both is
 * what stops a stale tab from being the only thing between a cheap model and
 * the agent that decides whether work is shippable.
 */
function renderModels(run, box) {
  const models = run.config.models;
  // A run whose stored config predates the routing table has nothing to show
  // and nothing to edit. Rendering an empty disclosure would be worse than
  // rendering none — it would read as "this run uses no models".
  if (!models) return;
  const roles = Object.keys(models);
  if (!roles.length) return;
  const open = roles.filter((r) => LOCKED_ROLES.indexOf(r) === -1);
  const changed = open.filter((r) => modelSaid[r] && modelSaid[r].ok).length;

  const d = el("details");
  d.id = "models";
  d.open = openModels.has(run.id);
  d.addEventListener("toggle", () => {
    if (d.open) openModels.add(run.id);
    else openModels.delete(run.id);
  });
  d.append(el("summary", null, "Models \\u00b7 " + roles.length + " roles" + (changed ? " \\u00b7 " + changed + " changed" : "")));
  d.append(el("small", "note", "affects agents started from now on"));

  const row = (role, locked) => {
    const r = el("div", "row");
    r.append(el("span", "role", role));
    if (locked) {
      r.append(el("span", "val", models[role]));
      r.append(el("span", "lock", "locked"));
      return r;
    }
    if (editingRole === role) {
      const sel = el("select");
      sel.setAttribute("aria-label", "Model for the " + role + " role");
      const choices = MODEL_CHOICES.indexOf(models[role]) === -1 ? [models[role]].concat(MODEL_CHOICES) : MODEL_CHOICES;
      for (const m of choices) {
        const o = el("option", null, m);
        o.value = m;
        sel.append(o);
      }
      sel.value = models[role];
      sel.addEventListener("change", () => { if (sel.value !== models[role]) saveModel(run, role, sel.value); });
      sel.addEventListener("keydown", (e) => { if (e.key === "Escape") { editingRole = ""; modelSig = ""; renderRunInfo(); } });
      r.append(sel);
      return r;
    }
    const val = el("span", "val editable", models[role]);
    val.tabIndex = 0;
    val.setAttribute("role", "button");
    val.setAttribute("aria-label", "Model for the " + role + " role: " + models[role] + ". Change it.");
    const edit = () => { editingRole = role; modelSig = ""; renderRunInfo(); };
    val.addEventListener("click", edit);
    val.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); edit(); } });
    r.append(val);
    return r;
  };

  for (const role of open) {
    d.append(row(role, false));
    if (modelSaid[role]) d.append(el("small", "said" + (modelSaid[role].ok ? "" : " bad"), modelSaid[role].text));
  }
  const locked = el("div", "locked");
  for (const role of roles) if (LOCKED_ROLES.indexOf(role) !== -1) locked.append(row(role, true));
  locked.append(el("small", "why", "These decide whether work is correct or shippable. A cheap model here is how bad work merges."));
  d.append(locked);
  box.append(d);
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

/*
 * A task whose session was stopped by the operator rather than by finishing.
 *
 * Derived rather than stored: pausing does not move the task, because leaving it
 * WORKING is exactly what tells a resume to requeue it from its own commits.
 * Read by the card and by the signature below, from one place, because a card
 * that renders on a value its signature does not include is a card that never
 * rebuilds — which is how the pill went on saying WORKING on a stopped run
 * through every poll, in a browser, with the panel above it saying "paused".
 */
function taskStopped(t, run) {
  return run.state === "PAUSED" && groupOf[t.state] === "live";
}

/**
 * What the operator typed into the board's search box.
 *
 * The question it answers is "is this already a task?", asked of a plan the
 * operator approved days ago and a board of sixty cards under four collapsed
 * groups. Two real ones: a refresh button nobody could find in a 59-task run,
 * and DNSSEC in a 55-task one. Both were answerable in a second and neither
 * was answerable by reading.
 */
let taskQuery = "";

/**
 * Task groups the operator has switched off.
 *
 * Cancelled is the one that prompted this: it is dead weight on a long board,
 * it never becomes interesting again, and it sits between the operator and the
 * groups that do change. Collapsing its disclosure is not the same thing — a
 * collapsed group still counts, still takes a row, and reopens itself in the
 * next reading. Hiding is a decision that stays made.
 *
 * Not persisted across a reload, deliberately: this is a reading posture for
 * the next few minutes, and a filter that survives a refresh is one the
 * operator forgets is on and then reads a board that is lying to them.
 */
const hiddenGroups = new Set();

/**
 * Where a task can match, in the order the result prefers to report.
 *
 * The spec and the criteria are the point. A title search would have missed
 * the refresh question entirely — the run had no task titled anything like it,
 * and the word only appears inside two other tasks' specs, which is itself the
 * answer: it was folded into other work rather than planned as its own task.
 * Reading a field the card does not show is why a hit line exists.
 */
const SEARCHABLE = [
  ["title", (t) => t.title],
  ["id", (t) => t.id],
  ["spec", (t) => t.spec],
  ["criteria", (t) => (t.acceptanceCriteria || []).join(" \\u2022 ")],
  ["files", (t) => (t.touchedPaths || []).join(" ")],
  ["why", (t) => t.errorSummary],
];

/** The first field of this task the query appears in, or null for no match. */
function taskHit(t, q) {
  for (const pair of SEARCHABLE) {
    const text = pair[1](t);
    if (!text) continue;
    const at = String(text).toLowerCase().indexOf(q);
    if (at >= 0) return { field: pair[0], text: String(text), at: at, len: q.length };
  }
  return null;
}

/**
 * The matched text in context, with the match itself picked out.
 *
 * Only rendered for a match the card does not already show. A hit line under a
 * title that visibly contains the word is noise, and the operator scanning
 * results reads one of these per card.
 */
function hitRow(hit) {
  const row = el("div", "hit");
  row.append(el("em", null, hit.field));
  const from = Math.max(0, hit.at - 60);
  const end = hit.at + hit.len;
  const tidy = (s) => s.replace(/\\s+/g, " ");
  row.append(document.createTextNode((from ? "\\u2026" : "") + tidy(hit.text.slice(from, hit.at))));
  row.append(el("b", null, hit.text.slice(hit.at, end)));
  row.append(document.createTextNode(tidy(hit.text.slice(end, end + 90)) + (hit.text.length > end + 90 ? "\\u2026" : "")));
  return row;
}

function cardSig(t, run, isDone, hit) {
  return JSON.stringify([
    t.state, t.title, t.id, t.dependsOn, t.qaIterations, t.githubIssueNumber, t.prNumber,
    t.assignedSkills, t.errorSummary, t.spec, t.acceptanceCriteria, run.githubRepo, isDone,
    taskStopped(t, run),
    // A card built before the search ran carries no hit line, and a card built
    // for one query must not be handed back for the next.
    hit ? hit.field + ":" + hit.at + ":" + hit.len : "",
  ]);
}

function cardFor(t, run, isDone, kept, hit) {
  const key = run.id + "/" + t.id;
  const sig = cardSig(t, run, isDone, hit);
  const had = cards.get(key);
  const entry = had && had.sig === sig ? had : { sig: sig, node: taskCard(t, run, isDone, hit) };
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
    // The cards live in a box of their own so a wide viewport can lay them out
    // in columns. A <details> wraps its content in an anonymous box, so making
    // the disclosure itself a grid puts every card in the first column.
    sec.append(el("div", "cards"));
    groups.set(g.key, sec);
  }
  sec.querySelector("summary .n").textContent = " " + count;
  return sec;
}

function renderBoard() {
  const box = $("board");

  const q = taskQuery;
  const buckets = {};
  // Progress is a fact about the run, not about the search. Counted before the
  // filter so the bar and "12 of 59 done" do not shrink to whatever was typed.
  const counts = {};
  for (const g of GROUPS) { buckets[g.key] = []; counts[g.key] = 0; }
  let total = 0;
  let shown = 0;
  let matched = 0;
  for (const run of runs) {
    total += run.tasks.length;
    for (const t of run.tasks) {
      const key = groupOf[t.state] ?? "todo";
      counts[key]++;
      if (hiddenGroups.has(key)) continue;
      shown++;
      const hit = q ? taskHit(t, q) : null;
      if (q && !hit) continue;
      matched++;
      buckets[key].push({ t, run, hit });
    }
  }
  // The box and the chips only appear once there is something to search or
  // filter; the note under them only while one of the two is on.
  $("searchbar").style.display = total ? "flex" : "none";
  renderGroupFilter(counts, total);
  renderSearchNote(q, matched, shown, total);

  if (!total || !matched) {
    box.textContent = "";
    cards = new Map();
    // A search that found nothing is a real answer — "no task covers this" —
    // and must not read as an empty board or a run that has not planned yet.
    if (q) box.append(el("div", "empty", "No task matches \\u201c" + q + "\\u201d."));
    // Not "no tasks": there are tasks, and the operator switched them off. A
    // board that goes blank without saying why reads as a bug.
    else if (total) box.append(el("div", "empty", "Every group is hidden. Switch one back on above."));
    else {
      for (const run of runs) box.append(el("div", "empty", phaseHint(run.state)));
      if (!runs.length) box.append(el("div", "empty", "No tasks yet."));
    }
    // A search that matched nothing has not undone the run's progress. Only an
    // actually empty board has no progress to show.
    if (total) renderProgress(counts, total);
    else {
      $("taskcount").textContent = "";
      $("tbar").style.display = "none";
    }
    return;
  }

  // Rebuilt from what is on the board now, so a task that goes away takes its
  // cached node with it rather than waiting to be handed back to a later run.
  const kept = new Map();
  if (q) {
    // Results are a flat list, most urgent group first. Grouping them would put
    // the answer behind the same disclosures that made the question hard, and
    // forcing those open would quietly discard which ones the operator closed —
    // the state pill on each card carries what the group heading would have.
    const found = [];
    for (const g of GROUPS) for (const item of buckets[g.key]) found.push(item);
    box.classList.add("flat");
    syncChildren(box, found.map((item) => cardFor(item.t, item.run, groupOf[item.t.state] === "done", kept, item.hit)), 0);
  } else {
    box.classList.remove("flat");
    const sections = [];
    for (const g of GROUPS) {
      const items = buckets[g.key];
      if (!items.length) continue;
      const sec = groupFor(g, items.length);
      syncChildren(sec.querySelector(".cards"), items.map((item) => cardFor(item.t, item.run, g.key === "done", kept)), 0);
      sections.push(sec);
    }
    syncChildren(box, sections, 0);
  }
  cards = kept;

  renderProgress(counts, total);
}

/**
 * Done / in flight / blocked, as a share of the work still standing.
 *
 * Cancelled tasks are out of the denominator. Run 7ef8fb4d read "24 of 71
 * done" with 33 of those 71 cancelled — 34%, when 24 of the 38 tasks that can
 * still be done were done, which is 63%. Cutting scope made the run look like
 * it had gone backwards, and cutting scope is how a run is supposed to end
 * well. The cancelled count is still printed, because dropping it from the
 * denominator silently would be its own kind of lie.
 */
function renderProgress(counts, total) {
  const standing = total - counts.gone;
  $("taskcount").textContent = standing
    ? counts.done + " of " + standing + " done" + (counts.gone ? " \\u00b7 " + counts.gone + " cancelled" : "")
    : total + " cancelled";
  const bar = $("tbar");
  bar.style.display = "flex";
  // Nothing standing means nothing to draw a share of; an all-cancelled run
  // gets an empty bar rather than three NaN widths.
  const pct = (n) => (standing ? (n / standing) * 100 : 0) + "%";
  bar.children[0].style.width = pct(counts.done);
  bar.children[1].style.width = pct(counts.live);
  bar.children[2].style.width = pct(counts.blocked);
}

/**
 * One chip per group, carrying its whole-run count, switching it off.
 *
 * The count is the group's real size, not the filtered or searched one — a
 * chip that read "Cancelled 0" while hiding four cancelled tasks would be the
 * one thing on this bar that is not true.
 */
function renderGroupFilter(counts, total) {
  const bar = $("gfilter");
  bar.style.display = total ? "flex" : "none";
  const chips = [];
  for (const g of GROUPS) {
    if (!counts[g.key]) continue;
    const on = !hiddenGroups.has(g.key);
    const b = el("button", "g-" + g.key, g.label);
    b.type = "button";
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.title = on ? "Hide " + g.label.toLowerCase() : "Show " + g.label.toLowerCase();
    b.append(el("span", "n", String(counts[g.key])));
    b.addEventListener("click", () => {
      if (hiddenGroups.has(g.key)) hiddenGroups.delete(g.key);
      else hiddenGroups.add(g.key);
      renderBoard();
    });
    chips.push(b);
  }
  syncChildren(bar, chips, 0);
}

/**
 * How much of the board is hidden, and by which of the two things that hide it.
 *
 * Always says the denominator. "3 tasks" alone leaves the operator wondering
 * whether the other fifty-six were checked, and the whole value of the answer
 * is knowing the search read all of them. When a group filter is also on, the
 * denominator is what the filter left — and it says so, because a search that
 * silently skipped a hidden group would answer "no" to a question it never
 * asked.
 */
function renderSearchNote(q, matched, shown, total) {
  const note = $("searchnote");
  $("searchclear").style.display = q ? "block" : "none";
  const filtered = total - shown;
  if (!q && !filtered) { note.style.display = "none"; note.textContent = ""; return; }
  note.style.display = "block";
  note.textContent = "";
  const say = (s) => note.append(document.createTextNode(s));
  const tasks = (n) => " task" + (n === 1 ? "" : "s");

  if (!q) {
    note.append(el("b", null, String(filtered)));
    say(tasks(filtered) + " hidden by the group filter.");
    return;
  }
  if (!matched) {
    say("No match in ");
    note.append(el("b", null, String(shown)));
    say(tasks(shown) + " \\u2014 titles, specs, criteria, files and ids all read.");
  } else {
    note.append(el("b", null, String(matched)));
    say(" of " + shown + tasks(shown) + " match. Grouping is off while searching; each card keeps its state.");
  }
  if (filtered) say(" " + filtered + " more " + (filtered === 1 ? "is hidden by the group filter and was" : "are hidden by the group filter and were") + " not searched.");
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

function taskCard(t, run, isDone, hit) {
  const card = el("div", "task st-" + t.state + (isDone ? " done" : ""));
  const top = el("div", "top");
  top.append(el("span", "title", t.title));
  // The pill must not report a stopped task as an agent at work: an amber
  // WORKING on a run that has stopped reads as "the Pause button did nothing".
  const stopped = taskStopped(t, run);
  top.append(el("span", "pill s-" + (stopped ? "PAUSED" : t.state), stopped ? "PAUSED" : t.state));
  card.append(top);
  const sub = el("div", "sub");
  sub.append(el("span", null, t.id));
  if (t.dependsOn.length) sub.append(el("span", null, "after " + t.dependsOn.join(", ")));
  if (t.qaIterations) sub.append(el("span", null, "QA \\u00d7" + t.qaIterations));
  if (t.githubIssueNumber) sub.append(gh(run.githubRepo, "issues", t.githubIssueNumber, "issue #" + t.githubIssueNumber));
  if (t.prNumber) sub.append(gh(run.githubRepo, "pull", t.prNumber, "PR #" + t.prNumber));
  card.append(sub);
  // Only when the match is somewhere the card does not already show it. A hit
  // line under a title that visibly contains the word is noise.
  if (hit && hit.field !== "title" && hit.field !== "id") card.append(hitRow(hit));
  if (t.assignedSkills.length) card.append(skillsRow(t.assignedSkills));
  if (t.errorSummary) {
    // Clipped, but no longer *only* clipped: a parked task's reason is the case
    // for and against reviving it, and it was being cut mid-sentence with no way
    // to read the rest. The full text goes in a disclosure under it.
    const short = clip(t.errorSummary, 220);
    card.append(el("div", "why", short));
    if (short !== t.errorSummary) {
      const key = run.id + "/" + t.id + "/why";
      const more = el("details", "whymore");
      more.open = openTasks.has(key);
      more.addEventListener("toggle", () => {
        if (more.open) openTasks.add(key);
        else openTasks.delete(key);
      });
      more.append(el("summary", null, "the rest of the reason"));
      more.append(el("p", "why", t.errorSummary));
      card.append(more);
    }
  }
  // A parked task is the one card on this board that is *addressed to* the
  // operator, and it had nothing on it to act with: the control that revives it
  // is the composer two panels up, behind a dropdown listing every open task,
  // with nothing anywhere saying that answering there is what reopens this. The
  // button does not revive on its own — it aims the composer at this task, so
  // what reopens the task is still the operator's actual answer.
  if (t.state === "NEEDS_HUMAN") {
    const answer = el("button", "ghost answer", "Answer this\\u2026");
    answer.type = "button";
    // The run's state is read at click time rather than closed over: what an
    // answer *does* depends on whether the run is still executing, and the card
    // is cached across polls that change exactly that.
    answer.addEventListener("click", () => aimFeedbackAt(run.id, t.id));
    card.append(answer);
  }

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
    ended = ended || ["PR_REVIEW", "BLOCKED", "INTEGRATING", "VERIFYING", "DONE"].includes(run.state);
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
/** Same, for the model table — it is the disclosure an operator watching spend
 *  leaves open, and snapping it shut every 5s would make it unusable. */
const openModels = new Set();

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
    // The model table lives in this panel, so its values — and the two bits of
    // local state that decide how a row is drawn — belong in the signature.
    // Without them a re-route saves and the row still shows the old model until
    // some unrelated fact happens to change.
    JSON.stringify(run.config.models), editingRole, modelSig,
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
    renderModels(run, box);
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
  // The run finished its task list and could not prove the product: a red or
  // opinionless acceptance suite, an intent check that failed or never
  // finished, or nothing merged at all. It is asking for help, not a review.
  BLOCKED:     ["waiting", "The run ran out of tasks without proving the product. The activity feed has what is unmet; fix it and resume."],
  // Merged, but the cycle did not close: the deploy went red, or production
  // disagreed. Both need the operator, and neither is visible from the repo.
  VERIFYING:   ["waiting", "Following the release through merge, deployment and production checks. Production delivery is not yet proven; the activity feed has the reason."],
  DONE:        ["done", "Merged, deployed, and verified against production."],
  FAILED:      ["failed", "The run stopped on an error. The activity feed has the reason."],
  ABORTED:     ["aborted", "The run was cancelled."],
  PAUSED:      ["paused", "The run is parked and will not continue on its own."],
  BUDGET_HOLD: ["waiting", "The budget cap was reached. Raise it or stop the run."],
  // Parked on quota rather than on money, and the difference matters to whoever
  // reads this: no number they can type un-parks it — another subscription, or
  // a date on the calendar, does.
  LIMIT_HOLD:  ["waiting", "The Claude subscription is nearly spent. Resume on another account, or after the window resets."],
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
/** The subscription gate already on screen, so it is drawn (and notified) once. */
let subShown = null;
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

/**
 * An interruption that is not a run-state change — a pit stop opening, or the
 * account behind the run running out.
 *
 * The label is what the tab says, and it is a parameter rather than the constant
 * it used to be because a second caller arrived: a tab reading "pit stop" while
 * the run is actually parked on quota tells the operator the one thing they
 * would act on differently.
 */
function notify(title, body, label) {
  const where = repoName() || "harness";
  titleOverride = where + " \\u00b7 " + label;
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

let refreshPending = null;
function refresh() {
  if (!refreshPending) refreshPending = refreshState().finally(() => { refreshPending = null; });
  return refreshPending;
}

async function refreshState() {
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
    notify("Pit stop " + ps.number, ps.reason + " \\u2014 come and look", "pit stop");
  }
  const bg = data.budgetGate;
  $("budget").style.display = bg ? "block" : "none";
  if (bg) {
    $("budget-detail").textContent =
      "The run cap of $" + bg.capUsd.toFixed(2) + " was reached: $" + bg.spentUsd.toFixed(2) + " spent. " +
      "The agent is paused, not cancelled — raise the cap in the header above to continue.";
  }
  const sg = data.subscriptionGate;
  $("sub").style.display = sg ? "block" : "none";
  // Rendered once per gate rather than on every poll: refresh() runs on a timer
  // and on every streamed event, and rebuilding the buttons under the operator's
  // cursor is how a click lands on nothing.
  //
  // Keyed on the whole payload, not on its summary. Two gates in a row can read
  // identically and offer completely different accounts — which is not an exotic
  // case but the *normal* one, because the gate that follows a switch is asking
  // about the account the switch just moved to. Keyed on the summary, the second
  // gate kept the first one's buttons: the operator clicked "Continue on work"
  // on a gate that no longer offered it and got "unknown subscription account".
  // A payload does not change while its gate is open, so this still redraws once.
  const sgKey = sg ? JSON.stringify(sg) : null;
  if (sg && sgKey !== subShown) {
    subShown = sgKey;
    renderSubscription(sg);
    notify("Subscription nearly spent", sg.summary + " — the run is paused and waiting for you", "subscription");
  }
  if (!sg) subShown = null;
  renderHeader(); renderIntent(); renderNow(); renderFeedback(); renderSummon(); renderPause(); renderPaused(); renderBoard(); renderPrs(); renderRunInfo();
  for (const run of runs) stream(run.id);
}

async function stream(runId) {
  if (streaming.has(runId)) return;
  streaming.add(runId);
  let reader;
  try {
    const res = await fetch("/api/runs/" + encodeURIComponent(runId) + "/events?after=" + (streamCursors.get(runId) || 0), { headers });
    if (!res.ok || !res.body) return;
    reader = res.body.getReader();
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
        const id = frame.split("\\n").find((l) => l.indexOf("id: ") === 0);
        const seq = id ? Number(id.slice(4)) : 0;
        if (seq && seq <= (streamCursors.get(runId) || 0)) continue;
        const ev = JSON.parse(data.slice(6));
        append(ev);
        if (Number.isSafeInteger(seq) && seq > 0) streamCursors.set(runId, seq);
        if (ev.type === "run.state_changed") notifyRunState(ev);
        if (ev.type.indexOf("state_changed") >= 0 || ev.type.indexOf("gate_") >= 0 ||
            ev.type === "agent.spawned" || ev.type === "agent.ended" || ev.type === "agent.usage") refresh();
      }
    }
  } catch (e) {
    // The next state poll reconnects from the last rendered event. A dropped
    // connection must not become an unhandled promise rejection.
  } finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    streaming.delete(runId);
  }
}

async function resolveGate(approved) {
  const buttons = [...$("gate").querySelectorAll("button")];
  if (buttons.some((b) => b.disabled)) return;
  buttons.forEach((b) => { b.disabled = true; });
  const error = $("gate-error");
  error.textContent = "";
  try {
    const res = await fetch("/api/gates/plan", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, headers),
      body: JSON.stringify({ approved: approved, feedback: $("gate-feedback").value }),
    });
    if (!res.ok) {
      error.textContent = (await res.json().catch(() => ({}))).error || "Could not submit the plan decision (HTTP " + res.status + "). Try again.";
      return;
    }
    $("gate-feedback").value = "";
    await refresh();
  } catch (e) {
    error.textContent = "Could not reach the harness. Your feedback is saved here; reconnect and try again.";
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

/**
 * The subscription gate's body and its one-button-per-account row.
 *
 * The account buttons come first and are the plain (not "reject") style: they
 * are the answer that keeps the run moving, and the operator who configured a
 * second subscription configured it for exactly this moment. A run with none
 * configured is told so, because "carry on or park" with no third option looks
 * like a missing feature rather than a missing config.
 */
function renderSubscription(sg) {
  $("sub-detail").textContent =
    sg.summary + ". That is past the " + sg.pauseAtPercent + "% line, and the window reopens in " + sg.untilReset + ". " +
    "The agents are paused, not cancelled" + (sg.account ? ' — this run is spending "' + sg.account + '".' : ".");
  const row = $("sub-accounts");
  row.textContent = "";
  for (const name of sg.alternatives) {
    const b = el("button", null, "Continue on " + name);
    b.onclick = () => resolveSubscription("switch", name);
    row.append(b);
  }
  if (!sg.alternatives.length) {
    row.append(el("small", "lead", "No other subscriptions are configured — add one under subscription.accounts to be able to switch here."));
  }
}

async function resolveSubscription(action, account) {
  const res = await fetch("/api/gates/subscription", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers),
    body: JSON.stringify({ action: action, account: account }),
  });
  $("sub-error").textContent = res.ok ? "" : ((await res.json().catch(() => ({}))).error || "could not resolve the gate");
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
$("intentmeter").addEventListener("click", openIntent);
$("intentmeter").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIntent(); } });
$("pause").addEventListener("click", clickPause);
$("summon-ask").addEventListener("click", armSummon);
$("summon-go").addEventListener("click", () => postPitStop({ question: $("fb-text").value.trim() }));
/* Editing the question after arming disarms: the armed button was offered for
   the sentence that was in the box when it was clicked, and a control that keeps
   its authorisation across a rewrite is authorising something nobody read. */
$("fb-text").addEventListener("input", () => { if (summonArmed) { disarmSummon(); $("summon-price").textContent = ""; } });
/* Straight to renderBoard, not through a poll: the data is already here, and a
   search box that answers on the next 5s tick is one the operator types into
   twice. */
function runSearch(text) {
  taskQuery = text.trim().toLowerCase();
  renderBoard();
}
$("tasksearch").addEventListener("input", (e) => runSearch(e.target.value));
$("searchclear").addEventListener("click", () => { $("tasksearch").value = ""; runSearch(""); $("tasksearch").focus(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (summonArmed) { disarmSummon(); $("summon-price").textContent = ""; }
  if (pauseArmed) { disarmPause(); renderPause(); }
  if (taskQuery) { $("tasksearch").value = ""; runSearch(""); }
});
refresh();
setInterval(refresh, 5000);
setInterval(renderNow, 1000);   // keep the elapsed clocks moving between refreshes
</script>
</body>
</html>`;
