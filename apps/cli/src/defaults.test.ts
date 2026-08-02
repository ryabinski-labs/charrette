import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

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

  it("builds as well as tests a Go module, since a Go test run does not compile every package", () => {
    const detected = detectChecks(tmpRepo({ "go.mod": "module example.com/api\n\ngo 1.23\n" }));

    expect(detected).toEqual({ checks: ["go build ./...", "go test ./..."], source: "go.mod" });
  });

  it("names why it found nothing, so the banner can say it", () => {
    expect(detectChecks(tmpRepo()).source).toBe("no conventional checks found");
  });

  const PKG = JSON.stringify({ scripts: { test: "vitest run" } });

  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ])("runs the scripts with the package manager %s implies", (lockfile, pm) => {
    const repo = tmpRepo({ "package.json": PKG, [lockfile]: "" });

    expect(detectChecks(repo).checks).toEqual([`${pm} run test`]);
  });

  it("assumes npm when there is no lockfile at all", () => {
    expect(detectChecks(tmpRepo({ "package.json": PKG })).checks).toEqual(["npm run test"]);
  });

  it("ignores a package.json whose JSON is valid but is not an object", () => {
    // `JSON.parse` succeeds here, so the try/catch does not catch it — without
    // the type check this would read `.scripts` off a number and throw.
    expect(detectChecks(tmpRepo({ "package.json": "42" })).checks).toEqual([]);
  });

  it("ignores a package.json with no scripts block", () => {
    expect(detectChecks(tmpRepo({ "package.json": JSON.stringify({ name: "x" }) })).checks).toEqual([]);
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

  /**
   * The schema is `.strict()`, so a knob that exists in `RunConfig` but not here
   * is not merely undocumented — declaring it makes the whole file throw. Every
   * one of these shipped that way: settable in the type, unsettable by a person.
   */
  it("accepts the knobs that decide who works on what", () => {
    const declared = {
      workerMaxTurns: 200,
      skillRouting: [{ when: "\\b(payments|billing)\\b", skills: ["fintech-reviewer"] }],
      roleSkills: { planner: ["product-manager"], qa: ["security-engineer"] },
    };
    const repo = tmpRepo({ "harness.config.json": JSON.stringify(declared) });
    expect(loadFileConfig(repo).config).toEqual(declared);
  });

  it("still rejects a routing rule that is not one", () => {
    const repo = tmpRepo({ "harness.config.json": JSON.stringify({ skillRouting: [{ when: "x" }] }) });
    expect(() => loadFileConfig(repo)).toThrow(/is invalid/);
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

  /**
   * The regression: the loop returned at the first subproject it found, so a
   * repo with both halves got checks for whichever came first in the list and
   * none at all for the other — QA's only hard signal, silently covering half
   * the product.
   */
  it("collects every subproject, not just the first one found", () => {
    const repo = tmpRepo();
    for (const [dir, scripts] of [
      ["frontend", { typecheck: "vue-tsc", test: "vitest" }],
      ["backend", { lint: "golangci-lint run", test: "go test ./..." }],
    ] as const) {
      mkdirSync(path.join(repo, dir));
      writeFileSync(path.join(repo, dir, "package.json"), JSON.stringify({ scripts }));
    }
    const { checks, source } = detectChecks(repo);
    expect(checks).toEqual([
      "cd frontend && npm run typecheck",
      "cd frontend && npm run test",
      "cd backend && npm run lint",
      "cd backend && npm run test",
    ]);
    expect(source).toContain("frontend/package.json");
    expect(source).toContain("backend/package.json");
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

  /**
   * `gh` is stubbed rather than shelled out to. What this function returns
   * otherwise depends on whether the developer running the suite happens to be
   * logged into the GitHub CLI — which made the "no token" case untestable on a
   * logged-in machine and would have had CI, where gh is absent, exercising a
   * different path than anyone had ever run locally.
   */
  function ghSays(answers: { token?: string; slug?: string }): void {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const wanted = args[0] === "auth" ? answers.token : answers.slug;
      if (wanted === undefined) throw new Error("gh: not authenticated");
      return `${wanted}\n`;
    });
  }

  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

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
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("names both sources when the token and the slug come from different places", () => {
    process.env.GITHUB_TOKEN = "ghp_from_env";
    delete process.env.HARNESS_GITHUB_REPO;
    const gh = resolveGitHub(tmpRepo(), "acme/widgets");
    expect(gh.slug).toBe("acme/widgets");
    expect(gh.source).toBe("GITHUB_TOKEN + harness.config.json");
  });

  it("falls back to the gh CLI for both, and names it once", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.HARNESS_GITHUB_REPO;
    ghSays({ token: "ghp_from_cli", slug: "acme/from-cli" });

    expect(resolveGitHub(tmpRepo(), undefined)).toEqual({
      token: "ghp_from_cli",
      slug: "acme/from-cli",
      source: "gh cli",
    });
  });

  it("says how to fix it when nothing has authenticated", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.HARNESS_GITHUB_REPO;
    ghSays({});

    const gh = resolveGitHub(tmpRepo(), undefined);

    expect(gh.token).toBeUndefined();
    expect(gh.slug).toBeUndefined();
    expect(gh.source).toBe("off — no GITHUB_TOKEN and `gh auth login` has not been run");
  });

  it("withholds the slug when there is a token but no remote, so the adapter stays disabled", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.HARNESS_GITHUB_REPO;
    ghSays({ token: "ghp_from_cli" });

    const gh = resolveGitHub(tmpRepo(), undefined);

    expect(gh.token).toBe("ghp_from_cli");
    expect(gh.slug).toBeUndefined();
    expect(gh.source).toBe("off — no GitHub remote found for this repo");
  });

  it("caches per repo, so gh is not shelled out to twice for the same answer", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.HARNESS_GITHUB_REPO;
    ghSays({ token: "ghp_from_cli", slug: "acme/from-cli" });
    const repo = tmpRepo();

    const first = resolveGitHub(repo, undefined);
    const callsAfterFirst = execFileSyncMock.mock.calls.length;
    const second = resolveGitHub(repo, undefined);

    expect(second).toEqual(first);
    expect(execFileSyncMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("does not serve a cached answer to a caller whose environment has changed", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.HARNESS_GITHUB_REPO;
    ghSays({ token: "ghp_from_cli", slug: "acme/from-cli" });
    const repo = tmpRepo();
    expect(resolveGitHub(repo, undefined).token).toBe("ghp_from_cli");

    process.env.GITHUB_TOKEN = "ghp_from_env";

    expect(resolveGitHub(repo, undefined).source).toBe("GITHUB_TOKEN + gh cli");
  });

  it("treats an empty answer from gh as no answer", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.HARNESS_GITHUB_REPO;
    // `gh auth token` exits 0 with an empty line in some logged-out states;
    // an empty string is not a token.
    execFileSyncMock.mockReturnValue("  \n");

    expect(resolveGitHub(tmpRepo(), undefined).token).toBeUndefined();
  });

  it("never puts the token in the provenance string", () => {
    process.env.GITHUB_TOKEN = "ghp_supersecret";
    process.env.HARNESS_GITHUB_REPO = "acme/widgets";
    expect(resolveGitHub(tmpRepo(), undefined).source).not.toContain("ghp_supersecret");
  });
});
