import { git } from "./git.js";

/**
 * Which files this repository ships together, learned from its own history.
 *
 * The problem is that `touchedPaths` is a guess. The planner names four or five
 * of the dozen files a change really delivers, and `nextDispatch` holds a task
 * back only when the names overlap — so two workers are sent at one file that
 * neither task mentioned, they branch from the same commit, and whichever merges
 * second meets a conflict. Run 40da9337 hit 23 of those across 36 tasks.
 *
 * What is missing is not intelligence, it is the rest of the file set. Git
 * already has it: every commit in the repository is a set of files that some
 * real change delivered together. Counting how often two files appear in the
 * same commit gives, for any file the planner did name, the files it has always
 * arrived with — the ones it did not name.
 *
 * ## Why history rather than the import graph
 *
 * The obvious alternative is to parse the code and follow imports and calls.
 * Measured on four brownfield repositories (folio, agentdraft,
 * trip-app-business, seo-app — 3,000-odd commits between them), taking
 * each commit as a task, 40% of its files as what a planner would have named,
 * and asking which pairs of tasks would have been correctly held apart:
 *
 * | widening                     | real conflicts caught | safe pairs held | paths added |
 * | ---------------------------- | --------------------- | --------------- | ----------- |
 * | none — declared paths only   | 43.0%                 | 0%              | 0           |
 * | AST import/call graph, 1 hop | 68.8%                 | 28.2%           | 15.3        |
 * | co-change, this module       | 69.6%                 | 23.7%           | 2.9         |
 *
 * The same catch rate for fewer wrong holds, a fifth of the added paths, and no
 * dependency beyond `git log`. The AST graph's extra paths are mostly noise:
 * only 5-10% of the file pairs that actually change together have a direct
 * import or call edge between them at all. Files change together because they
 * answer to the same requirement, and that is a fact about the project's history
 * rather than about its call graph. `repoFileList` reached the same conclusion
 * from the other end — a full AST dependency graph scored no better than a flat
 * list of filenames for planning.
 *
 * ## Why holding a task back too often is the cheap mistake
 *
 * The two errors are not symmetric, which is what makes 23.7% acceptable. A
 * missed collision costs a re-dispatched worker, or past the conflict cap an
 * operator. A hold that turns out to be unnecessary costs waiting: the task is
 * next in line the moment the other one merges, and only loses the run anything
 * when nothing else was runnable. Buying 27 points of conflict detection with
 * time that is usually free is a good trade; it would not be if it ran the other
 * way.
 */

/**
 * How far back to read. Long enough to see a file's habits, short enough that a
 * layout the repository has since abandoned does not still speak.
 */
const HISTORY_COMMITS = 1200;

/**
 * A commit touching more files than this is a sweep — a rename, a formatter, a
 * dependency bump — and it did not mean that all of them belong together. Left
 * in, one such commit links every file it touched to every other, which is
 * precisely the shape that makes everything collide with everything.
 */
const SWEEPING_COMMIT = 50;

/** One commit together is a coincidence. Two is the weakest thing worth calling a habit. */
const MIN_TOGETHER = 2;

/**
 * How many files may be added to one task. The measurement flattens here: a
 * fourth and fifth neighbour bought 12 more points of detection for 25 more
 * points of spurious holds, which is the wrong side of the trade above.
 */
const WIDEN_BY = 3;

/**
 * A file that has shipped with this much of the repository is a hub and is never
 * suggested. A lockfile, a barrel index, a root config, an operations doc — they
 * ship with everything, so they say nothing about what a particular change
 * touches, and letting one into a widened set links every task to every other.
 *
 * Stated as a fraction of the repository rather than as a rank, because rank
 * does not survive a change of scale: "the top 1%" was the rule that measured
 * best on the four large repositories, and on the charrette's own 199-file
 * repository it named one file and let `docs/OPERATIONS.md` — which ships with
 * 51% of the tree — through to attach itself to every task in the run. At 30%
 * both repositories are read the same way, for 64.0% of real conflicts caught
 * against 16.4% of safe pairs held, versus 69.6%/23.7% for the rank rule. Fewer
 * conflicts caught per run, and fewer runs quietly serialised on a changelog.
 */
const HUB_REACH_FRACTION = 0.3;

/**
 * …and below this many files, there is no such thing as a hub. Thirty percent of
 * a six-file index is two files, so the rule would start deleting the only
 * answers such a repository has. A tree that small cannot serialise a run.
 */
const HUB_MIN_FILES = 20;

/**
 * Past this share of the tree being hubs, the repository is not being read at
 * all — it is being described. Some histories cannot tell files apart: a young
 * project where every commit is a whole vertical slice has genuinely shipped
 * most of its files with most of its other files, and "what does this one
 * usually arrive with" has no answer. The charrette's own repository is one — 55
 * commits, 8 files each, and 19.6% of the tree over the hub line, against 0.3%
 * to 1.6% for the four established repositories measured. The separation is not
 * subtle, and on the wrong side of it every suggestion was noise.
 *
 * So the index says so and widens nothing, rather than tuning a threshold until
 * a repository with no signal in it produces confident-looking output.
 */
const UNINFORMATIVE_HUB_SHARE = 0.05;

export interface CoChangeIndex {
  /** How many commits it learned from. Zero means it will widen nothing. */
  commits: number;
  /** How many files it has an opinion about. */
  files: number;
  /** The most-connected files, which are deliberately never suggested. */
  hubs: string[];
  /**
   * Whether this history distinguishes files at all. False means `widen` returns
   * nothing however much history there was — see `UNINFORMATIVE_HUB_SHARE`.
   */
  informative: boolean;
  /**
   * The files these ones have shipped with, strongest habit first — never more
   * than `WIDEN_BY`, never one of the paths passed in, never a hub.
   */
  widen(paths: string[]): string[];
}

/**
 * One line telling the operator what the scheduler is about to do differently.
 *
 * Worth saying out loud because it changes when tasks start, and a run that
 * quietly holds work back for a reason nobody announced is a run whose
 * throughput has no explanation. Both of the silent cases say so explicitly —
 * "as before" is the whole point of them.
 */
export function coChangeNote(index: CoChangeIndex): string {
  if (index.informative) {
    return `co-change: ${index.files} files across ${index.commits} commits — a task's declared paths are now held against up to ${WIDEN_BY} files this repository ships them with`;
  }
  if (index.commits) {
    return `co-change: ${index.commits} commits touch too much of the tree at once to tell files apart — tasks are held apart on their declared paths alone, as before`;
  }
  return "co-change: no usable history — tasks are held apart on their declared paths alone, as before";
}

/** Matches `dispatchOrder`'s spelling rules, so a path indexed here collides there. */
function normalize(p: string): string {
  return p.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** An index that knows nothing and therefore changes nothing. */
export function emptyCoChange(): CoChangeIndex {
  return { commits: 0, files: 0, hubs: [], informative: false, widen: () => [] };
}

/**
 * Read the repository's history into an index.
 *
 * Never throws. A repository with no commits, no git, or a history too short to
 * generalise from returns an index that widens nothing, which is exactly the
 * behaviour the charrette had before this existed — the run continues on the
 * planner's declared paths alone.
 */
export async function coChangeIndex(repoPath: string): Promise<CoChangeIndex> {
  // A NUL before each commit rather than parsing blank lines: a commit that
  // touched no files then contributes an empty record instead of swallowing the
  // next one's filenames.
  const out = await git(repoPath, ["log", "--no-merges", `-${HISTORY_COMMITS}`, "--name-only", "--pretty=format:%x00"]).catch(() => "");
  const commits = out
    .split("\0")
    .map((block) => block.split("\n").map(normalize).filter(Boolean))
    .filter((files) => files.length > 1 && files.length <= SWEEPING_COMMIT);
  if (!commits.length) return emptyCoChange();

  const together = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string) => {
    const row = together.get(a) ?? new Map<string, number>();
    row.set(b, (row.get(b) ?? 0) + 1);
    together.set(a, row);
  };
  for (const files of commits) {
    const unique = [...new Set(files)];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        bump(unique[i]!, unique[j]!);
        bump(unique[j]!, unique[i]!);
      }
    }
  }

  // How many distinct files each one has shipped with, against the size of the
  // index it is part of.
  const reach = together.size * HUB_REACH_FRACTION;
  const hubs = new Set(together.size < HUB_MIN_FILES ? [] : [...together.keys()].filter((f) => together.get(f)!.size >= reach).sort());
  const informative = hubs.size <= together.size * UNINFORMATIVE_HUB_SHARE;

  return {
    commits: commits.length,
    files: together.size,
    hubs: [...hubs],
    informative,
    widen(paths: string[]): string[] {
      const declared = new Set(paths.map(normalize).filter(Boolean));
      if (!informative || !declared.size) return [];
      // Strongest habit across the whole task, not per path: a task naming six
      // files should not pull in eighteen. The bound is on the task.
      const best = new Map<string, number>();
      for (const p of declared) {
        for (const [other, count] of together.get(p) ?? []) {
          if (count < MIN_TOGETHER || declared.has(other) || hubs.has(other)) continue;
          best.set(other, Math.max(best.get(other) ?? 0, count));
        }
      }
      return [...best.keys()].sort((a, b) => best.get(b)! - best.get(a)! || a.localeCompare(b)).slice(0, WIDEN_BY);
    },
  };
}
