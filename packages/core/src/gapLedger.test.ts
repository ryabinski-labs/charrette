import { describe, expect, it } from "vitest";
import { gapLedger, gapLedgerSignal, readableForGaps } from "./gapLedger.js";
import type { ScannedFile } from "./darkSwitches.js";

/**
 * How much of what a run wrote is a record of what it did not build.
 *
 * waf's `docs/KNOWN-GAPS.md` is 118.6 KB across 27 sections; its `HANDOVER.md`
 * is another 68 KB; its operator UI ships a card reading "Out of scope for v1".
 * None of it is dishonest, and that is the difficulty — every unbuilt thing was
 * reframed as a scoping decision at the moment it went unbuilt, and
 * truthfulness became the deliverable (issue #119).
 */

const file = (path: string, text: string): ScannedFile => ({ path, text });
const big = (kb: number) => "x".repeat(kb * 1024);

describe("measuring what a run wrote about what it did not build", () => {
  it("recognises a gap ledger by name, whatever it is called", () => {
    const l = gapLedger([
      file("docs/KNOWN-GAPS.md", "a"),
      file("docs/known_gaps.md", "b"),
      file("HANDOVER.md", "c"),
      file("docs/limitations.txt", "d"),
      file("docs/future-work.md", "e"),
      file("docs/out-of-scope.rst", "f"),
      file("src/gaps.ts", "not documentation"),
      file("docs/architecture.md", "ordinary"),
    ]);
    expect(l.files.map((f) => f.path).sort()).toEqual([
      "HANDOVER.md",
      "docs/KNOWN-GAPS.md",
      "docs/future-work.md",
      "docs/known_gaps.md",
      "docs/limitations.txt",
      "docs/out-of-scope.rst",
    ]);
  });

  it("counts the bytes and puts the largest first", () => {
    const l = gapLedger([file("docs/gaps.md", big(4)), file("HANDOVER.md", big(9))]);
    expect(l.files[0]!.path).toBe("HANDOVER.md");
    expect(l.ledgerBytes).toBe(13 * 1024);
  });

  /**
   * waf's disclosure was spread across a gaps file, a handover and a card in
   * the product itself, and only one of those is a file recognisable by name.
   */
  it("counts lines that record something as undone, wherever they are", () => {
    const l = gapLedger([
      file("README.md", "# Thing\n\nNetwork-layer signal is out of scope for v1.\nThe rest works."),
      file("ui/src/Overview.tsx", `<Card title="Out of scope for v1 — Network-layer signal" />`),
      file("src/pay.ts", "// Refunds are not implemented yet.\nexport const pay = 1;"),
      file("src/fine.ts", "export const ok = 1;"),
    ]);
    expect(l.disclaimers).toBe(3);
    expect(l.worst.map((w) => w.path)).toEqual(["README.md", "ui/src/Overview.tsx", "src/pay.ts"]);
    expect(l.worst[0]!.line).toBe("Network-layer signal is out of scope for v1.");
  });

  it("shows only the first few examples, however many it counted", () => {
    const l = gapLedger([file("docs/x.md", Array.from({ length: 20 }, (_, i) => `- thing ${i}: not implemented`).join("\n"))]);
    expect(l.disclaimers).toBe(20);
    expect(l.worst).toHaveLength(3);
  });

  it("has nothing to say about a diff that documents nothing", () => {
    expect(gapLedger([file("src/a.ts", "export const a = 1;")])).toMatchObject({ ledgerBytes: 0, files: [], disclaimers: 0, worst: [] });
    expect(gapLedger([])).toMatchObject({ ledgerBytes: 0, disclaimers: 0 });
  });
});

describe("which files are read at all", () => {
  /**
   * Wider than the dark-switch scanner's filter on purpose: that one asks
   * which files can declare a switch and excludes markdown, which is every
   * file this module exists to measure.
   */
  it("reads documentation and the source that carries a user-visible disclosure", () => {
    expect(["docs/KNOWN-GAPS.md", "HANDOVER.txt", "docs/x.rst", "ui/src/Overview.tsx", "api/main.py", "src/lib.rs"].every(readableForGaps)).toBe(true);
  });

  it("leaves alone what cannot carry prose", () => {
    expect(["pnpm-lock.yaml", "assets/logo.png", "Dockerfile", "schema.sql"].some(readableForGaps)).toBe(false);
  });
});

describe("what the operator is asked about it", () => {
  it("says nothing about the ordinary amount of honest documentation", () => {
    const l = gapLedger([file("docs/HANDOVER.md", big(8)), file("README.md", "One thing is out of scope for v1.")]);
    expect(gapLedgerSignal(l)).toBe("");
  });

  it("asks about a gaps file that has become the deliverable, naming the largest", () => {
    const signal = gapLedgerSignal(gapLedger([file("docs/KNOWN-GAPS.md", big(118)), file("docs/HANDOVER.md", big(68))]));
    expect(signal).toContain("186.0 KB of documentation whose subject is what it did not build");
    expect(signal).toContain("docs/KNOWN-GAPS.md at 118.0 KB");
    expect(signal).toContain("has not finished so much as documented not finishing");
    expect(signal).toContain("is this work you want bought, or gaps you accept?");
  });

  it("asks about disclosure spread thin as well as piled deep", () => {
    const many = Array.from({ length: 50 }, (_, i) => `- feature ${i} is not implemented`).join("\n");
    const signal = gapLedgerSignal(gapLedger([file("src/notes.ts", many)]));
    expect(signal).toContain("50 line(s) across the diff record something as deliberately not done");
    expect(signal).toContain("feature 0 is not implemented");
    // No ledger file, so nothing is claimed about one.
    expect(signal).not.toContain("KB of documentation");
  });

  it("says both when a run did both", () => {
    const many = Array.from({ length: 50 }, (_, i) => `- feature ${i} is deferred to a later run`).join("\n");
    const signal = gapLedgerSignal(gapLedger([file("docs/gaps.md", big(20)), file("src/notes.ts", many)]));
    expect(signal).toContain("KB of documentation");
    expect(signal).toContain("and 50 line(s)");
  });
});
