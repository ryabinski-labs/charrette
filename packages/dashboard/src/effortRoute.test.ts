import { createServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Bus, Store } from "@charrette/core";
import { Dashboard } from "./index.js";

const otherSink = {
  sendFeedback: () => "live" as const,
  raiseBudget: () => "cap raised",
  requestPitStop: () => "pit stop requested",
  cancelPitStop: () => "pit stop cancelled",
  rerouteModel: () => "worker: a → b",
  pauseRun: () => "pausing",
};

/** A port the OS says is free, well away from the range a live dashboard uses. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe("the effort route", () => {
  const started: Dashboard[] = [];
  afterEach(async () => {
    for (const d of started.splice(0)) await d.stop();
  });

  async function withDash() {
    const store = new Store(":memory:");
    const dash = new Dashboard(store, new Bus(store), { port: await freePort() });
    started.push(dash);
    const url = await dash.start();
    const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${dash.token}` }) =>
      fetch(new URL("/api/runs/r1/effort", url), {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close", ...headers },
        body: JSON.stringify(body),
      });
    return { dash, post };
  }

  it("relays a change with the controller's words", async () => {
    const { dash, post } = await withDash();
    const seen: string[][] = [];
    dash.attach({ ...otherSink, setModelEffort: (...args) => (seen.push(args), { ok: true, message: "set" }) });
    const res = await post({ model: "gemini-4-neon", level: "high" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: "set" });
    expect(seen).toEqual([["r1", "gemini-4-neon", "high"]]);
  });

  it("passes a refusal back as a 400", async () => {
    const { dash, post } = await withDash();
    dash.attach({ ...otherSink, setModelEffort: () => ({ ok: false, message: "use one of: low, high, max." }) });
    const res = await post({ model: "deepseek-flash", level: "medium" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("use one of");
  });

  it("rejects a request naming no model or no level", async () => {
    const { dash, post } = await withDash();
    let calls = 0;
    dash.attach({ ...otherSink, setModelEffort: () => (calls++, { ok: true, message: "set" }) });
    for (const body of [{ level: "high" }, { model: "gemini-4-neon" }, { model: "  ", level: "high" }, { model: "gemini-4-neon", level: " " }, { model: 3, level: "high" }, { model: "gemini-4-neon", level: 3 }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  it("rejects an empty body the same way", async () => {
    const { dash } = await withDash();
    dash.attach({ ...otherSink, setModelEffort: () => ({ ok: true, message: "set" }) });
    const res = await dash["app"].inject({ method: "POST", url: "/api/runs/r1/effort", headers: { authorization: `Bearer ${dash.token}` } });
    expect(res.statusCode).toBe(400);
  });

  it("refuses until the dashboard is wired to a controller", async () => {
    const { post } = await withDash();
    expect((await post({ model: "gemini-4-neon", level: "high" })).status).toBe(503);
  });

  it("rejects an unauthenticated change", async () => {
    const { post } = await withDash();
    expect((await post({ model: "gemini-4-neon", level: "high" }, { authorization: "" })).status).toBe(401);
  });

  it("rejects a cross-origin change", async () => {
    const { dash, post } = await withDash();
    const res = await post({ model: "gemini-4-neon", level: "high" }, { authorization: `Bearer ${dash.token}`, origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });
});
