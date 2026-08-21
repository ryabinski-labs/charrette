import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import { detectChecks, loadFileConfig, resolveGitHub, resolveRepoRoot, verifyChecks } from "./defaults.js";

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

    expect(detected).toEqual({ checks: ["go build ./...", "go test ./..."], source: "go.mod", skipped: [] });
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

  it("accepts who answers a task that hits its cap", () => {
    // Same trap as above: a knob only settable in the type is not settable.
    // `decidedBy: "operator"` is the whole opt-out from the harness answering
    // its own escalations, and it has to be writable in the file that opts out.
    const declared = { taskGate: { decidedBy: "operator" as const }, pitStop: { decidedBy: "operator" as const } };
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

const PR_WORKFLOW = (jobs: string) => `name: CI\non:\n  pull_request:\njobs:\n${jobs}`;

describe("checks taken from the repository's own pipeline", () => {
  it("prefers what CI runs over what the language implies", () => {
    // The two are not equivalent. `Cargo.toml` implies `cargo test`; this
    // repo's CI also refuses unformatted code and unlicensed dependencies, and
    // those are the failures a human was reading off pull requests.
    const repo = tmpRepo({
      "Cargo.toml": "",
      ".github/workflows/ci.yml": PR_WORKFLOW(
        "  fmt:\n    steps:\n      - run: cargo fmt --all --check\n  deny:\n    steps:\n      - run: cargo deny check\n"
      ),
    });
    expect(detectChecks(repo).checks).toEqual(["cargo fmt --all --check", "cargo deny check", "cargo test", "cargo clippy -- -D warnings"]);
  });

  it("does not pay twice for one answer when CI already covers the tool and verb", () => {
    const repo = tmpRepo({
      "Cargo.toml": "",
      ".github/workflows/ci.yml": PR_WORKFLOW("  t:\n    steps:\n      - run: cargo test --workspace --all-features --locked\n"),
    });
    expect(detectChecks(repo).checks).toEqual(["cargo test --workspace --all-features --locked", "cargo clippy -- -D warnings"]);
  });

  it("names the pipeline in the provenance the banner prints", () => {
    const repo = tmpRepo({
      "Cargo.toml": "",
      ".github/workflows/ci.yml": PR_WORKFLOW("  t:\n    steps:\n      - run: cargo test\n"),
    });
    expect(detectChecks(repo).source).toContain("CI workflow");
  });

  it("carries what it could not lift, so the gap is visible rather than silent", () => {
    const repo = tmpRepo({
      "Cargo.toml": "",
      ".github/workflows/ci.yml": PR_WORKFLOW("  t:\n    steps:\n      - run: cargo test\n      - run: rustup show\n"),
    });
    expect(detectChecks(repo).skipped.map((s) => s.reason)).toEqual([expect.stringContaining("not a known verification command")]);
  });

  it("falls back to the language when the repo has no workflows at all", () => {
    const repo = tmpRepo({ "Cargo.toml": "" });
    expect(detectChecks(repo).checks).toEqual(["cargo test", "cargo clippy -- -D warnings"]);
    expect(detectChecks(repo).source).toBe("Cargo.toml");
  });

  it("adds nothing from convention when CI already covers every tool and verb", () => {
    const repo = tmpRepo({
      "Cargo.toml": "",
      ".github/workflows/ci.yml": PR_WORKFLOW(
        "  t:\n    steps:\n      - run: cargo test --locked\n      - run: cargo clippy --all-targets -- -D warnings\n"
      ),
    });
    const detected = detectChecks(repo);
    expect(detected.checks).toEqual(["cargo test --locked", "cargo clippy --all-targets -- -D warnings"]);
    expect(detected.source).not.toContain("plus");
  });

  it("tells a subproject's script apart from the same script at the root", () => {
    const repo = tmpRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
      ".github/workflows/ci.yml": PR_WORKFLOW("  site:\n    steps:\n      - working-directory: site\n        run: npm run test\n"),
    });
    // `cd site && npm run test` is not the root suite, so the root suite stays.
    expect(detectChecks(repo).checks).toEqual(["cd site && npm run test", "npm run test"]);
  });

  it("carries on past a workflow path it cannot read", () => {
    const repo = tmpRepo({ "Cargo.toml": "" });
    mkdirSync(path.join(repo, ".github", "workflows", "broken.yml"), { recursive: true });
    writeFileSync(path.join(repo, ".github", "workflows", "ci.yml"), PR_WORKFLOW("  t:\n    steps:\n      - run: cargo test\n"));
    expect(detectChecks(repo).checks).toEqual(["cargo test", "cargo clippy -- -D warnings"]);
  });

  it("falls back when every workflow is a nightly one no pull request has to satisfy", () => {
    const repo = tmpRepo({
      "Cargo.toml": "",
      ".github/workflows/nightly.yml": 'name: N\non:\n  schedule:\n    - cron: "0 3 * * *"\njobs:\n  t:\n    steps:\n      - run: cargo test\n',
    });
    expect(detectChecks(repo).source).toBe("Cargo.toml");
  });
});

describe("proving a check can pass here before adopting it", () => {
  // These have to really run: the whole claim is that a check was watched to
  // pass on this machine, and a mocked `execFileSync` that returns for
  // everything would let the suite prove it while proving nothing.
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    execFileSyncMock.mockImplementation(actual.execFileSync as never);
  });

  it("keeps one that passes", () => {
    expect(verifyChecks(tmpRepo(), ["exit 0"]).kept).toEqual(["exit 0"]);
  });

  it("drops one that fails, and says what it said", () => {
    // `cargo deny` lifted out of a workflow whose `cargo install` step was
    // correctly refused as setup. Adopted unproven it is red in every worktree,
    // and a check red before any task starts parks the whole run.
    const { kept, dropped } = verifyChecks(tmpRepo(), ["echo 'command not found: cargo-deny' >&2; exit 127"]);
    expect(kept).toEqual([]);
    expect(dropped[0]!.reason).toContain("command not found");
  });

  it("names the command when a failure said nothing at all, rather than handing over a blank reason", () => {
    expect(verifyChecks(tmpRepo(), ["exit 1"]).dropped[0]!.reason).toContain("exit 1");
  });

  it("drops one that outlives the time QA would give it, since it would be killed on every task", () => {
    const { dropped } = verifyChecks(tmpRepo(), ["sleep 5"], { timeoutMs: 200 });
    expect(dropped[0]!.reason).toContain("did not finish");
    // Names the fix, because the drop is only correct while the ceiling is. A
    // suite honestly slower than this one is not a check to abandon — it is a
    // ceiling to raise, and the operator's config is the only place to raise it.
    expect(dropped[0]!.reason).toContain("Raise deterministicCheckTimeoutMinutes");
  });

  it("judges each one on its own, so a broken check does not take the rest with it", () => {
    const { kept, dropped } = verifyChecks(tmpRepo(), ["exit 1", "exit 0"]);
    expect(kept).toEqual(["exit 0"]);
    expect(dropped).toHaveLength(1);
  });

  it("reports a check it could not even start, rather than crashing the command", () => {
    // No stdout and no stderr to quote: the process never existed. The error
    // itself is the only thing there is to say.
    const { kept, dropped } = verifyChecks(path.join(tmpRepo(), "gone"), ["exit 0"]);
    expect(kept).toEqual([]);
    expect(dropped[0]!.reason).not.toBe("");
  });

  it("quotes the failure rather than a warning that happened to come first", () => {
    const { dropped } = verifyChecks(tmpRepo(), ["echo 'warning: unused import' >&2; echo 'error: the real one' >&2; exit 1"]);
    expect(dropped[0]!.reason).toBe("error: the real one");
  });

  /**
   * The reason `cargo test --workspace --all-features` was dropped from waf's
   * config was `running 6 tests` — the first line a test binary prints, and
   * true of every run of it that ever passed. An operator reading that cannot
   * tell whether the check is broken or the tree is, which is the only thing
   * the line is there to tell them. The failure is hundreds of lines further
   * down, past every test that passed.
   */
  it("quotes the line that says what failed, not the line the runner opened with", () => {
    const { dropped } = verifyChecks(tmpRepo(), [
      "echo 'running 6 tests'; echo 'test parses_a_rule ... ok'; echo 'test blocks_a_request ... FAILED'; exit 1",
    ]);
    expect(dropped[0]!.reason).toBe("test blocks_a_request ... FAILED");
  });

  it("quotes the error a compiler stopped on, not the tally it printed after", () => {
    // First rather than last: `error[E0308]` names the thing to go and fix,
    // where `could not compile` names only that it happened.
    const { dropped } = verifyChecks(tmpRepo(), [
      "echo 'Compiling revetment-core v0.1.0'; echo 'error[E0308]: mismatched types' >&2; echo 'error: could not compile due to 1 previous error' >&2; exit 101",
    ]);
    expect(dropped[0]!.reason).toBe("error[E0308]: mismatched types");
  });

  it("falls back to the opening line when nothing in the output reads as a diagnosis", () => {
    // A check can fail without ever saying so in words this recognises. The
    // opening line is then the only thing there is, and it beats a blank.
    const { dropped } = verifyChecks(tmpRepo(), ["echo 'something went sideways'; exit 3"]);
    expect(dropped[0]!.reason).toBe("something went sideways");
  });

  it("does not mistake a lower-case failure in prose for the diagnosis", () => {
    // `FAILED` and `FAIL` are shouted by cargo, go, jest and vitest. A
    // lower-case one is usually a test name or a log line, and picking it
    // would put the wrong line in front of the operator.
    const { dropped } = verifyChecks(tmpRepo(), [
      "echo 'test handles_a_failed_lookup ... ok'; echo 'error: the real one' >&2; exit 1",
    ]);
    expect(dropped[0]!.reason).toBe("error: the real one");
  });

  it("tells the caller what it is running, for a suite that takes minutes", () => {
    const started: string[] = [];
    const finished: (string | null)[] = [];
    verifyChecks(tmpRepo(), ["exit 0"], { onStart: (c) => started.push(c), onResult: (_c, _ms, reason) => finished.push(reason) });
    expect(started).toEqual(["exit 0"]);
    expect(finished).toEqual([null]);
  });

  it("runs them in the repository, not wherever the CLI was invoked", () => {
    const repo = tmpRepo({ "marker.txt": "" });
    expect(verifyChecks(repo, ["test -f marker.txt"]).kept).toEqual(["test -f marker.txt"]);
  });
});
