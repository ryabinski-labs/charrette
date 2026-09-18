import { describe, expect, it } from "vitest";
import { scanCiChecks } from "./ciChecks.js";

/** A workflow, indented the way one is actually written. */
function wf(text: string, path = ".github/workflows/ci.yml") {
  return [{ path, text }];
}

function commands(text: string): string[] {
  return scanCiChecks(wf(text)).checks.map((c) => c.command);
}

function reason(text: string): string {
  return scanCiChecks(wf(text)).skipped.map((s) => s.reason).join(" | ");
}

const PR = `name: CI
on:
  pull_request:
jobs:
`;

describe("reading a repository's own pipeline as a list of commands", () => {
  it("lifts the command a check step runs", () => {
    expect(
      commands(`${PR}  test:
    steps:
      - name: cargo test
        run: cargo test --workspace --locked
`)
    ).toEqual(["cargo test --workspace --locked"]);
  });

  it("says where each one came from, because the operator has to be able to check it", () => {
    const scan = scanCiChecks(
      wf(`${PR}  lint:
    steps:
      - name: cargo clippy
        run: cargo clippy -- -D warnings
`)
    );
    expect(scan.checks[0]!.source).toBe("ci.yml › lint › cargo clippy");
  });

  it("keeps the repository's own order across files, jobs and steps", () => {
    const scan = scanCiChecks([
      { path: ".github/workflows/supply-chain.yml", text: `${PR}  deny:\n    steps:\n      - run: cargo deny check\n` },
      { path: ".github/workflows/ci.yml", text: `${PR}  test:\n    steps:\n      - run: cargo test\n      - run: cargo build\n` },
    ]);
    expect(scan.checks.map((c) => c.command)).toEqual(["cargo test", "cargo build", "cargo deny check"]);
  });

  it("does not run the same command twice because two workflows both wanted it", () => {
    const scan = scanCiChecks([
      { path: ".github/workflows/a.yml", text: `${PR}  x:\n    steps:\n      - run: cargo test\n` },
      { path: ".github/workflows/b.yml", text: `${PR}  y:\n    steps:\n      - run: cargo test\n` },
    ]);
    expect(scan.checks).toHaveLength(1);
  });

  it("reads a block scalar, which is how most steps are written", () => {
    expect(
      commands(`${PR}  test:
    steps:
      - run: |
          cargo test --all-features
`)
    ).toEqual(["cargo test --all-features"]);
  });

  it("passes over the error handling a script opens with", () => {
    expect(
      commands(`${PR}  test:
    steps:
      - run: |
          set -euo pipefail
          cargo test
`)
    ).toEqual(["cargo test"]);
  });

  it("joins a command wrapped across lines with backslashes, rather than counting the wraps", () => {
    // Run bc691359's clippy and coverage steps are both this shape. Read as
    // separate lines they are refused, and the two checks with the most to say
    // about that repository are the two the charrette never runs.
    expect(
      commands(`${PR}  lint:
    steps:
      - run: |
          cargo clippy --workspace --all-targets \\
            --all-features --locked -- -D warnings
`)
    ).toEqual(["cargo clippy --workspace --all-targets --all-features --locked -- -D warnings"]);
  });
});

describe("what it refuses to lift, and why it says so out loud", () => {
  it("refuses a multi-line script, because deciding a shell program is safe is not something this can do", () => {
    expect(
      reason(`${PR}  fmt:
    steps:
      - run: |
          packages=$(cargo metadata --no-deps)
          cargo fmt --check
`)
    ).toContain("only a single command");
  });

  it("refuses the setup CI needs and a worktree already has", () => {
    const text = `${PR}  test:
    steps:
      - run: rustup show
      - run: cargo install cargo-deny --locked
      - run: npm ci
`;
    expect(commands(text)).toEqual([]);
    expect(reason(text)).toContain("not a known verification command");
  });

  it("refuses a step that reads an Actions expression, since it has no value outside a runner", () => {
    expect(
      reason(`${PR}  test:
    steps:
      - run: cargo test --features \${{ matrix.features }}
`)
    ).toContain("Actions expression");
  });

  it("refuses a step chained onto something else rather than lifting half of it", () => {
    expect(
      reason(`${PR}  build:
    steps:
      - run: npm ci --prefix ui && npm run --prefix ui build
`)
    ).toContain("pipes, chains or redirects");
  });

  it("refuses a step that only runs under a condition, because it is not part of every build", () => {
    expect(
      reason(`${PR}  test:
    steps:
      - name: cargo test
        if: github.event_name == 'push'
        run: cargo test
`)
    ).toContain("`if:` condition");
  });

  it("says nothing at all about a step with no command in it", () => {
    // An action — checkout, cache, upload. A skip list padded with every
    // `uses:` in the file is one nobody reads.
    const scan = scanCiChecks(`${PR}  test:
    steps:
      - uses: actions/checkout@v4
      - run: cargo test
`.split("|").map((text) => ({ path: ".github/workflows/ci.yml", text })));
    expect(scan.skipped).toEqual([]);
    expect(scan.checks).toHaveLength(1);
  });
});

describe("a formatter is only a check when it is told to report", () => {
  it("lifts `cargo fmt --check`", () => {
    expect(commands(`${PR}  fmt:\n    steps:\n      - run: cargo fmt --all --check\n`)).toEqual(["cargo fmt --all --check"]);
  });

  it("refuses `cargo fmt`, which edits the very worktree QA is about to read", () => {
    expect(reason(`${PR}  fmt:\n    steps:\n      - run: cargo fmt --all\n`)).toContain("would rewrite the tree");
  });

  it("refuses `prettier --write` and lifts `prettier --check`", () => {
    expect(reason(`${PR}  fmt:\n    steps:\n      - run: prettier --write .\n`)).toContain("would rewrite the tree");
    expect(commands(`${PR}  fmt:\n    steps:\n      - run: prettier --check .\n`)).toEqual(["prettier --check ."]);
  });

  it("refuses `eslint --fix`", () => {
    expect(reason(`${PR}  lint:\n    steps:\n      - run: eslint --fix src\n`)).toContain("would rewrite the tree");
  });
});

describe("resolving the workflow's own variables, or refusing to guess", () => {
  it("substitutes a value the workflow defines", () => {
    expect(
      commands(`name: CI
on:
  pull_request:
env:
  VENDOR: some-vendored-crate
jobs:
  lint:
    steps:
      - run: cargo clippy --workspace --exclude "$VENDOR" -- -D warnings
`)
    ).toEqual(['cargo clippy --workspace --exclude "some-vendored-crate" -- -D warnings']);
  });

  it("handles the braced spelling too", () => {
    expect(
      commands(`name: CI
on:
  pull_request:
env:
  FLOOR: "75"
jobs:
  cov:
    steps:
      - run: cargo llvm-cov --fail-under-lines \${FLOOR}
`)
    ).toEqual(["cargo llvm-cov --fail-under-lines 75"]);
  });

  it("refuses a variable it cannot resolve rather than substituting nothing for something", () => {
    // The dangerous one. `cargo clippy --exclude ""` is not a narrower version
    // of the check — it is a different check, red in every worktree, and a
    // check that is red before any task starts parks the whole run.
    expect(reason(`${PR}  lint:\n    steps:\n      - run: cargo clippy --exclude "$VENDOR" -- -D warnings\n`)).toContain(
      "does not define"
    );
  });
});

describe("running a step where CI runs it", () => {
  it("carries a step's own working directory", () => {
    expect(
      commands(`${PR}  site:
    steps:
      - name: build
        working-directory: site
        run: npm run build
`)
    ).toEqual(["cd site && npm run build"]);
  });

  it("carries the job's default working directory to every step that has none", () => {
    expect(
      commands(`${PR}  site:
    defaults:
      run:
        working-directory: ./site
    steps:
      - run: npm run test
      - run: npm run build
`)
    ).toEqual(["cd site && npm run test", "cd site && npm run build"]);
  });

  it("does not prefix a directory that is the repo root", () => {
    expect(
      commands(`${PR}  x:
    defaults:
      run:
        working-directory: .
    steps:
      - run: cargo test
`)
    ).toEqual(["cargo test"]);
  });
});

describe("which workflows get read at all", () => {
  it("reads one that judges a pull request", () => {
    expect(commands(`${PR}  t:\n    steps:\n      - run: cargo test\n`)).toEqual(["cargo test"]);
  });

  it("reads one that gates the default branch, since the run's pull request merges into it", () => {
    expect(
      commands(`name: CI
on:
  push:
    branches: [main]
jobs:
  t:
    steps:
      - run: cargo test
`)
    ).toEqual(["cargo test"]);
  });

  it("reads the shorthand form", () => {
    expect(commands("on: [push, pull_request]\njobs:\n  t:\n    steps:\n      - run: cargo test\n")).toEqual(["cargo test"]);
  });

  it("passes over a nightly job, whose verdict no pull request has to satisfy", () => {
    expect(
      scanCiChecks(
        wf(`name: Nightly
on:
  schedule:
    - cron: "0 3 * * *"
jobs:
  t:
    steps:
      - run: cargo test
`)
      )
    ).toEqual({ checks: [], skipped: [] });
  });

  it("passes over a hand-launched one", () => {
    expect(commands("on:\n  workflow_dispatch:\njobs:\n  t:\n    steps:\n      - run: cargo test\n")).toEqual([]);
  });

  it("passes over a push workflow aimed at some other branch", () => {
    expect(
      commands(`on:
  push:
    branches: [release]
jobs:
  t:
    steps:
      - run: cargo test
`)
    ).toEqual([]);
  });

  it("is not talked out of a reading by a comment", () => {
    expect(
      commands(`${PR}  t:
    steps:
      # run: cargo publish
      - run: cargo test
`)
    ).toEqual(["cargo test"]);
  });

  it("returns nothing for a repository with no workflows", () => {
    expect(scanCiChecks([])).toEqual({ checks: [], skipped: [] });
  });
});

describe("the shapes a workflow file actually comes in", () => {
  it("reads a branch list written as a block sequence", () => {
    expect(
      commands(`on:
  push:
    branches:
      - main
      - release
jobs:
  t:
    steps:
      - run: cargo test
`)
    ).toEqual(["cargo test"]);
  });

  it("reads a push trigger with no branch filter as covering the default branch", () => {
    expect(commands("on:\n  push:\njobs:\n  t:\n    steps:\n      - run: cargo test\n")).toEqual(["cargo test"]);
  });

  it("passes over a shorthand trigger that fires on neither", () => {
    expect(commands("on: [workflow_dispatch]\njobs:\n  t:\n    steps:\n      - run: cargo test\n")).toEqual([]);
  });

  it("passes over a file with no trigger at all", () => {
    expect(commands("jobs:\n  t:\n    steps:\n      - run: cargo test\n")).toEqual([]);
  });

  it("passes over a file with no jobs at all", () => {
    expect(scanCiChecks(wf("name: CI\non:\n  pull_request:\n"))).toEqual({ checks: [], skipped: [] });
  });

  it("passes over a jobs key with nothing under it", () => {
    expect(scanCiChecks(wf(`${PR}`))).toEqual({ checks: [], skipped: [] });
  });

  it("reports a step that is nothing but error handling as having no command", () => {
    expect(reason(`${PR}  t:\n    steps:\n      - run: |\n          set -euo pipefail\n`)).toBe("no command");
  });

  it("keeps a wrapped command's continuation indented when a blank line sits inside the script", () => {
    expect(
      reason(`${PR}  t:
    steps:
      - run: |
          cargo test

          cargo build
`)
    ).toContain("2-line shell script");
  });

  it("passes over a job with no steps", () => {
    expect(commands(`${PR}  t:\n    runs-on: ubuntu-latest\n`)).toEqual([]);
  });

  it("passes over a steps list with nothing in it", () => {
    expect(commands(`${PR}  t:\n    steps:\n      []\n`)).toEqual([]);
  });

  it("passes over an empty block scalar rather than reporting a gap for it", () => {
    expect(scanCiChecks(wf(`${PR}  t:\n    steps:\n      - run: |\n      - run: cargo test\n`)).skipped).toEqual([]);
  });

  it("names a step by its command when the step has no name", () => {
    expect(scanCiChecks(wf(`${PR}  t:\n    steps:\n      - run: rustup show\n`)).skipped[0]!.source).toContain("rustup show");
  });

  it("keeps reading a job after a blank line inside it", () => {
    expect(
      commands(`${PR}  t:
    steps:
      - run: cargo test

      - run: cargo build
`)
    ).toEqual(["cargo test", "cargo build"]);
  });

  it("does not read a nested key as another job", () => {
    expect(
      commands(`${PR}  t:
    strategy:
      matrix:
        os: [ubuntu-latest]
    steps:
      - run: cargo test
`)
    ).toEqual(["cargo test"]);
  });

  it("takes a job's defaults block that names no run directory as naming none", () => {
    expect(commands(`${PR}  t:\n    defaults:\n      shell: bash\n    steps:\n      - run: cargo test\n`)).toEqual(["cargo test"]);
  });

  it("lets a step's own directory win over the job's", () => {
    expect(
      commands(`${PR}  t:
    defaults:
      run:
        working-directory: site
    steps:
      - working-directory: api
        run: npm run test
`)
    ).toEqual(["cd api && npm run test"]);
  });

  it("reads a quoted inline command", () => {
    expect(commands(`${PR}  t:\n    steps:\n      - run: "cargo test"\n`)).toEqual(["cargo test"]);
  });

  it("reports one gap for a step eight jobs repeat, not eight", () => {
    // Run bc691359's workflows install rustup in every job. Undeduplicated the
    // list is eighty-five lines of the same four sentences, which is a list
    // nobody reads — the same outcome as not printing it.
    const jobs = Array.from({ length: 8 }, (_, i) => `  j${i}:\n    steps:\n      - run: rustup show\n`).join("");
    expect(scanCiChecks(wf(`${PR}${jobs}`)).skipped).toHaveLength(1);
  });
});

describe("reading the workflow's env", () => {
  it("passes over a key whose value is a block scalar rather than a literal", () => {
    expect(
      reason(`name: CI
on:
  pull_request:
env:
  SCRIPT: |
    echo hello
jobs:
  t:
    steps:
      - run: cargo test $SCRIPT
`)
    ).toContain("does not define");
  });

  it("passes over a key whose value is an Actions expression, so the step that reads it is refused too", () => {
    expect(
      reason(`name: CI
on:
  pull_request:
env:
  REF: \${{ github.ref }}
jobs:
  t:
    steps:
      - run: cargo test $REF
`)
    ).toContain("does not define");
  });

  it("has nothing to substitute when the workflow declares no env at all", () => {
    expect(commands(`${PR}  t:\n    steps:\n      - run: cargo test\n`)).toEqual(["cargo test"]);
  });
});

/**
 * Run bc691359. `ci.yml` runs `npm ci --prefix ui && npm run --prefix ui build`
 * before the cargo step in every job, because revetment-control-plane's build
 * script panics without ui/dist. The `&&` chain is refused, so the cargo step
 * was lifted on its own — and then failed on every task in the run for an hour,
 * against a tree that was green. A check that cannot pass in a fresh worktree
 * is the most expensive thing this scanner can produce.
 */
describe("a step that depends on one this scanner would not take", () => {
  it("does not lift a command whose prerequisite was dropped", () => {
    const out = scanCiChecks(
      wf(`${PR}  clippy:
    steps:
      - run: npm ci --prefix ui && npm run --prefix ui build
      - run: cargo clippy -- -D warnings
`)
    );

    expect(out.checks).toEqual([]);
    // And it says why, naming the step it refused rather than going quiet: an
    // operator comparing this list against their CI needs to know the gap is
    // deliberate.
    expect(out.skipped.map((s) => s.reason)).toContain("an earlier step in this job was not lifted, so this one may depend on something that never ran");
  });

  it("still lifts the steps that ran before the dropped one", () => {
    // Nothing was missing yet when these ran, so they are as safe as they were.
    expect(
      commands(`${PR}  t:
    steps:
      - run: cargo deny check
      - run: npm ci --prefix ui && npm run --prefix ui build
      - run: cargo test
`)
    ).toEqual(["cargo deny check"]);
  });

  it("does not poison a job over a step that only sets the runner up", () => {
    // Every job in run bc691359's eight workflows opens with a multi-line
    // rustup installer. Treating that as a prerequisite refused all fourteen
    // checks — correct in the strict sense and useless in every other one,
    // because the machine running the worktree already has the toolchain.
    expect(
      commands(`${PR}  t:
    steps:
      - name: Install rustup if the runner does not have it
        run: |
          if ! command -v rustup >/dev/null 2>&1; then
            curl -sSf https://sh.rustup.rs | sh -s -- -y
          fi
          echo "$HOME/.cargo/bin" >> "$GITHUB_PATH"
      - run: cargo test
`)
    ).toEqual(["cargo test"]);
  });

  it("does not poison a job over a dependency install", () => {
    // The canonical Node pipeline, and the regression that made this test
    // exist: `npm ci` is not a liftable verb, so it is dropped — and treating
    // the drop as a poisoned prerequisite refused every check behind it. A repo
    // whose CI is checkout / setup-node / install / lint / test came out of
    // `charrette init` with no deterministic checks at all.
    //
    // It is also the one drop that provably needs no poisoning:
    // `seedWorktreeDeps` installs node_modules into every task worktree before
    // the first check runs.
    expect(
      commands(`${PR}  t:
    steps:
      - run: npm ci
      - run: npm run lint
      - run: npm test
`)
    ).toEqual(["npm run lint", "npm test"]);
  });

  it("does not poison a job over a runner-setup step that merely names a build tool", () => {
    // `make` appears here as an apt package, not as a command. Matching the
    // word anywhere on the line dropped both cargo checks behind it — the same
    // "a strict rule refused all fourteen checks" failure as the rustup case
    // above, moved from rustup to make.
    expect(
      commands(`${PR}  t:
    steps:
      - run: sudo apt-get install -y make libssl-dev
      - run: cargo test --workspace
      - run: cargo clippy --workspace -- -D warnings
`)
    ).toEqual(["cargo test --workspace", "cargo clippy --workspace -- -D warnings"]);
  });

  it("does not poison a job over a package manager that is only asked its version", () => {
    expect(
      commands(`${PR}  t:
    steps:
      - run: npm --version
      - run: cargo test
`)
    ).toEqual(["cargo test"]);
  });

  it("still poisons a job over a build that writes into the tree", () => {
    // The exemption above is for installs, not for builds. `npm run --prefix ui
    // build` makes ui/dist, which revetment-control-plane's build script reads
    // — this is the case the whole mechanism exists for, and it is chained
    // behind an install so the two are told apart per command, not per line.
    expect(
      commands(`${PR}  t:
    steps:
      - run: npm ci --prefix ui && npm run --prefix ui build
      - run: cargo clippy -- -D warnings
`)
    ).toEqual([]);
  });

  it("keeps the jobs apart — one job's gap is not another's", () => {
    // Jobs run independently, so a prerequisite missing from one says nothing
    // about the next. Poisoning the file rather than the job would throw away
    // every check after the first awkward step in it.
    expect(
      commands(`${PR}  a:
    steps:
      - run: npm ci --prefix ui && npm run --prefix ui build
      - run: cargo clippy -- -D warnings
  b:
    steps:
      - run: cargo audit
`)
    ).toEqual(["cargo audit"]);
  });
});
