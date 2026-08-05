import { inflateSync } from "node:zlib";

/**
 * The gate on what a pit stop is allowed to call evidence.
 *
 * A demo agent captured a marketing page at two widths and shipped both files.
 * The mobile one was 1082x2202 of pure white — the page had never painted — and
 * the pit stop listed it under "## Evidence" beside the desktop one, as a bare
 * filename with no claim attached. The operator opened a blank image and a
 * screenshot of a homepage and could not tell what either was supposed to
 * settle. The agent's prose did admit the blank capture, four paragraphs up.
 *
 * Two failures, one shape: nothing between the agent and the operator ever
 * *looked* at the files. So this module looks. An image that is one flat colour
 * is not evidence of anything; a file listed without the claim it backs is not
 * evidence either, because evidence is a file plus what it proves. Both are
 * struck from the report and reappear under "What it could NOT check", which is
 * where an unverified thing has always belonged.
 *
 * Pure and I/O-free on purpose — the caller supplies the bytes — so the rule
 * about what counts is testable without a browser, a worktree or a run.
 */

/** A file the demo agent wrote, and the claim it is offered as proof of. */
export interface ArtifactClaim {
  file: string;
  /** What a reader learns by opening it. Empty is a fault, not a default. */
  shows: string;
}

export interface EvidenceCheck extends ArtifactClaim {
  ok: boolean;
  /** Why it is not evidence, in the operator's language. Empty when ok. */
  fault: string;
  /** Whether re-capturing it could plausibly fix the fault. */
  retryable: boolean;
}

/** Anything below this is a failed capture, not a small image. */
const MIN_IMAGE_BYTES = 256;

/**
 * The fraction of one colour at which an image stops carrying information.
 *
 * A blank capture is exactly 1.0. The threshold sits just below because a page
 * that painted its background and nothing else is the same failure with a
 * stray scrollbar in it, and because a real screenshot of a sparse page still
 * comes in well under: the desktop capture that prompted this module is 71%
 * background.
 */
const FLAT_FRACTION = 0.995;

export type ImageVerdict =
  | { kind: "flat"; detail: string }
  | { kind: "content"; detail: string }
  | { kind: "unreadable"; detail: string };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Png {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  interlace: boolean;
  idat: Buffer;
}

/** Chunk walk. Returns null for anything that is not a PNG we can read. */
function parsePng(buf: Buffer): Png | null {
  if (buf.length < 8 + 25 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  let head: Omit<Png, "idat"> | null = null;
  const idat: Buffer[] = [];
  let at = 8;
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const body = at + 8;
    if (body + len > buf.length) break;
    if (type === "IHDR") {
      head = {
        width: buf.readUInt32BE(body),
        height: buf.readUInt32BE(body + 4),
        depth: buf[body + 8]!,
        colorType: buf[body + 9]!,
        interlace: buf[body + 12] !== 0,
      };
    } else if (type === "IDAT") {
      idat.push(buf.subarray(body, body + len));
    } else if (type === "IEND") {
      break;
    }
    at = body + len + 4; // + CRC
  }
  if (!head || !idat.length || !head.width || !head.height) return null;
  return { ...head, idat: Buffer.concat(idat) };
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Paeth, from the PNG spec. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Does this image show anything?
 *
 * Decodes far enough to compare pixels and no further: 8- and 16-bit
 * non-interlaced PNGs, which is what every headless browser emits. Anything
 * else comes back "unreadable" and is left alone — a check that guesses is
 * worse than no check, because a struck artifact is one the operator never
 * sees.
 */
export function inspectPng(buf: Buffer): ImageVerdict {
  const png = parsePng(buf);
  if (!png) return { kind: "unreadable", detail: "not a PNG this harness can decode" };
  if (png.interlace) return { kind: "unreadable", detail: "interlaced PNG" };
  const channels = CHANNELS[png.colorType];
  if (!channels || (png.depth !== 8 && png.depth !== 16)) {
    return { kind: "unreadable", detail: `PNG colour type ${png.colorType} at ${png.depth}-bit` };
  }

  let raw: Buffer;
  try {
    raw = inflateSync(png.idat);
  } catch {
    return { kind: "unreadable", detail: "PNG pixel data would not inflate" };
  }
  const bpp = (channels * png.depth) / 8;
  const stride = png.width * bpp;
  if (raw.length < (stride + 1) * png.height) {
    return { kind: "unreadable", detail: "PNG pixel data is short" };
  }

  // Un-filter in place into a single scanline pair; only the current and
  // previous lines are ever needed, so a 20MB screenshot costs two rows.
  let prev = Buffer.alloc(stride);
  let line = Buffer.alloc(stride);
  const counts = new Map<string, number>();
  let sampled = 0;
  // Sample rather than count every pixel: the answer is a ratio, and a full
  // pass over a retina full-page capture is millions of map writes for a digit
  // that does not move.
  const rowStep = Math.max(1, Math.floor(png.height / 400));
  const colStep = Math.max(1, Math.floor(png.width / 400));

  for (let y = 0; y < png.height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at]!;
    raw.copy(line, 0, at + 1, at + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const x = line[i]!;
      if (filter === 1) line[i] = (x + a) & 0xff;
      else if (filter === 2) line[i] = (x + b) & 0xff;
      else if (filter === 3) line[i] = (x + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) line[i] = (x + paeth(a, b, c)) & 0xff;
    }
    if (y % rowStep === 0) {
      for (let x = 0; x < png.width; x += colStep) {
        const key = line.toString("latin1", x * bpp, x * bpp + bpp);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        sampled++;
      }
    }
    const swap = prev;
    prev = line;
    line = swap;
  }

  if (!sampled) return { kind: "unreadable", detail: "no pixels sampled" };
  let top = 0;
  for (const n of counts.values()) if (n > top) top = n;
  const fraction = top / sampled;
  const size = `${png.width}x${png.height}`;
  return fraction >= FLAT_FRACTION
    ? {
        kind: "flat",
        detail:
          counts.size === 1
            ? `${size} of a single colour — the page never painted`
            : `${size} and ${(fraction * 100).toFixed(1)}% one colour — nothing rendered`,
      }
    : { kind: "content", detail: `${size}, ${counts.size} distinct colours` };
}

/** Is this name something we know how to look inside? */
function isImage(file: string): boolean {
  return /\.(png|jpe?g|webp|gif|avif)$/i.test(file);
}

/**
 * Grade every artifact the demo agent offered.
 *
 * `read` returns the file's bytes, or null when it is not there — which keeps
 * this function pure and means "the agent listed a file it never wrote" is
 * caught by the same pass as "the agent listed a blank one".
 */
export function checkEvidence(artifacts: ArtifactClaim[], read: (file: string) => Buffer | null): EvidenceCheck[] {
  const seen = new Set<string>();
  return artifacts.map((a) => {
    const file = a.file.trim();
    const shows = a.shows.trim();
    const bad = (fault: string, retryable = true): EvidenceCheck => ({ file, shows, ok: false, fault, retryable });

    if (!file) return bad("an artifact with no filename", false);
    if (seen.has(file)) return bad("listed twice", false);
    seen.add(file);

    const bytes = read(file);
    if (!bytes) return bad("listed as evidence but not written to the artifact directory");
    if (!bytes.length) return bad("written empty (0 bytes)");

    if (isImage(file)) {
      if (bytes.length < MIN_IMAGE_BYTES) return bad(`${bytes.length} bytes — a failed capture, not an image`);
      const verdict = inspectPng(bytes);
      if (verdict.kind === "flat") return bad(verdict.detail);
    }
    // Checked last so that a blank image is reported as blank rather than as
    // uncaptioned: the agent should fix the capture before it writes a caption
    // for it.
    if (!shows) return bad("listed with no statement of what it shows, so nobody can tell what it proves");
    return { file, shows, ok: true, fault: "", retryable: false };
  });
}

/** The agent-facing list of what has to be fixed. Empty when nothing does. */
export function evidenceFaults(checks: EvidenceCheck[]): string[] {
  return checks.filter((c) => !c.ok).map((c) => `${c.file || "(unnamed)"} — ${c.fault}`);
}

/** Anything a second attempt could plausibly repair. */
export function retryableFaults(checks: EvidenceCheck[]): boolean {
  return checks.some((c) => !c.ok && c.retryable);
}

/**
 * Move everything that failed the check out of the evidence list and into the
 * list of things this pit stop did not verify.
 *
 * Not deletion: a capture that came back blank is a fact about the run, and an
 * operator who is shown neither the file nor the failure will assume the width
 * was covered. It is the same information, filed under the heading that is true.
 */
export function strikeEvidence<T extends { artifacts: ArtifactClaim[]; couldNotReach: string[] }>(
  report: T,
  checks: EvidenceCheck[]
): T {
  const struck = checks.filter((c) => !c.ok);
  if (!struck.length) return { ...report, artifacts: checks.map((c) => ({ file: c.file, shows: c.shows })) };
  return {
    ...report,
    artifacts: checks.filter((c) => c.ok).map((c) => ({ file: c.file, shows: c.shows })),
    couldNotReach: [
      ...report.couldNotReach,
      ...struck.map(
        (c) =>
          `${c.shows || c.file || "an artifact"} — not verified: ${c.file ? `\`${c.file}\` ` : ""}${c.fault}` +
          " (struck from the evidence by the harness, which inspected the file)"
      ),
    ],
  };
}
