import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkEvidence, evidenceFaults, inspectPng, retryableFaults, strikeEvidence } from "./evidence.js";

/**
 * Real PNGs, built here rather than checked in as fixtures: the thing under
 * test is a decoder, and a decoder tested against bytes some other decoder
 * wrote is the only way to know it reads what a browser writes.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([head, typed, crc]);
}

/** An 8-bit RGBA PNG. `filter` picks the row filter every scanline uses. */
function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
  filter: 0 | 1 | 2 = 0
): Buffer {
  const bpp = 4;
  const stride = width * bpp;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const raw = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), x * bpp);
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? raw[i - bpp]! : 0;
      const b = prev[i]!;
      const encoded = filter === 1 ? raw[i]! - a : filter === 2 ? raw[i]! - b : raw[i]!;
      out[i + 1] = encoded & 0xff;
    }
    rows.push(out);
    prev = raw;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const blank = (filter: 0 | 1 | 2 = 0) => png(390, 844, () => WHITE, filter);
/** A page: white, with text-ish marks and a coloured band. Not busy — sparse. */
const page = (filter: 0 | 1 | 2 = 0) =>
  png(
    1440,
    900,
    (x, y) => {
      if (y < 64) return [26, 26, 23, 255];
      if (y % 40 < 12 && x > 100 && x < 700) return [((x * 7) % 200) + 30, 40, 60, 255];
      return WHITE;
    },
    filter
  );

describe("looking at the image before calling it evidence", () => {
  it("calls a screenshot of one flat colour what it is", () => {
    const verdict = inspectPng(blank());
    expect(verdict.kind).toBe("flat");
    expect(verdict.detail).toContain("390x844");
    expect(verdict.detail).toContain("never painted");
  });

  it("passes a real page, sparse as it is", () => {
    expect(inspectPng(page()).kind).toBe("content");
  });

  it("reads the filters a browser actually emits, not just unfiltered rows", () => {
    // A bug in un-filtering shows up here twice over: Sub/Up deltas of a flat
    // image are all zero, so a decoder that forgets to undo them still sees
    // flat — but a real page decoded wrong turns into noise and passes.
    for (const filter of [1, 2] as const) {
      expect(inspectPng(blank(filter)).kind).toBe("flat");
      expect(inspectPng(page(filter)).kind).toBe("content");
    }
  });

  it("says so rather than guessing when it cannot decode the file", () => {
    expect(inspectPng(Buffer.from("not a png at all")).kind).toBe("unreadable");
    expect(inspectPng(Buffer.alloc(0)).kind).toBe("unreadable");
    // A PNG whose pixel data is truncated must not be read as blank: an
    // undecodable file is left to the operator, a blank one is struck.
    const truncated = page().subarray(0, 200);
    expect(inspectPng(truncated).kind).toBe("unreadable");
  });

  it("still calls an almost-flat capture flat", () => {
    // The failure mode that is not pure white: the background painted and
    // nothing else did. One 8px square in a 390x844 page is 0.01% of it.
    const nearly = png(390, 844, (x, y) => (x < 8 && y < 8 ? [255, 0, 0, 255] : WHITE));
    expect(inspectPng(nearly).kind).toBe("flat");
  });
});

describe("what a pit stop is allowed to call evidence", () => {
  const files = (map: Record<string, Buffer>) => (f: string) => map[f] ?? null;

  it("takes a captioned file that shows something", () => {
    const checks = checkEvidence([{ file: "home.png", shows: "the marketing home at 1440px" }], files({ "home.png": page() }));
    expect(checks[0]!.ok).toBe(true);
    expect(evidenceFaults(checks)).toEqual([]);
  });

  it("rejects the blank capture the operator was going to open", () => {
    const checks = checkEvidence([{ file: "home-mobile.png", shows: "the home page at 390px" }], files({ "home-mobile.png": blank() }));
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.fault).toContain("never painted");
    expect(checks[0]!.retryable).toBe(true);
  });

  it("rejects a file offered with no claim, because a filename proves nothing", () => {
    const checks = checkEvidence([{ file: "home.png", shows: "  " }], files({ "home.png": page() }));
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.fault).toContain("no statement of what it shows");
  });

  it("rejects a file that was listed but never written, and one written empty", () => {
    const checks = checkEvidence(
      [
        { file: "ghost.png", shows: "the checkout page" },
        { file: "empty.log", shows: "the seed script output" },
      ],
      files({ "empty.log": Buffer.alloc(0) })
    );
    expect(checks.map((c) => c.ok)).toEqual([false, false]);
    expect(checks[0]!.fault).toContain("not written");
    expect(checks[1]!.fault).toContain("0 bytes");
  });

  it("does not judge the contents of files it cannot open, only that they exist", () => {
    const checks = checkEvidence(
      [{ file: "request.har", shows: "the checkout POST and its 303" }],
      files({ "request.har": Buffer.from("{\"log\":{}}") })
    );
    expect(checks[0]!.ok).toBe(true);
  });

  it("treats a tiny image as the failed capture it is", () => {
    const checks = checkEvidence([{ file: "shot.png", shows: "the dashboard" }], files({ "shot.png": Buffer.alloc(40, 1) }));
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.fault).toContain("failed capture");
  });

  it("counts the same file listed twice once", () => {
    const map = files({ "home.png": page() });
    const checks = checkEvidence(
      [
        { file: "home.png", shows: "the home page" },
        { file: "home.png", shows: "the home page again" },
      ],
      map
    );
    expect(checks[0]!.ok).toBe(true);
    expect(checks[1]!.ok).toBe(false);
    expect(checks[1]!.retryable).toBe(false);
  });

  it("knows which faults are worth another turn", () => {
    const good = checkEvidence([{ file: "home.png", shows: "the home page" }], files({ "home.png": page() }));
    expect(retryableFaults(good)).toBe(false);
    const blankOne = checkEvidence([{ file: "m.png", shows: "mobile" }], files({ "m.png": blank() }));
    expect(retryableFaults(blankOne)).toBe(true);
  });
});

describe("striking what did not survive the look", () => {
  const report = {
    artifacts: [
      { file: "desktop.png", shows: "the marketing home at 1440px, no giveaway banner" },
      { file: "mobile.png", shows: "the marketing home at 390px" },
    ],
    couldNotReach: ["the billing page in any tier state"],
  };
  const checks = checkEvidence(report.artifacts, (f) => (f === "desktop.png" ? page() : blank()));

  it("keeps the evidence and files the rest under what was not checked", () => {
    const struck = strikeEvidence(report, checks);
    expect(struck.artifacts).toEqual([report.artifacts[0]]);
    expect(struck.couldNotReach).toHaveLength(2);
    expect(struck.couldNotReach[1]).toContain("the marketing home at 390px");
    expect(struck.couldNotReach[1]).toContain("mobile.png");
    expect(struck.couldNotReach[1]).toContain("never painted");
  });

  it("does not delete the failure — an operator shown neither assumes it was covered", () => {
    const struck = strikeEvidence(report, checks);
    expect(struck.couldNotReach.join(" ")).toContain("struck from the evidence");
    // and leaves the original alone
    expect(report.artifacts).toHaveLength(2);
    expect(report.couldNotReach).toHaveLength(1);
  });

  it("leaves a clean report exactly as it was", () => {
    const clean = { artifacts: [{ file: "desktop.png", shows: "the home page" }], couldNotReach: [] as string[] };
    const struck = strikeEvidence(clean, checkEvidence(clean.artifacts, () => page()));
    expect(struck).toEqual(clean);
  });
});
