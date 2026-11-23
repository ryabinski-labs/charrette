// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_EFFORTS, RunConfig } from "@charrette/shared";
import { MODEL_CHOICES, PAGE_HTML } from "./page.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- the page is untyped JS. */
type Any = any;

describe("the effort control", () => {
  const models = { worker: "gemini-4-neon", demo: "gemini-4-neon", advisor: "deepseek-flash", qa: "claude-sonnet-5-5", repair: "local-model" };
  const run = (config: Record<string, Any> = {}) => ({
    id: "r1", repoPath: "/repo", integrationBranch: "b", createdAt: 0, state: "EXECUTING", githubRepo: "a/b",
    assignment: "Build it.", spentUsd: 1, sessions: [], tasks: [],
    config: { deterministicChecks: [], qaIterationCap: 3, budget: { runCapUsd: 100 }, models, effort: {}, ...config },
  });
  const state = (r: Any) => ({ runs: [r], planGate: null, budgetGate: null, taskGates: [], pitStop: null });

  function mount(initial: Any) {
    const opensAt = PAGE_HTML.indexOf("<script>");
    const closesAt = PAGE_HTML.indexOf("</script>");
    const source = PAGE_HTML.slice(opensAt + "<script>".length, closesAt);
    document.documentElement.innerHTML = (PAGE_HTML.slice(0, opensAt) + PAGE_HTML.slice(closesAt + "</script>".length))
      .replace(/^[\s\S]*?<html[^>]*>/, "")
      .replace(/<\/html>\s*$/, "");
    let payload = initial;
    const posts: { url: string; body: Any }[] = [];
    let answer: (body: Any) => Promise<Any> = async () => ({ ok: true, status: 200, json: async () => ({ message: "saved" }) });
    const fetchStub = (url: string, init?: Any): Promise<Any> => {
      if (url === "/api/state") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
      if (init?.method === "POST") {
        const body = JSON.parse(init.body);
        posts.push({ url, body });
        return answer(body);
      }
      return new Promise(() => {});
    };
    const api = new Function("fetch", "setInterval", source + "\n;return { refresh: refresh };")(fetchStub, () => 0);
    return {
      refresh: () => api.refresh() as Promise<void>,
      serve: (next: Any) => void (payload = next),
      answer: (fn: typeof answer) => void (answer = fn),
      posts,
    };
  }

  const rowOf = (role: string) => [...document.querySelectorAll("#models .row")].find((r) => r.querySelector(".role")!.textContent === role)!;
  const control = (role: string) => rowOf(role).querySelector(".effort select") as HTMLSelectElement | null;
  const options = (role: string) => [...control(role)!.options].map((o) => o.value);
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const choose = async (role: string, level: string) => {
    const sel = control(role)!;
    sel.value = level;
    sel.dispatchEvent(new Event("change"));
    await settle();
  };

  beforeEach(() => {
    document.documentElement.innerHTML = "";
  });

  it("every model the dropdown offers has a row in the table", () => {
    for (const model of MODEL_CHOICES) expect(MODEL_EFFORTS[model], model).toBeDefined();
  });

  it("lists only the levels the role's model takes, plus default", async () => {
    const page = mount(state(run()));
    await page.refresh();
    expect(options("worker")).toEqual(["default", "low", "medium", "high", "xhigh"]);
    expect(options("advisor")).toEqual(["default", "low", "high", "max"]);
    expect(options("qa")).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
  });

  it("shows no control for a model with no effort setting", async () => {
    const page = mount(state(run()));
    await page.refresh();
    expect(control("repair")).toBeNull();
  });

  it("reads a provider-prefixed model as that model", async () => {
    const page = mount(state(run({ models: { ...models, worker: "google/gemini-4-carbon" }, effort: { "gemini-4-carbon": "high" } })));
    await page.refresh();
    expect(options("worker")).toEqual(["default", "low", "medium", "high"]);
    expect(control("worker")!.value).toBe("high");
  });

  it("says plainly that the setting reaches every role on the model", async () => {
    const page = mount(state(run()));
    await page.refresh();
    expect(document.querySelector("#models")!.textContent).toContain("effort is set per model: changing it changes every role on that model");
    expect(rowOf("worker").querySelector(".effort")!.textContent).toContain("2 roles");
    expect(control("worker")!.getAttribute("aria-label")).toBe("Effort for gemini-4-neon. Changing it changes every role on this model: worker, demo.");
    expect(rowOf("advisor").querySelector(".effort")!.firstChild!.textContent).toBe("effort");
  });

  it("posts the model and level, and keeps every row on the model in step", async () => {
    const page = mount(state(run()));
    await page.refresh();
    page.serve(state(run({ effort: { "gemini-4-neon": "xhigh" } })));
    await choose("worker", "xhigh");
    expect(page.posts).toEqual([{ url: "/api/runs/r1/effort", body: { model: "gemini-4-neon", level: "xhigh" } }]);
    expect(control("worker")!.value).toBe("xhigh");
    expect(control("demo")!.value).toBe("xhigh");
    expect(control("advisor")!.value).toBe("default");
    expect(rowOf("worker").nextElementSibling!.textContent).toBe("saved");
  });

  it("sends nothing when the choice is what is already set", async () => {
    const page = mount(state(run({ effort: { "gemini-4-neon": "high" } })));
    await page.refresh();
    await choose("worker", "high");
    expect(page.posts).toEqual([]);
  });

  it("puts focus back on the control after the redraw, for a keyboard user", async () => {
    const page = mount(state(run()));
    await page.refresh();
    page.serve(state(run({ effort: { "gemini-4-neon": "low" } })));
    await choose("worker", "low");
    expect(document.activeElement).toBe(control("worker"));
  });

  it("goes back to the stored level on a refusal and shows why", async () => {
    const page = mount(state(run()));
    await page.refresh();
    page.answer(async () => ({ ok: false, status: 400, json: async () => ({ error: "use one of: low, high, max." }) }));
    await choose("advisor", "max");
    expect(control("advisor")!.value).toBe("default");
    const said = rowOf("advisor").nextElementSibling!;
    expect(said.textContent).toBe("use one of: low, high, max.");
    expect(said.className).toContain("bad");
  });

  it("has words for a refusal with no body, and for a server it cannot reach", async () => {
    const page = mount(state(run()));
    await page.refresh();
    page.answer(async () => ({ ok: false, status: 500, json: async () => { throw new Error("not json"); } }));
    await choose("advisor", "low");
    expect(rowOf("advisor").nextElementSibling!.textContent).toBe("could not change effort");
    page.answer(async () => { throw new Error("offline"); });
    await choose("advisor", "high");
    expect(rowOf("advisor").nextElementSibling!.textContent).toBe("could not reach the server");
  });

  it("follows the role when its model changes", async () => {
    const page = mount(state(run({ effort: { "gemini-4-neon": "xhigh" } })));
    await page.refresh();
    expect(control("worker")!.value).toBe("xhigh");
    page.serve(state(run({ models: { ...models, worker: "deepseek-flash" }, effort: { "gemini-4-neon": "xhigh", "deepseek-flash": "max" } })));
    await page.refresh();
    expect(options("worker")).toEqual(["default", "low", "high", "max"]);
    expect(control("worker")!.value).toBe("max");
  });

  it("drops the last message once the role has moved to another model", async () => {
    const page = mount(state(run()));
    await page.refresh();
    page.serve(state(run({ effort: { "gemini-4-neon": "xhigh" } })));
    await choose("worker", "xhigh");
    expect(document.querySelector("#models")!.textContent).toContain("saved");
    page.serve(state(run({ models: { ...models, worker: "deepseek-flash" }, effort: { "gemini-4-neon": "xhigh" } })));
    await page.refresh();
    expect(document.querySelector("#models")!.textContent).not.toContain("saved");
  });

  it("keeps a pinned role's vendor label on the model's line, before the effort control", async () => {
    const page = mount(state(run()));
    await page.refresh();
    const classes = [...rowOf("qa").children].map((n) => n.className);
    expect(classes.indexOf("lock")).toBeLessThan(classes.indexOf("effort"));
  });

  it("draws a run recorded before effort existed", async () => {
    const page = mount(state(run({ effort: undefined })));
    await page.refresh();
    expect(control("worker")!.value).toBe("default");
  });

  it("uses a real, labelled, focusable control", async () => {
    const page = mount(state(run()));
    await page.refresh();
    const sel = control("worker")!;
    expect(sel.tagName).toBe("SELECT");
    expect(sel.closest("label")).not.toBeNull();
    expect(RunConfig.parse({}).effort).toEqual({});
  });
});
