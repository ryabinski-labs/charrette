import type { Runbook } from "@harness/shared";

/**
 * The switches a run declared and could not throw — read off the diff it
 * merged.
 *
 * A run ends and the operator is told "12 tasks merged, CI green, production
 * verified". All of that can be true while half the product is inert: the
 * Stripe key the checkout reads is not set anywhere, the Route53 record the
 * template declares was never created, the migration that adds the table has
 * not run. The code shipped. The feature did not.
 *
 * The harness is structurally incapable of throwing these itself —
 * `infraGuard` denies `terraform apply` to every agent because they run under
 * `bypassPermissions`, and no agent is given the operator's production
 * credentials. So the gap is not a bug to fix, it is a permanent property of
 * the system, and the only honest thing to do with it is *report* it: name
 * every switch the run left off, and say what throws it.
 *
 * These are candidates, deliberately. A regex over a diff can tell that
 * `process.env.STRIPE_SECRET_KEY` appeared in code the run wrote; it cannot
 * tell whether the operator set it in the deploy environment last Tuesday.
 * That is what the reporter agent is for — it takes this inventory and proves
 * each entry against the running system. What this file guarantees is that
 * nothing gets *overlooked*: an agent asked to "find what is not turned on"
 * finds what it thinks to look for, and an agent handed this list has to
 * account for every row.
 *
 * Pure and I/O-free, like `evidence` and `deployCapability`: the caller reads
 * the bytes, so every rule here is testable without a repo or a cloud account.
 */

type RunbookStep = Runbook["steps"][number];

/** A file the caller has read out of the merged diff. */
export interface ScannedFile {
  path: string;
  text: string;
}

export type SwitchKind = "secret" | "infrastructure" | "dns" | "migration" | "flag";

export interface DarkSwitch {
  kind: SwitchKind;
  /** The thing that is off, in the words the repo uses for it. */
  name: string;
  /** Where the run declared it — `path` or `path:line`. */
  where: string;
  /** One sentence saying what stays inert until this is thrown. */
  why: string;
  /** What throws it, written for someone who is not in this repository. */
  steps: RunbookStep[];
}

/**
 * Environment names that are not secrets to seed.
 *
 * Every one of these is either set by the platform, set by the process
 * manager, or meaningless in production. Reporting them is how a real finding
 * ends up on page two of a list the operator has stopped reading.
 */
const AMBIENT = new Set([
  "NODE_ENV",
  "ENV",
  "ENVIRONMENT",
  "STAGE",
  "PORT",
  "HOST",
  "HOSTNAME",
  "HOME",
  "PATH",
  "PWD",
  "USER",
  "SHELL",
  "TERM",
  "TZ",
  "LANG",
  "CI",
  "DEBUG",
  "LOG_LEVEL",
  "RUST_LOG",
  "PYTHONPATH",
  "GOPATH",
  "TMPDIR",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "VERCEL_ENV",
  "npm_package_version",
]);

/**
 * How the languages this harness actually runs against read their environment.
 *
 * One pass per pattern rather than one clever union: the capture group sits in
 * a different place in each, and a single expression that handles all of them
 * is one nobody can check by reading.
 */
const ENV_READS: RegExp[] = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*["'`]([^"'`]+)["'`]\s*\]/g,
  /(?:Deno|Netlify)\.env\.get\(\s*["'`]([^"'`]+)["'`]/g,
  /os\.environ(?:\.get)?[[(]\s*["']([^"']+)["']/g,
  /os\.getenv\(\s*["']([^"']+)["']/g,
  /os\.(?:Getenv|LookupEnv)\(\s*"([^"]+)"/g,
  /(?:std::)?env::var(?:_os)?\(\s*"([^"]+)"/g,
  /System\.getenv\(\s*"([^"]+)"/g,
  /ENV\[\s*["']([^"']+)["']\s*\]/g,
];

/** Only shout about a name that looks like configuration, not a local. */
const SECRET_SHAPED = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * Names whose absence is a dead feature rather than a default.
 *
 * A missing `RETRY_LIMIT` degrades; a missing `STRIPE_SECRET_KEY` means the
 * money path throws on first call. Both are worth listing, but only the second
 * earns the word "dark", so the sentence differs.
 */
const CREDENTIAL = /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|DSN|API|WEBHOOK|CLIENT_ID|ACCOUNT|URL|URI|ENDPOINT|CONNECTION)/;

const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|php|cs|ex|exs)$/;

/**
 * Files whose contents describe a test, not a running system.
 *
 * A `_test.go` that reads `dns-project_API_TOKEN` is naming a fixture, and a
 * runbook's `.bats` file quoting a command is documentation. Reporting either
 * as a switch the operator has to throw is how a section of 23 findings ends up
 * with 17 that are wrong — at which point the six real ones are gone too,
 * because nobody reads past the third false one.
 */
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|specs?|fixtures?|testdata|e2e)\/|[._-](?:test|spec)\.[A-Za-z]+$|\.bats$/i;

/**
 * Files that *declare* infrastructure, as opposed to files that mention it.
 *
 * The DNS rule reads for tokens like `dns01`, which is a cert-manager solver in
 * a manifest and an ordinary noun in a guide about cert-manager. Run 1e7d3df3's
 * first report found it in five Go files, four Markdown documents and a test
 * runbook; every one was prose. A declaration lives in a template.
 */
const DECLARATIVE = /\.(?:tf|tfvars|ya?ml|json)$/;
const ENV_FILE = /(?:^|\/)\.env(?:\.[A-Za-z0-9_.-]+)?$/;

const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/**
 * Every environment name a `.env`-shaped file assigns a non-empty value to.
 *
 * `.env.example` is deliberately *not* treated as configured — a name that
 * appears only there is precisely the case this whole file exists to catch:
 * declared, documented, and never seeded. The caller decides which files count
 * as real by what it passes in `configured`.
 */
export function envNames(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    const value = m[2]!.trim().replace(/^["']|["']$/g, "");
    // `FOO=` and `FOO=""` are placeholders, not settings. A file full of empty
    // assignments is a template someone copied and never filled in, and
    // treating it as configured hides every finding in it.
    if (value) names.push(name);
  }
  return names;
}

/**
 * Every name a `.env`-shaped file mentions, whether or not it carries a value.
 *
 * The counterpart to `envNames`, and the reason both exist: in a template, an
 * assignment with no value is not a placeholder to ignore, it is the strongest
 * possible statement that somebody has to supply this one.
 */
export function declaredNames(text: string): { name: string; blank: boolean; line: number }[] {
  const out: { name: string; blank: boolean; line: number }[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const name = m?.[1];
    if (!m || !name) return;
    // `(?:^|\s+)#` rather than `\s+#`: after the assignment regex has eaten the
    // spaces, a line whose whole value is a comment arrives with `#` at index 0
    // — and a template's blank-with-an-explanation is the single strongest
    // signal in the file, so reading it as configured loses the best finding.
    // Anchoring on start-or-space still leaves a `pa##word` value alone.
    const value = m[2]!.replace(/(?:^|\s+)#.*$/, "").trim().replace(/^["']|["']$/g, "");
    out.push({ name, blank: !value, line: i + 1 });
  });
  return out;
}

const EXAMPLE_FILE = /(?:^|\/)\.env\.(?:example|sample|template|dist)$|(?:^|\/)env\.example$/;

/**
 * Names the repository documents as required and nothing on this machine sets.
 *
 * The most productive rule of the set, and the one that survives real code.
 * Scanning for `process.env.X` only finds the codebases that read their
 * environment inline; a Go service whose `config.Load()` calls
 * `os.LookupEnv(key)` in a loop has no literal to find, and every one of its
 * eighteen required variables is invisible to a scanner looking for
 * identifiers. The `.env.example` the same run wrote lists all eighteen.
 *
 * Two shapes qualify, and nothing else, because the cost of a noisy row here is
 * that the operator stops reading the section: a name left blank in the
 * template — which is the author saying "you must supply this" — and a
 * credential-shaped name, which fails closed rather than falling back.
 */
function declared(files: ScannedFile[], configured: Set<string>): Map<string, { where: string; credential: boolean }> {
  const found = new Map<string, { where: string; credential: boolean }>();
  for (const file of files) {
    if (!EXAMPLE_FILE.test(file.path)) continue;
    for (const { name, blank, line } of declaredNames(file.text)) {
      const credential = CREDENTIAL.test(name);
      if (AMBIENT.has(name) || configured.has(name) || found.has(name)) continue;
      if (!blank && !credential) continue;
      found.set(name, { where: `${file.path}:${line}`, credential });
    }
  }
  return found;
}

/** Environment reads in code the run wrote, that nothing on this machine sets. */
function secrets(files: ScannedFile[], configured: Set<string>): DarkSwitch[] {
  const found = declared(files, configured);
  for (const file of files) {
    if (!SOURCE_EXT.test(file.path) || TEST_FILE.test(file.path)) continue;
    for (const pattern of ENV_READS) {
      // Each scan starts from zero: these are module-level regexes with /g, and
      // a shared lastIndex between files silently skips matches.
      pattern.lastIndex = 0;
      for (let m = pattern.exec(file.text); m; m = pattern.exec(file.text)) {
        const name = m[1]!;
        if (AMBIENT.has(name) || !SECRET_SHAPED.test(name) || configured.has(name)) continue;
        if (found.has(name)) continue;
        found.set(name, { where: `${file.path}:${lineOf(file.text, m.index)}`, credential: CREDENTIAL.test(name) });
      }
    }
  }
  // Grouped by the file that declares them, not listed one per card.
  //
  // A backend with eighteen required variables produces eighteen findings whose
  // text differs only in the identifier, and the operator does not have
  // eighteen jobs — they have one job with a list attached. Run ec40b527's
  // report rendered eleven cards carrying the same three sentences, which is
  // the shape a reader learns to scroll past, and the two entries that actually
  // needed separate handling would have been scrolled past with them.
  const groups = new Map<string, { names: string[]; where: string; credential: boolean }>();
  for (const [name, { where, credential }] of [...found.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const file = where.replace(/:\d+$/, "");
    const group = groups.get(file);
    if (group) {
      group.names.push(name);
      group.credential ||= credential;
    } else groups.set(file, { names: [name], where, credential });
  }

  return [...groups.values()].map(({ names, where, credential }) => {
    const one = names.length === 1;
    const name = names[0]!;
    return {
      kind: "secret" as const,
      name: one ? name : `${names.length} unset variables`,
      where,
      why: one
        ? credential
          ? `${name} is a credential this run's code needs, and nothing in this checkout sets it. The path that reads it fails closed until someone seeds it — which is the abrupt kind of dark: it works for whoever wrote it and errors for everyone else.`
          : `${name} is required by the merged code — the repository's own template leaves it blank — and nothing in this checkout sets it.`
        : `${where.replace(/:\d+$/, "")} declares ${names.length} variables the merged code requires, and nothing in this checkout sets any of them: ${names.join(", ")}. Each path that reads one fails closed, so this is the abrupt kind of dark — it works for whoever wrote it and errors for everyone else.`,
      steps: [
        {
          do: one
            ? `Put a real value for ${name} wherever this service reads its environment — the deploy platform's settings, the secret manager, or the CI secret it is injected from.`
            : `Set all ${names.length} wherever this service reads its environment — the deploy platform's settings, the secret manager, or the CI secrets they are injected from. Some are infrastructure outputs rather than things you choose: read them off the stack that creates them rather than inventing values.`,
        },
        {
          do: one ? `If it is injected through GitHub Actions, set it as a repository secret.` : `If they are injected through GitHub Actions, set them as repository secrets.`,
          command: names.map((n) => `gh secret set ${n}`).join("\n"),
        },
        { do: `Redeploy, then confirm the service starts — an environment change does not reach a process that is already running, and a variable that is still missing usually shows up as a boot failure rather than a bad response.` },
      ],
    };
  });
}

/**
 * Infrastructure-as-code the run wrote, which nothing in the run applied.
 *
 * This is the flattest of the rules and the most reliably true, because it does
 * not depend on reading the operator's cloud account: `infraGuard` refuses
 * `apply` to every agent by construction, so a changed template is always a
 * declaration and never a deployment. The only question is whether the
 * repository's own pipeline applies it on merge, and that is the question the
 * step below tells the operator to answer.
 */
const IAC: { test: (f: ScannedFile) => boolean; tool: string; apply: string }[] = [
  {
    test: (f) => /\.tf$/.test(f.path) && /^\s*resource\s+"/m.test(f.text),
    tool: "Terraform",
    apply: "terraform plan   # then, once it reads right: terraform apply",
  },
  {
    test: (f) => /\.(?:ya?ml|json)$/.test(f.path) && /AWSTemplateFormatVersion|Transform:\s*AWS::Serverless/.test(f.text),
    tool: "CloudFormation",
    apply: "sam deploy --no-execute-changeset   # review the changeset, then execute it",
  },
  {
    test: (f) => /\.(?:ya?ml|yml)$/.test(f.path) && /^\s*apiVersion:/m.test(f.text) && /^\s*kind:/m.test(f.text),
    tool: "Kubernetes",
    apply: "kubectl apply --dry-run=server -f <path>   # then without the dry run",
  },
];

function infrastructure(files: ScannedFile[]): DarkSwitch[] {
  // Grouped by the directory that is applied, not listed per file. A Terraform
  // module is sixteen files and one `terraform apply`; sixteen cards saying the
  // same sentence is the shape a reader scrolls past, and the reader who does
  // scrolls past the DNS and the secrets underneath it too.
  const groups = new Map<string, { rule: (typeof IAC)[number]; paths: string[] }>();
  for (const file of files) {
    const rule = IAC.find((r) => r.test(file));
    if (!rule) continue;
    const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".";
    const key = `${rule.tool}\u0000${dir}`;
    const group = groups.get(key);
    if (group) group.paths.push(file.path);
    else groups.set(key, { rule, paths: [file.path] });
  }

  return [...groups.values()].map(({ rule, paths }) => {
    const one = paths.length === 1;
    const dir = paths[0]!.includes("/") ? paths[0]!.slice(0, paths[0]!.lastIndexOf("/")) : ".";
    return {
      kind: "infrastructure" as const,
      name: one ? paths[0]! : `${paths.length} ${rule.tool} files in ${dir}`,
      where: paths.join(", "),
      why: `${one ? paths[0]! : `${dir} (${paths.length} files)`} declares ${rule.tool} resources. No agent in this run could have created them — the harness denies apply to every agent it runs — so they exist as a description until the pipeline or a person applies it.`,
      steps: [
        { do: `Check whether this repository's deploy pipeline applies ${rule.tool} on merge. If it does, this is already live and only needs confirming.` },
        { do: `If nothing applies it automatically, apply it yourself, and read the plan before you do.`, command: rule.apply.replace("<path>", dir) },
      ],
    };
  });
}

/**
 * DNS declared in the diff.
 *
 * Its own kind rather than a subset of infrastructure, because it fails
 * differently and the operator fixes it somewhere else. An unapplied stack
 * means nothing exists; an unresolved name means everything exists and no
 * traffic can find it — and the fix is often at a registrar the IaC never
 * touches, which is exactly the case where "apply the template" is the wrong
 * instruction.
 */
/**
 * Restricting the search to templates was not enough on its own.
 *
 * A template is mostly YAML, and YAML is mostly comments and descriptions. Run
 * 1e7d3df3 matched `dns01` twice more after the file filter: once in an OpenAPI
 * description, where `acme-dns01` is the *name of a token scope*, and once in a
 * comment on line 3 of a manifest saying which ClusterIssuer the cluster uses.
 * Neither declares anything.
 *
 * So each pattern matches the syntax of a declaration rather than the word:
 * `dns01:` is a cert-manager solver key, `dns01` is a noun. `^(?!\s*#)` keeps
 * the rest off comment lines, which is where a template explains itself.
 */
const DNS_DECLARATIONS: { pattern: RegExp; what: string }[] = [
  { pattern: /^(?![^\S\n]*#).*AWS::Route53::RecordSet/gm, what: "a Route53 record" },
  { pattern: /resource\s+"aws_route53_record"\s+"([A-Za-z0-9_-]+)"/g, what: "a Route53 record" },
  { pattern: /resource\s+"cloudflare_record"\s+"([A-Za-z0-9_-]+)"/g, what: "a Cloudflare record" },
  { pattern: /resource\s+"dns-project_record"\s+"([A-Za-z0-9_-]+)"/g, what: "a dns-project record" },
  { pattern: /^(?![^\S\n]*#).*AWS::CertificateManager::Certificate/gm, what: "an ACM certificate, which is issued only once its validation record resolves" },
  { pattern: /^[^\S\n]*-?[^\S\n]*dns01:/gm, what: "an ACME DNS-01 solver, which cannot issue a certificate until its TXT record resolves" },
];

function dns(files: ScannedFile[]): DarkSwitch[] {
  const out: DarkSwitch[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!DECLARATIVE.test(file.path) || TEST_FILE.test(file.path)) continue;
    for (const { pattern, what } of DNS_DECLARATIONS) {
      pattern.lastIndex = 0;
      const m = pattern.exec(file.text);
      if (!m) continue;
      const declared = m[1];
      const name = declared ? `${file.path} (${declared})` : file.path;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        kind: "dns",
        name,
        where: `${file.path}:${lineOf(file.text, m.index)}`,
        why: `${file.path} declares ${what}. Until it resolves publicly, everything behind that name is unreachable no matter how green the deploy went.`,
        steps: [
          { do: `Apply whatever creates the record, then confirm it actually resolves — a created record and a resolving name are not the same claim.`, command: `dig +short <name>` },
          { do: `If the zone is delegated somewhere the template does not control, add the record at that registrar or DNS host by hand.` },
          { do: `For a certificate, confirm it left PENDING_VALIDATION — a certificate stuck there fails every TLS handshake.` },
        ],
      });
    }
  }
  return out;
}

/**
 * Schema changes that have to be run against a database that already exists.
 *
 * A migration in the diff is code; the table it adds is not there until
 * something runs it. Repos differ on whether deploy runs migrations, so the
 * step asks rather than asserts.
 */
const MIGRATION_PATH = /(?:^|\/)(?:migrations?|migrate|alembic\/versions|db\/migrate|prisma\/migrations)\//i;
const MIGRATION_SQL = /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TYPE|SCHEMA)\b/i;

function migrations(files: ScannedFile[]): DarkSwitch[] {
  const hits = files.filter((f) => MIGRATION_PATH.test(f.path) || (/\.sql$/.test(f.path) && MIGRATION_SQL.test(f.text)));
  if (!hits.length) return [];
  const where = hits.map((f) => f.path).join(", ");
  // One entry for the set, not one per file: they are applied together, in
  // order, by a single command, and a list of eleven identical rows buries the
  // other findings.
  return [
    {
      kind: "migration",
      name: hits.length === 1 ? where : `${hits.length} migrations`,
      where,
      why: `The run added schema changes. Any code path that reads the new shape errors against a database still on the old one, so this is dark in the most abrupt way — it works locally and 500s in production.`,
      steps: [
        { do: `Check whether the deploy pipeline runs migrations. If it does, confirm it ran on this deploy rather than assuming it.` },
        { do: `If not, run them against production yourself, after taking a backup.` },
        { do: `Confirm the new shape is really there before calling it done.` },
      ],
    },
  ];
}

/**
 * Feature flags the run shipped in the off position.
 *
 * The narrowest rule here, and deliberately so: "a line with `false` on it" is
 * most of a codebase. This wants the specific shape of a flag whose default is
 * off — the thing a run ships when it has built a feature behind a switch and
 * left the switch down, which reads as "delivered" in every other report.
 */
const FLAG_DEFAULT =
  /(?:^|[\s,{("'`])((?:enable|feature|flag|is|use|allow)[A-Za-z0-9_]*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)["'`]?\s*[:=]\s*(?:(?:false|0)\b|"(?:false|off)"|'(?:false|off)')/g;
const FLAG_NAMED = /(?:enable|feature|flag)/i;

function flags(files: ScannedFile[]): DarkSwitch[] {
  const out: DarkSwitch[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if ((!SOURCE_EXT.test(file.path) && !/\.(?:json|ya?ml|toml)$/.test(file.path)) || TEST_FILE.test(file.path)) continue;
    FLAG_DEFAULT.lastIndex = 0;
    for (let m = FLAG_DEFAULT.exec(file.text); m; m = FLAG_DEFAULT.exec(file.text)) {
      const name = m[1]!;
      // The identifier has to name a switch. `isDeleted = false` is state.
      if (!FLAG_NAMED.test(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({
        kind: "flag",
        name,
        where: `${file.path}:${lineOf(file.text, m.index)}`,
        why: `${name} defaults to off. Whatever it guards is merged, tested and unreachable to anyone who has not turned it on.`,
        steps: [
          { do: `Decide whether ${name} should be on. If the run was asked to deliver what it guards, then shipping it off is the feature not being delivered.` },
          { do: `Turn it on where the running system reads it — config, environment, or the flag service — and confirm the guarded path is reachable.` },
        ],
      });
    }
  }
  return out;
}

/**
 * Whether this file can carry a switch at all.
 *
 * Exported because the caller reads the bytes, and on a large run that read is
 * a subprocess per file: run f338b5c8 changed enough that fetching every blob
 * took longer than the command was worth waiting for. Every rule above keys off
 * the path before it looks at the text, so the same question can be asked
 * before the read — and a lockfile, an image or a PDF can never answer yes.
 */
export function scannable(path: string): boolean {
  if (TEST_FILE.test(path)) return SOURCE_EXT.test(path) === false && DECLARATIVE.test(path);
  return (
    SOURCE_EXT.test(path) ||
    DECLARATIVE.test(path) ||
    ENV_FILE.test(path) ||
    EXAMPLE_FILE.test(path) ||
    MIGRATION_PATH.test(path) ||
    /\.(?:sql|toml)$/.test(path)
  );
}

/**
 * Every switch the merged diff left off, worst first.
 *
 * Ordered by how completely each one stops the feature working, because the
 * operator reads this top down and stops somewhere: a missing credential and an
 * unapplied stack are total, a flag is a decision, and a warning that arrives
 * below the fold is a warning that did not arrive.
 */
const ORDER: Record<SwitchKind, number> = { secret: 0, infrastructure: 1, dns: 2, migration: 3, flag: 4 };

export function scanDarkSwitches(files: ScannedFile[], configured: Iterable<string> = []): DarkSwitch[] {
  const set = new Set(configured);
  // A `.env` in the diff is itself an answer about what is configured, so it is
  // folded in before the scan rather than reported as a finding.
  // `EXAMPLE_FILE` rather than a second list of suffixes. Two lists that have to
  // agree are two lists that drift: this one omitted `.dist`, so a `.env.dist`
  // full of placeholders was read as settings and silenced every finding under
  // it — the exact failure the whole file exists to prevent, caused by the
  // scanner rather than the repo.
  for (const file of files) if (ENV_FILE.test(file.path) && !EXAMPLE_FILE.test(file.path)) for (const n of envNames(file.text)) set.add(n);
  return [...secrets(files, set), ...infrastructure(files), ...dns(files), ...migrations(files), ...flags(files)].sort(
    (a, b) => ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name)
  );
}
