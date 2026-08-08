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
