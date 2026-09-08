import type { ScannedFile } from "./darkSwitches.js";

/**
 * How much of what a run wrote is a record of what it did not build.
 *
 * waf's `docs/KNOWN-GAPS.md` is 118.6 KB across 27 sections, opening with
 * "Everything listed here was, at the time each entry was written, deliberately
 * left out of that run's budget". `docs/HANDOVER.md` is another 68 KB. The
 * operator UI ships a card reading "Out of scope for v1 — Network-layer
 * signal". None of it is dishonest, and that is exactly the problem: every
 * unbuilt thing was reframed as a scoping decision at the moment it went
 * unbuilt, and truthfulness became the deliverable (issue #119).
 *
 * A run that has to write 118 KB of gaps has not finished; it has documented
 * not finishing. This measures that, in the run's own diff, so the operator can
 * be asked whether to buy the work *while there is budget left* rather than
 * shown the file afterwards. It is a signal, never a gate: some of these
 * documents are exactly what a good handover looks like, and the difference
 * between the two is a judgment only the person paying can make.
 *
 * Pure and I/O-free, like `darkSwitches` and `deployCapability`: the caller
 * supplies the bytes.
 */

/**
 * What the gap ledger reads: documentation, and the source files that carry a
 * user-visible disclosure.
 *
 * Deliberately wider than the dark-switch scanner's `scannable`, which answers
 * "can this file declare a switch" and therefore excludes markdown — every
 * file this module exists to measure. waf's disclosure lived in a gaps file, a
 * handover, and a card in a React component, and a filter that reads only one
 * of the three measures a third of the problem.
 */
export function readableForGaps(path: string): boolean {
  return /\.(md|mdx|txt|rst|adoc|tsx?|jsx?|py|go|rs|java|rb|swift|kt|vue|svelte)$/i.test(path);
}

/** Files whose whole subject is what was not built. */
const LEDGER_FILE = /(^|\/)(known[-_ ]?gaps?|gaps?|limitations|not[-_ ]?implemented|todo|handover|hand[-_ ]?off|deferred|out[-_ ]?of[-_ ]?scope|future[-_ ]?work)([-_. ][^/]*)?\.(md|mdx|txt|rst|adoc)$/i;

/**
 * A heading or bullet that records something as deliberately not done.
 *
 * Counted per line rather than per file so that a gap section inside an
 * ordinary README is caught too — waf's was spread across a gaps file, a
 * handover, and a card in the product itself, and only one of those is a file
 * this would recognise by name.
 */
const DISCLAIMER =
  /\b(out of scope|not implemented|unimplemented|deliberately (left|not)|intentionally (left|not)|known (gap|limitation)|not supported (yet|in v1)|deferred to|future work|will not (be )?(support|implement)|no(t)? (yet )?(built|wired|shipped))\b/i;

export interface GapLedger {
  /** Bytes of files whose subject is what was not built. */
  ledgerBytes: number;
  /** Those files, largest first. */
  files: { path: string; bytes: number }[];
  /** Lines anywhere in the diff that record something as deliberately undone. */
  disclaimers: number;
  /** Where the worst of them are, for the sentence the operator reads. */
  worst: { path: string; line: string }[];
}

/** How many example lines travel with the finding. Enough to recognise, few enough to read. */
const SHOWN = 3;

export function gapLedger(changed: ScannedFile[]): GapLedger {
  const files: { path: string; bytes: number }[] = [];
  const worst: { path: string; line: string }[] = [];
  let disclaimers = 0;
  for (const f of changed) {
    const bytes = Buffer.byteLength(f.text, "utf8");
    if (LEDGER_FILE.test(f.path)) files.push({ path: f.path, bytes });
    for (const raw of f.text.split("\n")) {
      const line = raw.trim();
      if (!line || !DISCLAIMER.test(line)) continue;
      disclaimers += 1;
      if (worst.length < SHOWN) worst.push({ path: f.path, line: line.slice(0, 160) });
    }
  }
  files.sort((a, b) => b.bytes - a.bytes);
  return { ledgerBytes: files.reduce((n, f) => n + f.bytes, 0), files, disclaimers, worst };
}

/**
 * The size at which a gap ledger stops being a handover and starts being the
 * deliverable.
 *
 * 16 KB is roughly four thousand words: a thorough, honest account of what a
 * run left for next time. waf's was seven times that, and its own intent
 * verdict described the core deliverable as not working "though this is
 * honestly disclosed rather than hidden". The threshold is where the second
 * sentence stops being a mitigation.
 */
const LEDGER_BYTES_LIMIT = 16_384;

/** How many "we did not build this" lines a run may write before it is worth asking about. */
const DISCLAIMER_LIMIT = 40;

/**
 * What to put to the operator about it, if anything.
 *
 * One sentence, phrased as the question the epic asks — buy the work, or accept
 * the gaps — because that is the only decision available and it is theirs.
 * Empty for a run whose documentation is the ordinary amount.
 */
export function gapLedgerSignal(ledger: GapLedger): string {
  const big = ledger.ledgerBytes > LEDGER_BYTES_LIMIT;
  const many = ledger.disclaimers > DISCLAIMER_LIMIT;
  if (!big && !many) return "";
  const parts: string[] = [];
  if (big) {
    parts.push(
      `this run has written ${(ledger.ledgerBytes / 1024).toFixed(1)} KB of documentation whose subject is what it did not build (${ledger.files
        .slice(0, 3)
        .map((f) => `${f.path} at ${(f.bytes / 1024).toFixed(1)} KB`)
        .join(", ")})`
    );
  }
  if (many) {
    parts.push(
      `and ${ledger.disclaimers} line(s) across the diff record something as deliberately not done — for example: ${ledger.worst
        .map((w) => `"${w.line}" (${w.path})`)
        .join("; ")}`
    );
  }
  return (
    `${parts.join(", ")}. None of that is dishonest, which is the difficulty: every unbuilt thing is being recorded as a scoping decision at the moment it goes unbuilt, and a run that needs a gaps file this size has not finished so much as documented not finishing. ` +
    `There is budget left now and there will not be later — is this work you want bought, or gaps you accept?`
  );
}
