import { describe, expect, it } from "vitest";
import { declaredResources, pathMatches, pushTrigger, renderDeployOrder, scanDeployOrder, withoutComments } from "./deployOrder.js";

/**
 * The files that actually took the DNS service's console down, trimmed to the shape
 * that matters. Commit af60742 changed both `infra/aws/dynamodb/main.tf` and
 * `control-plane/internal/store/dynamostore.go`; PR #243 merged on
 * 2026-08-17T00:02:36Z with ten green checks; `deploy-web.yml` built and
 * rolled the image on that merge, against a `dns-service-sessions` table the run
 * had already confirmed did not exist.
 */
const TERRAFORM = `resource "aws_dynamodb_table" "control_plane" {
  name         = "dns-service-control-plane"
  billing_mode = "PAY_PER_REQUEST"
}

resource "aws_dynamodb_table" "sessions" {
  name         = "dns-service-sessions"
  billing_mode = "PAY_PER_REQUEST"

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}
`;

const DEPLOY_WEB = `name: Deploy web tier

# CD on merge to main, on the org's self-hosted runners.
on:
  push:
    branches: [main]
    paths:
      - 'frontend/**'
      - 'marketing/**'
      - 'control-plane/**'

jobs:
  api:
    steps:
      - run: kubectl rollout status deploy/dns-service-api
`;

/**
 * The near-miss that a lazier rule fails on. This repo really does run
 * `tofu apply` in CI — on workflow_dispatch, against a different stack. A
 * check that greps for the command and not its trigger goes quiet on the exact
 * repo that broke.
 */
const DEPLOY_EDGE = `name: Deploy edge (immutable image)

on:
  push:
    branches: [main]
    paths:
      - 'edge/**'
  workflow_dispatch:

jobs:
  deploy:
    name: roll droplets (terraform apply)
    if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'
    steps:
      - name: tofu apply (saved plan)
        run: tofu apply -input=false -lock-timeout=120s tfplan
`;

const CHANGED = [
  { path: "infra/aws/dynamodb/main.tf", text: TERRAFORM },
  { path: "control-plane/internal/store/dynamostore.go", text: "func (s *Store) IsSessionRevoked(...)" },
  { path: "control-plane/internal/api/auth.go", text: "a.revocations.IsSessionRevoked(...)" },
];

const WORKFLOWS = [
  { path: ".github/workflows/deploy-web.yml", text: DEPLOY_WEB },
  { path: ".github/workflows/deploy-edge.yml", text: DEPLOY_EDGE },
];

/** A deployer with no paths filter: everything the merge carries goes live. */
const WIDE_CD = {
  path: ".github/workflows/cd.yml",
  text: `on:\n  push:\n    branches: [main]\njobs:\n  ship:\n    steps:\n      - run: kubectl rollout restart deploy/api\n`,
};

describe("Terraform resources a change declares", () => {
  it("finds the table whose absence returned 503", () => {
    expect(declaredResources({ path: "infra/aws/dynamodb/main.tf", text: TERRAFORM })).toEqual([
      { file: "infra/aws/dynamodb/main.tf", type: "aws_dynamodb_table", name: "control_plane" },
      { file: "infra/aws/dynamodb/main.tf", type: "aws_dynamodb_table", name: "sessions" },
    ]);
  });

  it("says nothing about a file that is not Terraform", () => {
    expect(declaredResources({ path: "deploy/k8s/api.yaml", text: `resource "aws_s3_bucket" "x" {` })).toEqual([]);
  });

  it("ignores a module block, which is not the unit that gets created", () => {
    expect(declaredResources({ path: "main.tf", text: `module "vpc" {\n  source = "./vpc"\n}` })).toEqual([]);
  });
});

describe("what a workflow's push trigger says", () => {
  it("reads branches and paths off the CD workflow that shipped the outage", () => {
    expect(pushTrigger(DEPLOY_WEB)).toEqual({
      branches: ["main"],
      paths: ["frontend/**", "marketing/**", "control-plane/**"],
    });
  });

  it("reads the block-sequence form as well as the inline one", () => {
    expect(pushTrigger(`on:\n  push:\n    branches:\n      - main\n      - release\n`)).toEqual({
      branches: ["main", "release"],
      paths: null,
    });
  });

  it("treats a bare `on: push` as every branch and no path filter", () => {
    expect(pushTrigger(`on: push\njobs: {}\n`)).toEqual({ branches: [], paths: null });
    expect(pushTrigger(`on: [push, workflow_dispatch]\n`)).toEqual({ branches: [], paths: null });
  });

  it("is null for a scalar trigger that is not a push", () => {
    expect(pushTrigger(`on: workflow_dispatch\njobs: {}\n`)).toBeNull();
  });

  it("reads a push with paths but no branches as every branch", () => {
    expect(pushTrigger(`on:\n  push:\n    paths:\n      - 'src/**'\n`)).toEqual({ branches: [], paths: ["src/**"] });
  });

  it("is null for a file with no trigger block at all", () => {
    expect(pushTrigger(`name: nothing\njobs: {}\n`)).toBeNull();
  });

  it("does not read a trailing comment as the trigger", () => {
    // `on:` with a comment after it is a mapping, and its triggers are in the
    // block below. Reading the comment as the value decides the workflow fires
    // on something called "#" and stops looking.
    expect(pushTrigger(`on:  # what fires this\n  push:\n    branches: [main]\n`)).toEqual({ branches: ["main"], paths: null });
  });

  it("is null for a workflow no merge can trigger", () => {
    expect(pushTrigger(`on:\n  workflow_dispatch:\n    inputs:\n      node:\n        type: choice\n`)).toBeNull();
    expect(pushTrigger(`on:\n  pull_request:\n    branches: [main]\n`)).toBeNull();
  });

  it("does not read a pull_request paths filter as the push one", () => {
    const both = `on:\n  pull_request:\n    paths:\n      - 'docs/**'\n  push:\n    branches: [main]\n    paths:\n      - 'src/**'\n`;
    expect(pushTrigger(both)).toEqual({ branches: ["main"], paths: ["src/**"] });
  });
});

describe("reading steps rather than prose", () => {
  it("drops a whole-line and a trailing comment", () => {
    expect(withoutComments("# note\n  - run: go test\n")).toBe("\n  - run: go test\n");
    expect(withoutComments("  - run: make  # builds it")).toBe("  - run: make  ");
  });

  it("keeps a # that is part of a value", () => {
    expect(withoutComments(`  color: "#fff"`)).toBe(`  color: "#fff"`);
    expect(withoutComments(`  tag: 'sha#1'`)).toBe(`  tag: 'sha#1'`);
    expect(withoutComments("  - run: echo a#b")).toBe("  - run: echo a#b");
  });

  it("does not let an escaped quote end the string early", () => {
    expect(withoutComments(`  s: "a \\" # b" # gone`)).toBe(`  s: "a \\" # b" `);
  });

  it("leaves a line with no comment untouched", () => {
    expect(withoutComments("  - run: kubectl apply -f x.yaml")).toBe("  - run: kubectl apply -f x.yaml");
  });
});

describe("GitHub path filters", () => {
  it("crosses separators for ** and not for *", () => {
    expect(pathMatches("control-plane/**", "control-plane/internal/api/auth.go")).toBe(true);
    expect(pathMatches("control-plane/*", "control-plane/internal/api/auth.go")).toBe(false);
    expect(pathMatches("control-plane/*", "control-plane/main.go")).toBe(true);
  });

  it("matches a bare directory against everything beneath it", () => {
    expect(pathMatches("frontend", "frontend/src/app.tsx")).toBe(true);
    expect(pathMatches("frontend/", "frontend/src/app.tsx")).toBe(true);
  });

  it("lets ** swallow the separator that follows it", () => {
    expect(pathMatches("docs/**/*.md", "docs/runbooks/edge.md")).toBe(true);
    expect(pathMatches("docs/**/*.md", "docs/edge.md")).toBe(true);
    expect(pathMatches("docs/**/*.md", "docs/edge.txt")).toBe(false);
  });

  it("matches a single character for ?, and not a separator", () => {
    expect(pathMatches("infra/v?.tf", "infra/v2.tf")).toBe(true);
    expect(pathMatches("infra/v?.tf", "infra/v/2.tf")).toBe(false);
  });

  it("does not let a dot in the glob match any character", () => {
    expect(pathMatches("docs/openapi.yaml", "docs/openapiXyaml")).toBe(false);
    expect(pathMatches("docs/openapi.yaml", "docs/openapi.yaml")).toBe(true);
  });
});

describe("a merge that deploys ahead of its own prerequisite", () => {
  it("fires on the change that took the console down", () => {
    const findings = scanDeployOrder(CHANGED, WORKFLOWS);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.deployer).toBe(".github/workflows/deploy-web.yml");
    expect(findings[0]!.deploys).toBe("control-plane/internal/store/dynamostore.go");
    expect(findings[0]!.via).toBe("control-plane/**");
    expect(findings[0]!.resources.map((r) => r.name)).toEqual(["control_plane", "sessions"]);
  });

  it("is not silenced by a workflow_dispatch apply elsewhere in the repo", () => {
    // The whole point: deploy-edge.yml contains `tofu apply`, and it is still
    // a finding, because no human has run it at the moment the merge lands.
    expect(scanDeployOrder(CHANGED, [WORKFLOWS[1]!, WORKFLOWS[0]!])).toHaveLength(1);
  });

  it("goes quiet when the merge applies the configuration itself", () => {
    const applies = {
      path: ".github/workflows/infra.yml",
      text: `on:\n  push:\n    branches: [main]\njobs:\n  apply:\n    steps:\n      - run: tofu apply -auto-approve\n`,
    };
    expect(scanDeployOrder(CHANGED, [...WORKFLOWS, applies])).toEqual([]);
  });

  it("says nothing when the change declares no infrastructure", () => {
    expect(scanDeployOrder(CHANGED.slice(1), WORKFLOWS)).toEqual([]);
  });

  it("says nothing when the Terraform merges on its own", () => {
    expect(scanDeployOrder([CHANGED[0]!], WORKFLOWS)).toEqual([]);
  });

  it("says nothing when no workflow deploys on the merge", () => {
    const prOnly = [{ path: ".github/workflows/ci.yml", text: `on:\n  pull_request:\n    branches: [main]\n` }];
    expect(scanDeployOrder(CHANGED, prOnly)).toEqual([]);
  });

  it("says nothing about a repo whose deployment it cannot see", () => {
    expect(scanDeployOrder(CHANGED, [])).toEqual([]);
  });

  it("still fires when the deploying workflow has no paths filter at all", () => {
    const findings = scanDeployOrder(CHANGED, [WIDE_CD]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.via).toBe("");
  });

  it("does not report the Terraform file as the thing being deployed", () => {
    expect(scanDeployOrder(CHANGED, [WIDE_CD])[0]!.deploys).not.toBe("infra/aws/dynamodb/main.tf");
  });

  it("does not name a workflow that only builds and tests on the merge", () => {
    // Measured against forty commits each of dns-service, billing-app and rust-service, the
    // rule that asked only "does something run on the merge?" fired on all
    // twenty commits that touched a .tf file, because every repo's ci.yml runs
    // on push to main with no paths filter. Tests do not go live.
    const ci = [{ path: ".github/workflows/ci.yml", text: `on:\n  push:\n    branches: [main]\njobs:\n  test:\n    steps:\n      - run: go build ./...\n      - run: go test ./...\n` }];
    expect(scanDeployOrder(CHANGED, ci)).toEqual([]);
  });

  it("does not read a comment as a deploy, or as an apply that excuses one", () => {
    // dns-service's ci.yml carries the line `# unit-tested with doctl+dig faked.`,
    // which named it the deployer. The same read in reverse is worse: a note
    // saying the team runs `terraform apply` by hand satisfies the
    // merge-applies-it test and switches the gate off on the one repo whose
    // manual apply is the whole hazard.
    const chatty = { path: ".github/workflows/ci.yml", text: `on:\n  push:\n    branches: [main]\njobs:\n  test:\n    steps:\n      # unit-tested with doctl+dig faked.\n      - run: go test ./...\n` };
    expect(scanDeployOrder(CHANGED, [chatty])).toEqual([]);

    const excuse = { ...WIDE_CD, text: `${WIDE_CD.text}      # we run terraform apply by hand first\n` };
    expect(scanDeployOrder(CHANGED, [excuse])).toHaveLength(1);
  });

  it("names source rather than a README when both ship", () => {
    // Against dns-service's real history this reported a `.coveragerc`, a README
    // and a `_test.go` on three of five true findings. All of them do ship on
    // the merge, so the finding was sound — it just read like a false one.
    const docsFirst = [
      { path: "infra/aws/dynamodb/main.tf", text: TERRAFORM },
      { path: "control-plane/README.md", text: "# control plane" },
      { path: "control-plane/internal/api/auth_test.go", text: "func TestAuth(t *testing.T) {}" },
      { path: "control-plane/internal/api/auth.go", text: "a.revocations.IsSessionRevoked(...)" },
    ];
    expect(scanDeployOrder(docsFirst, WORKFLOWS)[0]!.deploys).toBe("control-plane/internal/api/auth.go");
  });

  it("still names a document when the merge ships nothing else", () => {
    const docsOnly = [
      { path: "infra/aws/dynamodb/main.tf", text: TERRAFORM },
      { path: "control-plane/README.md", text: "# control plane" },
    ];
    expect(scanDeployOrder(docsOnly, WORKFLOWS)[0]!.deploys).toBe("control-plane/README.md");
  });

  it("does not blame a workflow file for the code it ships", () => {
    const withWorkflow = [...CHANGED, { path: ".github/workflows/cd.yml", text: WIDE_CD.text }];
    expect(scanDeployOrder(withWorkflow, [WIDE_CD])[0]!.deploys).not.toMatch(/^\.github\//);
  });
});

describe("the paragraph QA reads", () => {
  it("is empty when there is nothing to say", () => {
    expect(renderDeployOrder([])).toBe("");
  });

  it("names the workflow, the file it ships, and the resource that will be missing", () => {
    const text = renderDeployOrder(scanDeployOrder(CHANGED, WORKFLOWS));
    expect(text).toContain(".github/workflows/deploy-web.yml");
    expect(text).toContain("control-plane/**");
    expect(text).toContain("aws_dynamodb_table.sessions");
    expect(text).toContain("infra/aws/dynamodb/main.tf");
  });

  it("rules out the fix that failed — a document that states the order", () => {
    const text = renderDeployOrder(scanDeployOrder(CHANGED, WORKFLOWS));
    expect(text).toContain("A runbook, a handover document or a plan that states the order is not one of these.");
    expect(text).toContain("workflow_dispatch apply does not count");
  });

  it("says so plainly when the deployer filters on no paths at all", () => {
    expect(renderDeployOrder(scanDeployOrder(CHANGED, [WIDE_CD]))).toContain("(no paths filter — it ships everything)");
  });

  it("says which direction to fix it in, and that it is a FAIL", () => {
    const text = renderDeployOrder(scanDeployOrder(CHANGED, WORKFLOWS));
    expect(text).toContain("tolerate the resource being absent");
    expect(text).toContain("This is a FAIL rather than a note.");
  });
});
