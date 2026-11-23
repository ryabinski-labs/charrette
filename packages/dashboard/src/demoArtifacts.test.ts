import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@charrette/shared";
import { Bus, Store } from "@charrette/core";
import {
  BINARY_CAP,
  FINISHING_WINDOW_MS,
  IMAGE_CAP,
  VIDEO_CAP,
  VIEW_TEXT_CAP,
  activeDemo,
  cleanRelative,
  demoFs,
  describeFile,
  listArtifacts,
  looksText,
  openContained,
  registerDemoRoutes,
  stopRoot,
  withheldReason,
} from "./demoArtifacts.js";
import { Dashboard } from "./index.js";
import { MASK } from "./redact.js";


const RUN = "abc12345";
const TOKEN = "t".repeat(32);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

interface Injected {
  statusCode: number;
  headers: Record<string, string | number | string[] | undefined>;
  body: string;
  rawPayload: Buffer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each route's shape is asserted where it is read.
  json(): any;
}

interface Fixture {
  repo: string;
  stops: string;
  store: Store;
  bus: Bus;
  app: FastifyInstance;
  driven: { value: boolean };
  waiting: { value: number | null };
  get(url: string, headers?: Record<string, string>): Promise<Injected>;
  file(stop: number, rel: string, query?: string): Promise<Injected>;
  write(rel: string, body: string | Buffer): string;
  session(id: string, role: string, state: string, startedAt: number, endedAt?: number | null): void;
  spawn(id: string, role: string): void;
  opened(stop: number, demoStarted?: boolean): void;
}

const made: string[] = [];
const apps: FastifyInstance[] = [];

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), "charrette-demo-"));
  made.push(root);
  const repo = path.join(root, "repo");
  const stops = path.join(repo, ".charrette", RUN, "pitstops");
  mkdirSync(stops, { recursive: true });
  const store = new Store(":memory:");
  const bus = new Bus(store);
  store.createRun({
    id: RUN, repoPath: repo, assignment: "a", state: "CREATED", prdPath: null, planHash: null,
    integrationBranch: `charrette/${RUN}/main`, config: RunConfig.parse({}),
  });
  const driven = { value: true };
  const waiting = { value: null as number | null };
  const app = Fastify();
  registerDemoRoutes(app, {
    store,
    token: TOKEN,
    authed: (req) => req.headers.authorization === `Bearer ${TOKEN}`,
    originOk: (req) => req.headers.origin === undefined,
    drivenHere: () => driven.value,
    openStop: () => waiting.value,
  });
  await app.ready();
  apps.push(app);
  const auth = { authorization: `Bearer ${TOKEN}` };
  return {
    repo, stops, store, bus, app, driven, waiting,
    get: (url, headers = auth) => app.inject({ method: "GET", url, headers }) as unknown as Promise<Injected>,
    file: (stop, rel, query = "") =>
      app.inject({ method: "GET", url: `/api/runs/${RUN}/pitstops/${stop}/file?path=${encodeURIComponent(rel)}${query}`, headers: auth }) as unknown as Promise<Injected>,
    write(rel, body) {
      const p = path.join(stops, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, body);
      return p;
    },
    session(id, role, state, startedAt, endedAt = null) {
      store.db
        .prepare("INSERT INTO sessions (id, runId, taskId, role, model, state, startedAt, endedAt, build) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, RUN, null, role, "m", state, startedAt, endedAt, "");
    },
    spawn(id, role) {
      bus.publish({ type: "agent.spawned", runId: RUN, sessionId: id, role: role as "demo", model: "m", ts: Date.now() });
    },
    opened(stop, demoStarted = true) {
      bus.publish({ type: "run.pitstop_opened", runId: RUN, stop, reason: `reason ${stop}`, epicIds: [], mergedCount: 0, spentUsd: 0, artifactsDir: "", demoStarted, summoned: false, askedAt: 0, ts: Date.now() });
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) await a.close();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("describeFile", () => {
  it.each([
    ["a.png", "image", "screens"], ["A.JPG", "image", "screens"], ["a.jpeg", "image", "screens"], ["a.gif", "image", "screens"], ["a.webp", "image", "screens"],
    ["a.webm", "video", "screens"], ["a.mp4", "video", "screens"],
    ["REPORT.md", "markdown", "reports"], ["a.markdown", "markdown", "reports"], ["pitstop.json", "json", "reports"],
    ["a.json", "json", "data"], ["a.har", "json", "data"], ["a.csv", "csv", "data"], ["a.tsv", "csv", "data"], ["a.yaml", "text", "data"],
    ["a.html", "source", "other"], ["a.svg", "source", "other"], ["a.xml", "source", "other"],
    ["a.log", "text", "logs"], ["a.txt", "text", "logs"], ["logs/server.py", "text", "logs"], ["logs/noext", "file", "logs"],
    ["a.py", "text", "other"], ["a.sh", "text", "other"], ["a.headers", "text", "other"], ["demo.env", "text", "other"], [".env", "text", "other"],
    ["Dockerfile", "file", "other"], ["a.bin", "file", "other"],
  ])("%s renders as %s under %s", (rel, render, category) => {
    expect(describeFile(rel)).toMatchObject({ render, category });
  });

  it("never types agent-written markup as anything a browser would run", () => {
    for (const rel of ["a.html", "a.htm", "a.xhtml", "a.svg", "a.svgz", "a.xml", "a.mhtml"]) {
      expect(describeFile(rel).type).toBe("text/plain; charset=utf-8");
    }
  });
});

describe("cleanRelative", () => {
  it("accepts ordinary paths, dotfiles and a literal percent", () => {
    for (const p of ["a.png", "live/a b.png", ".env", "dir/.hidden/x.txt", "100%.txt"]) expect(cleanRelative(p)).toBe(p);
  });

  it.each([
    "", "..", ".", "../x", "a/../b", "a/..", "a/./b", "/etc/passwd", "a//b", "a/", "C:/x", "c:\\x", "a\\b", "..\\x",
    "a\u0000b", "a\nb", "%2e%2e/x", "%2E%2E%2Fx", "a%2fb", "a%5cb", "a%00b", "x".repeat(1025),
  ])("refuses %j", (p) => {
    expect(cleanRelative(p)).toBeNull();
  });

  it("refuses anything that is not a string", () => {
    for (const v of [undefined, null, 1, ["a"], {}]) expect(cleanRelative(v)).toBeNull();
  });
});

describe("looksText and withheldReason", () => {
  it("tells text from binary", () => {
    expect(looksText(Buffer.from("héllo"))).toBe(true);
    expect(looksText(Buffer.from([0x61, 0, 0x62]))).toBe(false);
    expect(looksText(Buffer.from([0xff, 0xfe, 0x41]))).toBe(false);
    // A multibyte character cut by the read is not evidence of binary.
    expect(looksText(Buffer.from("é").subarray(0, 1))).toBe(true);
  });

  it("withholds key formats, oversized files and anything holding a credential", () => {
    expect(withheldReason("certs/server.p12", 10, Buffer.alloc(10))).toMatch(/private keys/);
    expect(withheldReason("id_ed25519", 10, Buffer.alloc(10))).toMatch(/private keys/);
    expect(withheldReason("a.bin", BINARY_CAP + 1, Buffer.alloc(10))).toMatch(/too large/);
    expect(withheldReason("a.bin", 30, Buffer.from("\u0000API_TOKEN=hunter2222\n"))).toMatch(/credentials/);
    expect(withheldReason("a.bin", 4, Buffer.from([1, 2, 3, 4]))).toBeNull();
  });
});

describe("stopRoot", () => {
  it("resolves a stop through a repository reached by a symlink", async () => {
    const f = await fixture();
    f.write("3/a.txt", "x");
    const link = `${f.repo}-link`;
    symlinkSync(f.repo, link);
    expect(await stopRoot(link, RUN, 3)).toMatch(/pitstops\/3$/);
  });

  it("refuses a stop directory that is itself a link, and a missing one", async () => {
    const f = await fixture();
    const outside = path.join(path.dirname(f.repo), "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(f.stops, "4"));
    expect(await stopRoot(f.repo, RUN, 4)).toBeNull();
    expect(await stopRoot(f.repo, RUN, 9)).toBeNull();
  });
});

describe("listArtifacts", () => {
  it("lists nested files and dotfiles, and counts what it will not offer", async () => {
    const f = await fixture();
    f.write("1/REPORT.md", "# r");
    f.write("1/live/a.png", PNG);
    f.write("1/.env", "A=1");
    f.write("1/node_modules/x/index.js", "x");
    f.write("1/odd%2fname.txt", "x");
    symlinkSync("/etc/hosts", path.join(f.stops, "1", "escape.txt"));
    const out = await listArtifacts(path.join(f.stops, "1"));
    expect(out.files.map((x) => x.path).sort()).toEqual([".env", "REPORT.md", "live/a.png"]);
    expect(out.files.find((x) => x.path === "live/a.png")).toMatchObject({ name: "a.png", dir: "live", render: "image", category: "screens", size: PNG.length });
    expect(out.unlisted).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it("stops descending past the depth limit", async () => {
    const f = await fixture();
    f.write(`1/${Array(14).fill("d").join("/")}/deep.txt`, "x");
    f.write("1/d/shallow.txt", "x");
    const out = await listArtifacts(path.join(f.stops, "1"));
    expect(out.files.map((x) => x.name)).toEqual(["shallow.txt"]);
    expect(out.unlisted).toBe(1);
  });

  it("answers empty for a directory it cannot read", async () => {
    expect(await listArtifacts("/nonexistent/charrette-demo")).toEqual({ files: [], unlisted: 0, truncated: false });
  });

  it("says when a stop holds more files than it lists", async () => {
    const entries = Array.from({ length: 5002 }, (_, i) => ({ name: `f${i}.txt`, isDirectory: () => false, isFile: () => true }));
    vi.spyOn(demoFs, "readdir").mockResolvedValue(entries as never);
    vi.spyOn(demoFs, "lstat").mockResolvedValue({ size: 1, mtimeMs: 1 } as never);
    const out = await listArtifacts("/fake");
    expect(out.files).toHaveLength(5000);
    expect(out.truncated).toBe(true);
  });

  it("skips a file deleted between listing and stat", async () => {
    const f = await fixture();
    f.write("1/a.txt", "x");
    vi.spyOn(demoFs, "lstat").mockRejectedValue(new Error("gone"));
    expect((await listArtifacts(path.join(f.stops, "1"))).files).toEqual([]);
  });
});

describe("openContained", () => {
  async function setup() {
    const f = await fixture();
    const root = path.join(f.stops, "1");
    f.write("1/a.txt", "inside");
    f.write("1/sub/b.txt", "inside");
    writeFileSync(path.join(path.dirname(f.repo), "secret.txt"), "outside");
    return { f, root };
  }

  it("opens a file inside the stop", async () => {
    const { root } = await setup();
    const opened = await openContained(await demoFs.realpath(root), "sub/b.txt");
    expect(opened?.rel).toBe("sub/b.txt");
    await opened?.fh.close();
  });

  it("follows a link that stays inside, and reports the real name", async () => {
    const { root } = await setup();
    symlinkSync("a.txt", path.join(root, "link.png"));
    const opened = await openContained(await demoFs.realpath(root), "link.png");
    expect(opened?.rel).toBe("a.txt");
    await opened?.fh.close();
  });

  it("refuses links out of the stop, to the stop, and to its parent", async () => {
    const { f, root } = await setup();
    const real = await demoFs.realpath(root);
    symlinkSync(path.join(path.dirname(f.repo), "secret.txt"), path.join(root, "out.txt"));
    symlinkSync(".", path.join(root, "self"));
    symlinkSync("..", path.join(root, "up"));
    symlinkSync(path.dirname(f.repo), path.join(root, "dirout"));
    for (const rel of ["out.txt", "self", "up", "dirout/secret.txt"]) expect(await openContained(real, rel)).toBeNull();
  });

  it("refuses a directory, a FIFO and a missing path", async () => {
    const { root } = await setup();
    const real = await demoFs.realpath(root);
    execFileSync("mkfifo", [path.join(root, "pipe.log")]);
    for (const rel of ["sub", "pipe.log", "nope.txt"]) expect(await openContained(real, rel)).toBeNull();
  });

  it("gives up when the file cannot be stat'd or opened", async () => {
    const { root } = await setup();
    const real = await demoFs.realpath(root);
    const lstat = vi.spyOn(demoFs, "lstat").mockRejectedValueOnce(new Error("gone"));
    expect(await openContained(real, "a.txt")).toBeNull();
    lstat.mockRestore();
    vi.spyOn(demoFs, "open").mockRejectedValueOnce(new Error("denied"));
    expect(await openContained(real, "a.txt")).toBeNull();
  });

  describe("a path swapped after the check", () => {
    it("is refused when it now resolves outside", async () => {
      const { root } = await setup();
      const real = await demoFs.realpath(root);
      const original = demoFs.realpath;
      let calls = 0;
      vi.spyOn(demoFs, "realpath").mockImplementation(((p: string) => (++calls === 2 ? Promise.resolve("/etc/hosts") : original(p))) as never);
      expect(await openContained(real, "a.txt")).toBeNull();
    });

    it("is refused when it no longer resolves", async () => {
      const { root } = await setup();
      const real = await demoFs.realpath(root);
      const original = demoFs.realpath;
      let calls = 0;
      vi.spyOn(demoFs, "realpath").mockImplementation(((p: string) => (++calls === 2 ? Promise.reject(new Error("gone")) : original(p))) as never);
      expect(await openContained(real, "a.txt")).toBeNull();
    });

    it.each([["inode", { ino: -1 }], ["device", { dev: -1 }]])("is refused when the %s differs", async (_what, change) => {
      const { root } = await setup();
      const real = await demoFs.realpath(root);
      const original = demoFs.lstat;
      let calls = 0;
      vi.spyOn(demoFs, "lstat").mockImplementation((async (p: string) => {
        const info = await original(p);
        if (++calls === 2) return Object.assign(Object.create(Object.getPrototypeOf(info)), info, change);
        return info;
      }) as never);
      expect(await openContained(real, "a.txt")).toBeNull();
    });

    it("is refused when the second stat fails", async () => {
      const { root } = await setup();
      const real = await demoFs.realpath(root);
      const original = demoFs.lstat;
      let calls = 0;
      vi.spyOn(demoFs, "lstat").mockImplementation(((p: string) => (++calls === 2 ? Promise.reject(new Error("gone")) : original(p))) as never);
      expect(await openContained(real, "a.txt")).toBeNull();
    });
  });
});

describe("activeDemo", () => {
  const NOW = 10_000_000;
  it("is nothing when no process owns the run", async () => {
    const f = await fixture();
    f.session("d", "demo", "running", 1);
    f.spawn("d", "demo");
    expect(activeDemo(f.store, RUN, false, NOW)).toBeNull();
  });

  it("is nothing before any demo, and after its stop has opened", async () => {
    const f = await fixture();
    expect(activeDemo(f.store, RUN, true, NOW)).toBeNull();
    f.session("d", "demo", "done", 1, 2);
    f.spawn("d", "demo");
    f.opened(1);
    expect(activeDemo(f.store, RUN, true, NOW)).toBeNull();
  });

  it("is nothing when the spawn has no session row", async () => {
    const f = await fixture();
    f.spawn("ghost", "demo");
    expect(activeDemo(f.store, RUN, true, NOW)).toBeNull();
  });

  it("numbers the running stop one past the stops already opened", async () => {
    const f = await fixture();
    f.opened(1);
    f.opened(2);
    f.session("d", "demo", "running", 5);
    f.spawn("d", "demo");
    expect(activeDemo(f.store, RUN, true, NOW)).toMatchObject({ stop: 3, phase: "demo", startedAt: 5, sessionIds: ["d"] });
  });

  it.each(["reviewer", "pm"])("reads a running %s as the review phase", async (role) => {
    const f = await fixture();
    f.session("d", "demo", "done", 5, 6);
    f.spawn("d", "demo");
    f.session("r", role, "running", 7);
    expect(activeDemo(f.store, RUN, true, NOW)).toMatchObject({ phase: "review", sessionIds: ["d", "r"] });
  });

  it("counts the quiet after the demo as finishing, for a while", async () => {
    const f = await fixture();
    f.session("d", "demo", "done", 5, NOW - 1000);
    f.spawn("d", "demo");
    expect(activeDemo(f.store, RUN, true, NOW)).toMatchObject({ phase: "finishing" });
    expect(activeDemo(f.store, RUN, true, NOW + FINISHING_WINDOW_MS)).toBeNull();
  });

  it("is nothing for a finished session with no end time, or an interrupted one", async () => {
    const f = await fixture();
    f.session("d", "demo", "done", 5, null);
    f.spawn("d", "demo");
    expect(activeDemo(f.store, RUN, true, NOW + FINISHING_WINDOW_MS)).toBeNull();
    const g = await fixture();
    g.session("d", "demo", "interrupted", 5, NOW);
    g.spawn("d", "demo");
    expect(activeDemo(g.store, RUN, true, NOW)).toBeNull();
  });

  it("is nothing once the run has moved on to other work", async () => {
    const f = await fixture();
    f.session("d", "demo", "done", 5, NOW - 1000);
    f.spawn("d", "demo");
    f.session("w", "worker", "running", 7);
    expect(activeDemo(f.store, RUN, true, NOW)).toBeNull();
  });
});

describe("the routes' gate", () => {
  const urls = [`/api/runs/${RUN}/demo`, `/api/runs/${RUN}/pitstops/1/artifacts`, `/api/runs/${RUN}/pitstops/1/file?path=a.txt`];

  it.each(urls)("%s refuses no token, a wrong token and a foreign origin", async (url) => {
    const f = await fixture();
    f.write("1/a.txt", "x");
    expect((await f.get(url, {})).statusCode).toBe(401);
    expect((await f.get(url, { authorization: "Bearer nope" })).statusCode).toBe(401);
    const foreign = await f.get(url, { authorization: `Bearer ${TOKEN}`, origin: "https://evil.test" });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("will not take a token in the query string", async () => {
    const f = await fixture();
    f.write("1/a.txt", "x");
    expect((await f.get(`/api/runs/${RUN}/pitstops/1/file?path=a.txt&token=${TOKEN}`, {})).statusCode).toBe(401);
  });

  it("validates the run id and the stop number", async () => {
    const f = await fixture();
    expect((await f.get("/api/runs/bad%20id/demo")).statusCode).toBe(400);
    expect((await f.get("/api/runs/unknown/demo")).statusCode).toBe(404);
    for (const stop of ["0", "-1", "1e3", "01", "1234567"]) {
      expect((await f.get(`/api/runs/${RUN}/pitstops/${stop}/artifacts`)).statusCode).toBe(400);
      expect((await f.get(`/api/runs/${RUN}/pitstops/${stop}/file?path=a.txt`)).statusCode).toBe(400);
    }
  });

  it("takes no writes", async () => {
    const f = await fixture();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const url of urls) {
        const res = await f.app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` } });
        expect(res.statusCode).toBe(404);
      }
    }
  });
});

describe("GET the artifact list", () => {
  it("lists a stop", async () => {
    const f = await fixture();
    f.write("2/a.txt", "x");
    const res = await f.get(`/api/runs/${RUN}/pitstops/2/artifacts`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.json()).toMatchObject({ stop: 2, files: [{ path: "a.txt" }], unlisted: 0 });
  });

  it("is an empty list for an empty stop, and 404 for one with no folder", async () => {
    const f = await fixture();
    mkdirSync(path.join(f.stops, "3"));
    expect((await f.get(`/api/runs/${RUN}/pitstops/3/artifacts`)).json().files).toEqual([]);
    expect((await f.get(`/api/runs/${RUN}/pitstops/4/artifacts`)).statusCode).toBe(404);
  });

  it("does not expose a filesystem error", async () => {
    const f = await fixture();
    f.write("2/a.txt", "x");
    const original = demoFs.realpath;
    vi.spyOn(demoFs, "realpath").mockImplementation(((p: string) => (p.endsWith(".charrette") ? Promise.reject(new Error(`EACCES ${p}`)) : original(p))) as never);
    const res = await f.get(`/api/runs/${RUN}/pitstops/2/artifacts`);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(f.repo);
  });
});

describe("GET a file", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  it.each(["../../secret.txt", "..%2f..%2fsecret.txt", "%2e%2e/secret.txt", "/etc/hosts", "a/../../x", "a\\..\\x"])("refuses %s", async (rel) => {
    f.write("1/a.txt", "x");
    expect((await f.file(1, rel)).statusCode).toBe(400);
  });

  it("refuses a doubly encoded and a repeated path", async () => {
    f.write("1/a.txt", "x");
    expect((await f.get(`/api/runs/${RUN}/pitstops/1/file?path=%252e%252e%252fx`)).statusCode).toBe(400);
    expect((await f.get(`/api/runs/${RUN}/pitstops/1/file?path=a.txt&path=b.txt`)).statusCode).toBe(400);
    expect((await f.get(`/api/runs/${RUN}/pitstops/1/file`)).statusCode).toBe(400);
  });

  it("will not read through a symlink out of the stop", async () => {
    f.write("1/a.txt", "x");
    const outside = path.join(path.dirname(f.repo), "secret.txt");
    writeFileSync(outside, "outside-the-stop");
    symlinkSync(outside, path.join(f.stops, "1", "link.txt"));
    const res = await f.file(1, "link.txt");
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("outside-the-stop");
  });

  it("is 404 for a missing file and a missing stop", async () => {
    f.write("1/a.txt", "x");
    expect((await f.file(1, "nope.txt")).statusCode).toBe(404);
    expect((await f.file(9, "a.txt")).statusCode).toBe(404);
  });

  it("serves an image with its own type and the guards", async () => {
    f.write("1/live/a.png", PNG);
    const res = await f.file(1, "live/a.png");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("sandbox");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="a.png"');
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-charrette-render"]).toBe("image");
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });

  it("serves video, and an empty image while it is being written", async () => {
    f.write("1/a.webm", Buffer.from("webm-bytes"));
    f.write("1/empty.png", Buffer.alloc(0));
    const video = await f.file(1, "a.webm");
    expect(video.headers["content-type"]).toBe("video/webm");
    expect(video.body).toBe("webm-bytes");
    const empty = await f.file(1, "empty.png");
    expect(empty.statusCode).toBe(200);
    expect(empty.rawPayload).toHaveLength(0);
  });

  it("refuses media over its cap", async () => {
    truncateSync(f.write("1/big.png", ""), IMAGE_CAP + 1);
    truncateSync(f.write("1/big.mp4", ""), VIDEO_CAP + 1);
    expect((await f.file(1, "big.png")).statusCode).toBe(413);
    expect((await f.file(1, "big.mp4")).statusCode).toBe(413);
  });

  it.each(["page.html", "page.htm", "icon.svg", "feed.xml"])("serves %s as inert text", async (name) => {
    const body = `<svg onload="alert(1)"><script>alert(2)</script></svg>`;
    f.write(`1/${name}`, body);
    const res = await f.file(1, name);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-charrette-render"]).toBe("source");
    expect(res.body).toBe(body);
    const dl = await f.file(1, name, "&download=1");
    expect(dl.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  it("decides by the real file, so a .png link to an env file is masked text", async () => {
    f.write("1/demo.env", "API_TOKEN=hunter2222");
    symlinkSync("demo.env", path.join(f.stops, "1", "fake.png"));
    const res = await f.file(1, "fake.png");
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.body).toBe(`API_TOKEN=${MASK}`);
  });

  it("masks on view and on download alike, and says how many", async () => {
    f.write("1/demo.env", 'export AWS_SECRET_ACCESS_KEY="hunter2222"\nAWS_ACCESS_KEY_ID=hunter3333\nREGION=us-east-1');
    for (const q of ["", "&download=1"]) {
      const res = await f.file(1, "demo.env", q);
      expect(res.body).not.toMatch(/hunter/);
      expect(res.body).toContain("REGION=us-east-1");
      expect(res.headers["x-charrette-masked"]).toBe("2");
    }
  });

  it("masks a value from an env file wherever else it was echoed", async () => {
    f.write("1/demo.env", "API_TOKEN=zqzqzq12345");
    f.write("2/logs/server.log", "booted with zqzqzq12345 in the clear");
    const once = await f.file(2, "logs/server.log");
    expect(once.body).toBe(`booted with ${MASK} in the clear`);
    // Read again from the harvest cache rather than from the file.
    expect((await f.file(2, "logs/server.log")).body).toBe(`booted with ${MASK} in the clear`);
  });

  it("masks this process's secrets and the dashboard's own token", async () => {
    vi.stubEnv("SOME_API_TOKEN", "fromtheenvironment1");
    f.write("1/a.log", `saw fromtheenvironment1 and ${TOKEN}`);
    const res = await f.file(1, "a.log");
    vi.unstubAllEnvs();
    expect(res.body).toBe(`saw ${MASK} and ${MASK}`);
  });

  it("ignores env files it should not harvest", async () => {
    f.write("1/big.env", `API_TOKEN=toolargetoread\n${"#".repeat(300 * 1024)}`);
    f.write("notastop/demo.env", "API_TOKEN=notastopvalue");
    const outside = path.join(path.dirname(f.repo), "elsewhere");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "demo.env"), "API_TOKEN=linkedstopvalue");
    symlinkSync(outside, path.join(f.stops, "7"));
    f.write("1/a.log", "toolargetoread notastopvalue linkedstopvalue");
    expect((await f.file(1, "a.log")).body).toBe("toolargetoread notastopvalue linkedstopvalue");
  });

  it("skips an env file that vanishes before it is read", async () => {
    f.write("1/a.log", "plain");
    f.write("2/demo.env", "API_TOKEN=vanishedvalue");
    const original = demoFs.open;
    let calls = 0;
    vi.spyOn(demoFs, "open").mockImplementation(((...args: Parameters<typeof original>) => (++calls === 2 ? Promise.reject(new Error("gone")) : original(...args))) as never);
    expect((await f.file(1, "a.log")).body).toBe("plain");
  });

  it("caps a large text file, says so, and masks across the cut", async () => {
    const secret = "API_TOKEN=straddlesthecut99";
    const body = "a\n".repeat((VIEW_TEXT_CAP - 8) / 2) + secret + "\n" + "b\n".repeat(5000);
    f.write("1/big.log", body);
    const res = await f.file(1, "big.log");
    expect(res.headers["x-charrette-truncated"]).toBe(String(VIEW_TEXT_CAP));
    expect(res.headers["x-charrette-size"]).toBe(String(body.length));
    expect(res.body.length).toBe(VIEW_TEXT_CAP);
    expect(res.body).not.toContain("straddles");
    const whole = await f.file(1, "big.log", "&download=1");
    expect(whole.headers["x-charrette-truncated"]).toBe("0");
    expect(whole.body).toContain("b\nb\n");
    expect(whole.body).not.toContain("straddles");
  });

  it("opens an unknown extension as text when it decodes", async () => {
    f.write("1/notes.custom", "SESSION_SECRET=hunter2222\nhello");
    const res = await f.file(1, "notes.custom");
    expect(res.headers["x-charrette-render"]).toBe("text");
    expect(res.body).toBe(`SESSION_SECRET=${MASK}\nhello`);
  });

  it("describes a binary file on view and hands it over on download", async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 0xff]);
    f.write("1/data.bin", bytes);
    const view = await f.file(1, "data.bin");
    expect(view.headers["x-charrette-render"]).toBe("binary");
    expect(view.rawPayload).toHaveLength(0);
    const dl = await f.file(1, "data.bin", "&download=1");
    expect(dl.headers["content-type"]).toBe("application/octet-stream");
    expect(dl.rawPayload.equals(bytes)).toBe(true);
  });

  it("withholds a binary that holds a credential or could be a key", async () => {
    f.write("1/dump.bin", Buffer.concat([Buffer.from([0, 1]), Buffer.from("\nAPI_TOKEN=hunter2222\n")]));
    f.write("1/store.p12", Buffer.from([0, 1, 2]));
    for (const name of ["dump.bin", "store.p12"]) {
      const view = await f.file(1, name);
      expect(view.headers["x-charrette-withheld"]).toBeTruthy();
      const dl = await f.file(1, name, "&download=1");
      expect(dl.statusCode).toBe(403);
      expect(dl.body).not.toContain("hunter2222");
    }
  });

  it("copes with a file that shrinks while it is read", async () => {
    f.write("1/a.log", "short");
    const original = demoFs.open;
    vi.spyOn(demoFs, "open").mockImplementation((async (...args: Parameters<typeof original>) => {
      const fh = await original(...args);
      const stat = fh.stat.bind(fh);
      fh.stat = (async () => Object.assign(await stat(), { size: 50 })) as typeof fh.stat;
      return fh;
    }) as never);
    const res = await f.file(1, "a.log");
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("short");
  });

  it("does not expose a read failure", async () => {
    f.write("1/a.log", "x");
    const original = demoFs.realpath;
    vi.spyOn(demoFs, "realpath").mockImplementation(((p: string) => (p.endsWith(".charrette") ? Promise.reject(new Error(`EIO ${p}`)) : original(p))) as never);
    const res = await f.file(1, "a.log");
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(f.repo);
  });
});

describe("GET the demo status", () => {
  it("is empty for a run that has never stopped", async () => {
    const f = await fixture();
    rmSync(f.stops, { recursive: true });
    expect((await f.get(`/api/runs/${RUN}/demo`)).json()).toEqual({ runId: RUN, active: null, stops: [] });
  });

  it("lists stops newest first with their state and file count", async () => {
    const f = await fixture();
    f.write("1/a.txt", "x");
    f.write("2/a.txt", "x");
    f.write("2/b.txt", "x");
    f.write("3/a.txt", "x");
    f.write("notastop/a.txt", "x");
    f.opened(1);
    f.opened(2, false);
    f.opened(4);
    f.waiting.value = 2;
    const { stops, active } = (await f.get(`/api/runs/${RUN}/demo`)).json();
    expect(active).toBeNull();
    expect(stops.map((s: { number: number }) => s.number)).toEqual([4, 3, 2, 1]);
    expect(stops[0]).toMatchObject({ state: "finished", files: 0, reason: "reason 4", demoStarted: true });
    expect(stops[1]).toMatchObject({ state: "unfinished", files: 1, reason: "", at: null, demoStarted: false });
    expect(stops[2]).toMatchObject({ state: "open", files: 2, demoStarted: false });
    expect(stops[3]).toMatchObject({ state: "finished", files: 1 });
  });

  it("names the running stop, what the agent did, and masks it", async () => {
    const f = await fixture();
    f.opened(1);
    f.session("d", "demo", "running", Date.now() - 1000);
    f.spawn("d", "demo");
    f.session("other", "worker", "running", Date.now());
    f.bus.publish({ type: "agent.log", runId: RUN, sessionId: "d", text: "using API_TOKEN=hunter2222 now", ts: 5000 });
    f.bus.publish({ type: "agent.tool_use", runId: RUN, sessionId: "d", tool: "Bash", summary: JSON.stringify({ command: "curl -H 'Authorization: Bearer hunter3333'" }), ts: 6000 });
    f.bus.publish({ type: "agent.log", runId: RUN, sessionId: "other", text: "somebody else's work", ts: 7000 });
    mkdirSync(path.join(f.stops, "2"));
    const body = (await f.get(`/api/runs/${RUN}/demo`)).json();
    expect(body.active).toMatchObject({ stop: 2, phase: "demo" });
    expect(body.active.firstSeq).toBeUndefined();
    expect(body.active.activity).toHaveLength(2);
    expect(body.active.activity[0]).toMatchObject({ kind: "log", role: "demo", text: `using API_TOKEN=${MASK} now` });
    expect(body.active.activity[1]).toMatchObject({ kind: "tool", tool: "Bash" });
    expect(JSON.stringify(body)).not.toMatch(/hunter/);
    expect(body.stops[0]).toMatchObject({ number: 2, state: "running", files: 0 });
  });

  it("counts a file write as activity, so a busy demo is not called stalled", async () => {
    const f = await fixture();
    f.session("d", "demo", "running", 1);
    f.spawn("d", "demo");
    f.store.db.prepare("UPDATE events SET ts = 1 WHERE sessionId = 'd'").run();
    f.write("1/new.png", PNG);
    const { active } = (await f.get(`/api/runs/${RUN}/demo`)).json();
    expect(active.lastEventAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it("does not believe a running session when nothing owns the run", async () => {
    const f = await fixture();
    f.driven.value = false;
    f.session("d", "demo", "running", 1);
    f.spawn("d", "demo");
    expect((await f.get(`/api/runs/${RUN}/demo`)).json().active).toBeNull();
  });

  it("believes it when another live process holds the run's lock", async () => {
    const f = await fixture();
    f.driven.value = false;
    f.session("d", "demo", "running", 1);
    f.spawn("d", "demo");
    const locks = path.join(f.repo, ".charrette", "locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(path.join(locks, `${RUN}.lock`), JSON.stringify({ pid: process.pid, runId: RUN, startedAt: 1, heartbeatAt: 1, host: "h" }));
    expect((await f.get(`/api/runs/${RUN}/demo`)).json().active).toMatchObject({ stop: 1 });
  });

  it("does not expose a failure", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "listSessions").mockImplementation(() => {
      throw new Error(`boom ${f.repo}`);
    });
    f.spawn("d", "demo");
    const res = await f.get(`/api/runs/${RUN}/demo`);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(f.repo);
  });
});

describe("wired into the dashboard", () => {
  // One server for the whole story: a second one can land on the same port and
  // inherit this one's pooled keep-alive socket, which then resets.
  it("serves the routes behind its own token and origin check, and marks the open stop", async () => {
    const f = await fixture();
    f.write("1/a.txt", "hello");
    f.opened(1);
    const dash = new Dashboard(f.store, f.bus, { token: TOKEN });
    const origin = new URL(await dash.start()).origin;
    const headers = { authorization: `Bearer ${TOKEN}` };
    try {
      expect((await fetch(`${origin}/api/runs/${RUN}/demo`)).status).toBe(401);
      expect((await fetch(`${origin}/api/runs/${RUN}/demo`, { headers: { ...headers, origin: "https://evil.test" } })).status).toBe(403);
      const res = await fetch(`${origin}/api/runs/${RUN}/pitstops/1/file?path=a.txt`, { headers });
      expect(await res.text()).toBe("hello");
      const before = await (await fetch(`${origin}/api/runs/${RUN}/demo`, { headers })).json();
      expect(before.stops[0]).toMatchObject({ number: 1, state: "finished" });
      void dash.resolvePitStop({ runId: RUN, number: 1, reason: "r", markdown: "m" } as never);
      const during = await (await fetch(`${origin}/api/runs/${RUN}/demo`, { headers })).json();
      expect(during.stops[0]).toMatchObject({ number: 1, state: "open" });
    } finally {
      await dash.stop();
    }
  });
});
