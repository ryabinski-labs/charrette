import { describe, expect, it } from "vitest";
import { renderCompletionReport, reportTitle, standaloneReport, type CompletionReport } from "./completionReport.js";
import { deliveryLedger, type LedgerInput, type LedgerTask } from "./deliveryLedger.js";
import type { DarkSwitch } from "./darkSwitches.js";

const task = (over: Partial<LedgerTask> = {}): LedgerTask => ({
  id: "t1",
  title: "Checkout",
  state: "MERGED",
  acceptanceCriteria: ["A card charge succeeds end to end"],
  touchedPaths: ["src/checkout.ts"],
  prNumber: 7,
  unverified: [],
  why: "",
  runbook: null,
  blocking: [],
  ...over,
});

const ledger = (over: Partial<LedgerInput> = {}) =>
  deliveryLedger({
    runState: "DONE",
    tasks: [task()],
    merged: true,
    deploy: { state: "passing", failing: [] },
    prod: { url: "https://x.test", verdict: "PASS", findings: [] },
    ci: { state: "passing", failing: [] },
    intent: { verdict: "PASS", gaps: [] },
    switches: [],
    ...over,
  });

const report = (over: Partial<CompletionReport> = {}): CompletionReport => ({
  runId: "ec40b527-1111-2222-3333-444455556666",
  project: "icelandcopilot-companion",
  assignment: "Build the fulfillment spine",
  state: "DONE",
  generatedAt: Date.UTC(2026, 7, 20),
  ledger: ledger(),
  prs: [{ number: 7, title: "#7", url: "https://github.com/o/r/pull/7" }],
  prodUrl: "https://x.test",
  spentUsd: 97.19,
  wallClockHours: 3.32,
  sessions: 75,
  couldNotCheck: [],
  method: "Derived from the event log.",
  // Null is the honest default: most fixtures describe a run that was never
  // specified, which is not the same as one whose scenarios proved nothing.
  coverage: null,
  // And null here means nothing started the product, which the page says in
  // those words — see the "Exercised" cases.
  live: null,
  // Null for a run with no specification, which promised nothing in the
  // vocabulary the Scope section is written in.
  scope: null,
  ...over,
});

describe("what became of what you asked for", () => {
  const scope = (over: Partial<NonNullable<CompletionReport["scope"]>> = {}) => ({ shipped: 2, writtenOff: [], dropped: [], unclaimed: [], ...over });

  it("says nothing at all for a run that was never specified", () => {
    expect(renderCompletionReport(report())).not.toContain("What became of what you asked for");
  });

  it("counts the four states, and prints your own words for what you wrote off", () => {
    const html = renderCompletionReport(
      report({
        scope: scope({
          writtenOff: [{ id: "REQ-2", text: "email a receipt", answer: "next run" }],
          dropped: [{ id: "REQ-3", text: "refunds", why: "task-c CANCELLED (unreachable: dependencies parked)" }],
          unclaimed: [{ id: "REQ-4", text: "a nicer button" }],
        }),
      })
    );
    expect(html).toContain("Requirements, not tasks");
    expect(html).toContain("REQ-2 — email a receipt — your answer: next run");
    expect(html).toContain("Dropped without a decision:");
    expect(html).toContain("task-c CANCELLED (unreachable: dependencies parked)");
    expect(html).toContain("REQ-4 — a nicer button");
  });

  it("prints the counts without the lists when there is nothing to list", () => {
    const html = renderCompletionReport(report({ scope: scope() }));
    expect(html).toContain("What became of what you asked for");
    expect(html).not.toContain("Written off:");
    expect(html).not.toContain("Dropped without a decision:");
    expect(html).not.toContain("Never claimed by any task:");
  });

  it("omits the provenance of a dropped requirement no task ever touched", () => {
    const html = renderCompletionReport(report({ scope: scope({ dropped: [{ id: "REQ-9", text: "a thing", why: "" }] }) }));
    expect(html).toContain("REQ-9 — a thing");
  });
});

describe("what happened when someone used it", () => {
  it("says in those words when nothing ever started the product", () => {
    const html = renderCompletionReport(report());
    expect(html).toContain("Nothing started this product and used it");
    expect(html).toContain("Treat everything above as a statement about the source.");
  });

  it("prints the path, the steps, and where the captures are when something did", () => {
    const html = renderCompletionReport(
      report({
        live: {
          verdict: "broken",
          path: "take a payment",
          steps: [
            { step: "open the checkout", result: "worked" },
            { step: "pay with a test card", result: "broken" },
            { step: "see the receipt", result: "not-reached" },
          ],
          howStarted: "pnpm dev",
          why: "1 of 3 step(s) worked",
          artifactsDir: "/r/.charrette/run/live",
        },
      })
    );
    expect(html).toContain("1 of 3 step(s) worked");
    expect(html).toContain("The path: take a payment");
    expect(html).toContain("BROKE — pay with a test card");
    expect(html).toContain("not reached — see the receipt");
    expect(html).toContain("Started with:");
    expect(html).toContain("/r/.charrette/run/live");
  });

  it("says a working path worked, without the noise of a run that has nothing to explain", () => {
    const html = renderCompletionReport(report({ live: { verdict: "worked", path: "", steps: [], howStarted: "", why: "all 2 step(s) worked", artifactsDir: "" } }));
    expect(html).toContain("all 2 step(s) worked");
    expect(html).not.toContain("The path:");
    expect(html).not.toContain("Started with:");
  });
});

const secret = (over: Partial<DarkSwitch> = {}): DarkSwitch => ({
  kind: "secret",
  name: "STRIPE_SECRET_KEY",
  where: "src/checkout.ts:12",
  why: "Nothing sets it.",
  steps: [{ do: "Seed it.", command: "gh secret set STRIPE_SECRET_KEY" }],
  ...over,
});

describe("the page's name", () => {
  /**
   * "Run report" fits every page this will ever produce, and a gallery of them
   * would be unreadable. The name has to identify one run.
   */
  it("names the run by what it left behind", () => {
    expect(reportTitle(report({ ledger: ledger({ merged: false, deploy: null, prod: null }) }))).toBe("icelandcopilot-companion: Nothing Shipped Yet");
    expect(reportTitle(report({ ledger: ledger({ switches: [secret()] }) }))).toBe("icelandcopilot-companion: 1 Still Dark");
    expect(reportTitle(report({ ledger: ledger({ prod: null }) }))).toBe("icelandcopilot-companion: Shipped, Unproven");
    expect(reportTitle(report())).toBe("icelandcopilot-companion: All Lights On");
  });
});

describe("the page holds together as a document", () => {
  const html = renderCompletionReport(report());

  it("carries its own title, styles and fonts and asks the network for nothing else", () => {
    expect(html).toContain("<title>icelandcopilot-companion: All Lights On</title>");
    expect(html).not.toContain("<script");
    // Google Fonts is the one host the artifact CSP admits; anything else would
    // fail silently and take the type design with it.
    const hrefs = [...html.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs.every((h) => h.startsWith("https://fonts.g") || h.startsWith("https://github.com/") || h.startsWith("https://x.test"))).toBe(true);
  });

  /**
   * The classic unreadable-artifact bug: a colour whose only definition sits
   * behind a media query or a `[data-theme]` stamp never applies in the
   * un-stamped state most viewers are in, and the page renders one theme's text
   * on the other theme's ground.
   */
  it("defines the whole palette on bare :root, and redefines it for both dark states", () => {
    const bare = html.slice(html.indexOf(":root {"), html.indexOf("@media (prefers-color-scheme: dark)"));
    const tokens = [...bare.matchAll(/(--[a-z-]+):/g)].map((m) => m[1]!);
    expect(tokens).toContain("--ground");
    expect(tokens.length).toBeGreaterThan(10);
    for (const block of [html.slice(html.indexOf('@media (prefers-color-scheme: dark)')), html.slice(html.indexOf(':root[data-theme="dark"]'))]) {
      for (const token of tokens) expect(block).toContain(`${token}:`);
    }
    expect(html).toContain(':root:not([data-theme="light"])');
    // A transparent body borrows the host's ground, which is the other half of
    // the same bug.
    expect(html).toMatch(/body\s*\{[^}]*background: var\(--ground\)/);
  });

  /**
   * Lighthouse's remaining deduction on the finished page: a document with no
   * main landmark gives a screen reader nothing to skip to. `.wrap` is already
   * the only content container, so naming it costs nothing.
   */
  it("gives a screen reader a main landmark to skip to", () => {
    const html = renderCompletionReport(report());
    expect(html).toContain('<main class="wrap">');
    expect(html.trimEnd().endsWith("</main>")).toBe(true);
    expect(html).not.toContain('<div class="wrap">');
  });

  it("keeps wide content inside its own scroller so the page never scrolls sideways", () => {
    expect(html).toMatch(/\.tablewrap \{ overflow-x: auto;/);
    expect(html).toMatch(/pre \{[^}]*overflow-x: auto;/);
  });

  it("escapes everything that came from a repository", () => {
    const html = renderCompletionReport(report({ assignment: `<script>alert("x")</script>`, project: "a&b" }));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("a&amp;b");
  });
});

describe("the reach ladder", () => {
  it("draws the rungs the run passed, the one it stopped on, and the ones it never reached", () => {
    const html = renderCompletionReport(report({ ledger: ledger({ deploy: { state: "failing", failing: [] }, prod: null }) }));
    expect(html).toContain(`<div class="rung rung--past">`); // Built
    expect(html).toContain(`<div class="rung rung--here">`); // Merged
    expect(html).toContain(`<div class="rung rung--ahead">`); // Deployed, Verified
    expect(html).toContain(`aria-label="This run reached: Merged`);
  });

  it("marks the last rung when the run went all the way", () => {
    expect(renderCompletionReport(report())).toContain(`aria-label="This run reached: Verified`);
  });
});

describe("the instrument cluster", () => {
  /** A bare `0` in a big display face reads as broken rather than as a reading. */
  it("shows a zero count as a word", () => {
    const html = renderCompletionReport(report());
    expect(html).toContain(`<div class="cell-value">None</div>`);
    expect(html).toContain(`<div class="cell-value">1</div>`);
  });
});

describe("the ledger table", () => {
  /**
   * Almost every verdict is a statement about the run, identical in all rows.
   * Printed per row it fills the most valuable column with one repeated
   * sentence, and buries the rows whose reason is genuinely their own.
   */
  it("says a shared reason once and gives the column back to what each row can say", () => {
    const tasks = [task(), task({ id: "t2", title: "Refunds" }), task({ id: "t3", title: "Receipts" })];
    const html = renderCompletionReport(report({ ledger: ledger({ tasks, merged: false, deploy: null, prod: null }) }));
    expect(html).toContain("All of these are in the same column for the same reason:");
    expect(html).toContain("<th>What done meant</th>");
    expect(html).toContain(`<span class="criterion">A card charge succeeds end to end</span>`);
    // The shared sentence appears in the note, not once per row.
    expect(html.split("nobody merged the pull request").length - 1).toBe(1);
  });

  it("keeps a row's own reason when it differs from the shared one", () => {
    const tasks = [task(), task({ id: "t2", title: "Refunds" }), task({ id: "t3", title: "Admin", state: "NEEDS_HUMAN", why: "needs a real Stripe account" })];
    const html = renderCompletionReport(report({ ledger: ledger({ tasks, merged: false, deploy: null, prod: null }) }));
    expect(html).toContain("needs a real Stripe account");
  });

  it("keeps the reason column when no reason dominates", () => {
    const tasks = [task(), task({ id: "t2", title: "Admin", state: "NEEDS_HUMAN", why: "needs an account" })];
    const html = renderCompletionReport(report({ ledger: ledger({ tasks }) }));
    expect(html).toContain("<th>Why it is in that column</th>");
  });

  it("says so rather than showing an empty cell when a task had no criteria", () => {
    const tasks = [task({ acceptanceCriteria: [] }), task({ id: "t2", title: "R", acceptanceCriteria: [] }), task({ id: "t3", title: "S", acceptanceCriteria: [] })];
    const html = renderCompletionReport(report({ ledger: ledger({ tasks, merged: false, deploy: null, prod: null }) }));
    expect(html).toContain("No acceptance criterion was recorded for this one.");
  });

  it("truncates a criterion written as an essay", () => {
    const long = "x".repeat(400);
    const tasks = [task({ acceptanceCriteria: [long] }), task({ id: "t2", title: "R", acceptanceCriteria: [long] })];
    const html = renderCompletionReport(report({ ledger: ledger({ tasks, merged: false, deploy: null, prod: null }) }));
    expect(html).toContain(`${"x".repeat(180)}…`);
    expect(html).not.toContain("x".repeat(200));
  });

  /**
   * A repository with no remote has no URL to link to, and `<a href="">` is not
   * a dead link — it is a link to *this page*. It looks live, it is clickable,
   * and it throws away the reader's place to tell them nothing.
   */
  it("prints a pull request as text when there is no remote to link it to", () => {
    // The pull request is on the task and in the list; what it lacks is a URL.
    const tasks = [task({ prNumber: 42 }), task({ id: "t2", title: "R", prNumber: 42 })];
    const html = renderCompletionReport(
      report({ ledger: ledger({ tasks }), prs: [{ number: 42, title: "#42", url: "" }] })
    );
    expect(html).not.toContain('<a href="">');
    expect(html).toContain("<td class=\"num\">#42</td>");
    expect(html).toContain("Delivered as one pull request: #42.");
  });

  it("links a pull request it knows and prints one it does not", () => {
    const tasks = [task(), task({ id: "t2", title: "R", prNumber: 99 }), task({ id: "t3", title: "S", prNumber: null })];
    const html = renderCompletionReport(report({ ledger: ledger({ tasks }) }));
    expect(html).toContain(`<a href="https://github.com/o/r/pull/7">#7</a>`);
    expect(html).toContain(`<td class="num">#99</td>`);
    expect(html).toContain(`<td class="num">—</td>`);
  });

  it("says so plainly when the run produced no tasks", () => {
    expect(renderCompletionReport(report({ ledger: ledger({ tasks: [] }) }))).toContain("no tasks, so there is nothing to account for");
  });
});

describe("the section the report exists for", () => {
  it("prints each switch with the literal commands that throw it", () => {
    const html = renderCompletionReport(report({ ledger: ledger({ switches: [secret()] }) }));
    expect(html).toContain("<code>STRIPE_SECRET_KEY</code>");
    expect(html).toContain(`<span class="tag tag--kind">secret</span>`);
    expect(html).toContain("<pre><code>gh secret set STRIPE_SECRET_KEY</code></pre>");
  });

  it("renders a step that has no command as prose alone", () => {
    const html = renderCompletionReport(report({ ledger: ledger({ switches: [secret({ steps: [{ do: "Decide whether to turn it on." }] })] }) }));
    expect(html).toContain("Decide whether to turn it on.");
  });

  /**
   * A rare answer, and worth saying out loud: most runs leave at least a key
   * behind, so an empty section that says nothing reads like a section that
   * failed to run.
   */
  it("says that nothing was left off rather than printing an empty section", () => {
    expect(renderCompletionReport(report())).toContain("Nothing in the merged diff declares a credential");
  });

  it("gives a parked task's own runbook its own section", () => {
    const runbook = { blocked: "this needs a real deploy", steps: [{ do: "Run it", command: "gh workflow run cd.yml" }], sendBack: "the workflow output" };
    const html = renderCompletionReport(report({ ledger: ledger({ tasks: [task({ state: "NEEDS_HUMAN", runbook })] }) }));
    expect(html).toContain("The work that stopped on something only you can do");
    expect(html).toContain("<pre><code>gh workflow run cd.yml</code></pre>");
    expect(html).toContain("<strong>Send back:</strong> the workflow output");
  });

  it("falls back to the reason when a runbook has no blocked sentence and no send-back", () => {
    const runbook = { blocked: "", steps: [{ do: "Do the thing" }], sendBack: "" };
    const html = renderCompletionReport(report({ ledger: ledger({ tasks: [task({ state: "NEEDS_HUMAN", why: "stopped on an account", runbook })] }) }));
    expect(html).toContain("stopped on an account");
    expect(html).not.toContain("Send back:");
  });

  it("omits the section entirely when nothing parked with steps attached", () => {
    expect(renderCompletionReport(report())).not.toContain("The work that stopped on something only you can do");
  });
});

describe("what the report will not claim", () => {
  it("prints production's findings against the URL that was checked", () => {
    const html = renderCompletionReport(report({ ledger: ledger({ prod: { url: "https://x.test", verdict: "FAIL", findings: ["the login page 500s"] } }) }));
    expect(html).toContain("What the running system said when it was checked");
    expect(html).toContain("<li>the login page 500s</li>");
    expect(html).toContain(`<a href="https://x.test">https://x.test</a>`);
  });

  it("prints the intent check's gaps", () => {
    const html = renderCompletionReport(report({ ledger: ledger({ intent: { verdict: "FAIL", gaps: ["no admin screen"] } }) }));
    expect(html).toContain("<li>no admin screen</li>");
  });

  it("lists what could not be settled, including QA's own caveats", () => {
    const html = renderCompletionReport(
      report({
        couldNotCheck: ["the diff could not be read from git"],
        ledger: ledger({ tasks: [task({ unverified: ["the refund path was never exercised"] })] }),
      })
    );
    expect(html).toContain("<li>the diff could not be read from git</li>");
    expect(html).toContain("<li>Checkout: the refund path was never exercised</li>");
    expect(html).toContain("worse than no report");
  });

  it("omits the optional sections when there is nothing in them", () => {
    const html = renderCompletionReport(report());
    expect(html).not.toContain("What the running system said");
    expect(html).not.toContain("What the end-of-run intent check found missing");
    expect(html).not.toContain("What this report is not in a position to claim");
  });
});

describe("the masthead and the footnote", () => {
  it("prints the run's own numbers rather than rounding them away", () => {
    const html = renderCompletionReport(report());
    expect(html).toContain("run ec40b527");
    expect(html).toContain("20 Aug 2026");
    expect(html).toContain("75 agent sessions");
    expect(html).toContain("$97.19");
    expect(html).toContain("3.3h wall clock");
    expect(html).toContain("State: DONE");
  });

  it("does not say 1 sessions", () => {
    expect(renderCompletionReport(report({ sessions: 1 }))).toContain("1 agent session<");
  });

  it("names the pull requests, and says so when there are none", () => {
    expect(renderCompletionReport(report())).toContain("Delivered as one pull request");
    expect(renderCompletionReport(report({ prs: [{ number: 7, title: "#7", url: "u" }, { number: 8, title: "#8", url: "v" }] }))).toContain(
      "Delivered as 2 pull requests"
    );
    expect(renderCompletionReport(report({ prs: [] }))).toContain("No pull request was opened");
  });

  it("states the rule the whole page rests on", () => {
    expect(renderCompletionReport(report())).toContain("never reported as more live than the run's reach allows");
  });
});

describe("what would notice if this broke", () => {
  const coverage = { proven: 3, broken: 1, unproven: ["REQ-004", "REQ-005"], total: 6, line: "The acceptance gate is red: 1 of 4 failing." };

  it("asks a different question from the ledger, and says so", () => {
    const html = renderCompletionReport(report({ coverage }));
    expect(html).toContain("What would notice if this broke");
    expect(html).toContain("live and unproven, or dark and thoroughly specified");
    expect(html).toContain("The acceptance gate is red: 1 of 4 failing.");
    expect(html).toContain("<code>REQ-004</code>, <code>REQ-005</code>");
  });

  it("shows each count as a reading rather than a bare zero", () => {
    const html = renderCompletionReport(report({ coverage: { proven: 6, broken: 0, unproven: [], total: 6, line: "6 gating scenario(s) green" } }));
    expect(html).toContain(`<div class="cell-value">None</div>`);
    // Nothing unproven, so no list of promises nothing checks.
    expect(html).not.toContain("promises the run made that nothing checks");
  });

  /**
   * A section of zeroes would read as "every check failed". A run that was
   * never specified has to be absent from the page instead.
   */
  it("says nothing at all about proof for a run that was never specified", () => {
    const html = renderCompletionReport(report());
    expect(html).not.toContain("What would notice if this broke");
  });
});

/**
 * Measured on an emulated iPhone viewport, run 1e7d3df3's report drew the
 * four-rung ladder and the four-cell instrument panel at 980px and scaled them
 * down to fit 390px of glass: with no viewport tag a phone picks a 980px
 * layout viewport, and every `max-width: 620px` rule in the stylesheet is dead.
 */
describe("the report as a file somebody opens", () => {
  it("is a whole document, so a phone lays it out at the width it actually has", () => {
    const doc = standaloneReport(report());
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(doc).toContain('<meta charset="utf-8">');
    expect(doc.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("carries the page itself, unchanged", () => {
    const r = report();
    expect(standaloneReport(r)).toContain(renderCompletionReport(r));
  });

  /**
   * The embedded form stays skeleton-free: an artifact host supplies its own,
   * and the tags below are the ones it owns.
   */
  it("leaves the embedded form for a host that brings its own skeleton", () => {
    const html = renderCompletionReport(report());
    expect(html).not.toContain("<!doctype");
    expect(html).not.toContain("<html");
    expect(html).not.toContain("<head>");
    expect(html).not.toContain("<body");
  });
});

/**
 * Lighthouse scored this page 94 on an emulated phone, and every deduction was
 * one of two muted tokens failing WCAG AA against the surface behind it. It
 * only ever tested the dark theme, because that is what the emulated browser
 * was in — the light theme was worse and nothing had looked at it.
 *
 * So the check lives here, over the palette the page actually ships, rather
 * than in whichever theme an auditing browser happens to prefer.
 */
describe("text a person has to be able to read", () => {
  const luminance = (hex: string): number => {
    const v = hex.replace("#", "");
    const channel = (i: number) => {
      const c = parseInt(v.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  /** Pull one theme's tokens straight out of the stylesheet the page ships. */
  const palette = (block: string): Record<string, string> => {
    const html = renderCompletionReport(report());
    const start = html.indexOf(block);
    const body = html.slice(start, html.indexOf("}", start));
    return Object.fromEntries([...body.matchAll(/--([a-z-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
  };

  // Every foreground/background pair the stylesheet actually puts together,
  // and whether WCAG treats it as large text (3:1) or body text (4.5:1).
  const PAIRS: [string, string, string, boolean][] = [
    ["body text", "ink", "ground", false],
    ["eyebrow", "accent", "ground", false],
    ["standfirst", "ink-soft", "ground", false],
    ["byline", "ink-faint", "ground", false],
    ["rung meaning", "ink-faint", "ground", false],
    ["cell label", "ink-faint", "surface", false],
    ["cell note", "ink-soft", "surface", false],
    ["table head", "ink-faint", "surface-alt", false],
    ["table cell", "ink", "surface", false],
    ["where", "ink-faint", "surface", false],
    ["footnote heading", "ink-faint", "ground", false],
    ["footnote body", "ink-soft", "ground", false],
    ["code", "ink", "surface-alt", false],
    ["link on ground", "accent", "ground", false],
    ["link on surface", "accent", "surface", false],
    ["tag live", "live", "live-wash", false],
    ["tag dark", "off", "off-wash", false],
    ["tag unproven", "unproven", "surface-alt", false],
    ["tag not-delivered", "absent", "surface-alt", false],
    ["tag kind", "accent", "accent-wash", false],
    ["reading live", "live", "surface", true],
    ["reading dark", "off", "surface", true],
    ["reading unproven", "unproven", "surface", true],
    ["reading absent", "absent", "surface", true],
  ];

  for (const [theme, block] of [
    ["light", ":root {"],
    ["dark", ':root[data-theme="dark"] {'],
  ] as const) {
    it(`meets WCAG AA in the ${theme} theme, on every pair the page puts together`, () => {
      const tokens = palette(block);
      const failures = PAIRS.filter(([, fg, bg, large]) => contrast(tokens[fg]!, tokens[bg]!) < (large ? 3 : 4.5)).map(
        ([label, fg, bg, large]) => `${label}: ${tokens[fg]} on ${tokens[bg]} = ${contrast(tokens[fg]!, tokens[bg]!).toFixed(2)} (needs ${large ? 3 : 4.5})`
      );
      expect(failures).toEqual([]);
    });
  }

  /** The media-query palette and the stamped one must not drift apart. */
  it("gives the two dark blocks identical values", () => {
    expect(palette(':root:not([data-theme="light"])')).toEqual(palette(':root[data-theme="dark"] {'));
  });
});
