import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { Store } from "./store.js";

/**
 * What a run resumed after a config default changed is allowed to do.
 *
 * `getRun` re-parses the stored config on every read, so a key that did not
 * exist when the run was created picks up whatever today's default is. That is
 * usually harmless — a new field nobody had an opinion about — and exactly once
 * it is not: `models.workerLight` decides which model writes the code, and a
 * run planned, priced and half-executed on Sonnet must not quietly finish on
 * Haiku because it was parked over a release.
 *
 * The stored configs of the twelve real runs on this machine all predate the
 * key, so every one of them was affected.
 */

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";

/** A store on disk, so it can be closed and reopened the way a resume does. */
function onDisk(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-frozen-"));
  return { dbPath: path.join(dir, "harness.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Writes a run whose stored config has had `models.workerLight` removed. */
function runFromBeforeTheLightTier(dbPath: string, models: Record<string, string> = {}): string {
  const store = new Store(dbPath);
  store.createRun({
    id: "run-old",
    repoPath: "/tmp/x",
    assignment: "a",
    state: "PLANNING",
    prdPath: null,
    planHash: null,
    integrationBranch: "harness/run-old",
    config: RunConfig.parse({ models }),
  });
  const row = store.db.prepare("SELECT config FROM runs WHERE id = ?").get("run-old") as { config: string };
  const stored = JSON.parse(row.config) as { models: Record<string, string> };
  delete stored.models.workerLight;
  store.db.prepare("UPDATE runs SET config = ? WHERE id = ?").run(JSON.stringify(stored), "run-old");
  store.db.close();
  return "run-old";
}

describe("a run created before the light tier existed", () => {
  it("keeps writing its code on the model it was planned on", () => {
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheLightTier(dbPath);

    // The resume.
    const store = new Store(dbPath);

    expect(store.getRun(runId)!.config.models.workerLight).toBe(SONNET);
    expect(store.getRun(runId)!.config.models.workerLight).not.toBe(HAIKU);
    cleanup();
  });

  it("follows whatever worker model that run actually named, not the default", () => {
    // A run pointed at another vendor is the case where taking the schema
    // default would be worst: it would move the light tier to Anthropic as
    // well as to a cheaper model.
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheLightTier(dbPath, { worker: "gpt-5.6-terra" });

    const store = new Store(dbPath);

    expect(store.getRun(runId)!.config.models.workerLight).toBe("gpt-5.6-terra");
    cleanup();
  });

  it("does not bake the new default in when something else patches the config", () => {
    // `patchRunConfig` re-parses and writes the whole config back, so a budget
    // raise on an old run was enough to make the change permanent.
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheLightTier(dbPath);

    const store = new Store(dbPath);
    store.patchRunConfig(runId, { workerMaxTurns: 200 });

    const stored = JSON.parse((store.db.prepare("SELECT config FROM runs WHERE id = ?").get(runId) as { config: string }).config);
    expect(stored.models.workerLight).toBe(SONNET);
    cleanup();
  });

  it("leaves a run that named its own light model alone", () => {
    const { dbPath, cleanup } = onDisk();
    const store = new Store(dbPath);
    store.createRun({
      id: "run-new",
      repoPath: "/tmp/x",
      assignment: "a",
      state: "PLANNING",
      prdPath: null,
      planHash: null,
      integrationBranch: "harness/run-new",
      config: RunConfig.parse({ models: { workerLight: HAIKU } }),
    });
    store.db.close();

    expect(new Store(dbPath).getRun("run-new")!.config.models.workerLight).toBe(HAIKU);
    cleanup();
  });

  it("falls back to the schema's worker when the stored config never named one", () => {
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheLightTier(dbPath);
    const store = new Store(dbPath);
    const stored = JSON.parse((store.db.prepare("SELECT config FROM runs WHERE id = ?").get(runId) as { config: string }).config);
    delete stored.models.worker;
    delete stored.models.workerLight;
    store.db.prepare("UPDATE runs SET config = ? WHERE id = ?").run(JSON.stringify(stored), runId);
    store.db.close();

    expect(new Store(dbPath).getRun(runId)!.config.models.workerLight).toBe(SONNET);
    cleanup();
  });

  it("steps over a config with no model table at all rather than inventing one", () => {
    const { dbPath, cleanup } = onDisk();
    const store = new Store(dbPath);
    store.db.prepare("INSERT INTO runs (id, repoPath, assignment, state, integrationBranch, config, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)")
      .run("run-bare", "/tmp/x", "a", "PLANNING", "b", "{}", 1, 1);
    store.db.close();

    // Nothing to freeze — it never expressed a preference, so it takes today's
    // defaults like any other unset field.
    expect(() => new Store(dbPath)).not.toThrow();
    expect(new Store(dbPath).getRun("run-bare")!.config.models.workerLight).toBe(HAIKU);
    cleanup();
  });

  it("survives being opened twice, and a config that is not what it should be", () => {
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheLightTier(dbPath);

    // A second open must not re-derive anything, and a row whose config is not
    // parseable JSON must not take the whole store down on the way past — the
    // migration runs in the constructor, so a throw here loses every run in the
    // database rather than the one bad row.
    const store = new Store(dbPath);
    store.db.prepare("INSERT INTO runs (id, repoPath, assignment, state, integrationBranch, config, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)")
      .run("run-broken", "/tmp/x", "a", "PLANNING", "b", "not json", 1, 1);
    store.db.close();

    expect(() => new Store(dbPath)).not.toThrow();
    expect(new Store(dbPath).getRun(runId)!.config.models.workerLight).toBe(SONNET);
    cleanup();
  });
});

describe("a run created today", () => {
  it("gets the light tier, because that is what it was priced with", () => {
    const { dbPath, cleanup } = onDisk();
    const store = new Store(dbPath);
    store.createRun({
      id: "run-today",
      repoPath: "/tmp/x",
      assignment: "a",
      state: "PLANNING",
      prdPath: null,
      planHash: null,
      integrationBranch: "harness/run-today",
      config: RunConfig.parse({}),
    });

    expect(store.getRun("run-today")!.config.models.workerLight).toBe(HAIKU);
    cleanup();
  });
});

/**
 * The other half of the same problem, and the more dangerous half.
 *
 * `workerLight` was a key that did not exist yet, so an old config was merely
 * *incomplete*. Pinning `reviewer` to Google made every old config *invalid*:
 * they all hold `reviewer: "claude-opus-5"`, which `ModelRouting` now refuses,
 * and `getRun` re-parses on every read. Without the migration the failure is not
 * "this run will not resume" but "this run cannot be read at all" — no ledger,
 * no postmortem, no dashboard row, for every run ever recorded.
 */
const OPUS = "claude-opus-5";
/* What the migration pins to: today's default, whatever that is. Written as the
   schema's own answer rather than as a literal because this file is about the
   migration, not about which Gemini is current — a literal here turns every
   reviewer upgrade into four unrelated test failures. */
const GEMINI = RunConfig.parse({}).models.reviewer;

/** Writes a run whose stored config names a reviewer today's schema refuses. */
function runFromBeforeTheReviewerPin(dbPath: string, reviewer: string | null = OPUS): string {
  const store = new Store(dbPath);
  store.createRun({
    id: "run-pre-pin",
    repoPath: "/tmp/x",
    assignment: "a",
    state: "PLANNING",
    prdPath: null,
    planHash: null,
    integrationBranch: "harness/run-pre-pin",
    config: RunConfig.parse({}),
  });
  // Written behind the schema's back, because the schema is what now refuses it
  // — which is the whole point: only rows already on disk can be in this state.
  const row = store.db.prepare("SELECT config FROM runs WHERE id = ?").get("run-pre-pin") as { config: string };
  const stored = JSON.parse(row.config) as { models: Record<string, string> };
  if (reviewer === null) delete stored.models.reviewer;
  else stored.models.reviewer = reviewer;
  store.db.prepare("UPDATE runs SET config = ? WHERE id = ?").run(JSON.stringify(stored), "run-pre-pin");
  store.db.close();
  return "run-pre-pin";
}

describe("a run created before the reviewer was pinned to Google", () => {
  it("stays readable, which is the thing the migration is actually protecting", () => {
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheReviewerPin(dbPath);

    // The resume. Before `freezeReviewer` this threw a ZodError.
    const store = new Store(dbPath);

    expect(() => store.getRun(runId)).not.toThrow();
    expect(store.getRun(runId)!.config.models.reviewer).toBe(GEMINI);
    cleanup();
  });

  it("keeps every other role exactly where that run had it", () => {
    // The migration moves one role. A run that had deliberately been put on a
    // cheap worker must not come back on the default one.
    const { dbPath, cleanup } = onDisk();
    const store0 = new Store(dbPath);
    store0.createRun({
      id: "run-pre-pin",
      repoPath: "/tmp/x",
      assignment: "a",
      state: "PLANNING",
      prdPath: null,
      planHash: null,
      integrationBranch: "harness/run-pre-pin",
      config: RunConfig.parse({ models: { worker: "gpt-5.6-terra", demo: HAIKU } }),
    });
    const row = store0.db.prepare("SELECT config FROM runs WHERE id = ?").get("run-pre-pin") as { config: string };
    const stored = JSON.parse(row.config) as { models: Record<string, string> };
    stored.models.reviewer = OPUS;
    store0.db.prepare("UPDATE runs SET config = ? WHERE id = ?").run(JSON.stringify(stored), "run-pre-pin");
    store0.db.close();

    const models = new Store(dbPath).getRun("run-pre-pin")!.config.models;
    expect(models.reviewer).toBe(GEMINI);
    expect(models.worker).toBe("gpt-5.6-terra");
    expect(models.demo).toBe(HAIKU);
    cleanup();
  });

  it("stamps a config too old to name a reviewer at all", () => {
    // Absent reads as today's default anyway; writing it down keeps the stored
    // config saying what the run is doing, which is `freezeLightTier`'s rule.
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheReviewerPin(dbPath, null);
    const store = new Store(dbPath);

    expect(store.getRun(runId)!.config.models.reviewer).toBe(GEMINI);
    const raw = JSON.parse((store.db.prepare("SELECT config FROM runs WHERE id = ?").get(runId) as { config: string }).config) as {
      models: Record<string, string>;
    };
    expect(raw.models.reviewer).toBe(GEMINI);
    cleanup();
  });

  it("leaves a row it cannot parse alone rather than taking the database down with it", () => {
    // This runs in the constructor. One corrupt row must not cost every other
    // run in the file, which is the rule `freezeLightTier` already follows.
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheReviewerPin(dbPath);
    const store0 = new Store(dbPath);
    store0.createRun({
      id: "run-corrupt",
      repoPath: "/tmp/x",
      assignment: "a",
      state: "PLANNING",
      prdPath: null,
      planHash: null,
      integrationBranch: "harness/run-corrupt",
      config: RunConfig.parse({}),
    });
    store0.db.prepare("UPDATE runs SET config = ? WHERE id = ?").run("{not json", "run-corrupt");
    store0.db.close();

    expect(() => new Store(dbPath)).not.toThrow();
    expect(new Store(dbPath).getRun(runId)!.config.models.reviewer).toBe(GEMINI);
    cleanup();
  });

  it("is idempotent, so reopening the store does not keep rewriting rows", () => {
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheReviewerPin(dbPath);
    new Store(dbPath).db.close();

    const store = new Store(dbPath);
    const after = (store.db.prepare("SELECT config FROM runs WHERE id = ?").get(runId) as { config: string }).config;
    new Store(dbPath).db.close();
    const again = (new Store(dbPath).db.prepare("SELECT config FROM runs WHERE id = ?").get(runId) as { config: string }).config;

    expect(again).toBe(after);
    cleanup();
  });

  it("moves a run frozen on a superseded Gemini onto the reviewer default", () => {
    // The case the vendor comparison could not see, and the one an operator
    // actually hits. `gemini-3.6-flash` and today's default are the same vendor,
    // so a run frozen on 3.6 kept it through every resume and the only way onto
    // the current reviewer was to retype `--model reviewer=…` on every resume
    // line for the rest of that run's life. A plain `harness resume` picks it up
    // now — which is the whole point of the migration, and was true of the
    // Anthropic→Google move only by accident of the vendor changing too.
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheReviewerPin(dbPath, "gemini-3.6-flash");

    expect(new Store(dbPath).getRun(runId)!.config.models.reviewer).toBe(GEMINI);
    cleanup();
  });

  it("reads the two spellings of the default as one model, so a prefixed row is left alone", () => {
    // `google/gemini-3.7-flash` and `gemini-3.7-flash` name the same model, and
    // a config written with the prefix must not be rewritten on every open —
    // that is a row churning in the database to say what it already said.
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheReviewerPin(dbPath, `google/${GEMINI}`);

    const raw = JSON.parse(
      (new Store(dbPath).db.prepare("SELECT config FROM runs WHERE id = ?").get(runId) as { config: string }).config
    ) as { models: Record<string, string> };
    expect(raw.models.reviewer).toBe(`google/${GEMINI}`);
    cleanup();
  });
});

/**
 * The same problem a third time, in the expensive direction.
 *
 * `workerUi` and `workerHeavy` are keys that did not exist, so an old config is
 * merely incomplete — but today's default for the heavy rung is a model at
 * twice the price of anything an old run agreed to, and a run parked over this
 * release would otherwise come back sending its rejected tasks there.
 */
const FABLE = RunConfig.parse({}).models.workerHeavy;
const OPUS_UI = RunConfig.parse({}).models.workerUi;

/** Writes a run whose stored config has had the two rungs removed. */
function runFromBeforeTheWorkerTiers(dbPath: string, models: Record<string, string> = {}, keep: string[] = []): string {
  const store = new Store(dbPath);
  store.createRun({
    id: "run-pre-rungs",
    repoPath: "/tmp/x",
    assignment: "a",
    state: "PLANNING",
    prdPath: null,
    planHash: null,
    integrationBranch: "harness/run-pre-rungs",
    config: RunConfig.parse({ models }),
  });
  const row = store.db.prepare("SELECT config FROM runs WHERE id = ?").get("run-pre-rungs") as { config: string };
  const stored = JSON.parse(row.config) as { models: Record<string, string> };
  for (const rung of ["workerUi", "workerHeavy"]) if (!keep.includes(rung)) delete stored.models[rung];
  store.db.prepare("UPDATE runs SET config = ? WHERE id = ?").run(JSON.stringify(stored), "run-pre-rungs");
  store.db.close();
  return "run-pre-rungs";
}

describe("a run created before the interface and heavy rungs existed", () => {
  it("keeps every rung on the model it was planned on", () => {
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheWorkerTiers(dbPath);

    const store = new Store(dbPath);
    const models = store.getRun(runId)!.config.models;
    expect(models.workerUi).toBe(SONNET);
    expect(models.workerHeavy).toBe(SONNET);
    store.db.close();
    cleanup();
  });

  it("follows that run's own worker rather than the default", () => {
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheWorkerTiers(dbPath, { worker: "gpt-5.6-terra" });

    const store = new Store(dbPath);
    const models = store.getRun(runId)!.config.models;
    expect(models.workerUi).toBe("gpt-5.6-terra");
    expect(models.workerHeavy).toBe("gpt-5.6-terra");
    store.db.close();
    cleanup();
  });

  it("leaves a rung the run named for itself alone, and fills only the missing one", () => {
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheWorkerTiers(dbPath, { workerHeavy: HAIKU }, ["workerHeavy"]);

    const store = new Store(dbPath);
    const models = store.getRun(runId)!.config.models;
    expect(models.workerHeavy).toBe(HAIKU);
    expect(models.workerUi).toBe(SONNET);
    store.db.close();
    cleanup();
  });

  it("is idempotent, so reopening the store does not keep rewriting rows", () => {
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheWorkerTiers(dbPath);

    const once = new Store(dbPath);
    const after1 = (once.db.prepare("SELECT config FROM runs WHERE id = ?").get(runId) as { config: string }).config;
    once.db.close();
    const twice = new Store(dbPath);
    const after2 = (twice.db.prepare("SELECT config FROM runs WHERE id = ?").get(runId) as { config: string }).config;
    twice.db.close();

    expect(after2).toBe(after1);
    cleanup();
  });

  it("steps over a config it cannot read, or one with no model table", () => {
    const { dbPath, cleanup } = onDisk();
    const runId = runFromBeforeTheWorkerTiers(dbPath);
    const raw = new Store(dbPath);
    raw.db.prepare("UPDATE runs SET config = ? WHERE id = ?").run("{not json", runId);
    raw.createRun({
      id: "run-no-models",
      repoPath: "/tmp/x",
      assignment: "a",
      state: "PLANNING",
      prdPath: null,
      planHash: null,
      integrationBranch: "harness/run-no-models",
      config: RunConfig.parse({}),
    });
    raw.db.prepare("UPDATE runs SET config = ? WHERE id = ?").run(JSON.stringify({ budget: { runCapUsd: 1 } }), "run-no-models");
    raw.db.close();

    // The constructor runs the migration; a throw here would take every run.
    const store = new Store(dbPath);
    expect((store.db.prepare("SELECT config FROM runs WHERE id = ?").get(runId) as { config: string }).config).toBe("{not json");
    expect(JSON.parse((store.db.prepare("SELECT config FROM runs WHERE id = ?").get("run-no-models") as { config: string }).config)).toEqual({ budget: { runCapUsd: 1 } });
    store.db.close();
    cleanup();
  });

  it("gives a run created today both rungs, because that is what it was priced with", () => {
    const { dbPath, cleanup } = onDisk();
    const store = new Store(dbPath);
    store.createRun({
      id: "run-today-rungs",
      repoPath: "/tmp/x",
      assignment: "a",
      state: "PLANNING",
      prdPath: null,
      planHash: null,
      integrationBranch: "harness/run-today-rungs",
      config: RunConfig.parse({}),
    });

    const models = store.getRun("run-today-rungs")!.config.models;
    expect(models.workerUi).toBe(OPUS_UI);
    expect(models.workerHeavy).toBe(FABLE);
    store.db.close();
    cleanup();
  });
});
