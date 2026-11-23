import { constants as FS, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { runLockHolder, type Store } from "@charrette/core";
import { statePaths } from "@charrette/shared";
import { environmentSecrets, harvestSecrets, maskSecrets } from "./redact.js";

/**
 * Read-only access to what a pit stop's demo wrote to disk.
 *
 * Everything under a stop directory was written by an agent, so it is untrusted
 * twice over: its *paths* may try to leave the directory and its *contents* may
 * try to run in the page. The routes below hold three lines. A path must resolve
 * inside the stop. Only images and video go out as themselves, and every other
 * file goes out as masked `text/plain`. And no route takes a write.
 */

/** The filesystem calls used here, on an object so a test can stage a race. */
export const demoFs = { lstat, open, readdir, realpath };

export type Render = "image" | "video" | "markdown" | "json" | "csv" | "text" | "source" | "file";
export type Category = "screens" | "reports" | "data" | "logs" | "other";

export const VIEW_TEXT_CAP = 1024 * 1024;
export const DOWNLOAD_TEXT_CAP = 32 * 1024 * 1024;
export const IMAGE_CAP = 32 * 1024 * 1024;
export const VIDEO_CAP = 256 * 1024 * 1024;
export const BINARY_CAP = 16 * 1024 * 1024;
/** Read past a text cap so a secret straddling it is masked before the cut. */
const MASK_OVERLAP = 8 * 1024;
const MAX_FILES = 5000;
const MAX_DEPTH = 12;
const MAX_PATH = 1024;
const ENV_FILE_CAP = 256 * 1024;
/** How long a finished demo counts as "finishing" before nothing is happening. */
export const FINISHING_WINDOW_MS = 10 * 60_000;
const ACTIVITY_LINES = 25;
const STOP_NUMBER = /^[1-9]\d{0,5}$/;

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const VIDEO_TYPES: Record<string, string> = { webm: "video/webm", mp4: "video/mp4" };
/** Markup that would be active if a browser were allowed to believe its extension. */
const SOURCE = new Set(["html", "htm", "xhtml", "shtml", "mhtml", "svg", "svgz", "xml", "xsl"]);
const DATA = new Set(["yaml", "yml", "toml", "ini", "ndjson", "jsonl", "properties"]);
const LOGS = new Set(["log", "txt", "out", "err"]);
const CODE = new Set([
  "py", "sh", "bash", "zsh", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "sql", "diff", "patch",
  "tf", "go", "rs", "rb", "java", "kt", "swift", "c", "h", "cpp", "lock", "gradle", "cfg", "conf", "env", "headers",
]);
/** Binary formats that hold keys, which no pattern can recognise inside them. */
const KEY_MATERIAL = /(?:\.(?:pem|key|p12|pfx|jks|keystore|der|kdbx|gpg)|(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519))$/i;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const ENV_NAME = /(?:^|[._-])env(?:$|[._-])/i;
const PLAIN = "text/plain; charset=utf-8";

/**
 * How a file is shown and which filter it falls under.
 *
 * This never decides whether a file can be opened. `file` means "look at the
 * bytes": it renders as text if they decode and as a details card if not.
 */
export function describeFile(rel: string): { render: Render; category: Category; type: string } {
  const name = path.posix.basename(rel);
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  if (IMAGE_TYPES[ext]) return { render: "image", category: "screens", type: IMAGE_TYPES[ext]! };
  if (VIDEO_TYPES[ext]) return { render: "video", category: "screens", type: VIDEO_TYPES[ext]! };
  if (ext === "md" || ext === "markdown") return { render: "markdown", category: "reports", type: PLAIN };
  if (ext === "json" || ext === "har") return { render: "json", category: name === "pitstop.json" ? "reports" : "data", type: PLAIN };
  if (ext === "csv" || ext === "tsv") return { render: "csv", category: "data", type: PLAIN };
  if (SOURCE.has(ext)) return { render: "source", category: "other", type: PLAIN };
  if (DATA.has(ext)) return { render: "text", category: "data", type: PLAIN };
  const known = LOGS.has(ext) || CODE.has(ext);
  if (LOGS.has(ext) || rel.startsWith("logs/")) return { render: known ? "text" : "file", category: "logs", type: PLAIN };
  return { render: known ? "text" : "file", category: "other", type: PLAIN };
}

/**
 * A relative path, or null.
 *
 * One decode has already happened by the time this runs, so an escape still
 * present here was encoded twice and exists to get past a check like this one.
 */
export function cleanRelative(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_PATH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw) || /%(?:2e|2f|5c|00)/i.test(raw)) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  return raw.split("/").every((s) => s !== "" && s !== "." && s !== "..") ? raw : null;
}

const quiet = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** Inside `root`, as a forward-slash relative path, or null. */
function within(root: string, target: string): string | null {
  const rel = path.relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * The real directory of one stop, or null.
 *
 * Compared against the real state directory rather than only resolved, so a
 * repository reached through a symlink still works while a stop directory that
 * is itself a link somewhere else does not.
 */
export async function stopRoot(repoPath: string, runId: string, stop: number): Promise<string | null> {
  const state = statePaths(repoPath).dir;
  const real = await quiet(demoFs.realpath(path.join(state, runId, "pitstops", String(stop))));
  if (!real) return null;
  const base = await demoFs.realpath(state);
  return real === path.join(base, runId, "pitstops", String(stop)) ? real : null;
}

export interface ArtifactEntry {
  path: string;
  name: string;
  dir: string;
  size: number;
  mtimeMs: number;
  render: Render;
  category: Category;
}

export interface ArtifactListing {
  files: ArtifactEntry[];
  /** Symlinks, sockets and unsafe names: present on disk and not offered. */
  unlisted: number;
  truncated: boolean;
}

export async function listArtifacts(root: string): Promise<ArtifactListing> {
  const files: ArtifactEntry[] = [];
  let unlisted = 0;
  let truncated = false;
  const dirs: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: "", depth: 0 }];
  for (let d = dirs.shift(); d; d = dirs.shift()) {
    const entries = await quiet(demoFs.readdir(d.abs, { withFileTypes: true }));
    if (!entries) continue;
    for (const entry of entries) {
      const rel = d.rel ? `${d.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || d.depth >= MAX_DEPTH) unlisted++;
        else dirs.push({ abs: path.join(d.abs, entry.name), rel, depth: d.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !cleanRelative(rel)) {
        unlisted++;
        continue;
      }
      if (files.length >= MAX_FILES) {
        truncated = true;
        continue;
      }
      const info = await quiet(demoFs.lstat(path.join(d.abs, entry.name)));
      if (!info) continue; // gone between the two calls: a demo is still writing
      const { render, category } = describeFile(rel);
      files.push({ path: rel, name: entry.name, dir: d.rel, size: info.size, mtimeMs: info.mtimeMs, render, category });
    }
  }
  return { files, unlisted, truncated };
}

/**
 * Open a file only if it really is inside the stop.
 *
 * Resolved, opened without following a final link and without blocking on a
 * FIFO, then resolved again and compared by inode: a path swapped for a link
 * between the check and the open is the attack this ordering exists to catch.
 */
export async function openContained(root: string, rel: string): Promise<{ fh: FileHandle; info: Stats; rel: string } | null> {
  const real = await quiet(demoFs.realpath(path.join(root, rel)));
  if (!real) return null;
  const inside = within(root, real);
  if (!inside) return null;
  const before = await quiet(demoFs.lstat(real));
  if (!before?.isFile()) return null;
  const fh = await quiet(demoFs.open(real, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK));
  if (!fh) return null;
  const info = await fh.stat();
  const again = await quiet(demoFs.realpath(real));
  const after = again && within(root, again) ? await quiet(demoFs.lstat(again)) : null;
  if (!after || after.ino !== info.ino || after.dev !== info.dev) {
    await fh.close();
    return null;
  }
  return { fh, info, rel: inside };
}

async function readHead(fh: FileHandle, limit: number): Promise<Buffer> {
  const buf = Buffer.alloc(limit);
  let total = 0;
  while (total < limit) {
    const { bytesRead } = await fh.read(buf, total, limit - total, total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buf.subarray(0, total);
}

export function looksText(head: Buffer): boolean {
  if (head.subarray(0, 8192).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, 65536), { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** Why a binary file may not be downloaded, or null when it may. */
export function withheldReason(rel: string, size: number, head: Buffer): string | null {
  if (KEY_MATERIAL.test(rel)) return "this file type can hold private keys";
  if (size > BINARY_CAP) return "too large to check for credentials";
  return maskSecrets(head.toString("latin1")).masked > 0 ? "it contains values that look like credentials" : null;
}

export interface DemoDeps {
  store: Store;
  authed(req: FastifyRequest): boolean;
  originOk(req: FastifyRequest): boolean;
  /** True when this process is driving a run, so its "running" sessions are real. */
  drivenHere(): boolean;
  /** The stop waiting on the operator right now, if any. */
  openStop(): number | null;
  token: string;
}

export interface DemoInFlight {
  stop: number;
  phase: "demo" | "review" | "finishing";
  startedAt: number;
  firstSeq: number;
  sessionIds: string[];
}

interface OpenedStop {
  stop: number;
  reason: string;
  ts: number;
  demoStarted: boolean;
}

function openedStops(store: Store, runId: string): OpenedStop[] {
  const rows = store.db
    .prepare("SELECT payload FROM events WHERE runId = ? AND type = 'run.pitstop_opened' ORDER BY seq")
    .all(runId) as unknown as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload) as OpenedStop);
}

/**
 * The stop whose demo is in flight, read from what the run already records.
 *
 * No new event and no change to the controller. A `demo` session spawned after
 * the newest `run.pitstop_opened` belongs to the next stop, and that stop's
 * number is the count of opened ones plus one, which is exactly how the
 * controller numbers it. A session row only says "running" truthfully while a
 * process owns the run, so `live` gates all of it.
 */
export function activeDemo(store: Store, runId: string, live: boolean, now = Date.now()): DemoInFlight | null {
  if (!live) return null;
  const after = store.lastEventSeq(runId, "run.pitstop_opened");
  const spawned = store.db
    .prepare("SELECT seq, sessionId FROM events WHERE runId = ? AND type = 'agent.spawned' AND seq > ? AND json_extract(payload, '$.role') = 'demo' ORDER BY seq")
    .all(runId, after) as unknown as { seq: number; sessionId: string }[];
  if (!spawned.length) return null;
  const ids = new Set(spawned.map((r) => r.sessionId));
  const sessions = store.listSessions(runId);
  const demos = sessions.filter((s) => ids.has(s.id));
  const newest = demos[demos.length - 1];
  if (!newest) return null;
  const startedAt = demos[0]!.startedAt;
  const later = sessions.filter((s) => !ids.has(s.id) && s.startedAt >= startedAt);
  const reviewers = later.filter((s) => s.role === "reviewer" || s.role === "pm");
  const base = {
    stop: openedStops(store, runId).length + 1,
    startedAt,
    firstSeq: spawned[0]!.seq,
    sessionIds: [...ids, ...reviewers.map((s) => s.id)],
  };
  if (demos.some((s) => s.state === "running")) return { ...base, phase: "demo" };
  if (reviewers.some((s) => s.state === "running")) return { ...base, phase: "review" };
  // Between the demo ending and the first reviewer the controller re-runs the
  // demo's commands, which can take minutes and has no session of its own.
  const movedOn = later.length > reviewers.length;
  if (newest.state === "done" && !movedOn && now - (newest.endedAt ?? 0) < FINISHING_WINDOW_MS) return { ...base, phase: "finishing" };
  return null;
}

function sendGuards(reply: FastifyReply): FastifyReply {
  return reply
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox")
    .header("cross-origin-resource-policy", "same-origin")
    .header("cache-control", "no-store");
}

export function registerDemoRoutes(app: FastifyInstance, deps: DemoDeps): void {
  const { store } = deps;
  const harvested = new Map<string, string[]>();

  /** Values to remove everywhere: this process's secrets and any an env file in the run assigned. */
  async function knownSecrets(repoPath: string, runId: string): Promise<string[]> {
    const known = new Set([deps.token, ...environmentSecrets(process.env)]);
    const stopsDir = path.join(statePaths(repoPath).dir, runId, "pitstops");
    for (const name of (await quiet(demoFs.readdir(stopsDir))) ?? []) {
      const root = STOP_NUMBER.test(name) ? await stopRoot(repoPath, runId, Number(name)) : null;
      if (!root) continue;
      for (const f of (await listArtifacts(root)).files) {
        if (!ENV_NAME.test(f.name) || f.size > ENV_FILE_CAP) continue;
        const key = `${name}/${f.path}:${f.mtimeMs}:${f.size}`;
        if (!harvested.has(key)) {
          const opened = await openContained(root, f.path);
          if (!opened) continue;
          const body = await readHead(opened.fh, f.size);
          await opened.fh.close();
          harvested.set(key, harvestSecrets(body.toString("utf8")));
        }
        for (const v of harvested.get(key)!) known.add(v);
      }
    }
    // Longest first, so a value containing a shorter one is removed whole.
    return [...known].filter(Boolean).sort((a, b) => b.length - a.length);
  }

  /** Auth, origin, and a run that exists: the same answer on every route here. */
  function runFor(req: FastifyRequest, reply: FastifyReply) {
    sendGuards(reply);
    if (!deps.authed(req)) {
      reply.code(401).send();
      return null;
    }
    if (!deps.originOk(req)) {
      reply.code(403).send();
      return null;
    }
    const { id } = req.params as { id: string };
    if (!/^[\w-]{1,64}$/.test(id)) {
      reply.code(400).send({ error: "bad run id" });
      return null;
    }
    const run = store.getRun(id);
    if (!run) reply.code(404).send({ error: "no such run" });
    return run ?? null;
  }

  function stopNumber(req: FastifyRequest, reply: FastifyReply): number | null {
    const raw = (req.params as { stop: string }).stop;
    if (STOP_NUMBER.test(raw)) return Number(raw);
    reply.code(400).send({ error: "bad stop number" });
    return null;
  }

  const live = (repoPath: string, runId: string) => deps.drivenHere() || runLockHolder(statePaths(repoPath).dir, runId) !== null;

  app.get("/api/runs/:id/demo", async (req, reply) => {
    const run = runFor(req, reply);
    if (!run) return reply;
    try {
      const known = await knownSecrets(run.repoPath, run.id);
      const clean = (s: string) => maskSecrets(s, known).text;
      const found = activeDemo(store, run.id, live(run.repoPath, run.id));
      const opened = openedStops(store, run.id);
      const stopsDir = path.join(statePaths(run.repoPath).dir, run.id, "pitstops");
      const onDisk = ((await quiet(demoFs.readdir(stopsDir))) ?? []).filter((n) => STOP_NUMBER.test(n)).map(Number);
      const numbers = new Set([...onDisk, ...opened.map((o) => o.stop), ...(found ? [found.stop] : [])]);
      const waiting = deps.openStop();
      let newestWrite = 0;
      const stops = [];
      for (const number of [...numbers].sort((a, b) => b - a)) {
        const root = await stopRoot(run.repoPath, run.id, number);
        const files = root ? (await listArtifacts(root)).files : [];
        const event = opened.find((o) => o.stop === number);
        if (found?.stop === number) newestWrite = Math.max(0, ...files.map((f) => f.mtimeMs));
        stops.push({
          number,
          files: files.length,
          state: found?.stop === number ? "running" : waiting === number ? "open" : event ? "finished" : "unfinished",
          reason: clean(event?.reason ?? ""),
          at: event?.ts ?? null,
          demoStarted: event?.demoStarted ?? false,
        });
      }
      let active = null;
      if (found) {
        const { firstSeq, sessionIds, ...rest } = found;
        const roles = new Map(store.listSessions(run.id).map((s) => [s.id, s.role]));
        const rows = store.db
          .prepare("SELECT type, sessionId, payload, ts FROM events WHERE runId = ? AND seq >= ? AND type IN ('agent.log','agent.tool_use') ORDER BY seq DESC LIMIT 400")
          .all(run.id, firstSeq) as unknown as { type: string; sessionId: string; payload: string; ts: number }[];
        const mine = rows.filter((r) => sessionIds.includes(r.sessionId)).slice(0, ACTIVITY_LINES).reverse();
        const last = store.db
          .prepare(`SELECT MAX(ts) t FROM events WHERE runId = ? AND seq >= ? AND sessionId IN (${sessionIds.map(() => "?").join(",")})`)
          .get(run.id, firstSeq, ...sessionIds) as { t: number };
        active = {
          ...rest,
          lastEventAt: Math.max(last.t, newestWrite),
          activity: mine.map((r) => {
            const p = JSON.parse(r.payload) as { text: string; tool: string; summary: string };
            const role = roles.get(r.sessionId)!;
            return r.type === "agent.log"
              ? { ts: r.ts, role, kind: "log" as const, text: clean(p.text.slice(0, 500)) }
              : { ts: r.ts, role, kind: "tool" as const, tool: p.tool, text: clean(p.summary) };
          }),
        };
      }
      return { runId: run.id, active, stops };
    } catch {
      return reply.code(500).send({ error: "could not read this run's demos" });
    }
  });

  app.get("/api/runs/:id/pitstops/:stop/artifacts", async (req, reply) => {
    const run = runFor(req, reply);
    if (!run) return reply;
    const stop = stopNumber(req, reply);
    if (stop === null) return reply;
    try {
      const root = await stopRoot(run.repoPath, run.id, stop);
      if (!root) return reply.code(404).send({ error: "this stop has no artifacts folder" });
      return { stop, ...(await listArtifacts(root)) };
    } catch {
      return reply.code(500).send({ error: "could not list this stop" });
    }
  });

  app.get("/api/runs/:id/pitstops/:stop/file", async (req, reply) => {
    const run = runFor(req, reply);
    if (!run) return reply;
    const stop = stopNumber(req, reply);
    if (stop === null) return reply;
    const query = req.query as { path?: unknown; download?: unknown };
    const rel = cleanRelative(query.path);
    if (!rel) return reply.code(400).send({ error: "bad file path" });
    const download = query.download === "1";
    let fh: FileHandle | null = null;
    try {
      const root = await stopRoot(run.repoPath, run.id, stop);
      const opened = root ? await openContained(root, rel) : null;
      if (!opened) return reply.code(404).send({ error: "no such file in this stop" });
      fh = opened.fh;
      const { info } = opened;
      // The real file's name decides, so `a.png` linked to `b.env` is treated as `b.env`.
      const kind = describeFile(opened.rel);
      const safeName = path.posix.basename(opened.rel).replace(/[^\w.-]/g, "_");
      reply
        .header("content-disposition", `attachment; filename="${safeName}"`)
        .header("x-charrette-size", String(info.size))
        .header("x-charrette-mtime", String(Math.round(info.mtimeMs)));

      if (kind.render === "image" || kind.render === "video") {
        const limit = kind.render === "image" ? IMAGE_CAP : VIDEO_CAP;
        if (info.size > limit) return reply.code(413).send({ error: `larger than the ${Math.round(limit / 1048576)} MB viewer limit` });
        reply.header("x-charrette-render", kind.render).type(kind.type).header("content-length", info.size);
        if (!info.size) return reply.send(Buffer.alloc(0));
        const stream = fh.createReadStream({ start: 0, end: info.size - 1 });
        fh = null; // the stream owns it now and closes it
        return reply.send(stream);
      }

      const cap = download ? DOWNLOAD_TEXT_CAP : VIEW_TEXT_CAP;
      const head = await readHead(fh, Math.min(info.size, cap + MASK_OVERLAP));
      if (kind.render === "file" && !looksText(head)) {
        const whole = await readHead(fh, Math.min(info.size, BINARY_CAP));
        const reason = withheldReason(opened.rel, info.size, whole);
        reply.header("x-charrette-render", "binary");
        if (reason) reply.header("x-charrette-withheld", reason);
        if (!download) return reply.type(PLAIN).send("");
        if (reason) return reply.code(403).send({ error: `download withheld: ${reason}` });
        return reply.type("application/octet-stream").send(whole);
      }
      const known = await knownSecrets(run.repoPath, run.id);
      const { text, masked } = maskSecrets(head.toString("utf8"), known);
      const truncated = info.size > cap;
      return reply
        .header("x-charrette-render", kind.render === "file" ? "text" : kind.render)
        .header("x-charrette-masked", String(masked))
        .header("x-charrette-truncated", truncated ? String(cap) : "0")
        .type(PLAIN)
        .send(truncated ? text.slice(0, cap) : text);
    } catch {
      return reply.code(500).send({ error: "could not read that file" });
    } finally {
      await fh?.close();
    }
  });
}
