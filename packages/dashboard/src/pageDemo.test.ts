// @vitest-environment happy-dom

/**
 * The Demo view runs inside the page's untyped script, so these drive it the way
 * `page.test.ts` drives everything else: mount the real page with a stubbed
 * fetch, then click. What is pinned is the operator's acceptance bar: every file
 * opens, the token never reaches a URL, nothing an agent wrote becomes markup,
 * and leaving the viewer returns them to the decision they were making.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_HTML } from "./page.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- the page is untyped JS. */
type Any = any;

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const TOKEN = "f".repeat(32);

const file = (p: string, render: string, category: string, size = 2048): Any => {
  const at = p.lastIndexOf("/");
  return { path: p, name: p.slice(at + 1), dir: at < 0 ? "" : p.slice(0, at), size, mtimeMs: NOW - 1000, render, category };
};

const FILES = [
  file("REPORT.md", "markdown", "reports"),
  file("pitstop.json", "json", "reports"),
  file("live/a-desktop.png", "image", "screens"),
  file("live/a-mobile.png", "image", "screens"),
  file("live/a-desktop.txt", "text", "logs"),
  file("live/a-desktop.design.json", "json", "data"),
  file("data/table.csv", "csv", "data"),
  file("logs/server.log", "text", "logs"),
  file("page.html", "source", "other"),
  file("blob.bin", "file", "other"),
  file("demo.env", "text", "other"),
];

const REPORT = [
  "# Pit stop 2",
  "",
  "Started with `podman run` from `backend/`.",
  "",
  "## Evidence",
  "",
  "- `live/a-desktop.png` — the roll-up",
  "- `a-mobile.png` — by bare name",
  "- `live/gone.png` — never written",
  "",
  "Re-run by the charrette and confirmed:",
  "",
  "- `curl localhost` — it answered",
].join("\n");

interface Reply {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  json?: Any;
}

const text = (body: string, render: string, extra: Record<string, string> = {}): Reply => ({
  body, headers: { "x-charrette-render": render, "x-charrette-size": String(body.length), ...extra },
});

function bodies(): Record<string, Reply> {
  return {
    "REPORT.md": text(REPORT, "markdown"),
    "pitstop.json": text('{"a":1,"b":[2]}', "json"),
    "live/a-desktop.txt": text("page text", "text"),
    "live/a-desktop.design.json": text("not json at all", "json"),
    "data/table.csv": text('name,note\nalpha,"has, comma"\nbeta,"say ""hi"""\r\ngamma', "csv"),
    "logs/server.log": text("line one", "text", { "x-charrette-truncated": "1048576", "x-charrette-size": "5242880" }),
    "page.html": text("<script>window.pwned = 1</script><img src=x onerror=alert(1)>", "source"),
    "blob.bin": { body: "", headers: { "x-charrette-render": "binary", "x-charrette-size": "4096" } },
    "demo.env": text("API_TOKEN=<masked>", "text", { "x-charrette-masked": "1" }),
    "live/a-desktop.png": { body: "png", headers: { "x-charrette-render": "image", "x-charrette-size": "3" } },
    "live/a-mobile.png": { body: "png", headers: { "x-charrette-render": "image", "x-charrette-size": "3" } },
  };
}

interface Mounted {
  api: Any;
  urls: string[];
  calls: { url: string; auth?: string }[];
  status: Any;
  lists: Record<string, Any>;
  files: Record<string, Reply>;
  flush(): Promise<void>;
  poll(): Promise<void>;
}

function runState(over: Any = {}): Any {
  return {
    runs: [{
      id: "r1", repoPath: "/repo", integrationBranch: "charrette/r1/main", createdAt: NOW - 3600_000, state: "EXECUTING",
      githubRepo: "acme/app", assignment: "Build.", spentUsd: 1, sessions: over.sessions ?? [],
      config: { deterministicChecks: [], qaIterationCap: 3, budget: { runCapUsd: 100 } }, tasks: [],
    }],
    planGate: null, budgetGate: null, taskGates: [], pitStop: over.pitStop ?? null,
  };
}

function finished(): Any {
  return {
    runId: "r1", active: null,
    stops: [
      { number: 2, state: "finished", files: FILES.length, reason: "r", at: NOW, demoStarted: true },
      { number: 1, state: "finished", files: 0, reason: "r", at: NOW, demoStarted: false },
    ],
  };
}

function response(r: Reply): Any {
  const status = r.status ?? 200;
  const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status < 400, status,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: () => (r.json === undefined ? Promise.reject(new Error("no json")) : Promise.resolve(r.json)),
    text: () => Promise.resolve(r.body ?? ""),
    blob: () => Promise.resolve(new Blob([r.body ?? ""], { type: h.get("content-type") ?? "image/png" })),
  };
}

const listeners: (() => void)[] = [];

async function mount(state: Any = runState(), search = ""): Promise<Mounted> {
  history.replaceState(null, "", `/${search}#${TOKEN}`);
  const opensAt = PAGE_HTML.indexOf("<script>");
  const closesAt = PAGE_HTML.indexOf("</script>");
  const source = PAGE_HTML.slice(opensAt + "<script>".length, closesAt);
  document.documentElement.innerHTML = (PAGE_HTML.slice(0, opensAt) + PAGE_HTML.slice(closesAt + "</script>".length))
    .replace(/^[\s\S]*?<html[^>]*>/, "")
    .replace(/<\/html>\s*$/, "");
  const m: Mounted = {
    api: null, urls: [], calls: [], status: finished(), lists: { 2: { stop: 2, files: FILES, unlisted: 0, truncated: false }, 1: { stop: 1, files: [], unlisted: 0, truncated: false } },
    files: bodies(), flush: async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); },
    poll: async () => { await m.api.dmPoll(); await m.flush(); },
  };
  const fetchStub = (url: string, init?: Any): Promise<Any> => {
    m.urls.push(url);
    m.calls.push({ url, auth: init?.headers?.authorization });
    if (url === "/api/state") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(state) });
    if (url.endsWith("/demo")) {
      if (m.status instanceof Error) return Promise.reject(m.status);
      if (m.status.__status) return Promise.resolve(response({ status: m.status.__status, json: { error: m.status.error } }));
      return Promise.resolve(response({ json: m.status }));
    }
    const list = /pitstops\/(\d+)\/artifacts$/.exec(url);
    if (list) {
      const v = m.lists[list[1]!];
      return Promise.resolve(v?.__status ? response({ status: v.__status, json: { error: v.error } }) : response(v ? { json: v } : { status: 404, json: { error: "this stop has no artifacts folder" } }));
    }
    const one = /pitstops\/\d+\/file\?path=([^&]+)/.exec(url);
    if (one) {
      const r = m.files[decodeURIComponent(one[1]!)];
      if (r === undefined) return Promise.resolve(response({ status: 404, json: { error: "no such file in this stop" } }));
      if ((r as Any).reject) return Promise.reject(new Error("offline"));
      return Promise.resolve(response(r));
    }
    return new Promise(() => {});
  };
  const factory = new Function("fetch", "setInterval", source + "\n;return { refresh, dm, dmPoll, dmOpenFile, dmStep, dmCsv, dmNewTab, dmDownload, dmCloseViewer, dmThumbFetch };");
  // The document outlives each mount, so a listener left by an earlier page
  // would answer this test's key presses against that page's state.
  for (const off of listeners.splice(0)) off();
  for (const target of [document, window] as EventTarget[]) {
    const add = target.addEventListener;
    vi.spyOn(target, "addEventListener").mockImplementation(function (this: EventTarget, type: string, fn: Any, opts?: Any) {
      listeners.push(() => target.removeEventListener(type, fn, opts));
      add.call(target, type, fn, opts);
    } as never);
  }
  m.api = factory(fetchStub, () => 0);
  (document.addEventListener as Any).mockRestore();
  (window.addEventListener as Any).mockRestore();
  await m.api.refresh();
  await m.flush();
  return m;
}

const $ = (id: string) => document.getElementById(id) as Any;
const card = (p: string) => document.querySelector(`#dm-groups [data-path="${p}"]`) as Any;
const key = (k: string, extra: Any = {}) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));

async function openBrowse(m: Mounted): Promise<void> {
  $("dm-open").click();
  await m.flush();
  await m.poll();
}

async function openFile(m: Mounted, p: string): Promise<void> {
  card(p).click();
  await m.flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:mock/${++n}`) as never;
  URL.revokeObjectURL = vi.fn() as never;
  return () => vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reaching the view", () => {
  it("offers the button once there is a run, and asks the server nothing until it is opened", async () => {
    const m = await mount();
    expect($("dm-open").hidden).toBe(false);
    expect(m.urls.some((u) => u.includes("/demo") || u.includes("/pitstops/"))).toBe(false);
  });

  it("hides it with no run", async () => {
    await mount({ runs: [], planGate: null, budgetGate: null, taskGates: [], pitStop: null });
    expect($("dm-open").hidden).toBe(true);
  });

  it("says a demo is running from the session list alone", async () => {
    await mount(runState({ sessions: [{ id: "d", role: "demo", state: "running", startedAt: NOW, model: "m", turns: 0, costUsd: 0 }] }));
    expect($("dm-open").textContent).toBe("Demo running");
    expect($("dm-open").classList.contains("live")).toBe(true);
  });

  it("selects the newest stop and labels each with its state and count", async () => {
    const m = await mount();
    await openBrowse(m);
    const options = [...$("dm-stop").options].map((o: Any) => o.textContent);
    expect(options).toEqual([`Stop 2 · finished · ${FILES.length} files`, "Stop 1 · no artifacts · 0 files"]);
    expect($("dm-stop").value).toBe("2");
  });

  it("says when the run has not reached a stop", async () => {
    const m = await mount();
    m.status = { runId: "r1", active: null, stops: [] };
    await openBrowse(m);
    expect($("dm-msg").textContent).toMatch(/has not reached a pit stop/);
  });

  it("says when the status cannot be read", async () => {
    const m = await mount();
    m.status = { __status: 500, error: "could not read this run's demos" };
    await openBrowse(m);
    expect($("dm-msg").textContent).toMatch(/Could not load this run's demos/);
  });

  it("says a finished stop's demo produced nothing, honestly", async () => {
    const m = await mount();
    m.status.stops[1].demoStarted = true;
    await openBrowse(m);
    $("dm-stop").value = "1";
    $("dm-stop").dispatchEvent(new Event("change"));
    await m.flush();
    await m.poll();
    expect($("dm-msg").textContent).toBe("This demo produced no files.");
  });

  it("goes back to the run, and hides nothing it did not hide", async () => {
    const m = await mount();
    await openBrowse(m);
    expect(document.body.classList.contains("demo-on")).toBe(true);
    $("dm-back").click();
    expect(document.body.classList.contains("demo-on")).toBe(false);
    expect($("demoview").hidden).toBe(true);
  });
});

describe("browsing", () => {
  it("makes every listed file a real button", async () => {
    const m = await mount();
    await openBrowse(m);
    for (const f of FILES) {
      expect(card(f.path).tagName).toBe("BUTTON");
      expect(card(f.path).title).toBe(f.path);
    }
  });

  it("groups by folder, and filters with counts", async () => {
    const m = await mount();
    await openBrowse(m);
    const sections = [...document.querySelectorAll(".dm-group > summary span")].map((n) => n.textContent);
    expect(sections).toEqual(["Top level", "data", "live", "logs"]);
    const chip = (name: string) => document.querySelector(`#dm-chips [data-chip="${name}"]`) as Any;
    expect(chip("screens").textContent).toBe("Screenshots2");
    expect(chip("logs").textContent).toBe("Logs2");
    chip("logs").click();
    expect(chip("logs").getAttribute("aria-pressed")).toBe("true");
    expect(card("logs/server.log")).toBeTruthy();
    expect(card("REPORT.md")).toBeNull();
  });

  it("searches filenames and says when nothing matches", async () => {
    const m = await mount();
    await openBrowse(m);
    $("dm-q").value = "SERVER";
    $("dm-q").dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("#dm-groups [data-path]")).toHaveLength(1);
    $("dm-q").value = "zzz";
    $("dm-q").dispatchEvent(new Event("input"));
    expect($("dm-msg").textContent).toMatch(/No files match/);
  });

  it("keeps the extension visible however the name is cut", async () => {
    const m = await mount();
    m.lists[2] = { stop: 2, unlisted: 0, truncated: false, files: [file("a-very-long-artifact-name-that-will-not-fit-anywhere-desktop.png", "image", "screens")] };
    await openBrowse(m);
    expect(document.querySelector(".dm-name .t")!.textContent!.endsWith(".png")).toBe(true);
  });

  it("reports what it left out", async () => {
    const m = await mount();
    m.lists[2] = { stop: 2, unlisted: 2, truncated: true, files: FILES };
    await openBrowse(m);
    expect($("dm-msg").textContent).toMatch(/2 items on disk not shown/);
    expect($("dm-msg").textContent).toMatch(/more files than the viewer lists/);
  });
});

describe("the viewer opens every kind of file", () => {
  it("renders markdown through the page's renderer", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "REPORT.md");
    expect($("dm-viewer").hidden).toBe(false);
    expect(document.querySelector("#dm-v-body .report h3")!.textContent).toBe("Pit stop 2");
  });

  it("pretty-prints JSON, and shows what will not parse as it is", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "pitstop.json");
    expect(document.querySelector("#dm-v-body pre")!.textContent).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
    key("Escape");
    await openFile(m, "live/a-desktop.design.json");
    expect(document.querySelector("#dm-v-body pre")!.textContent).toBe("not json at all");
  });

  it("draws CSV as a table, with quoting", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "data/table.csv");
    expect([...document.querySelectorAll(".dm-table th")].map((n) => n.textContent)).toEqual(["name", "note"]);
    const cells = [...document.querySelectorAll(".dm-table td")].map((n) => n.textContent);
    expect(cells).toEqual(["alpha", "has, comma", "beta", 'say "hi"', "gamma"]);
  });

  it("reads tab-separated files and caps long ones", async () => {
    const m = await mount();
    expect(m.api.dmCsv("a\tb\n1\t2\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(m.api.dmCsv("x\n".repeat(600))).toHaveLength(500);
  });

  it("says how much of a capped file it is showing", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "logs/server.log");
    expect($("dm-v-note").textContent).toBe("Showing the first 1024 KB of 5.0 MB. Download for the rest");
  });

  it("shows HTML as inert source and never builds it", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "page.html");
    const body = $("dm-v-body");
    expect(body.querySelector("pre").textContent).toContain("<script>window.pwned");
    expect(body.querySelector("script")).toBeNull();
    expect(body.querySelector("img")).toBeNull();
    expect($("dm-v-note").textContent).toBe("Shown as source, never rendered");
  });

  it("says when values were masked", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "demo.env");
    expect($("dm-v-note").textContent).toBe("1 value masked");
  });

  it("gives a binary file a details card with Download", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "blob.bin");
    const text = $("dm-v-body").textContent;
    expect(text).toContain("blob.bin");
    expect(text).toContain("4.0 KB");
    expect($("dm-v-dl").disabled).toBe(false);
    expect($("dm-v-tab").hidden).toBe(true);
  });

  it("explains a withheld binary and disables its download", async () => {
    const m = await mount();
    m.files["blob.bin"] = { body: "", headers: { "x-charrette-render": "binary", "x-charrette-size": "9", "x-charrette-withheld": "this file type can hold private keys" } };
    await openBrowse(m);
    await openFile(m, "blob.bin");
    expect($("dm-v-body").textContent).toContain("Download is withheld");
    expect($("dm-v-dl").disabled).toBe(true);
  });

  it("shows a failed open in the viewer, with a Retry that works", async () => {
    const m = await mount();
    const good = m.files["logs/server.log"]!;
    m.files["logs/server.log"] = { status: 500, json: { error: "could not read that file" } };
    await openBrowse(m);
    await openFile(m, "logs/server.log");
    expect($("dm-viewer").hidden).toBe(false);
    const err = document.querySelector("#dm-v-body .dm-err") as Any;
    expect(err.textContent).toContain("could not read that file");
    m.files["logs/server.log"] = good;
    err.querySelector("button").click();
    await m.flush();
    expect(document.querySelector("#dm-v-body pre")!.textContent).toBe("line one");
  });

  it("survives the server going away", async () => {
    const m = await mount();
    m.files["logs/server.log"] = { reject: true } as Any;
    await openBrowse(m);
    await openFile(m, "logs/server.log");
    expect($("dm-v-body").textContent).toContain("did not answer");
  });
});

describe("moving through files", () => {
  it("shows the position and walks the on-screen order with the arrow keys", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "REPORT.md");
    expect($("dm-v-pos").textContent).toBe(`1 of ${FILES.length}`);
    expect($("dm-v-prev").disabled).toBe(true);
    key("ArrowRight");
    await m.flush();
    expect($("dm-v-name").textContent).toBe("blob.bin");
    key("ArrowLeft");
    await m.flush();
    expect($("dm-v-name").textContent).toBe("REPORT.md");
  });

  it("follows the current filter", async () => {
    const m = await mount();
    await openBrowse(m);
    (document.querySelector('#dm-chips [data-chip="logs"]') as Any).click();
    await openFile(m, "live/a-desktop.txt");
    expect($("dm-v-pos").textContent).toBe("1 of 2");
    $("dm-v-next").click();
    await m.flush();
    expect($("dm-v-name").textContent).toBe("server.log");
    expect($("dm-v-next").disabled).toBe(true);
  });

  it("offers the other captures of a screen and the text saved beside it", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "live/a-desktop.png");
    const labels = [...$("dm-v-variants").children].map((b: Any) => b.textContent);
    expect(labels).toEqual(["Desktop", "Mobile", "Design facts", "Page text"]);
    ([...$("dm-v-variants").children] as Any[]).find((b) => b.textContent === "Page text").click();
    await m.flush();
    expect($("dm-v-name").textContent).toBe("a-desktop.txt");
  });

  it("toggles an image between fit and actual size", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "live/a-desktop.png");
    expect($("dm-v-fit").hidden).toBe(false);
    expect($("dm-v-body").className).toBe("dm-fit");
    $("dm-v-fit").click();
    expect($("dm-v-body").className).toBe("");
    expect($("dm-v-fit").textContent).toBe("Fit");
  });

  it("keeps Tab inside the dialog", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "pitstop.json");
    expect($("dm-viewer").getAttribute("role")).toBe("dialog");
    expect($("dm-viewer").getAttribute("aria-modal")).toBe("true");
    expect((document.querySelector("main") as Any).inert).toBe(true);
    $("dm-v-body").focus();
    key("Tab");
    expect(document.activeElement).toBe($("dm-v-prev").disabled ? $("dm-v-next") : $("dm-v-prev"));
    key("Tab", { shiftKey: true });
    expect(document.activeElement).toBe($("dm-v-body"));
  });

  it("closes on Escape and returns focus to the file that opened it", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "pitstop.json");
    key("Escape");
    expect($("dm-viewer").hidden).toBe(true);
    expect((document.querySelector("main") as Any).inert).toBe(false);
    expect(document.activeElement).toBe(card("pitstop.json"));
  });
});

describe("the address bar", () => {
  it("keeps the token in the fragment and the viewer in the query", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "live/a-desktop.txt");
    expect(location.search).toBe("?stop=2&file=live/a-desktop.txt");
    expect(location.hash).toBe(`#${TOKEN}`);
  });

  it("restores a deep link on load", async () => {
    const m = await mount(runState(), "?stop=2&file=pitstop.json");
    await m.flush();
    await m.flush();
    expect($("dm-viewer").hidden).toBe(false);
    expect($("dm-v-name").textContent).toBe("pitstop.json");
    expect($("dm-stop").value).toBe("2");
  });

  it("closes the viewer when the browser goes back", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "pitstop.json");
    history.replaceState(null, "", `/?stop=2#${TOKEN}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect($("dm-viewer").hidden).toBe(true);
    expect(document.body.classList.contains("demo-on")).toBe(true);
    history.replaceState(null, "", `/#${TOKEN}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(document.body.classList.contains("demo-on")).toBe(false);
  });

  it("ignores a stop that is not a number", async () => {
    await mount(runState(), "?stop=../1&file=x");
    expect($("dm-viewer").hidden).toBe(true);
    expect($("demoview").hidden).toBe(true);
  });
});

describe("the token", () => {
  it("is sent as a header on every artifact request and never in a URL", async () => {
    const m = await mount();
    await openBrowse(m);
    for (const f of FILES) {
      await openFile(m, f.path);
      key("Escape");
    }
    const demoCalls = m.calls.filter((c) => c.url.includes("/pitstops/") || c.url.endsWith("/demo"));
    expect(demoCalls.length).toBeGreaterThan(FILES.length);
    for (const c of demoCalls) {
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain(TOKEN);
    }
  });

  it("opens a new tab from a blob, never from an API URL", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "page.html");
    const tab: Any = { location: { href: "" }, close: vi.fn(), opener: window };
    vi.spyOn(window, "open").mockReturnValue(tab);
    $("dm-v-tab").click();
    await m.flush();
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toMatch(/^blob:/);
    const blob = (URL.createObjectURL as Any).mock.calls.at(-1)[0];
    expect(blob.type.startsWith("text/plain")).toBe(true);
  });

  it("says so when the browser blocks the tab", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "pitstop.json");
    vi.spyOn(window, "open").mockReturnValue(null);
    $("dm-v-tab").click();
    expect($("dm-v-note").textContent).toMatch(/blocked/);
  });

  it("reports a download the server refused", async () => {
    const m = await mount();
    await openBrowse(m);
    await openFile(m, "pitstop.json");
    m.files["pitstop.json"] = { status: 403, json: { error: "download withheld: reasons" } };
    await m.api.dmDownload();
    expect($("dm-v-note").textContent).toBe("Could not download it: download withheld: reasons");
  });
});

describe("a running demo", () => {
  function running(over: Any = {}): Any {
    return {
      runId: "r1",
      active: {
        stop: 3, phase: "demo", startedAt: NOW - 240_000, lastEventAt: NOW - 30_000,
        activity: [
          { ts: NOW - 60_000, role: "demo", kind: "log", text: "Starting the backend." },
          { ts: NOW - 30_000, role: "demo", kind: "tool", tool: "Bash", text: JSON.stringify({ command: "uvicorn app:app" }) },
        ],
        ...over,
      },
      stops: [{ number: 3, state: "running", files: 0, reason: "", at: null, demoStarted: false }, ...finished().stops],
    };
  }

  it("says it is running with no files, how long, and the agent's last action", async () => {
    const m = await mount();
    m.status = running();
    m.lists[3] = { stop: 3, files: [], unlisted: 0, truncated: false };
    await openBrowse(m);
    await m.poll();
    expect($("dm-live").hidden).toBe(false);
    expect($("dm-live-title").textContent).toBe("Demo running. No files yet");
    expect($("dm-live-sub").textContent).toContain("running for 4m 0s");
    expect($("dm-live-now").textContent).toBe("demo: $ uvicorn app:app");
    expect($("dm-live-stall").hidden).toBe(true);
    expect($("dm-msg").hidden).toBe(true);
  });

  it("says plainly when nothing has happened for ten minutes", async () => {
    const m = await mount();
    m.status = running({ lastEventAt: NOW - 12 * 60_000 });
    m.lists[3] = { stop: 3, files: [], unlisted: 0, truncated: false };
    await openBrowse(m);
    await m.poll();
    expect($("dm-live-stall").textContent).toBe("No activity for 12 minutes; a command may be waiting on a server.");
    expect($("dm-live").classList.contains("stalled")).toBe(true);
  });

  it.each([["review", "Demo finished. Reviewers are reading it"], ["finishing", "Demo finished. Checking its evidence"]])("names the %s phase", async (phase, title) => {
    const m = await mount();
    m.status = running({ phase });
    m.lists[3] = { stop: 3, files: [], unlisted: 0, truncated: false };
    await openBrowse(m);
    await m.poll();
    expect($("dm-live-title").textContent).toBe(title);
  });

  it("adds new files at the end, marks them, and leaves focus and earlier cards alone", async () => {
    const m = await mount();
    m.status = running();
    m.lists[3] = { stop: 3, files: [file("b.log", "text", "logs")], unlisted: 0, truncated: false };
    await openBrowse(m);
    await m.poll();
    const first = card("b.log");
    first.focus();
    m.lists[3] = { stop: 3, files: [file("a.log", "text", "logs"), file("b.log", "text", "logs")], unlisted: 0, truncated: false };
    await m.poll();
    expect(card("b.log")).toBe(first);
    expect(document.activeElement).toBe(first);
    const order = [...document.querySelectorAll("#dm-groups [data-path]")].map((n: Any) => n.dataset.path);
    expect(order).toEqual(["b.log", "a.log"]);
    expect(card("a.log").querySelector(".dm-new-tag")).toBeTruthy();
    expect($("dm-count").textContent).toBe("1 new file from the demo");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(card("a.log").querySelector(".dm-new-tag")).toBeNull();
  });

  it("throttles what it announces", async () => {
    const m = await mount();
    m.status = running();
    m.lists[3] = { stop: 3, files: [file("a.log", "text", "logs")], unlisted: 0, truncated: false };
    await openBrowse(m);
    await m.poll();
    m.lists[3] = { stop: 3, unlisted: 0, truncated: false, files: [file("a.log", "text", "logs"), file("b.log", "text", "logs")] };
    await m.poll();
    expect($("dm-count").textContent).toBe("1 new file from the demo");
    m.lists[3] = { stop: 3, unlisted: 0, truncated: false, files: ["a", "b", "c", "d"].map((n) => file(`${n}.log`, "text", "logs")) };
    await m.poll();
    expect($("dm-count").textContent).toBe("1 new file from the demo");
    await vi.advanceTimersByTimeAsync(20_000);
    expect($("dm-count").textContent).toBe("2 new files from the demo");
  });

  it("does not poll while the view is closed", async () => {
    const m = await mount();
    const before = m.urls.length;
    await m.api.dmPoll();
    expect(m.urls.length).toBe(before);
  });
});

describe("thumbnails", () => {
  let images: Any[];
  beforeEach(() => {
    images = [];
    class FakeImage {
      alt = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      constructor() {
        images.push(this);
      }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("IntersectionObserver", undefined);
    return () => vi.unstubAllGlobals();
  });

  const shots = (n: number) => Array.from({ length: n }, (_, i) => file(`s${i}.png`, "image", "screens"));
  const blockAll = (m: Mounted, n: number) => {
    for (let i = 0; i < n; i++) m.files[`s${i}.png`] = { body: "png", headers: { "x-charrette-render": "image" } };
  };

  it("never has more than six in flight", async () => {
    const m = await mount();
    m.lists[2] = { stop: 2, unlisted: 0, truncated: false, files: shots(20) };
    blockAll(m, 20);
    await openBrowse(m);
    expect(images).toHaveLength(6);
    for (let i = 0; i < 6; i++) { images[i].onload(); }
    await m.flush();
    expect(images).toHaveLength(12);
  });

  it("revokes every blob when the stop changes", async () => {
    const m = await mount();
    m.lists[2] = { stop: 2, unlisted: 0, truncated: false, files: shots(2) };
    blockAll(m, 2);
    await openBrowse(m);
    images[0].onload();
    images[1].onload();
    await m.flush();
    $("dm-stop").value = "1";
    $("dm-stop").dispatchEvent(new Event("change"));
    await m.flush();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("retries a screenshot that would not decode, so a half-written file recovers", async () => {
    const m = await mount();
    m.status = {
      runId: "r1", active: { stop: 2, phase: "demo", startedAt: NOW, lastEventAt: NOW, activity: [] },
      stops: [{ number: 2, state: "running", files: 1, reason: "", at: null, demoStarted: false }],
    };
    m.lists[2] = { stop: 2, unlisted: 0, truncated: false, files: shots(1) };
    blockAll(m, 1);
    await openBrowse(m);
    await m.flush();
    images[0].onerror();
    await m.flush();
    expect(card("s0.png").textContent).toContain("still being written");
    await vi.advanceTimersByTimeAsync(1500);
    await m.flush();
    expect(images).toHaveLength(2);
    images[1].onload();
    await m.flush();
    expect(card("s0.png").querySelector(".dm-pic img, .dm-pic")).toBeTruthy();
    expect(card("s0.png").textContent).not.toContain("still being written");
  });

  it("gives up quietly on one that never decodes, and the card still opens", async () => {
    const m = await mount();
    m.lists[2] = { stop: 2, unlisted: 0, truncated: false, files: shots(1) };
    blockAll(m, 1);
    await openBrowse(m);
    for (let i = 0; i < 4; i++) {
      images[i].onerror();
      await m.flush();
      await vi.advanceTimersByTimeAsync(1500);
      await m.flush();
    }
    expect(images).toHaveLength(4);
    expect(card("s0.png").textContent).toContain("no preview");
    expect(card("s0.png").tagName).toBe("BUTTON");
  });

  it("redraws a thumbnail when the file changes", async () => {
    const m = await mount();
    m.lists[2] = { stop: 2, unlisted: 0, truncated: false, files: shots(1) };
    blockAll(m, 1);
    await openBrowse(m);
    images[0].onload();
    await m.flush();
    m.lists[2] = { stop: 2, unlisted: 0, truncated: false, files: [{ ...shots(1)[0], mtimeMs: NOW }] };
    m.status = { ...m.status, stops: [{ ...m.status.stops[0], state: "running" }] };
    await m.poll();
    expect(images).toHaveLength(2);
  });
});

describe("the pit stop", () => {
  const stop = { runId: "r1", number: 2, reason: "r", markdown: REPORT };

  it("offers the evidence with a count on the decision itself", async () => {
    await mount(runState({ pitStop: stop }));
    expect($("dm-ps-open").hidden).toBe(false);
    expect($("dm-ps-open").textContent).toBe(`View demo artifacts (${FILES.length})`);
  });

  it("still offers it when the list cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const opensAt = runState({ pitStop: { ...stop, number: 9 } });
    await mount(opensAt);
    expect($("dm-ps-open").textContent).toBe("View demo artifacts");
  });

  it("links cited files by path and by bare name, and marks the one that is missing", async () => {
    await mount(runState({ pitStop: stop }));
    const report = $("pitstop-report");
    expect([...report.querySelectorAll(".dm-cite")].map((n: Any) => n.textContent)).toEqual(["live/a-desktop.png", "a-mobile.png"]);
    expect(report.querySelector(".dm-missing").textContent).toBe("live/gone.png(missing)");
  });

  it("does not call a repository path or a command missing", async () => {
    await mount(runState({ pitStop: stop }));
    const report = $("pitstop-report");
    expect(report.querySelectorAll(".dm-missing")).toHaveLength(1);
    const code = [...report.querySelectorAll(".dm-code")].map((n: Any) => n.textContent);
    expect(code).toEqual(expect.arrayContaining(["podman run", "backend/", "curl localhost"]));
  });

  it("resolves a citation given as an absolute path", async () => {
    const md = "## Evidence\n\n- `/repo/.charrette/r1/pitstops/2/pitstop.json` — the record";
    await mount(runState({ pitStop: { ...stop, markdown: md } }));
    expect($("pitstop-report").querySelector(".dm-cite")).toBeTruthy();
  });

  it("returns to the decision with what was typed still there", async () => {
    const m = await mount(runState({ pitStop: stop }));
    $("pitstop-feedback").value = "half a thought";
    const cite = $("pitstop-report").querySelector(".dm-cite");
    cite.click();
    await m.flush();
    expect($("dm-viewer").hidden).toBe(false);
    key("Escape");
    expect($("dm-viewer").hidden).toBe(true);
    expect($("pitstop-feedback").value).toBe("half a thought");
    expect(document.activeElement).toBe(cite);
  });

  it("opens the browse view for that stop and flags the waiting decision", async () => {
    const m = await mount(runState({ pitStop: stop }));
    $("pitstop").style.display = "block";
    $("dm-ps-open").click();
    await m.flush();
    await m.poll();
    expect($("demoview").hidden).toBe(false);
    expect($("dm-stop").value).toBe("2");
    expect($("dm-gate").hidden).toBe(false);
    $("dm-gate-go").click();
    expect($("demoview").hidden).toBe(true);
  });
});
