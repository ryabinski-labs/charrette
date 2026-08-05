import { inflateSync } from "node:zlib";
import { hasDryRun, infraMutation } from "./infraGuard.js";

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
 * A blank capture is exactly 1.0 — the failure this exists to catch is a page
 * that never painted, not a page with little on it. The threshold sits just
 * below 1.0 so that "background painted, nothing else did" is caught too, and
 * no lower: at 0.995 a mobile viewport whose only content is an 8px-tall line
 * of text was struck, and a false strike hides real evidence from the operator.
 * Measured margin — the real capture that prompted this module carries 2676
 * distinct colours, and one 16px line of text on a 390x844 page comes in at
 * 0.990, so nothing that rendered anything at all lands near here.
 */
const FLAT_FRACTION = 0.999;

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

  // `sampled` is always at least one: parsePng rejects a zero width or height,
  // and row 0 and column 0 are sampled whatever the steps work out to.
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

/**
 * The other half of the same rule, for the claims that are not files.
 *
 * A file listed as evidence is now opened before it is believed. A command is
 * not: "I ran the full suite and it is green" reaches the operator as a fact
 * because an agent typed it. In run da8325bd a release-verification task
 * reported a green end-to-end pass over criteria that the demo then
 * contradicted on the first surface it rendered — and the only thing standing
 * behind that report was the sentence itself.
 *
 * So a claim about a command has to carry the command, and the harness runs it
 * again. What comes back decides which heading the claim is printed under, the
 * same three-way outcome the artifacts get: confirmed, struck, or — for a
 * command that cannot be safely repeated — reported as the unverified thing it
 * is rather than as evidence.
 */
export interface CommandClaim {
  command: string;
  /** What passing it proves. Empty is a fault, as it is for a file. */
  shows: string;
}

export interface CommandCheck extends CommandClaim {
  ok: boolean;
  /** Whether the harness actually ran it. False means the claim is unverified, not disproved. */
  verified: boolean;
  /** Why it is not evidence, in the operator's language. Empty when ok. */
  fault: string;
}

/**
 * Commands whose second run is not the same as their first.
 *
 * Re-running a check is free; re-running a POST creates a second booking, and
 * re-running an install or a migration changes the tree the operator is about
 * to review. The harness would rather report a claim as unverified than cause
 * the thing it was trying to confirm.
 */
const NOT_REPEATABLE: { re: RegExp; why: string; unless?: (command: string) => boolean }[] = [
  // Scoped to the HTTP clients, and anchored on whitespace rather than `\b`:
  // there is no word boundary between a space and a `-`, so `\b-X` matches
  // nothing an agent would ever write.
  {
    re: /\b(curl|wget|http|https|xh|httpie)\b[\s\S]*?(?:(?:^|\s)-X\s*(?:POST|PUT|PATCH|DELETE)\b|--request[=\s]+(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?)[=\s]|--post-data\b|(?:^|\s)(?:POST|PUT|PATCH|DELETE)\s)/i,
    why: "it sends a write request, and running it again would repeat the write",
  },
  { re: /\b(npm|pnpm|yarn|pip|pip3|poetry|bundle|gem|cargo|go|apt|apt-get|brew)\s+(i|install|add|get|update|upgrade)\b/, why: "it installs or updates dependencies, which changes the tree being reviewed" },
  {
    // Both halves matter: the word, for `manage.py migrate` and `db:seed`, and
    // the tool, for `alembic upgrade head`, which says neither.
    re: /\b(migrate|migrations?|seed|createdb|dropdb|flushdb|truncate)\b|\b(alembic|flyway|liquibase|goose|dbmate|sqitch|prisma|knex)\b/i,
    why: "it changes stored data, so a second run does not start from the same state",
  },
  {
    // The tools above are how a repository migrates; this is how a person does
    // the same thing by hand, and the harness has to recognise both. Scoped to
    // a database client and a statement that writes, so `psql -c "SELECT
    // count(*) FROM bookings"` — the shape a probe actually wants — still runs.
    re: /\b(psql|mysql|mariadb|sqlite3|mongosh|mongo|redis-cli|clickhouse-client|cqlsh)\b[\s\S]*?\b(drop|delete|truncate|insert|update|alter|create|flushall)\b/i,
    why: "it runs a statement that changes the database, so a second run does not start from the same state",
  },
  { re: /\bgit\s+(commit|push|merge|rebase|reset|checkout|switch|restore|clean|stash)\b/, why: "it writes to a git repository" },
  { re: />>?\s*\S|\btee\b|\b(rm|mv|cp|mkdir|touch|chmod|chown|ln)\s/, why: "it writes to the filesystem" },
  {
    re: /\b(docker|podman|compose|kubectl|helm)\b.*\b(up|run|start|restart|exec|apply|delete)\b/,
    why: "it starts or changes containers, which is not the same twice",
    // `kubectl --dry-run=server apply` is the same every time it runs, and is
    // the form these tools are supposed to be demonstrated with. Asking the
    // infra guard rather than matching a flag here keeps one answer to it.
    unless: hasDryRun,
  },
];

/** Can this command be run a second time without changing anything? */
export function repeatable(command: string): { ok: true } | { ok: false; why: string } {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, why: "there is no command to run" };
  const mutation = infraMutation(trimmed);
  if (mutation) return { ok: false, why: `${mutation.what} changes real infrastructure and the harness will not run it` };
  for (const { re, why, unless } of NOT_REPEATABLE) if (re.test(trimmed) && !unless?.(trimmed)) return { ok: false, why };
  return { ok: true };
}

/** How a re-run went: whether it passed, and what it printed. */
export interface Rerun {
  ok: boolean;
  output: string;
}

/**
 * Grade every command the agent offered as proof.
 *
 * `rerun` runs one command and says how it went, or returns null when the
 * harness had nowhere to run it — which keeps this pure, and means "there was
 * no worktree to check in" is reported as unverified rather than as failed.
 */
export function checkCommands(
  claims: CommandClaim[],
  rerun: (command: string) => Rerun | null,
  /** Why a command the harness was willing to repeat was not repeated after all. */
  notRunReason = "the harness did not run it again"
): CommandCheck[] {
  const seen = new Set<string>();
  return claims.map((c) => {
    const command = c.command.trim();
    const shows = c.shows.trim();
    const unverified = (fault: string): CommandCheck => ({ command, shows, ok: false, verified: false, fault });

    if (!command) return unverified("a claim with no command, so there is nothing to check");
    if (seen.has(command)) return { command, shows, ok: true, verified: false, fault: "" };
    seen.add(command);
    if (!shows) return unverified("run with no statement of what it proves, so nobody can tell what it settles");

    const repeat = repeatable(command);
    if (!repeat.ok) return unverified(`not re-run by the harness because ${repeat.why}`);

    const result = rerun(command);
    if (!result) return unverified(notRunReason);
    if (!result.ok) {
      return { command, shows, ok: false, verified: true, fault: `re-run by the harness and it failed:\n${result.output.slice(-1200)}` };
    }
    return { command, shows, ok: true, verified: true, fault: "" };
  });
}

/**
 * File every command claim under the heading that is true of it.
 *
 * A confirmed claim keeps its place. Everything else moves to what the pit stop
 * could not check — including the ones that were merely not re-run, because an
 * unverified claim printed beside a verified one reads as verified, and that is
 * the whole failure this exists to stop.
 */
export function strikeCommands<T extends { commands: CommandClaim[]; couldNotReach: string[] }>(report: T, checks: CommandCheck[]): T {
  const kept = checks.filter((c) => c.ok && c.verified);
  const struck = checks.filter((c) => !(c.ok && c.verified));
  if (!struck.length) return { ...report, commands: kept.map((c) => ({ command: c.command, shows: c.shows })) };
  return {
    ...report,
    commands: kept.map((c) => ({ command: c.command, shows: c.shows })),
    couldNotReach: [
      ...report.couldNotReach,
      ...struck.map((c) => `${c.shows || c.command || "a command"} — not verified: ${c.command ? `\`${c.command}\` ` : ""}${c.fault}`),
    ],
  };
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
