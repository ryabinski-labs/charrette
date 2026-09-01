import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ceilingNote,
  ceilingTable,
  forgetCeilingTable,
  grantedTokens,
  installedCeilingTable,
  modelCeiling,
  requestTokens,
  sdkCeiling,
  type CeilingTable,
} from "./outputCeiling.js";

/** One entry of the SDK's minified model registry, with the fields that matter. */
function entry(id: string, standard: number, upper: number, extra = ""): string {
  return `{id:"${id}",model_names:{anthropic:"${id}"},context:{window:200000}${extra},max_output_tokens:{default:${standard},upper:${upper}},pricing:"tier_3_15",capabilities:[]}`;
}

const REGISTRY = `let MODELS=[${[
  entry("claude-3-5-haiku", 8192, 8192),
  entry("claude-opus-4-5", 32000, 64000),
  entry("claude-opus-4", 32000, 32000),
  entry("claude-sonnet-4-5", 32000, 64000),
  entry("claude-opus-5", 64000, 128000),
  entry("claude-fable-5", 64000, 128000),
].join(",")}];`;

describe("reading the ceiling the installed SDK will actually grant", () => {
  it("reads every entry of the registry", () => {
    const table = ceilingTable(REGISTRY)!;
    expect(table.models).toHaveLength(6);
    expect(table.models).toContainEqual({ id: "claude-opus-5", limits: { standard: 64_000, upper: 128_000 } });
  });

  it("keeps both numbers, because they answer different questions", () => {
    // `standard` is what a message gets unasked; `upper` is what it gets when
    // the harness asks. Reporting only one of them is how the planner ended up
    // asking for half of what it could have had.
    expect(modelCeiling(ceilingTable(REGISTRY), "claude-opus-5")).toMatchObject({ known: true, standard: 64_000, upper: 128_000 });
  });

  it("prefers the longest matching id, because one id is a prefix of another", () => {
    // `claude-opus-4-5` starts with `claude-opus-4`. Matched the other way round
    // every 4.5 model would be reported at half its real ceiling.
    const table = ceilingTable(REGISTRY);
    expect(modelCeiling(table, "claude-opus-4-5-20251101")).toMatchObject({ upper: 64_000 });
    expect(modelCeiling(table, "claude-opus-4-20250514")).toMatchObject({ upper: 32_000 });
  });

  it("matches a lowercased prefix, so dated and suffixed names find their model", () => {
    const table = ceilingTable(REGISTRY);
    expect(modelCeiling(table, "Claude-Sonnet-4-5")).toMatchObject({ upper: 64_000 });
    // The 1M-context variant is the same model as far as output is concerned.
    expect(modelCeiling(table, "claude-opus-5[1m]")).toMatchObject({ upper: 128_000 });
  });

  it("says a model is unlisted rather than inventing a number for it", () => {
    // The distinction is the whole point: a wrong-but-confident ceiling is what
    // makes a truncated message look like a plan that was simply too long.
    expect(modelCeiling(ceilingTable(REGISTRY), "claude-opus-9")).toEqual({ known: false, model: "claude-opus-9", reason: "unlisted" });
  });

  it("keeps the first entry when a model is listed twice", () => {
    const twice = `[${entry("claude-opus-5", 64000, 128000)},${entry("claude-opus-5", 1, 2)},${entry("claude-opus-4", 32000, 32000)},${entry("claude-opus-4-5", 32000, 64000)},${entry("claude-sonnet-4-5", 32000, 64000)},${entry("claude-3-5-haiku", 8192, 8192)}]`;
    expect(modelCeiling(ceilingTable(twice), "claude-opus-5")).toMatchObject({ upper: 128_000 });
  });
});

describe("a bundle it cannot read the registry out of", () => {
  it("has no opinion when there is no registry at all", () => {
    expect(ceilingTable("function xY(A){return 32000}")).toBeUndefined();
  });

  it("has no opinion when there are too few entries to be the registry", () => {
    // A handful of objects that happen to parse is a coincidence, not a table.
    expect(ceilingTable(`[${entry("claude-opus-5", 64000, 128000)},${entry("claude-opus-4", 32000, 32000)}]`)).toBeUndefined();
  });

  it("skips an entry that states no output limits rather than borrowing its neighbour's", () => {
    // The failure that would matter: reading the next model's ceiling onto this
    // one and reporting it with full confidence.
    const gap = `[{id:"claude-opus-9",model_names:{}},${[
      entry("claude-3-5-haiku", 8192, 8192),
      entry("claude-opus-4-5", 32000, 64000),
      entry("claude-opus-4", 32000, 32000),
      entry("claude-sonnet-4-5", 32000, 64000),
      entry("claude-opus-5", 64000, 128000),
    ].join(",")}]`;
    const table = ceilingTable(gap)!;
    expect(table.models.some((m) => m.id === "claude-opus-9")).toBe(false);
    expect(modelCeiling(table, "claude-opus-9")).toMatchObject({ known: false, reason: "unlisted" });
  });

  it("ignores objects that are not models", () => {
    const noisy = `${REGISTRY};let OTHER=[{id:"not-a-model",max_output_tokens:{default:1,upper:2}}];`;
    expect(ceilingTable(noisy)!.models.every((m) => m.id.startsWith("claude-"))).toBe(true);
  });
});

describe("the SDK this harness is actually installed against", () => {
  beforeEach(() => forgetCeilingTable());

  it("still has a registry in the shape this parses", async () => {
    // The test that earns the rest of the module. If an SDK upgrade moves the
    // ceiling somewhere else, the harness goes quiet instead of lying — and this
    // is what tells us it went quiet. It moved once already: 0.3.25x keeps the
    // table in the native binary rather than the entry bundle, which is why
    // this asks the installed-SDK reader rather than the bundle directly.
    const table = await installedCeilingTable();
    expect(table).toBeDefined();
    expect(table!.models.length).toBeGreaterThanOrEqual(10);
  });

  it("finds nothing in the entry bundle of the SDK installed today, which is why the binary is read", async () => {
    // Pinned so that the day the bundle carries the registry again, the
    // two-hundred-megabyte scan is noticed as the dead code it would then be.
    const bundle = await readFile(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"), "utf8");
    expect(ceilingTable(bundle)).toBeUndefined();
  });

  it("knows the model the heavy tier runs on", async () => {
    const reading = await sdkCeiling("claude-fable-5-1");
    expect(reading).toMatchObject({ known: true });
    expect(requestTokens(reading, 64_000)).toBeGreaterThanOrEqual(64_000);
  });

  it("knows the model the planner runs on, and grants more than the harness used to ask for", async () => {
    // The regression this module exists for, in its fixed form: 0.1.77 had never
    // heard of `claude-opus-5` and silently handed it 32000, which truncated a
    // plan mid-JSON and — once the wrap-up message landed on the truncated turn
    // — took a whole run down with a 400.
    const reading = await sdkCeiling("claude-opus-5");
    expect(reading).toMatchObject({ known: true });
    expect(requestTokens(reading, 64_000)).toBeGreaterThanOrEqual(64_000);
    expect(ceilingNote(reading, 64_000)).toBeUndefined();
  });

  it("reads the bundle once however many models are asked about", async () => {
    let reads = 0;
    const load = async () => {
      reads++;
      return REGISTRY;
    };
    await sdkCeiling("claude-opus-5", load);
    await sdkCeiling("claude-opus-4", load);
    expect(reads).toBe(1);
  });

  it("has no opinion when the SDK cannot be read at all", async () => {
    // A pnpm layout this cannot resolve, a bundle that is not on disk. None of
    // it may take a run down over a message the run does not need.
    expect(await sdkCeiling("claude-opus-5", () => Promise.reject(new Error("ENOENT")))).toEqual({
      known: false,
      model: "claude-opus-5",
      reason: "unreadable",
    });
  });
});

describe("what the operator is told about it", () => {
  const table = ceilingTable(REGISTRY) as CeilingTable;

  it("names the SDK, not the plan, when the model is one it never heard of", async () => {
    // The failure downstream is a message cut off mid-JSON, which reads exactly
    // like a plan that was too long. Without this the retry says "write less".
    const note = ceilingNote(modelCeiling(table, "claude-opus-9"), 64_000)!;
    expect(note).toContain("does not list claude-opus-9");
    expect(note).toContain("32000");
    expect(note).toContain("Upgrade @anthropic-ai/claude-agent-sdk");
  });

  it("says the model tops out there when the SDK does know it", async () => {
    const note = ceilingNote(modelCeiling(table, "claude-opus-4"), 64_000)!;
    expect(note).toContain("claude-opus-4 tops out at 32000");
    expect(note).not.toContain("upgrade");
  });

  it("says nothing when the request stands", () => {
    // Silence is the signal that the ceiling was granted, so it has to stay
    // silence — a reassurance printed every run is a line nobody reads.
    expect(ceilingNote(modelCeiling(table, "claude-opus-5"), 64_000)).toBeUndefined();
    expect(ceilingNote(modelCeiling(table, "claude-opus-4"), 32_000)).toBeUndefined();
  });

  it("says nothing when the ceiling could not be read", () => {
    // Nothing the operator can act on, unlike an SDK that is merely too old.
    expect(ceilingNote({ known: false, model: "claude-opus-5", reason: "unreadable" }, 64_000)).toBeUndefined();
  });

  it("names the role that asked, since the planner is not the only one who can", () => {
    expect(ceilingNote(modelCeiling(table, "claude-opus-9"), 64_000, "the replanner")).toContain("the replanner asks");
  });
});

describe("how much to ask each message for", () => {
  const table = ceilingTable(REGISTRY) as CeilingTable;

  it("asks for everything the model allows, not the harness's own figure", () => {
    // The planner emits one indivisible artifact per message. Leaving 64000
    // tokens of the model's allowance unused is a plan split in half for nothing.
    expect(requestTokens(modelCeiling(table, "claude-opus-5"), 64_000)).toBe(128_000);
    expect(requestTokens(modelCeiling(table, "claude-opus-4"), 64_000)).toBe(32_000);
  });

  it("falls back to the harness's figure for a model the SDK does not list", () => {
    // Asking for more than an unlisted model grants is harmless — it is clamped.
    // Asking for less than it grants is not.
    expect(requestTokens(modelCeiling(table, "claude-opus-9"), 64_000)).toBe(64_000);
    expect(requestTokens({ known: false, model: "x", reason: "unreadable" }, 64_000)).toBe(64_000);
  });

  it("plans around what was granted, and around the request when nothing was read", () => {
    // An unreadable SDK leaves the harness exactly where it was before it could
    // read one: taking its own request at face value.
    expect(grantedTokens(modelCeiling(table, "claude-opus-4"), 64_000)).toBe(32_000);
    expect(grantedTokens(modelCeiling(table, "claude-opus-5"), 128_000)).toBe(128_000);
    expect(grantedTokens(modelCeiling(table, "claude-opus-5"), 16_000)).toBe(16_000);
    expect(grantedTokens({ known: false, model: "x", reason: "unreadable" }, 64_000)).toBe(64_000);
  });
});
