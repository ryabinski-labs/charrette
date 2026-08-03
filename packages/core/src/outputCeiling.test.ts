import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ceilingNote, ceilingTable, forgetCeilingTable, grantedTokens, modelCeiling, sdkCeiling, type CeilingTable } from "./outputCeiling.js";

/** The shape the SDK minifies its ceiling chain into, with the pieces that matter. */
function chain(body: string): string {
  return `function xY(A){let Q=A.toLowerCase(),B;${body}let G=HuA.validate(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);return Math.min(G.effective,B)}`;
}

const TABLE = chain(
  'if(Q.includes("claude-3-opus"))B=4096;' +
    'else if(Q.includes("opus-4-5"))B=64000;' +
    'else if(Q.includes("opus-4"))B=32000;' +
    'else if(Q.includes("sonnet-4")||Q.includes("haiku-4"))B=64000;' +
    "else B=32000;"
);

describe("reading the ceiling the installed SDK will actually grant", () => {
  it("reads every arm of the chain, including one written as two substrings", () => {
    const table = ceilingTable(TABLE)!;
    expect(table.fallback).toBe(32000);
    expect(table.rules).toContainEqual({ match: ["sonnet-4", "haiku-4"], cap: 64000 });
    expect(table.rules).toHaveLength(4);
  });

  it("keeps the arms in order, because the SDK takes the first that matches", () => {
    // `opus-4-5` contains `opus-4`. Read in the other order every 4.5 model
    // would be reported at half its real ceiling.
    const table = ceilingTable(TABLE)!;
    expect(modelCeiling(table, "claude-opus-4-5-20251101").cap).toBe(64000);
    expect(modelCeiling(table, "claude-opus-4-20250514").cap).toBe(32000);
  });

  it("matches the way the SDK does, on a lowercased substring", () => {
    expect(modelCeiling(ceilingTable(TABLE)!, "Claude-Sonnet-4-5").cap).toBe(64000);
  });

  it("says when no arm matched, not just what the number was", () => {
    // The number alone is ambiguous: 32000 is both a real ceiling and the
    // fallback. Only the flag distinguishes "capped there" from "never heard of".
    const table = ceilingTable(TABLE)!;
    expect(modelCeiling(table, "claude-opus-4")).toMatchObject({ cap: 32000, recognized: true });
    expect(modelCeiling(table, "claude-opus-5")).toMatchObject({ cap: 32000, recognized: false });
  });
});

describe("a bundle it cannot read the chain out of", () => {
  it("has no opinion when the clamp is not there at all", () => {
    expect(ceilingTable("function xY(A){return 32000}")).toBeUndefined();
  });

  it("has no opinion when the chain does not lowercase the model", () => {
    // A future SDK keying its table some other way must produce silence rather
    // than whatever the window happens to contain.
    expect(ceilingTable("let G=HuA.validate(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);")).toBeUndefined();
  });

  it("has no opinion when there are too few arms to be a table", () => {
    expect(ceilingTable(chain('if(Q.includes("opus-4"))B=32000;else B=32000;'))).toBeUndefined();
  });

  it("has no opinion when the arms do not all set the same variable", () => {
    // Then the window has caught two unrelated pieces of code, and reading them
    // as one table would invent a ceiling nobody wrote.
    const mixed = chain('if(Q.includes("a"))B=1000;else if(Q.includes("b"))C=2000;else if(Q.includes("c"))B=3000;else B=32000;');
    expect(ceilingTable(mixed)).toBeUndefined();
  });

  it("has no opinion when one arm's ceiling is not a plain number", () => {
    // Reading the other arms and dropping this one would answer confidently and
    // wrongly for the model this arm was written for.
    const computed = chain('if(Q.includes("a"))B=1000;else if(Q.includes("b"))B=defaultFor(Q);else if(Q.includes("c"))B=3000;else B=32000;');
    expect(ceilingTable(computed)).toBeUndefined();
  });

  it("has no opinion when the chain never falls through", () => {
    const noFallback = chain('if(Q.includes("a"))B=1000;else if(Q.includes("b"))B=2000;else if(Q.includes("c"))B=3000;');
    expect(ceilingTable(noFallback)).toBeUndefined();
  });
});

describe("the SDK this harness is actually installed against", () => {
  beforeEach(() => forgetCeilingTable());

  it("still has a chain in the shape this parses", async () => {
    // The test that earns the rest of the module. If an SDK upgrade moves the
    // ceiling somewhere else, the harness goes quiet instead of lying — and this
    // is what tells us it went quiet.
    const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    const bundle = await readFile(path.join(path.dirname(entry), "cli.js"), "utf8");
    const table = ceilingTable(bundle);
    expect(table).toBeDefined();
    expect(table!.rules.length).toBeGreaterThanOrEqual(5);
  });

  it("does not recognise the model the planner runs on, which is the whole point", async () => {
    // 0.1.77 keys on `opus-4`, `sonnet-4`, `haiku-4`. `claude-opus-5` matches
    // none of them and is handed the fallback — the planner asks for 64000 and
    // is given 32000. Run 3ae58e02 lost a phase-B attempt to it.
    const ceiling = await sdkCeiling("claude-opus-5");
    expect(ceiling).toMatchObject({ recognized: false });
    expect(ceilingNote(ceiling, 64_000)).toContain("does not recognise claude-opus-5");
  });

  it("reads the bundle once however many models are asked about", async () => {
    let reads = 0;
    const load = async () => {
      reads++;
      return TABLE;
    };
    await sdkCeiling("claude-opus-5", load);
    await sdkCeiling("claude-opus-4", load);
    expect(reads).toBe(1);
  });

  it("has no opinion when the SDK cannot be read at all", async () => {
    // A pnpm layout this cannot resolve, a bundle that is not on disk. None of
    // it may take a run down over a message the run does not need.
    expect(await sdkCeiling("claude-opus-5", () => Promise.reject(new Error("ENOENT")))).toBeUndefined();
  });
});

describe("what the operator is told about it", () => {
  const table = ceilingTable(TABLE) as CeilingTable;

  it("names the SDK, not the plan, when the model is one it never heard of", async () => {
    // The failure downstream is a message cut off mid-JSON, which reads exactly
    // like a plan that was too long. Without this the retry says "write less".
    const note = ceilingNote(modelCeiling(table, "claude-opus-5"), 64_000)!;
    expect(note).toContain("asks for 64000");
    expect(note).toContain("will give 32000");
    expect(note).toContain("upgrade @anthropic-ai/claude-agent-sdk");
  });

  it("says the model is capped there when the SDK does know it", async () => {
    const note = ceilingNote(modelCeiling(table, "claude-opus-4"), 64_000)!;
    expect(note).toContain("claude-opus-4 is capped there");
    expect(note).not.toContain("upgrade");
  });

  it("says nothing when the request stands", () => {
    // Silence is the signal that the ceiling was granted, so it has to stay
    // silence — a reassurance printed every run is a line nobody reads.
    expect(ceilingNote(modelCeiling(table, "claude-sonnet-4-5"), 64_000)).toBeUndefined();
    expect(ceilingNote(modelCeiling(table, "claude-opus-4"), 32_000)).toBeUndefined();
  });

  it("plans around what was granted, and around the request when nothing was read", () => {
    // An unreadable SDK leaves the harness exactly where it was before it could
    // read one: taking its own request at face value.
    expect(grantedTokens(modelCeiling(table, "claude-opus-5"), 64_000)).toBe(32_000);
    expect(grantedTokens(modelCeiling(table, "claude-opus-4-5"), 64_000)).toBe(64_000);
    expect(grantedTokens(modelCeiling(table, "claude-opus-4-5"), 16_000)).toBe(16_000);
    expect(grantedTokens(undefined, 64_000)).toBe(64_000);
  });

  it("says nothing when the ceiling could not be read", () => {
    expect(ceilingNote(undefined, 64_000)).toBeUndefined();
  });

  it("names the role that asked, since the planner is not the only one who can", () => {
    expect(ceilingNote(modelCeiling(table, "claude-opus-5"), 64_000, "the replanner")).toContain("the replanner asks for");
  });
});
