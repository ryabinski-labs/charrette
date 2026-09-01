import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearDashboard, liveDashboardUrl, recordDashboard, recordedDashboard } from "./dashboardLink.js";

const made: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const s of servers.splice(0)) await new Promise((resolve) => s.close(resolve));
});

/** A repo with the `.harness/` directory the run would have made. */
function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-link-"));
  made.push(dir);
  mkdirSync(path.join(dir, ".harness"));
  return dir;
}

/**
 * A stand-in dashboard. Answers /api/state the way the real one does — 200 for
 * the right bearer token, 401 for anything else — and nothing else.
 */
async function fakeDashboard(): Promise<{ url: string; asked: string[] }> {
  const token = "deadbeef";
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(req.url ?? "");
    if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ runs: [] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/#${token}`, asked };
}

describe("recording where the dashboard is", () => {
  it("writes the url down, readable only by its owner", async () => {
    const dir = repo();
    const { url } = await fakeDashboard();
    recordDashboard(dir, url);
    expect(JSON.parse(readFileSync(path.join(dir, ".harness", "dashboard.json"), "utf8")).url).toBe(url);
  });

  it("says nothing when .harness/ cannot be written to", () => {
    // A read-only checkout, a full disk. The link is a convenience; refusing to
    // start a run over it would be the wrong trade.
    const dir = mkdtempSync(path.join(tmpdir(), "harness-nolink-"));
    made.push(dir);
    expect(() => recordDashboard(dir, "http://127.0.0.1:4777/#x")).not.toThrow();
  });

  it("removes the record on the way out, and does not mind if it is already gone", () => {
    const dir = repo();
    recordDashboard(dir, "http://127.0.0.1:4777/#x");
    clearDashboard(dir);
    expect(existsSync(path.join(dir, ".harness", "dashboard.json"))).toBe(false);
    expect(() => clearDashboard(dir)).not.toThrow();
  });
});

describe("coming back to the tab the operator already has open", () => {
  it("gives back the port and the token together", () => {
    const dir = repo();
    recordDashboard(dir, "http://127.0.0.1:4791/#0123456789abcdef0123456789abcdef");
    expect(recordedDashboard(dir)).toEqual({ port: 4791, token: "0123456789abcdef0123456789abcdef" });
  });

  it("has no opinion when there is nothing on file", () => {
    expect(recordedDashboard(repo())).toBeNull();
  });

  it("has no opinion about a record it cannot read", () => {
    // Half-written by a process that was killed mid-`resume`. A resume must
    // still start; it just takes a fresh port and a fresh token.
    const dir = repo();
    writeFileSync(path.join(dir, ".harness", "dashboard.json"), "{not json");
    expect(recordedDashboard(dir)).toBeNull();
  });

  it("has no opinion about a record with no url in it", () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".harness", "dashboard.json"), "{}\n");
    expect(recordedDashboard(dir)).toBeNull();
  });

  it("has no opinion about a url with no token in it", () => {
    // Half a credential is not a credential: reusing the port alone would send
    // the operator's tab back to a page that 401s.
    const dir = repo();
    recordDashboard(dir, "http://127.0.0.1:4791/");
    expect(recordedDashboard(dir)).toBeNull();
  });
});

describe("finding a dashboard that is actually up", () => {
  it("returns the url when the server answers", async () => {
    const dir = repo();
    const { url, asked } = await fakeDashboard();
    recordDashboard(dir, url);
    expect(await liveDashboardUrl(dir)).toBe(url);
    // It asked, rather than trusting the file.
    expect(asked).toEqual(["/api/state"]);
  });

  it("returns nothing when no run ever started one here", async () => {
    expect(await liveDashboardUrl(repo())).toBeNull();
  });

  it("returns nothing for a record with no url in it", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".harness", "dashboard.json"), "{}\n");
    expect(await liveDashboardUrl(dir)).toBeNull();
  });

  it("returns nothing, and forgets the record, when the process is gone", async () => {
    // Killed, crashed, or the machine rebooted — the file outlives the server.
    // A link that goes nowhere costs the operator a browser tab to discover.
    const dir = repo();
    const { url } = await fakeDashboard();
    recordDashboard(dir, url);
    for (const s of servers.splice(0)) await new Promise((resolve) => s.close(resolve));

    expect(await liveDashboardUrl(dir)).toBeNull();
    expect(existsSync(path.join(dir, ".harness", "dashboard.json"))).toBe(false);
  });

  it("returns nothing when the server is up but rejects the recorded token", async () => {
    // A second dashboard took the port after the first died. Its token is not
    // the one on file, so the link would land on a page that cannot load.
    const dir = repo();
    const { url } = await fakeDashboard();
    recordDashboard(dir, url.replace(/#.*$/, "#staleandwrong"));
    expect(await liveDashboardUrl(dir)).toBeNull();
  });
});

/**
 * A `dashboard.json` outlives the process that wrote it. ledger-app's run
 * beb799c5 left one naming a pid that had exited, and every reader of that file
 * — the CLI, and the watcher supervising the run — took it as evidence of a
 * live control plane, went to the port, and found nothing listening. The pid is
 * already recorded beside the URL; checking it answers the common case without
 * opening a socket at all.
 */
describe("a link whose process is gone", () => {
  const write = (dir: string, record: unknown) =>
    writeFileSync(path.join(dir, ".harness", "dashboard.json"), `${JSON.stringify(record)}\n`);

  /** A pid nothing can be running under: reaped, and never reissued this fast. */
  async function deadPid(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));
    // A closed port's number is not a pid; use one far above the range in use.
    return 4_000_000 + port;
  }

  it("does not go to the port for a dashboard whose writer has exited", async () => {
    const dir = repo();
    const { url, asked } = await fakeDashboard();
    write(dir, { url, pid: await deadPid() });

    expect(await liveDashboardUrl(dir)).toBeNull();
    // Never asked. The point is that a dead writer is answered without a socket.
    expect(asked).toEqual([]);
    // And the stale file is gone, so nothing reads it again.
    expect(existsSync(path.join(dir, ".harness", "dashboard.json"))).toBe(false);
  });

  it("still asks when the writer is alive", async () => {
    const dir = repo();
    const { url, asked } = await fakeDashboard();
    // This process is the liveness proof: a live pid proves nothing about the
    // server, so the request still has to settle it.
    write(dir, { url, pid: process.pid });
    expect(await liveDashboardUrl(dir)).toBe(url);
    expect(asked).toEqual(["/api/state"]);
  });

  it("asks when the file records no pid at all", async () => {
    const dir = repo();
    const { url, asked } = await fakeDashboard();
    // Written by a harness from before the pid was recorded. Still a perfectly
    // good link, and the request is what settles it.
    write(dir, { url });
    expect(await liveDashboardUrl(dir)).toBe(url);
    expect(asked).toEqual(["/api/state"]);
  });

  it("ignores a pid that is not a number", async () => {
    const dir = repo();
    const { url, asked } = await fakeDashboard();
    write(dir, { url, pid: "36025" });
    expect(await liveDashboardUrl(dir)).toBe(url);
    expect(asked).toEqual(["/api/state"]);
  });

  it("treats a process it may not signal as alive", async () => {
    const dir = repo();
    const { url, asked } = await fakeDashboard();
    // pid 1 exists and is not ours to signal — EPERM, which is "alive", not
    // "gone". Writing the file off here would delete a working link.
    write(dir, { url, pid: 1 });
    expect(await liveDashboardUrl(dir)).toBe(url);
    expect(asked).toEqual(["/api/state"]);
  });
});
