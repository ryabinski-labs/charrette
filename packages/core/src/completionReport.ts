import type { RunState } from "@harness/shared";
import type { Activation, DeliveryLedger, LedgerEntry, Reach } from "./deliveryLedger.js";
import type { DarkSwitch } from "./darkSwitches.js";
import type { SpecCoverage } from "./acceptance.js";

/**
 * The run, as one page a person reads when it is over.
 *
 * Everything else the harness prints is written for someone already inside the
 * run — `status` assumes you know what a task is, the event feed assumes you
 * were watching. This is written for the person who asked for the thing and
 * walked away, and it answers their two questions in order: what did I get, and
 * what of it can anyone actually use.
 *
 * Self-contained by construction. It goes to an operator as a file and to
 * claude.ai as an artifact, and both of those are places where a stylesheet
 * request or a script tag is either blocked or embarrassing. One string, no
 * assets, no network except the font link — which degrades to the declared
 * fallback stack when it fails.
 *
 * Pure: the caller assembles the facts, this decides how they read.
 */

export interface ReportPr {
  number: number;
  title: string;
  url: string;
}

export interface CompletionReport {
  runId: string;
  /** The repository, as a person names it. */
  project: string;
  assignment: string;
  state: RunState;
  generatedAt: number;
  ledger: DeliveryLedger;
  prs: ReportPr[];
  prodUrl: string;
  spentUsd: number;
  wallClockHours: number;
  /** Sessions the run paid for, for the footnote. */
  sessions: number;
  /**
   * What nothing in this report could settle. The reporter agent's own list,
   * plus every claim struck for want of evidence.
   */
  couldNotCheck: string[];
  /** One paragraph on how the report was produced, and what it is allowed to claim. */
  method: string;
  /**
   * What the run's own specification proves, when it had one.
   *
   * A different question from the ledger's, and independent of it: a feature can
   * be live and unproven, or dark and thoroughly specified. Null for a run with
   * no specification, which is not the same as one whose specification proved
   * nothing — and the page says which.
   */
  coverage: (SpecCoverage & { line: string }) | null;
  /**
   * What happened when something started the product and used it.
   *
   * The only line in this report not derived from reading. Null means nothing
   * ever did, which the page says in those words rather than leaving out: a
   * report with no live section reads as a report of a product that works,
   * and that reading is what issue #115 is about.
   */
  live: {
    verdict: "worked" | "broken" | "not-run";
    path: string;
    steps: { step: string; result: "worked" | "broken" | "not-reached" }[];
    howStarted: string;
    why: string;
    artifactsDir: string;
  } | null;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A literal — an identifier, a path, a command — set in the utility face. */
const code = (s: string): string => `<code>${escapeHtml(s)}</code>`;

const STATUS_LABEL: Record<Activation, string> = {
  live: "Live",
  dark: "Dark",
  unproven: "Unproven",
  "not-delivered": "Not delivered",
};

/** The ladder, as the reader sees it. Ordered, because the ordering is the rule. */
const RUNGS: { reach: Reach; label: string; meaning: string }[] = [
  { reach: "not-merged", label: "Built", meaning: "the work exists on a branch" },
  { reach: "merged", label: "Merged", meaning: "a person merged it to the base branch" },
  { reach: "deployed", label: "Deployed", meaning: "the deploy carrying it went green" },
  { reach: "verified", label: "Verified", meaning: "something looked at the running system and agreed" },
];
const RANK: Record<Reach, number> = { "not-merged": 0, merged: 1, deployed: 2, verified: 3 };

const dateOf = (ms: number): string =>
  new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** `2` → `2`, `0` → `None`. A zero reading is a reading; a bare 0 reads as broken. */
const reading = (n: number): string => (n === 0 ? "None" : String(n));

function panel(report: CompletionReport): string {
  const { counts } = report.ledger;
  const cells = [
    { label: "Live", value: reading(counts.live), tone: "live", note: "Merged, deployed green, and confirmed against the running system." },
    { label: "Dark", value: reading(counts.dark), tone: "dark", note: "Built and merged. Something has to be switched on before anyone can use it." },
    { label: "Unproven", value: reading(counts.unproven), tone: "unproven", note: "Shipped, and nothing has looked at it where it runs. Not known good, not known broken." },
    { label: "Not delivered", value: reading(counts["not-delivered"]), tone: "absent", note: "Parked, cancelled, or still in flight when the run ended." },
  ];
  return `<div class="panel">${cells
    .map(
      (c) => `<div class="cell cell--${c.tone}">
        <div class="cell-label">${escapeHtml(c.label)}</div>
        <div class="cell-value">${escapeHtml(c.value)}</div>
        <p class="cell-note">${escapeHtml(c.note)}</p>
      </div>`
    )
    .join("")}</div>`;
}

/**
 * The reach ladder.
 *
 * Not decoration and not a progress bar: it is the one rule that governs every
 * verdict below it, drawn so that an operator who reads nothing else can see
 * where the run stopped. Rungs past the run's reach are drawn hollow and
 * dashed — the difference between "we did not get there" and "we got there and
 * it failed" is the difference this whole report exists to hold.
 */
function ladder(reach: Reach): string {
  const at = RANK[reach];
  const here = RUNGS[at]!;
  return `<div class="ladder" role="img" aria-label="This run reached: ${escapeHtml(here.label)} — ${escapeHtml(here.meaning)}">
    ${RUNGS.map((rung, i) => {
      const state = i < at ? "past" : i === at ? "here" : "ahead";
      return `<div class="rung rung--${state}">
        <div class="rung-track"></div>
        <div class="rung-label">${escapeHtml(rung.label)}</div>
        <div class="rung-meaning">${escapeHtml(rung.meaning)}</div>
      </div>`;
    }).join("")}
  </div>`;
}

/**
 * The reason most entries share, when one dominates.
 *
 * Almost every verdict in this report is a statement about the *run* rather
 * than about the feature — "nobody merged the pull request" is true of all
 * twenty-five in the same words. Printed per row it fills the most valuable
 * column on the page with one sentence repeated until the reader stops reading
 * the column, and takes the rows that genuinely differ down with it.
 *
 * So the shared reason is said once, above the table, and the column is given
 * back to what the row alone can say: what this feature had to do to count as
 * done. A row whose reason is its own keeps it.
 */
function commonWhy(entries: LedgerEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.why, (counts.get(e.why) ?? 0) + 1);
  const [why, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return n > 1 && n >= entries.length / 2 ? why : "";
}

const CRITERION_CHARS = 180;

function ledgerTable(entries: LedgerEntry[], prs: ReportPr[]): string {
  if (!entries.length) return `<p class="empty">This run produced no tasks, so there is nothing to account for.</p>`;
  const prUrl = (n: number | null): string => {
    if (n === null) return "—";
    const pr = prs.find((p) => p.number === n);
    // A pull request with no URL is a repository with no remote to link to.
    // `<a href="">` is not a dead link, it is a link to *this page* — it looks
    // live, it is clickable, and it throws away the reader's scroll position to
    // tell them nothing.
    return pr?.url ? `<a href="${escapeHtml(pr.url)}">#${pr.number}</a>` : `#${n}`;
  };
  const shared = commonWhy(entries);
  const detail = (e: LedgerEntry): string => {
    if (e.why !== shared) return escapeHtml(e.why);
    const criterion = e.criteria[0];
    return criterion
      ? `<span class="criterion">${escapeHtml(criterion.length > CRITERION_CHARS ? `${criterion.slice(0, CRITERION_CHARS)}…` : criterion)}</span>`
      : `<span class="criterion">No acceptance criterion was recorded for this one.</span>`;
  };
  const note = shared
    ? `<p class="shared"><strong>All of these are in the same column for the same reason:</strong> ${escapeHtml(shared)} The column below therefore shows what each one had to do to count as done, and carries a reason only where that row's reason is its own.</p>`
    : "";
  return `${note}<div class="tablewrap"><table>
    <thead><tr><th>What was built</th><th>State</th><th>PR</th><th>${shared ? "What done meant" : "Why it is in that column"}</th></tr></thead>
    <tbody>${entries
      .map(
        (e) => `<tr>
          <th scope="row" class="feature">${escapeHtml(e.title)}</th>
          <td><span class="tag tag--${e.status}">${escapeHtml(STATUS_LABEL[e.status])}</span></td>
          <td class="num">${prUrl(e.prNumber)}</td>
          <td>${detail(e)}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table></div>`;
}

/** The switch, and the literal steps that throw it. */
function switchCard(sw: DarkSwitch, index: number): string {
  return `<article class="switch switch--${sw.kind}">
    <div class="switch-head">
      <span class="switch-index">${index + 1}</span>
      <div>
        <h3>${code(sw.name)}</h3>
        <div class="switch-meta"><span class="tag tag--kind">${escapeHtml(sw.kind)}</span><span class="where">${escapeHtml(sw.where)}</span></div>
      </div>
    </div>
    <p>${escapeHtml(sw.why)}</p>
    <ol class="steps">${sw.steps
      .map((s) => `<li><p>${escapeHtml(s.do)}</p>${s.command ? `<pre><code>${escapeHtml(s.command)}</code></pre>` : ""}</li>`)
      .join("")}</ol>
  </article>`;
}

function section(eyebrow: string, heading: string, body: string): string {
  return `<section><div class="eyebrow">${escapeHtml(eyebrow)}</div><h2>${escapeHtml(heading)}</h2>${body}</section>`;
}

const list = (items: string[]): string => `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;

/**
 * The page's name.
 *
 * Named for what the run left behind rather than for the document type: "Run
 * report" is a title that fits every page this function will ever produce, and
 * a gallery of them would be unreadable. The project's name plus the state it
 * ended in is specific to one run and recognisable at a glance.
 */
export function reportTitle(report: CompletionReport): string {
  const { counts, reach } = report.ledger;
  if (reach === "not-merged") return `${report.project}: Nothing Shipped Yet`;
  if (counts.dark) return `${report.project}: ${counts.dark} Still Dark`;
  if (counts.unproven) return `${report.project}: Shipped, Unproven`;
  return `${report.project}: All Lights On`;
}

/**
 * The report as a file a person opens, rather than as content to be embedded.
 *
 * `renderCompletionReport` deliberately emits no `<!doctype>`, `<html>` or
 * `<head>`: an artifact host supplies its own skeleton and the content goes in
 * the body. A file on disk has no such host, and without the skeleton two
 * things go wrong that no test in this repository could have caught.
 *
 * Chrome parses it in quirks mode, and — the one that actually matters — with
 * no `<meta name="viewport">` a phone lays the page out at 980px and scales the
 * result down. Every `max-width: 620px` rule in the stylesheet is then dead
 * code: run 1e7d3df3's report, measured on an emulated iPhone viewport, drew
 * the four-rung ladder and the four-cell instrument panel at 980px and shrank
 * them to fit 390px of glass.
 *
 * So the writer wraps and the renderer does not. Publishing this document to a
 * host that adds its own skeleton is still correct: a second `<!doctype>` in
 * the body is ignored rather than re-triggering quirks mode, and a duplicate
 * viewport tag resolves to the same value.
 */
export function standaloneReport(report: CompletionReport): string {
  return (
    `<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `${renderCompletionReport(report)}\n</html>\n`
  );
}

export function renderCompletionReport(report: CompletionReport): string {
  const { ledger } = report;
  const dark = ledger.entries.filter((e) => e.status === "dark" || e.status === "not-delivered");
  const withRunbooks = dark.filter((e) => e.runbook && e.runbook.steps.length);

  const activation = ledger.switches.length
    ? `<p>These are the switches the run declared and could not throw. No agent in this harness is given production credentials or allowed to run <code>apply</code>, so this list is not a set of mistakes — it is the permanent seam between what a run can build and what only you can turn on.</p>
       <div class="switches">${ledger.switches.map(switchCard).join("")}</div>`
    : `<p class="empty">Nothing in the merged diff declares a credential, a stack, a record or a migration that this run could not have thrown itself. That is a real answer and a rare one — most runs leave at least a key behind.</p>`;

  const parked = withRunbooks.length
    ? `<div class="switches">${withRunbooks
        .map(
          (e, i) => `<article class="switch switch--task">
            <div class="switch-head"><span class="switch-index">${i + 1}</span><div><h3>${escapeHtml(e.title)}</h3>
            <div class="switch-meta"><span class="tag tag--${e.status}">${escapeHtml(STATUS_LABEL[e.status])}</span></div></div></div>
            <p>${escapeHtml(e.runbook!.blocked || e.why)}</p>
            <ol class="steps">${e
              .runbook!.steps.map((s) => `<li><p>${escapeHtml(s.do)}</p>${s.command ? `<pre><code>${escapeHtml(s.command)}</code></pre>` : ""}</li>`)
              .join("")}</ol>
            ${e.runbook!.sendBack ? `<p class="sendback"><strong>Send back:</strong> ${escapeHtml(e.runbook!.sendBack)}</p>` : ""}
          </article>`
        )
        .join("")}</div>`
    : "";

  const unverified = ledger.entries.filter((e) => e.unverified.length);
  const cannot = [...report.couldNotCheck, ...unverified.flatMap((e) => e.unverified.map((u) => `${e.title}: ${u}`))];

  return `<title>${escapeHtml(reportTitle(report))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<style>
:root {
  --ground:      #F1F2F7;
  --surface:     #FFFFFF;
  --surface-alt: #E6E8F1;
  --ink:         #14161F;
  --ink-soft:    #545A6B;
  --ink-faint:   #62687B;
  --rule:        #D4D8E4;
  --rule-soft:   #E4E7EF;
  --accent:      #3A45B8;
  --accent-wash: #E2E4F6;
  --live:        #1B794F;
  --live-wash:   #DDEFE5;
  --off:         #B03D26;
  --off-wash:    #F7E2DC;
  --unproven:    #61687D;
  --absent:      #636879;
  --shadow:      0 1px 2px rgba(20,22,31,.05), 0 10px 28px -18px rgba(20,22,31,.35);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground:      #0F111A;
    --surface:     #171A25;
    --surface-alt: #1F2331;
    --ink:         #E6E9F2;
    --ink-soft:    #9DA4B8;
    --ink-faint:   #838A9E;
    --rule:        #2B3040;
    --rule-soft:   #222633;
    --accent:      #8B93F0;
    --accent-wash: #1D2145;
    --live:        #57B686;
    --live-wash:   #16301F;
    --off:         #E08573;
    --off-wash:    #351C16;
    --unproven:    #9299AD;
    --absent:      #848A9E;
    --shadow:      0 1px 2px rgba(0,0,0,.35), 0 10px 28px -18px rgba(0,0,0,.8);
  }
}
:root[data-theme="dark"] {
  --ground:      #0F111A;
  --surface:     #171A25;
  --surface-alt: #1F2331;
  --ink:         #E6E9F2;
  --ink-soft:    #9DA4B8;
  --ink-faint:   #838A9E;
  --rule:        #2B3040;
  --rule-soft:   #222633;
  --accent:      #8B93F0;
  --accent-wash: #1D2145;
  --live:        #57B686;
  --live-wash:   #16301F;
  --off:         #E08573;
  --off-wash:    #351C16;
  --unproven:    #9299AD;
  --absent:      #848A9E;
  --shadow:      0 1px 2px rgba(0,0,0,.35), 0 10px 28px -18px rgba(0,0,0,.8);
}

* { box-sizing: border-box; }

body {
  background: var(--ground);
  color: var(--ink);
  font-family: "Source Serif 4", Charter, Georgia, serif;
  font-size: 18px;
  line-height: 1.6;
  margin: 0;
  padding: 0 20px 100px;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 760px; margin: 0 auto; display: block; }

h1, h2, h3 { font-family: "Familjen Grotesk", "Helvetica Neue", Arial, sans-serif; text-wrap: balance; line-height: 1.1; margin: 0; }
code, pre, .num, .mono { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
strong { font-weight: 600; }

.eyebrow {
  font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
  font-size: 11px; font-weight: 500; letter-spacing: .15em; text-transform: uppercase; color: var(--accent);
}

/* Masthead */
.masthead { padding: 76px 0 36px; border-bottom: 2px solid var(--ink); }
.masthead h1 { font-size: clamp(36px, 7.5vw, 62px); font-weight: 700; letter-spacing: -.025em; margin: 14px 0 0; }
.standfirst { font-size: clamp(19px, 2.4vw, 22px); line-height: 1.45; color: var(--ink-soft); margin: 20px 0 0; max-width: 34em; }
.standfirst strong { color: var(--ink); }
.byline {
  font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
  font-size: 12px; color: var(--ink-faint); margin: 26px 0 0;
  display: flex; flex-wrap: wrap; gap: 6px 14px;
}

section { padding: 54px 0 0; }
section > h2 { font-size: clamp(25px, 3.6vw, 33px); font-weight: 600; letter-spacing: -.018em; margin: 10px 0 0; }
section > p, section > ul, section > ol, section > div { margin: 18px 0 0; }
p { margin: 0; }
p + p { margin-top: 16px; }
ul, ol { padding-left: 1.2em; }
li { margin: 0 0 10px; }
li::marker { color: var(--ink-faint); }
.empty { color: var(--ink-soft); font-style: italic; }

/* The reach ladder — rungs past the run's reach are hollow, not merely faint. */
.ladder { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0 12px; margin: 30px 0 0; }
.rung-track { height: 6px; border-radius: 3px; background: var(--surface-alt); border: 1px dashed var(--rule); }
.rung--past .rung-track { background: var(--accent); border: 1px solid var(--accent); opacity: .45; }
.rung--here .rung-track { background: var(--accent); border: 1px solid var(--accent); }
.rung-label {
  font-family: "Familjen Grotesk", "Helvetica Neue", Arial, sans-serif;
  font-weight: 600; font-size: 15px; margin-top: 10px; color: var(--ink-faint);
}
.rung--past .rung-label { color: var(--ink-soft); }
.rung--here .rung-label { color: var(--ink); }
.rung--here .rung-label::after { content: " ←"; color: var(--accent); }
.rung-meaning { font-size: 13px; line-height: 1.4; color: var(--ink-faint); margin-top: 4px; }
@media (prefers-reduced-motion: no-preference) {
  .rung--past .rung-track, .rung--here .rung-track { animation: fill .5s ease-out both; transform-origin: left; }
  @keyframes fill { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  .rung:nth-child(2) .rung-track { animation-delay: .1s; }
  .rung:nth-child(3) .rung-track { animation-delay: .2s; }
  .rung:nth-child(4) .rung-track { animation-delay: .3s; }
}

/* Instrument cluster */
.panel {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr));
  gap: 1px; background: var(--rule); border: 1px solid var(--rule); border-radius: 6px; overflow: hidden; margin: 28px 0 0;
}
.cell { background: var(--surface); padding: 18px 16px 16px; border-top: 3px solid var(--rule); }
.cell--live { border-top-color: var(--live); }
.cell--dark { border-top-color: var(--off); }
.cell--unproven { border-top-color: var(--unproven); }
.cell--absent { border-top-color: var(--absent); }
.cell-label {
  font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
  font-size: 10.5px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-faint);
}
.cell-value {
  font-family: "Familjen Grotesk", "Helvetica Neue", Arial, sans-serif;
  font-size: 36px; font-weight: 700; letter-spacing: -.03em; font-variant-numeric: tabular-nums; line-height: 1.05; margin-top: 6px;
}
.cell--live .cell-value { color: var(--live); }
.cell--dark .cell-value { color: var(--off); }
.cell--unproven .cell-value { color: var(--unproven); }
.cell--absent .cell-value { color: var(--absent); }
.cell-note { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.45; color: var(--ink-soft); margin-top: 8px; }

/* Verdict */
.verdict {
  margin: 32px 0 0; padding: 24px; background: var(--surface);
  border: 1px solid var(--rule); border-left: 4px solid var(--accent); border-radius: 4px; box-shadow: var(--shadow);
}
.verdict p { font-size: 21px; line-height: 1.42; margin-top: 10px; }

/* Ledger */
.tablewrap { overflow-x: auto; margin: 24px 0 0; border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: 15px; }
th, td { text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
thead th {
  font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
  font-size: 10.5px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase;
  color: var(--ink-faint); background: var(--surface-alt); white-space: nowrap;
}
tbody tr:last-child td, tbody tr:last-child th { border-bottom: 0; }
th.feature { font-family: "Familjen Grotesk", "Helvetica Neue", Arial, sans-serif; font-weight: 600; font-size: 15px; }
td.num { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }

.tag {
  font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
  font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  padding: 3px 7px; border-radius: 3px; white-space: nowrap; display: inline-block;
}
.tag--live { color: var(--live); background: var(--live-wash); }
.tag--dark { color: var(--off); background: var(--off-wash); }
.tag--unproven { color: var(--unproven); background: var(--surface-alt); }
.tag--not-delivered { color: var(--absent); background: var(--surface-alt); }
.tag--kind { color: var(--accent); background: var(--accent-wash); }

.shared { margin: 22px 0 0; font-size: 16px; line-height: 1.55; color: var(--ink-soft); }
.shared strong { color: var(--ink); }
.criterion { color: var(--ink-soft); font-size: 14px; }

/* Switch cards */
.switches { display: flex; flex-direction: column; gap: 16px; margin: 24px 0 0; }
.switch { background: var(--surface); border: 1px solid var(--rule); border-left: 4px solid var(--off); border-radius: 5px; padding: 20px; }
.switch--task { border-left-color: var(--absent); }
.switch-head { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 12px; }
.switch-index {
  font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
  font-size: 12px; font-weight: 700; color: var(--surface); background: var(--off);
  border-radius: 3px; padding: 3px 8px; flex: none; margin-top: 3px;
}
.switch--task .switch-index { background: var(--absent); }
.switch h3 { font-size: 18px; font-weight: 600; letter-spacing: -.01em; }
.switch h3 code { font-size: 16px; background: none; padding: 0; }
.switch-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 7px; }
.where { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 11px; color: var(--ink-faint); overflow-wrap: anywhere; }
.switch > p { color: var(--ink-soft); font-size: 16px; line-height: 1.5; }
.steps { margin: 14px 0 0; padding-left: 1.3em; }
.steps li { margin-bottom: 12px; }
.steps p { font-size: 15.5px; line-height: 1.5; }
.sendback { margin-top: 14px; font-size: 15px; color: var(--ink-soft); }
.sendback strong { color: var(--ink); }

code { background: var(--surface-alt); padding: .12em .38em; border-radius: 3px; font-size: .85em; overflow-wrap: anywhere; }
pre {
  margin: 8px 0 0; padding: 11px 13px; background: var(--surface-alt);
  border: 1px solid var(--rule-soft); border-radius: 4px; overflow-x: auto;
}
pre code { background: none; padding: 0; font-size: 13px; line-height: 1.5; white-space: pre; }

.assignment {
  margin: 22px 0 0; padding: 18px 20px; background: var(--surface); border: 1px solid var(--rule); border-radius: 5px;
  font-size: 16px; line-height: 1.55; color: var(--ink-soft); white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 20em; overflow-y: auto;
}

.footnote { margin-top: 60px; padding-top: 22px; border-top: 1px solid var(--rule); font-size: 14.5px; line-height: 1.6; color: var(--ink-soft); }
.footnote h3 {
  font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
  font-size: 12px; letter-spacing: .13em; text-transform: uppercase; color: var(--ink-faint); font-weight: 500; margin-bottom: 12px;
}
.footnote li { margin-bottom: 8px; }

@media (max-width: 620px) {
  body { font-size: 17px; }
  .ladder { grid-template-columns: 1fr 1fr; gap: 18px 12px; }
  .switch-head { gap: 10px; }
}
</style>

<main class="wrap">

<header class="masthead">
  <div class="eyebrow">${escapeHtml(report.project)} · run ${escapeHtml(report.runId.slice(0, 8))} · ${escapeHtml(dateOf(report.generatedAt))}</div>
  <h1>${escapeHtml(reportTitle(report))}</h1>
  <p class="standfirst"><strong>${escapeHtml(ledger.headline)}</strong> This is the whole run — what it built, what of it is switched on, and for everything that is not, the thing you have to do to switch it on.</p>
  <p class="byline">
    <span>State: ${escapeHtml(report.state)}</span><span>·</span>
    <span>${report.sessions} agent ${report.sessions === 1 ? "session" : "sessions"}</span><span>·</span>
    <span>$${report.spentUsd.toFixed(2)}</span><span>·</span>
    <span>${report.wallClockHours.toFixed(1)}h wall clock</span>
  </p>
</header>

${section(
  "How far it got",
  "The run reached here, and nothing it built can have reached further",
  `${ladder(ledger.reach)}
   ${panel(report)}
   <div class="verdict"><div class="eyebrow">Verdict</div><p>${escapeHtml(ledger.headline)}</p></div>`
)}

${section(
  "The assignment",
  "What was asked for",
  `<div class="assignment">${escapeHtml(report.assignment)}</div>
   ${
     report.prs.length
       ? `<p>Delivered as ${report.prs.length === 1 ? "one pull request" : `${report.prs.length} pull requests`}: ${report.prs
           .map((p) => (p.url ? `<a href="${escapeHtml(p.url)}">#${p.number}</a>` : `#${p.number}`))
           .join(", ")}.</p>`
       : `<p class="empty">No pull request was opened, so nothing from this run has reached the base branch.</p>`
   }`
)}

${section("The ledger", "Every feature, and which column it is in", ledgerTable(ledger.entries, report.prs))}

${section("Dark", "What is built, merged, and switched off", activation)}

${parked ? section("Yours", "The work that stopped on something only you can do", parked) : ""}

${
  ledger.findings.length
    ? section(
        "Production",
        "What the running system said when it was checked",
        `<p>Checked at <a href="${escapeHtml(report.prodUrl)}">${escapeHtml(report.prodUrl)}</a>.</p>${list(ledger.findings)}`
      )
    : ""
}

${
  ledger.gaps.length
    ? section(
        "Gaps",
        "What the end-of-run intent check found missing",
        `<p>Read against the assignment rather than against any single task's criteria — this is the check that asks whether the sum is what was asked for.</p>${list(ledger.gaps)}`
      )
    : ""
}

${
  cannot.length
    ? section(
        "Not checked",
        "What this report is not in a position to claim",
        `<p>Every line here is a claim that could not be settled. They are listed rather than resolved, because a report that quietly rounds an unknown up to a pass is worse than no report.</p>${list(cannot)}`
      )
    : ""
}

${section(
  "Exercised",
  "What happened when someone used it",
  report.live
    ? `<p>An agent checked this branch out clean, followed the repository's own documented start, and drove the critical path the brief was turned into before any code existed. Everything else in this report is a reading of the code; this is the only part of it that ran.</p>
       <p class="${report.live.verdict === "worked" ? "" : "bad"}">${escapeHtml(report.live.why)}</p>
       ${report.live.path ? `<p>The path: ${escapeHtml(report.live.path)}</p>` : ""}
       ${report.live.steps.length ? list(report.live.steps.map((s) => `${s.result === "worked" ? "worked" : s.result === "broken" ? "BROKE" : "not reached"} — ${s.step}`)) : ""}
       ${report.live.howStarted ? `<p>Started with: ${code(report.live.howStarted)}</p>` : ""}
       ${report.live.artifactsDir ? `<p>What it captured: ${code(report.live.artifactsDir)}</p>` : ""}`
    : `<p class="bad">Nothing started this product and used it. Every check in this run read the code — the tests, the reviews, the intent check — and none of them can tell a product that runs from one that does not. Treat everything above as a statement about the source.</p>`
)}

${
  report.coverage
    ? section(
        "Proof",
        "What would notice if this broke",
        `<p>Before anything was planned, the brief was turned into scenarios — falsifiable checks written while no code existed to agree with. This is what they say about the finished run, and it is a different question from the one above: a feature can be live and unproven, or dark and thoroughly specified.</p>
         <div class="panel">
           <div class="cell cell--live"><div class="cell-label">Proven</div><div class="cell-value">${escapeHtml(reading(report.coverage.proven))}</div><p class="cell-note">Requirements with a scenario that ran and passed. Something would notice if these broke.</p></div>
           <div class="cell cell--dark"><div class="cell-label">Broken</div><div class="cell-value">${escapeHtml(reading(report.coverage.broken))}</div><p class="cell-note">Requirements whose own scenario is failing against what shipped.</p></div>
           <div class="cell cell--unproven"><div class="cell-label">Unproven</div><div class="cell-value">${escapeHtml(reading(report.coverage.unproven.length))}</div><p class="cell-note">No scenario at all, or only ones blocked on a question nobody answered.</p></div>
           <div class="cell cell--absent"><div class="cell-label">Requirements</div><div class="cell-value">${escapeHtml(reading(report.coverage.total))}</div><p class="cell-note">Everything the brief was read as promising.</p></div>
         </div>
         <p>${escapeHtml(report.coverage.line)}</p>
         ${report.coverage.unproven.length ? `<p>Unproven: ${report.coverage.unproven.map((r) => code(r)).join(", ")}. These are promises the run made that nothing checks — not defects, and not proof either.</p>` : ""}`
      )
    : ""
}

<div class="footnote">
  <h3>How this was made</h3>
  <p>${escapeHtml(report.method)}</p>
  <ul>
    <li>Nothing in this report was written by the agents that did the work. Every state above is derived from what the run recorded — merges, deploy checks, the production verdict — and from a scan of the merged diff.</li>
    <li>A feature is never reported as more live than the run's reach allows. A run that stopped at <strong>Merged</strong> has no live features regardless of how green its tests were, because nothing carried them anywhere.</li>
    <li>The harness cannot throw the switches in the <strong>Dark</strong> section by design: no agent it runs is given production credentials, and <code>apply</code> is denied to all of them. That seam is permanent, and this page is what it produces.</li>
  </ul>
</div>

</main>`;
}
