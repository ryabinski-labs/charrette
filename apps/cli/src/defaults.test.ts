import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectChecks, loadFileConfig, resolveGitHub, resolveRepoRoot } from "./defaults.js";

function tmpRepo(files: Record<string, string> = {}, withGit = true): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-cli-"));
  if (withGit) mkdirSync(path.join(dir, ".git"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

describe("resolveRepoRoot", () => {
  it("walks up to the git root from a subdirectory", () => {
    const repo = tmpRepo({ "src/deep/file.ts": "" });
    expect(resolveRepoRoot(path.join(repo, "src", "deep"))).toBe(repo);
  });

  it("throws with actionable text outside a repo", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "harness-nogit-"));
    expect(() => resolveRepoRoot(dir)).toThrow(/not inside a git repository/);
  });
});

describe("detectChecks", () => {
  it("picks conventional npm scripts and the lockfile's package manager", () => {
    const repo = tmpRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", build: "tsc" } }),
      "pnpm-lock.yaml": "",
    });
    expect(detectChecks(repo).checks).toEqual(["pnpm run lint", "pnpm run test"]);
  });

  it("never runs both typecheck and type-check", () => {
    const repo = tmpRepo({
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc --noEmit", "type-check": "tsc --noEmit" } }),
    });
    expect(detectChecks(repo).checks).toEqual(["npm run typecheck"]);
  });

  it("falls back to cargo, then reports nothing found", () => {
    expect(detectChecks(tmpRepo({ "Cargo.toml": "" })).checks[0]).toBe("cargo test");
    expect(detectChecks(tmpRepo()).checks).toEqual([]);
  });
});

describe("loadFileConfig", () => {
  it("returns empty config when the file is absent", () => {
    expect(loadFileConfig(tmpRepo())).toEqual({ config: {}, path: null });
  });

  it("parses a valid config", () => {
    const repo = tmpRepo({ "harness.config.json": JSON.stringify({ budget: { runCapUsd: 50 }, dashboard: false }) });
    expect(loadFileConfig(repo).config).toEqual({ budget: { runCapUsd: 50 }, dashboard: false });
  });

  it("rejects unknown keys rather than ignoring them", () => {
    const repo = tmpRepo({ "harness.config.json": JSON.stringify({ runCapUsd: 50 }) });
    expect(() => loadFileConfig(repo)).toThrow(/is invalid/);
  });

  it("reports malformed JSON with the file path", () => {
    const repo = tmpRepo({ "harness.config.json": "{ nope" });
    expect(() => loadFileConfig(repo)).toThrow(/not valid JSON/);
  });
});

describe("detectChecks in monorepo layouts", () => {
  it("finds checks in frontend/ when the repo root has no package.json", () => {
    const repo = tmpRepo();
    mkdirSync(path.join(repo, "frontend"));
    writeFileSync(
      path.join(repo, "frontend", "package.json"),
      JSON.stringify({ scripts: { dev: "vite", build: "vite build", typecheck: "vue-tsc" } })
    );
    writeFileSync(path.join(repo, "frontend", "pnpm-lock.yaml"), "");
    const { checks, source } = detectChecks(repo);
    expect(checks).toEqual(["cd frontend && pnpm run typecheck"]);
    expect(source).toMatch(/frontend\/package\.json/);
  });

  it("prefers the repo root over a subdirectory", () => {
    const repo = tmpRepo();
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    mkdirSync(path.join(repo, "frontend"));
    writeFileSync(path.join(repo, "frontend", "package.json"), JSON.stringify({ scripts: { lint: "eslint" } }));
    expect(detectChecks(repo).checks).toEqual(["npm run test"]);
  });

  it("still reports none when a subdirectory has no useful scripts", () => {
    const repo = tmpRepo();
    mkdirSync(path.join(repo, "frontend"));
    writeFileSync(path.join(repo, "frontend", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    expect(detectChecks(repo).checks).toEqual([]);
  });
});

describe("resolveGitHub", () => {
  const saved = { token: process.env.GITHUB_TOKEN, repo: process.env.HARNESS_GITHUB_REPO };
  afterEach(() => {
    for (const [k, v] of [["GITHUB_TOKEN", saved.token], ["HARNESS_GITHUB_REPO", saved.repo]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("takes the environment when it is set, without shelling out to gh", () => {
    process.env.GITHUB_TOKEN = "ghp_from_env";
    process.env.HARNESS_GITHUB_REPO = "acme/widgets";
    const gh = resolveGitHub(tmpRepo(), undefined);
    expect(gh).toEqual({
      token: "ghp_from_env",
      slug: "acme/widgets",
      source: "GITHUB_TOKEN + HARNESS_GITHUB_REPO",
    });
  });

  it("names both sources when the token and the slug come from different places", () => {
    process.env.GITHUB_TOKEN = "ghp_from_env";
    delete process.env.HARNESS_GITHUB_REPO;
    const gh = resolveGitHub(tmpRepo(), "acme/widgets");
    expect(gh.slug).toBe("acme/widgets");
    expect(gh.source).toBe("GITHUB_TOKEN + harness.config.json");
  });

  it("withholds the slug when there is no token, so the adapter stays disabled", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.HARNESS_GITHUB_REPO;
    // A directory that is not a GitHub checkout: `gh repo view` cannot answer.
    const gh = resolveGitHub(tmpRepo(), undefined);
    if (!gh.token) {
      expect(gh.slug).toBeUndefined();
      expect(gh.source).toMatch(/^off — /);
    } else {
      // gh is logged in on this machine; the token is real but the repo is not.
      expect(gh.slug).toBeUndefined();
      expect(gh.source).toBe("off — no GitHub remote found for this repo");
    }
  });

  it("never puts the token in the provenance string", () => {
    process.env.GITHUB_TOKEN = "ghp_supersecret";
    process.env.HARNESS_GITHUB_REPO = "acme/widgets";
    expect(resolveGitHub(tmpRepo(), undefined).source).not.toContain("ghp_supersecret");
  });
});
