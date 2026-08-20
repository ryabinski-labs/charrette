import { describe, expect, it } from "vitest";
import { declaredNames, envNames, scanDarkSwitches, scannable, type ScannedFile } from "./darkSwitches.js";

const file = (path: string, text: string): ScannedFile => ({ path, text });
const kinds = (files: ScannedFile[], configured: string[] = []) => scanDarkSwitches(files, configured).map((s) => s.kind);
const named = (files: ScannedFile[], configured: string[] = []) => scanDarkSwitches(files, configured).map((s) => s.name);

describe("reading a .env-shaped file", () => {
  it("takes only the names something actually sets", () => {
    // `C=""` is a placeholder like `B=`, not a setting: an empty string is
    // what a copied template looks like, and reading it as configured hides
    // every finding underneath it.
    expect(envNames("A=1\nB=\nC=\"\"\n# D=4\n\nexport E=5")).toEqual(["A", "E"]);
  });

  /**
   * The distinction the whole secret rule turns on. `envNames` answers "what is
   * configured", where a blank is a placeholder and means no. `declaredNames`
   * answers "what does this template say is required", where a blank is the
   * author saying *you must supply this* — the strongest signal in the file.
   */
  it("keeps blanks when reading a template, and marks them", () => {
    expect(declaredNames("PORT=8080\nJWT_SIGNING_KEY=\n# note\nQUOTED=''")).toEqual([
      { name: "PORT", blank: false, line: 1 },
      { name: "JWT_SIGNING_KEY", blank: true, line: 2 },
      { name: "QUOTED", blank: true, line: 4 },
    ]);
  });

  it("does not read a trailing comment as the value", () => {
    expect(declaredNames("PORT=   # the port to listen on")).toEqual([{ name: "PORT", blank: true, line: 1 }]);
  });

  it("ignores lines that are not assignments at all", () => {
    expect(envNames("just prose\n=5\n1BAD=x")).toEqual([]);
    expect(declaredNames("just prose\n=5")).toEqual([]);
  });
});

describe("secrets the run's code needs and nothing sets", () => {
  it("finds an environment read in every language the harness runs against", () => {
    const files = [
      file("a.ts", `const k = process.env.STRIPE_SECRET_KEY;`),
      file("b.ts", `process.env["SENDGRID_API_KEY"]`),
      file("c.ts", `Deno.env.get("DENO_DB_URL")`),
      file("d.py", `os.environ["PY_API_TOKEN"]`),
      file("e.py", `os.getenv("PY_OTHER_KEY")`),
      file("f.go", `os.Getenv("GO_API_KEY")`),
      file("g.go", `os.LookupEnv("GO_LOOKUP_TOKEN")`),
      file("h.rs", `std::env::var("RUST_API_KEY")`),
      file("i.java", `System.getenv("JAVA_API_KEY")`),
      file("j.rb", `ENV["RUBY_API_KEY"]`),
    ];
    // One card per declaring file, so each of these lands on its own.
    expect(named(files)).toEqual([
      "DENO_DB_URL",
      "GO_API_KEY",
      "GO_LOOKUP_TOKEN",
      "JAVA_API_KEY",
      "PY_API_TOKEN",
      "PY_OTHER_KEY",
      "RUBY_API_KEY",
      "RUST_API_KEY",
      "SENDGRID_API_KEY",
      "STRIPE_SECRET_KEY",
    ]);
  });

  it("says nothing about names the platform sets, or that are not configuration at all", () => {
    const files = [file("a.ts", `process.env.NODE_ENV; process.env.PORT; process.env.AWS_REGION; process.env.timeout; process.env.X`)];
    expect(scanDarkSwitches(files)).toEqual([]);
  });

  it("says nothing about a name this checkout already sets", () => {
    const files = [file("a.ts", `process.env.STRIPE_SECRET_KEY`)];
    expect(scanDarkSwitches(files, ["STRIPE_SECRET_KEY"])).toEqual([]);
  });

  /**
   * A real `.env` in the diff answers the question the scan is asking, so it is
   * folded into what is configured rather than reported as a finding. A
   * template is the opposite: it is the declaration this rule exists to catch.
   */
  it("treats a committed .env as an answer and a .env.example as a question", () => {
    const code = file("a.ts", `process.env.STRIPE_SECRET_KEY; process.env.MAILER_API_KEY`);
    expect(named([code, file(".env", "STRIPE_SECRET_KEY=sk_live_x")])).toEqual(["MAILER_API_KEY"]);
    expect(named([code, file(".env.example", "STRIPE_SECRET_KEY=\nMAILER_API_KEY=")])).toEqual(["2 unset variables"]);
  });

  /**
   * The rule that survives real code. A Go service reading its environment
   * through `os.LookupEnv(key)` in a loop has no identifier to find, and every
   * one of its required variables is invisible to an identifier scan — while
   * the template the same run wrote lists all of them.
   */
  it("reads a template even when no code mentions the names", () => {
    const template = file("backend/.env.example", "PORT=8080\nTABLE_NAME=local\nJWT_SIGNING_KEY=\nPACK_CDN_DOMAIN=");
    const switches = scanDarkSwitches([template]);
    expect(switches).toHaveLength(1);
    expect(switches[0]!.name).toBe("2 unset variables");
    expect(switches[0]!.why).toContain("JWT_SIGNING_KEY, PACK_CDN_DOMAIN");
    // `PORT` is ambient and `TABLE_NAME` carries a working default: neither is
    // something the operator has to go and do.
    expect(switches[0]!.why).not.toContain("TABLE_NAME");
  });

  it("keeps a credential-shaped name from a template even when it has a default", () => {
    expect(named([file(".env.example", "ORDERS_API_URL=http://localhost:9000")])).toEqual(["ORDERS_API_URL"]);
  });

  it("says a blank non-credential is required rather than calling it a credential", () => {
    const switches = scanDarkSwitches([file(".env.example", "FEATURE_MODE=")]);
    expect(switches[0]!.name).toBe("FEATURE_MODE");
    expect(switches[0]!.why).toContain("required by the merged code");
    expect(switches[0]!.why).not.toContain("fails closed");
  });

  /**
   * `.env` in a diff answers the question; every template shape asks it. The
   * suffix list is what keeps a sample file from being read as a settings file
   * and silencing every finding under it.
   */
  it("treats every template suffix as a question, not an answer", () => {
    const code = file("a.ts", `process.env.MY_API_KEY`);
    for (const name of [".env.sample", ".env.template", ".env.dist", "env.example"]) {
      expect(named([code, file(name, "MY_API_KEY=placeholder")])).toEqual(["MY_API_KEY"]);
    }
    // A real `.env` variant is an answer and silences it.
    expect(scanDarkSwitches([code, file(".env.local", "MY_API_KEY=real")])).toEqual([]);
  });

  /**
   * Eleven cards carrying the same three sentences is the shape a reader learns
   * to scroll past — and the entries that genuinely need separate handling get
   * scrolled past with them. One card, one list, one set of steps.
   */
  it("groups the variables one file declares into a single job", () => {
    const switches = scanDarkSwitches([file("backend/.env.example", "A_API_KEY=\nB_SECRET=\nC_TOKEN=")]);
    expect(switches).toHaveLength(1);
    expect(switches[0]!.name).toBe("3 unset variables");
    expect(switches[0]!.steps[1]!.command).toBe("gh secret set A_API_KEY\ngh secret set B_SECRET\ngh secret set C_TOKEN");
  });

  it("names the single one when a file declares only one", () => {
    const switches = scanDarkSwitches([file(".env.example", "ONLY_API_KEY=")]);
    expect(switches[0]!.name).toBe("ONLY_API_KEY");
    expect(switches[0]!.steps[1]!.command).toBe("gh secret set ONLY_API_KEY");
  });

  it("reports a name once however many times it is read", () => {
    expect(named([file("a.ts", `process.env.MY_API_KEY; process.env.MY_API_KEY`), file("b.ts", `process.env.MY_API_KEY`)])).toEqual(["MY_API_KEY"]);
  });

  it("does not scan files that are not source", () => {
    expect(scanDarkSwitches([file("README.md", `process.env.MY_API_KEY`)])).toEqual([]);
  });
});

describe("infrastructure the run declared and no agent could apply", () => {
  it("recognises terraform, cloudformation and kubernetes", () => {
    const files = [
      file("infra/s3.tf", `resource "aws_s3_bucket" "packs" {}`),
      file("template.yaml", `AWSTemplateFormatVersion: "2010-09-09"\nResources: {}`),
      file("k8s/deploy.yaml", `apiVersion: apps/v1\nkind: Deployment`),
    ];
    expect(kinds(files)).toEqual(["infrastructure", "infrastructure", "infrastructure"]);
    // Sorted by name within a kind, not by the order they came out of the diff.
    expect(scanDarkSwitches(files).map((s) => s.steps[1]!.command)).toEqual([
      "terraform plan   # then, once it reads right: terraform apply",
      // The placeholder is filled in with the directory that is actually applied.
      "kubectl apply --dry-run=server -f k8s   # then without the dry run",
      "sam deploy --no-execute-changeset   # review the changeset, then execute it",
    ]);
  });

  /**
   * A Terraform module is sixteen files and one `terraform apply`. Sixteen
   * cards saying the same sentence is the shape a reader scrolls past — and
   * the reader who does scrolls past the DNS and the secrets under it too.
   */
  it("groups a module into the one apply that covers it", () => {
    const module = ["alb", "ecs", "iam", "kms"].map((n) => file(`infra/terraform/modules/compute/${n}.tf`, `resource "aws_x" "${n}" {}`));
    const other = [file("infra/terraform/modules/data/s3.tf", `resource "aws_s3_bucket" "b" {}`)];
    const switches = scanDarkSwitches([...module, ...other]);

    expect(switches.map((s) => s.name)).toEqual(["4 Terraform files in infra/terraform/modules/compute", "infra/terraform/modules/data/s3.tf"]);
    expect(switches[0]!.where).toBe(module.map((f) => f.path).join(", "));
    expect(switches[0]!.steps[1]!.command).toContain("terraform");
  });

  it("keeps a root-level template out of a directory it does not have", () => {
    const switches = scanDarkSwitches([file("template.yaml", `AWSTemplateFormatVersion: "2010-09-09"`), file("other.yaml", `AWSTemplateFormatVersion: "2010-09-09"`)]);
    expect(switches[0]!.name).toBe("2 CloudFormation files in .");
  });

  it("ignores a .tf file with no resources and yaml that is not a manifest", () => {
    expect(scanDarkSwitches([file("infra/vars.tf", `variable "region" {}`), file("ci.yaml", `on: push`)])).toEqual([]);
  });
});

describe("DNS, which fails somewhere the template may not reach", () => {
  it("is its own kind, not a subset of infrastructure", () => {
    const switches = scanDarkSwitches([file("infra/dns.tf", `resource "aws_route53_record" "api" {}`)]);
    // The file is both: a stack to apply, and a name that has to resolve.
    expect(switches.map((s) => s.kind)).toEqual(["infrastructure", "dns"]);
    expect(switches[1]!.name).toBe("infra/dns.tf (api)");
  });

  it("recognises the other record providers and the certificate cases", () => {
    expect(named([file("cf.tf", `resource "cloudflare_record" "www" {}`)])).toContain("cf.tf (www)");
    expect(named([file("dc.tf", `resource "dns-project_record" "mx" {}`)])).toContain("dc.tf (mx)");
    expect(named([file("cfn.yaml", `AWS::Route53::RecordSet`)])).toEqual(["cfn.yaml"]);
    expect(named([file("acm.yaml", `AWS::CertificateManager::Certificate`)])).toEqual(["acm.yaml"]);
    expect(named([file("issuer.yaml", `solvers:\n  - dns01: {}`)])).toEqual(["issuer.yaml"]);
  });

  /**
   * A CloudFormation template that declares a record *and* the certificate that
   * needs it matches two rules with no name of their own, and both resolve to
   * the file. One job, one card.
   */
  it("reports a file once when two different declarations both point at it", () => {
    const switches = scanDarkSwitches([file("cfn.yaml", `AWS::Route53::RecordSet\nAWS::CertificateManager::Certificate`)]);
    expect(switches.filter((s) => s.kind === "dns")).toHaveLength(1);
  });

  /**
   * Restricting the search to templates was not enough: a template is mostly
   * YAML, and YAML is mostly comments and descriptions. Run 1e7d3df3 matched
   * `dns01` in an OpenAPI description — where `acme-dns01` names a *token
   * scope* — and in a comment naming which ClusterIssuer the cluster uses.
   */
  it("matches a solver key, not the word in a comment or a description", () => {
    expect(scanDarkSwitches([file("k8s/api.yaml", "# nginx ingress, per-project dns01 ClusterIssuer\nkey: value")])).toEqual([]);
    expect(scanDarkSwitches([file("docs/openapi.yaml", "      * `acme-dns01` — bound to one zone; may call only")])).toEqual([]);
    expect(kinds([file("k8s/issuer.yaml", "    solvers:\n      - dns01:\n          route53: {}")])).toEqual(["dns"]);
  });

  it("ignores a commented-out record or certificate", () => {
    expect(scanDarkSwitches([file("cfn.yaml", "  # AWS::Route53::RecordSet — add this later")])).toEqual([]);
    expect(scanDarkSwitches([file("cfn2.yaml", "  # AWS::CertificateManager::Certificate is declared in the other stack")])).toEqual([]);
    expect(kinds([file("cfn3.yaml", "  Type: AWS::Route53::RecordSet")])).toEqual(["dns"]);
  });

  it("reports one file once however many records it declares", () => {
    const switches = scanDarkSwitches([file("dns.tf", `resource "aws_route53_record" "a" {}\nresource "aws_route53_record" "b" {}`)]);
    expect(switches.filter((s) => s.kind === "dns")).toHaveLength(1);
  });
});

describe("migrations, which are dark in the most abrupt way", () => {
  it("finds them by path and by content", () => {
    expect(kinds([file("db/migrate/001_orders.rb", "add_column :orders")])).toEqual(["migration"]);
    expect(kinds([file("schema/init.sql", "CREATE TABLE orders (id text)")])).toEqual(["migration"]);
  });

  it("reports the set once rather than once per file", () => {
    const switches = scanDarkSwitches([file("migrations/001.sql", "CREATE TABLE a (id text)"), file("migrations/002.sql", "ALTER TABLE a ADD b text")]);
    expect(switches).toHaveLength(1);
    expect(switches[0]!.name).toBe("2 migrations");
    expect(switches[0]!.where).toBe("migrations/001.sql, migrations/002.sql");
  });

  it("names the file when there is only one", () => {
    expect(named([file("migrations/001.sql", "CREATE TABLE a (id text)")])).toEqual(["migrations/001.sql"]);
  });

  it("says nothing about a .sql file that only reads", () => {
    expect(scanDarkSwitches([file("queries/report.sql", "SELECT * FROM orders")])).toEqual([]);
  });
});

describe("flags shipped in the off position", () => {
  it("finds a switch that defaults off, in the shapes config actually uses", () => {
    expect(named([file("a.ts", `const enableCheckout = false;`)])).toEqual(["enableCheckout"]);
    expect(named([file("flags.json", `{"featureNewNav": false}`)])).toEqual(["featureNewNav"]);
    expect(named([file("b.ts", `FEATURE_PACKS: "off"`)])).toEqual(["FEATURE_PACKS"]);
    expect(named([file("c.yaml", `enableBeta: 0`)])).toEqual(["enableBeta"]);
  });

  /**
   * The narrowest rule here on purpose: "a line with false on it" is most of a
   * codebase, and a section full of ordinary state is a section nobody reads.
   */
  it("says nothing about ordinary state that happens to be false", () => {
    expect(scanDarkSwitches([file("a.ts", `const isDeleted = false; let ready = false; const done = 0;`)])).toEqual([]);
  });

  it("reports a flag once and does not scan prose", () => {
    expect(named([file("a.ts", `enableX = false;\nenableX = false;`)])).toEqual(["enableX"]);
    expect(scanDarkSwitches([file("NOTES.md", `enableX = false`)])).toEqual([]);
  });
});

describe("precision, which is the whole value of the section", () => {
  /**
   * Run 1e7d3df3's first report listed 23 switches, 17 of them wrong: `dns01`
   * is a cert-manager solver in a manifest and an ordinary noun in a guide
   * *about* cert-manager, and it was matching Go source, Markdown and a `.bats`
   * runbook. A section where the first three rows are wrong is a section whose
   * real rows are never read.
   */
  it("reads DNS out of things that declare infrastructure, not things that discuss it", () => {
    const declaration = `solvers:\n  - dns01:\n      route53: {}`;
    // The same declaration quoted in a guide, a Go file or a README declares
    // nothing — it is someone explaining what to write.
    for (const path of ["docs/guides/cert-manager.md", "internal/api/server.go", "frontend/src/api/client.ts", "README.md"]) {
      expect(scanDarkSwitches([file(path, declaration)])).toEqual([]);
    }
    expect(kinds([file("deploy/issuer.yaml", declaration)])).toEqual(["dns"]);
  });

  it("does not ask the operator to seed a test's fixtures", () => {
    for (const path of ["internal/store/conformance_test.go", "src/api/client.test.ts", "tests/setup.ts", "e2e/login.spec.ts", "deploy/tests/cutover.bats"]) {
      expect(scanDarkSwitches([file(path, `process.env.MY_API_KEY; os.Getenv("MY_API_KEY")`)])).toEqual([]);
    }
    // The same read in a file that actually runs is a finding.
    expect(named([file("internal/store/store.go", `os.Getenv("MY_API_KEY")`)])).toEqual(["MY_API_KEY"]);
  });

  it("does not read a flag a test switched off as a flag the product shipped off", () => {
    expect(scanDarkSwitches([file("src/checkout.test.ts", `enableCheckout = false`)])).toEqual([]);
    expect(named([file("src/checkout.ts", `enableCheckout = false`)])).toEqual(["enableCheckout"]);
  });

  /**
   * Infrastructure is deliberately not filtered this way: a manifest under
   * `tests/` is usually the test *environment*, and one that was never applied
   * is still a thing that does not exist.
   */
  it("still reports a manifest that lives under a tests directory", () => {
    expect(kinds([file("deploy/tests/fixture.tf", `resource "aws_s3_bucket" "b" {}`)])).toEqual(["infrastructure"]);
  });
});

describe("the order the operator reads them in", () => {
  /**
   * Worst first, because the reader stops somewhere: a credential and an
   * unapplied stack are total, a flag is a decision, and a warning below the
   * fold is a warning that did not arrive.
   */
  it("puts what is totally broken above what is merely a decision", () => {
    const files = [
      file("flags.ts", `enableCheckout = false`),
      file("migrations/001.sql", "CREATE TABLE a (id text)"),
      file("dns.tf", `resource "aws_route53_record" "api" {}`),
      file("app.ts", `process.env.MY_API_KEY`),
    ];
    expect(kinds(files)).toEqual(["secret", "infrastructure", "dns", "migration", "flag"]);
  });

  it("finds nothing in a diff that declares nothing", () => {
    expect(scanDarkSwitches([file("README.md", "# hello"), file("src/util.ts", "export const add = (a: number, b: number) => a + b;")])).toEqual([]);
    expect(scanDarkSwitches([])).toEqual([]);
  });
});

/**
 * Asked before the caller fetches the bytes, because on a large run that fetch
 * is a subprocess per file: run f338b5c8 changed enough that reading every blob
 * took longer than the command was worth waiting for. Every rule above keys off
 * the path before it looks at the text, so the same question can be asked
 * first — and the answer has to agree with what the rules would have done.
 */
describe("deciding what is even worth reading", () => {
  it("says yes to everything a rule above could fire on", () => {
    for (const path of [
      "src/app.ts",
      "backend/main.go",
      "infra/main.tf",
      "k8s/deploy.yaml",
      "template.json",
      ".env",
      "backend/.env.example",
      "db/migrate/001_orders.rb",
      "schema/init.sql",
      "config/app.toml",
    ]) {
      expect(scannable(path)).toBe(true);
    }
  });

  it("says no to the bulk of a diff, which can declare nothing", () => {
    for (const path of ["pnpm-lock.yaml".replace("yaml", "txt"), "README.md", "docs/guide.mdx", "logo.png", "report.pdf", "vendor/blob.bin", "CHANGELOG"]) {
      expect(scannable(path)).toBe(false);
    }
  });

  it("still reads a manifest under a tests directory, and skips the tests themselves", () => {
    expect(scannable("deploy/tests/fixture.tf")).toBe(true);
    expect(scannable("src/api/client.test.ts")).toBe(false);
    expect(scannable("internal/store/store_test.go")).toBe(false);
    expect(scannable("deploy/k8s/tests/cutover.bats")).toBe(false);
  });

  /**
   * The predicate and the rules have to agree: a file the rules would fire on
   * and the predicate skips is a switch that silently never appears.
   */
  it("never skips a file the rules would have found something in", () => {
    const cases: ScannedFile[] = [
      file("src/app.ts", `process.env.MY_API_KEY`),
      file("backend/.env.example", "MY_API_KEY="),
      file("infra/main.tf", `resource "aws_route53_record" "a" {}`),
      file("k8s/issuer.yaml", "solvers:\n  - dns01:\n      route53: {}"),
      file("migrations/001.sql", "CREATE TABLE a (id text)"),
      file("flags.json", `{"enableCheckout": false}`),
    ];
    for (const c of cases) {
      expect(scanDarkSwitches([c]).length).toBeGreaterThan(0);
      expect(scannable(c.path)).toBe(true);
    }
  });
});
