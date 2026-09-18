import { existsSync } from "node:fs";
import path from "node:path";

/** What the state directory and the files in it were called before the rename. */
const LEGACY = { dir: ".harness", db: "harness.db", log: "harness.log" } as const;
/** What they are called now. */
const CURRENT = { dir: ".charrette", db: "charrette.db", log: "charrette.log" } as const;

export interface StatePaths {
  /** Absolute path to the run-state directory. */
  dir: string;
  /** Absolute path to the run ledger. */
  db: string;
  /** Absolute path to the crash log. */
  log: string;
  /** The directory's own name, for `.gitignore` entries and operator messages. */
  dirName: string;
  /** True when this repository is still on the pre-rename layout. */
  legacy: boolean;
}

/**
 * Where a repository's run state lives.
 *
 * The directory was `.harness/` until the project was renamed to Charrette.
 * A rename that quietly stopped looking for the old name would strand every
 * run already on disk — the database that *is* the run, its evidence, its
 * reports, the lock that says whether it is still going — behind a name
 * nothing reads any more. The operator would see an empty repo and a fresh
 * ledger where a finished run used to be.
 *
 * So the old layout wins where it is the only one present, filenames and all:
 * a legacy directory holds `harness.db`, not `charrette.db`, and renaming the
 * directory without renaming what is inside it would find nothing.
 *
 * Nothing is migrated here, on purpose. Moving a live ledger is the operator's
 * call to make, and both shapes stay readable for as long as they take to make
 * it. A repo with both directories is one mid-migration, and the new one wins.
 */
export function statePaths(repoPath: string): StatePaths {
  const onlyLegacy = !existsSync(path.join(repoPath, CURRENT.dir)) && existsSync(path.join(repoPath, LEGACY.dir));
  const names = onlyLegacy ? LEGACY : CURRENT;
  return {
    dir: path.join(repoPath, names.dir),
    db: path.join(repoPath, names.dir, names.db),
    log: path.join(repoPath, names.dir, names.log),
    dirName: names.dir,
    legacy: onlyLegacy,
  };
}
