// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { PAGE_HTML } from "./page.js";

const emptyState = { runs: [], planGate: null, budgetGate: null, taskGates: [], pitStop: null };

async function mount(request: typeof fetch) {
  const start = PAGE_HTML.indexOf("<script>");
  const end = PAGE_HTML.indexOf("</script>");
  document.documentElement.innerHTML = (PAGE_HTML.slice(0, start) + PAGE_HTML.slice(end + 9))
    .replace(/^[\s\S]*?<html[^>]*>/, "").replace(/<\/html>\s*$/, "");
  const source = PAGE_HTML.slice(start + 8, end);
  const factory = new Function("fetch", "setInterval", source + "\nreturn { stream, refresh, resolveGate };");
  const api = factory(request, () => 0) as {
    stream(runId: string): Promise<void>;
    refresh(): Promise<void>;
    resolveGate(approved: boolean): Promise<void>;
  };
  await api.refresh();
  return api;
}

function requestStub(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn((url: string | URL | Request, init?: RequestInit) =>
    String(url) === "/api/state" ? Promise.resolve(Response.json(emptyState)) : handler(String(url), init)
  );
}

function event(seq: number, text: string) {
  return `id: ${seq}\ndata: ${JSON.stringify({ type: "agent.log", runId: "r1", sessionId: "s", text, ts: seq })}\n\n`;
}

function streamResponse(text: string, split = text.length) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  }));
}

describe("activity feed recovery", () => {
  it("reconnects from the last rendered event and ignores duplicate frames", async () => {
    let call = 0;
    const request = requestStub(async () => ++call === 1
      ? streamResponse(event(7, "first") + event(9, "second"), 17)
      : streamResponse(event(9, "second") + event(12, "third")));
    const page = await mount(request);
    await page.stream("r1");
    await page.stream("r1");
    const urls = request.mock.calls.map(([url]) => String(url));
    expect(urls).toContain("/api/runs/r1/events?after=0");
    expect(urls).toContain("/api/runs/r1/events?after=9");
    expect([...document.querySelectorAll("#log .msg")].map((node) => node.textContent)).toEqual(["first", "second", "third"]);
  });

  it("keeps separate cursors for different runs", async () => {
    const request = requestStub(async () => streamResponse(event(8, "hello")));
    const page = await mount(request);
    await page.stream("r1");
    await page.stream("r2");
    expect(request.mock.calls.map(([url]) => String(url))).toContain("/api/runs/r2/events?after=0");
  });

  it.each(["network", "http", "read"])("can reconnect after a %s failure", async (failure) => {
    let call = 0;
    const request = requestStub(async () => {
      if (++call > 1) return streamResponse(event(2, "recovered"));
      if (failure === "network") throw new Error("offline");
      if (failure === "http") return new Response(null, { status: 401 });
      return new Response(new ReadableStream({ start(c) { c.error(new Error("connection lost")); } }));
    });
    const page = await mount(request);
    await expect(page.stream("r1")).resolves.toBeUndefined();
    await page.stream("r1");
    expect(document.querySelector("#log")!.textContent).toContain("recovered");
  });

  it("coalesces concurrent state refreshes into one request", async () => {
    const request = requestStub(async () => new Response());
    const page = await mount(request);
    request.mockClear();
    await Promise.all([page.refresh(), page.refresh(), page.refresh()]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("plan decisions", () => {
  it.each(["network", "http"])("shows a %s failure and preserves the operator's feedback", async (failure) => {
    const request = requestStub(async () => {
      if (failure === "network") throw new Error("offline");
      return Response.json({ error: "no open plan gate" }, { status: 409 });
    });
    const page = await mount(request);
    const input = document.getElementById("gate-feedback") as HTMLTextAreaElement;
    input.value = "Please include recovery";
    await page.resolveGate(false);
    expect(input.value).toBe("Please include recovery");
    expect(document.getElementById("gate-error")!.textContent).toContain(failure === "network" ? "Could not reach" : "no open plan gate");
    expect([...document.querySelectorAll<HTMLButtonElement>("#gate button")].every((button) => !button.disabled)).toBe(true);
  });

  it("prevents duplicate submissions while a decision is pending, then clears accepted feedback", async () => {
    let finish!: (response: Response) => void;
    const request = requestStub(() => new Promise((resolve) => { finish = resolve; }));
    const page = await mount(request);
    const input = document.getElementById("gate-feedback") as HTMLTextAreaElement;
    input.value = "Please include recovery";
    const pending = page.resolveGate(false);
    await page.resolveGate(true);
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    finish(Response.json({ ok: true }));
    await pending;
    expect(input.value).toBe("");
    expect(document.getElementById("gate-error")!.textContent).toBe("");
  });
});
