import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkCommands, checkEvidence, evidenceFaults, inspectPng, repeatable, retryableFaults, strikeCommands, strikeEvidence } from "./evidence.js";

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

/** Paeth, from the PNG spec — the encoding side of what the decoder undoes. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface PngOpts {
  /** The row filter every scanline uses. Browsers pick adaptively. */
  filter?: 0 | 1 | 2 | 3 | 4;
  /** 8 or 16 bits per channel. */
  depth?: 8 | 16;
  /** 0 greyscale, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  colorType?: 0 | 2 | 3 | 4 | 6;
  /** Chunks written between IHDR and IDAT, as a real encoder does. */
  extra?: Buffer[];
  interlace?: boolean;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** A PNG, in whatever shape the test needs. Defaults to 8-bit RGBA. */
function png(width: number, height: number, pixel: (x: number, y: number) => number[], opts: PngOpts = {}): Buffer {
  const { filter = 0, depth = 8, colorType = 6, extra = [], interlace = false } = opts;
  const bpp = (CHANNELS[colorType]! * depth) / 8;
  const stride = width * bpp;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const raw = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const px = pixel(x, y);
      for (let c = 0; c < CHANNELS[colorType]!; c++) {
        if (depth === 16) raw.writeUInt16BE(px[c] ?? 0, x * bpp + c * 2);
        else raw[x * bpp + c] = px[c] ?? 0;
      }
    }
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? raw[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const predictor = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0;
      out[i + 1] = (raw[i]! - predictor) & 0xff;
    }
    rows.push(out);
    prev = raw;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = interlace ? 1 : 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const WHITE = [255, 255, 255, 255];
const blank = (opts: PngOpts = {}) => png(390, 844, () => WHITE, opts);
/** A page: white, with text-ish marks and a coloured band. Not busy — sparse. */
const page = (opts: PngOpts = {}) =>
  png(
    1440,
    900,
    (x, y) => {
      if (y < 64) return [26, 26, 23, 255];
      if (y % 40 < 12 && x > 100 && x < 700) return [((x * 7) % 200) + 30, 40, 60, 255];
      return WHITE;
    },
    opts
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
    // All five, including Average and Paeth, which is what a browser reaches
    // for on a photographic or gradient region — a decoder that gets Paeth
    // wrong turns a real page into noise and passes it as content.
    for (const filter of [1, 2, 3, 4] as const) {
      expect(inspectPng(blank({ filter })).kind, `filter ${filter}`).toBe("flat");
      expect(inspectPng(page({ filter })).kind, `filter ${filter}`).toBe("content");
    }
  });

  it("decodes noise the same however it was filtered", () => {
    // Gradients let Paeth's three predictors agree. Noise makes each of them
    // win in turn, which is the only way to know the un-filtering is right
    // rather than accidentally close.
    let seed = 12_345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff;
    const pixels: number[][] = [];
    for (let i = 0; i < 128 * 128; i++) pixels.push([rand(), rand(), rand(), 255]);
    const noise = (opts: PngOpts) => png(128, 128, (x, y) => pixels[y * 128 + x]!, opts);
    const seen = ([0, 1, 2, 3, 4] as const).map((filter) => inspectPng(noise({ filter })).detail);
    expect(new Set(seen).size, seen.join(" | ")).toBe(1);
  });

  it("decodes a gradient the same however it was filtered", () => {
    // Same pixels, five encodings: any un-filtering bug shows up as a different
    // colour count for the same image.
    const gradient = (opts: PngOpts) => png(256, 256, (x, y) => [x, y, (x + y) & 0xff, 255], opts);
    const counts = ([0, 1, 2, 3, 4] as const).map((filter) => inspectPng(gradient({ filter })).detail);
    expect(new Set(counts).size, counts.join(" | ")).toBe(1);
  });

  it("reads every colour type and depth a screenshot arrives in", () => {
    // Playwright emits RGBA8; the others turn up from image tooling the demo
    // agent may reach for, and a shape misread as unreadable is a blank that
    // sails through.
    const shapes: [string, PngOpts, number[], number[]][] = [
      ["greyscale", { colorType: 0 }, [255], [0]],
      ["RGB", { colorType: 2 }, [255, 255, 255], [20, 30, 40]],
      ["palette", { colorType: 3, extra: [chunk("PLTE", Buffer.from([255, 255, 255, 0, 0, 0]))] }, [0], [1]],
      ["grey+alpha", { colorType: 4 }, [255, 255], [0, 255]],
      ["16-bit RGBA", { depth: 16, colorType: 6 }, [65535, 65535, 65535, 65535], [0, 20000, 40000, 65535]],
    ];
    for (const [name, opts, bg, ink] of shapes) {
      expect(inspectPng(png(300, 600, () => bg, opts)).kind, name).toBe("flat");
      expect(inspectPng(png(300, 600, (x, y) => (y < 80 || x % 9 < 3 ? ink : bg), opts)).kind, name).toBe("content");
    }
  });

  it("is not thrown off by the chunks an encoder puts before the pixels", () => {
    const tagged = blank({ extra: [chunk("tEXt", Buffer.from("Software\0playwright")), chunk("pHYs", Buffer.alloc(9))] });
    expect(inspectPng(tagged).kind).toBe("flat");
  });

  it("counts a fully transparent capture as blank", () => {
    expect(inspectPng(png(390, 844, () => [0, 0, 0, 0])).kind).toBe("flat");
  });

  it("leaves alone the shapes it does not decode, rather than calling them blank", () => {
    expect(inspectPng(blank({ interlace: true })).detail).toContain("interlaced");
    // Sub-byte depths: real files, but not what a browser writes, and unpacking
    // them wrong would read as flat.
    const oneBit = png(160, 200, () => [255], { colorType: 0 });
    oneBit[24] = 1; // IHDR bit depth
    expect(inspectPng(oneBit).kind).toBe("unreadable");
  });

  it("survives whatever bytes it is handed", () => {
    const real = page();
    const hostile: [string, Buffer][] = [
      ["png magic only", real.subarray(0, 8)],
      ["header only", real.subarray(0, 33)],
      ["truncated mid-IDAT", real.subarray(0, Math.floor(real.length / 2))],
      ["corrupted pixels", (() => { const b = Buffer.from(real); b[b.length - 100] = b[b.length - 100]! ^ 0xff; return b; })()],
      ["zero dimensions", (() => { const b = Buffer.from(real); b.writeUInt32BE(0, 16); return b; })()],
      ["dimensions that lie", (() => { const b = Buffer.from(real); b.writeUInt32BE(100_000, 16); return b; })()],
      ["a chunk length past the end", (() => { const b = Buffer.from(real); b.writeUInt32BE(0x7fffffff, 33); return b; })()],
      ["a JPEG", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)])],
    ];
    for (const [name, buf] of hostile) {
      // Never throws — a decoder that dies takes the whole pit stop with it —
      // and never claims blank, which would strike evidence over a parse bug.
      expect(inspectPng(buf).kind, name).toBe("unreadable");
    }
  });

  it("does not strike a page just because there is little on it", () => {
    // Calibration: struck at 0.995, this passes. A false strike hides real
    // evidence, and "sparse" is not "never painted".
    const oneLine = png(390, 844, (x, y) => (y > 420 && y < 436 && x > 95 && x < 295 ? [90, 90, 90, 255] : WHITE));
    expect(inspectPng(oneLine).kind).toBe("content");
    const darkEmptyState = png(390, 844, (x, y) => (y > 400 && y < 430 && x > 120 && x < 270 ? [200, 200, 200, 255] : [17, 17, 20, 255]));
    expect(inspectPng(darkEmptyState).kind).toBe("content");
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
    // nothing else did. One 8px square in a 390x844 page is 0.02% of it.
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

  it("rejects an artifact with no filename at all", () => {
    const checks = checkEvidence([{ file: "   ", shows: "the dashboard" }], files({}));
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.fault).toContain("no filename");
    expect(checks[0]!.retryable).toBe(false);
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

  it("names every fault for the agent, including the one with no filename", () => {
    const checks = checkEvidence(
      [
        { file: "m.png", shows: "the home page at 390px" },
        { file: "", shows: "" },
      ],
      files({ "m.png": blank() })
    );

    expect(evidenceFaults(checks)).toEqual([
      "m.png — 390x844 of a single colour — the page never painted",
      "(unnamed) — an artifact with no filename",
    ]);
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

  it("still names the failure when there is no claim and no filename to name it by", () => {
    const thin = {
      artifacts: [
        { file: "shot.png", shows: "" },
        { file: "", shows: "" },
      ],
      couldNotReach: [] as string[],
    };
    const struck = strikeEvidence(thin, checkEvidence(thin.artifacts, () => page()));

    expect(struck.artifacts).toEqual([]);
    expect(struck.couldNotReach[0]).toContain("shot.png");
    expect(struck.couldNotReach[1]).toContain("an artifact");
    expect(struck.couldNotReach[1]).not.toContain("``");
  });

  it("leaves a clean report exactly as it was", () => {
    const clean = { artifacts: [{ file: "desktop.png", shows: "the home page" }], couldNotReach: [] as string[] };
    const struck = strikeEvidence(clean, checkEvidence(clean.artifacts, () => page()));
    expect(struck).toEqual(clean);
  });
});

/**
 * The same rule as artifacts, applied to the claims that are not files.
 *
 * Run da8325bd: a release-verification task reported a green end-to-end pass
 * over criteria the demo then contradicted on the first surface it rendered.
 * Nothing stood behind that report but the sentence itself.
 */
describe("a claim about a command", () => {
  const green = () => ({ ok: true, output: "" });
  const red = (output: string) => () => ({ ok: false, output });

  it("survives when the harness runs it again and agrees", () => {
    const checks = checkCommands([{ command: "pnpm test", shows: "the suite is green" }], green);

    expect(checks[0]).toMatchObject({ ok: true, verified: true, fault: "" });
  });

  it("is struck, with the output, when the re-run disagrees", () => {
    const checks = checkCommands([{ command: "pnpm test", shows: "the suite is green" }], red("2 failed | 40 passed"));

    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.verified).toBe(true);
    expect(checks[0]!.fault).toContain("2 failed | 40 passed");
  });

  it("is not evidence without a statement of what passing it proves", () => {
    expect(checkCommands([{ command: "pnpm test", shows: "" }], green)[0]).toMatchObject({ ok: false, verified: false });
    expect(checkCommands([{ command: "", shows: "it works" }], green)[0]!.fault).toContain("no command");
  });

  /**
   * The harness would rather report a claim as unverified than cause the thing
   * it was trying to confirm — a second POST is a second booking.
   */
  it("refuses to repeat anything whose second run is not the same as its first", () => {
    expect(repeatable("curl -X POST localhost:8000/v1/bookings").ok).toBe(false);
    expect(repeatable("curl -s -d '{}' localhost:8000/v1/bookings").ok).toBe(false);
    expect(repeatable("pnpm install").ok).toBe(false);
    expect(repeatable("alembic upgrade head").ok).toBe(false);
    expect(repeatable("git commit -am wip").ok).toBe(false);
    expect(repeatable("echo hi > out.txt").ok).toBe(false);
    expect(repeatable("docker compose up -d").ok).toBe(false);
    expect(repeatable("terraform apply -auto-approve").ok).toBe(false);
  });

  /**
   * The migration tools are how a repository changes its data; a SQL client is
   * how a person does the same thing by hand, and it says none of their names.
   * It matters more since the completion probe started asking this function
   * whether the harness may run a planner's command — a probe is not re-run
   * once, it is re-run on every QA iteration until the task passes.
   */
  it("refuses a statement that writes to the database, however it was spelled", () => {
    expect(repeatable("psql -c 'DROP TABLE users'").ok).toBe(false);
    expect(repeatable("psql $DATABASE_URL -c \"DELETE FROM bookings\"").ok).toBe(false);
    expect(repeatable("mysql -e 'INSERT INTO orgs VALUES (1)'").ok).toBe(false);
    expect(repeatable("redis-cli flushall").ok).toBe(false);
  });

  it("does repeat the reads a demo actually offers as proof", () => {
    expect(repeatable("pnpm test").ok).toBe(true);
    expect(repeatable("npx tsc --noEmit").ok).toBe(true);
    expect(repeatable("pytest -q").ok).toBe(true);
    expect(repeatable("curl -s -o /dev/null -w '%{http_code}' localhost:8000/health").ok).toBe(true);
    // A query is the shape a completion probe actually wants, and it reads.
    expect(repeatable('psql -c "SELECT count(*) FROM bookings"').ok).toBe(true);
    // A dry run is the same every time it runs, and is how these tools are
    // meant to be demonstrated.
    expect(repeatable("kubectl --dry-run=server apply -f k8s/").ok).toBe(true);
  });

  /**
   * A planner writing a completion probe is the one caller that can hand this
   * an empty string: `completionProbe` defaults to "" for the tasks that have
   * none, and every task in a plan carries the field whether or not it is set.
   */
  it("has nothing to say yes to when there is no command", () => {
    expect(repeatable("")).toEqual({ ok: false, why: "there is no command to run" });
    expect(repeatable("   \n ").ok).toBe(false);
  });

  it("reports an unrepeatable claim as unverified rather than as proof or as a lie", () => {
    const checks = checkCommands([{ command: "curl -X POST /v1/bookings", shows: "a booking is created" }], green);

    expect(checks[0]).toMatchObject({ ok: false, verified: false });
    expect(checks[0]!.fault).toContain("repeat the write");
  });

  it("says why a claim it was willing to run was not run", () => {
    const checks = checkCommands([{ command: "pnpm test", shows: "green" }], () => null, "past the per-pit-stop cap");

    expect(checks[0]!.fault).toBe("past the per-pit-stop cap");
  });

  it("does not run the same command twice for two claims", () => {
    let runs = 0;
    const checks = checkCommands(
      [
        { command: "pnpm test", shows: "the suite is green" },
        { command: "pnpm test", shows: "the regression is fixed" },
      ],
      () => (runs++, { ok: true, output: "" })
    );

    expect(runs).toBe(1);
    expect(checks.every((c) => c.ok)).toBe(true);
  });
});

describe("filing command claims under the heading that is true of them", () => {
  const report = () => ({
    commands: [
      { command: "pnpm test", shows: "the suite is green" },
      { command: "curl -X POST /v1/bookings", shows: "a booking is created" },
      { command: "npx tsc --noEmit", shows: "the types check" },
    ],
    couldNotReach: ["payments — no Stripe test keys"],
  });

  it("keeps only what a second run confirmed, and moves the rest to what was not checked", () => {
    const r = report();
    const struck = strikeCommands(
      r,
      checkCommands(r.commands, (c) => (c === "pnpm test" ? { ok: true, output: "" } : { ok: false, output: "TS2339" }))
    );

    expect(struck.commands).toEqual([{ command: "pnpm test", shows: "the suite is green" }]);
    // The claim it could not repeat and the claim that failed both land here,
    // each with the command, so the operator can settle it themselves.
    expect(struck.couldNotReach).toHaveLength(3);
    expect(struck.couldNotReach.join("\n")).toContain("curl -X POST /v1/bookings");
    expect(struck.couldNotReach.join("\n")).toContain("npx tsc --noEmit");
    expect(struck.couldNotReach[0]).toBe("payments — no Stripe test keys");
  });

  /**
   * The heading has to name something even when the claim named nothing. A demo
   * that lists a command with no statement of what it proves, or a statement
   * with no command, still has to appear in what the pit stop could not check —
   * a claim that quietly disappears reads to the operator as one that passed.
   */
  it("still names the claim when the demo left the command or the statement blank", () => {
    const r = {
      commands: [
        { command: "pnpm test", shows: "" },
        { command: "", shows: "" },
      ],
      couldNotReach: [] as string[],
    };
    const struck = strikeCommands(r, checkCommands(r.commands, () => ({ ok: true, output: "" })));

    expect(struck.commands).toEqual([]);
    expect(struck.couldNotReach[0]).toContain("pnpm test — not verified: `pnpm test` ");
    expect(struck.couldNotReach[0]).toContain("no statement of what it proves");
    // Nothing left to name it by, so it is filed under what it was.
    expect(struck.couldNotReach[1]).toBe("a command — not verified: a claim with no command, so there is nothing to check");
  });

  it("leaves a report whose every claim was confirmed exactly as it was", () => {
    const clean = { commands: [{ command: "pnpm test", shows: "green" }], couldNotReach: [] as string[] };
    expect(strikeCommands(clean, checkCommands(clean.commands, () => ({ ok: true, output: "" })))).toEqual(clean);
  });
});
