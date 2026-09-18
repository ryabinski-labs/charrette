import { describe, expect, it } from "vitest";
import { deployCapabilities, namedIamResources, renderDeployCapability, scanDeployCapability } from "./deployCapability.js";

/**
 * The template and the workflow that actually failed, trimmed to the shape
 * that matters. api-service's CD run a CD run refused the changeset
 * with `Requires capabilities : [CAPABILITY_NAMED_IAM]` after the merge, on
 * main, having passed `sam validate --lint`, `sam build`, a 100%-coverage
 * suite and a green pull request on the way there.
 */
const TEMPLATE = `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  DeliveryLogTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: !Ref DeliveryLogTableName
  DeliveryLogRunnerPolicy:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: delivery-log-runner-write
      PolicyDocument:
        Version: "2012-10-17"
`;

const WORKFLOW = `name: CD
jobs:
  deploy:
    steps:
      - name: Deploy Lambda stack
        run: |
          sam deploy \\
            --stack-name "\${SAM_STACK_NAME}" \\
            --capabilities CAPABILITY_IAM \\
            --resolve-s3
`;

describe("IAM resources a template names itself", () => {
  it("finds the managed policy that broke the deployment", () => {
    expect(namedIamResources(TEMPLATE)).toEqual([
      { logicalId: "DeliveryLogRunnerPolicy", type: "AWS::IAM::ManagedPolicy", via: "ManagedPolicyName" },
    ]);
  });

  it("leaves a role whose name CloudFormation generates alone", () => {
    const template = `Resources:
  ApiFunctionRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
`;
    expect(namedIamResources(template)).toEqual([]);
  });

  it("reads a naming property written above the type", () => {
    // Both orders are correct YAML, and a resource whose Properties block comes
    // first would be invisible to a walk that only looked forward from `Type:`.
    const template = `Resources:
  Runner:
    Properties:
      RoleName: ci-runner
    Type: AWS::IAM::Role
`;
    expect(namedIamResources(template)).toEqual([{ logicalId: "Runner", type: "AWS::IAM::Role", via: "RoleName" }]);
  });

  it("stops at the next resource rather than borrowing its name", () => {
    const template = `Resources:
  Generated:
    Type: AWS::IAM::Role
    Properties:
      Path: /
  Named:
    Type: AWS::IAM::User
    Properties:
      UserName: someone
`;
    expect(namedIamResources(template).map((r) => r.logicalId)).toEqual(["Named"]);
  });

  it("counts an inline policy with no property to look at", () => {
    // PolicyName is required on AWS::IAM::Policy, so declaring one at all needs
    // the named acknowledgement.
    const template = `Resources:
  Inline:
    Type: AWS::IAM::Policy
    Properties:
      PolicyName: whatever
`;
    expect(namedIamResources(template)).toEqual([{ logicalId: "Inline", type: "AWS::IAM::Policy", via: "PolicyName (required)" }]);
  });

  it("ignores IAM types that have no name of their own", () => {
    const template = `Resources:
  Attachment:
    Type: AWS::IAM::RolePolicyAttachment
    Properties:
      RoleName: given
`;
    expect(namedIamResources(template)).toEqual([]);
  });

  it("ignores a type declaration with no resource above it", () => {
    expect(namedIamResources("Type: AWS::IAM::Role\n")).toEqual([]);
  });

  it("reads a quoted type and a trailing comment", () => {
    const template = `Resources:
  Quoted:
    Type: "AWS::IAM::Group"  # the one the console made
    Properties:
      GroupName: admins
`;
    expect(namedIamResources(template).map((r) => r.via)).toEqual(["GroupName"]);
  });
});

describe("what a deploy file acknowledges", () => {
  it("reads the capabilities out of a multi-line sam deploy", () => {
    expect(deployCapabilities(WORKFLOW)).toEqual(["CAPABILITY_IAM"]);
  });

  it("says nothing about a file that deploys nothing", () => {
    expect(deployCapabilities("name: CI\njobs:\n  test:\n    steps:\n      - run: pytest\n")).toBeNull();
  });

  it("reads a raw cloudformation call and de-duplicates repeats", () => {
    const script = `aws cloudformation create-change-set --capabilities CAPABILITY_IAM
aws cloudformation deploy --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM`;
    expect(deployCapabilities(script)).toEqual(["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"]);
  });

  it("reports a deploy that acknowledges nothing at all", () => {
    expect(deployCapabilities("sam deploy --stack-name app\n")).toEqual([]);
  });
});

describe("the gap between them", () => {
  it("names the resource, the deployer and what it passes", () => {
    const findings = scanDeployCapability(
      [{ path: "template.yaml", text: TEMPLATE }],
      [{ path: ".github/workflows/cd.yml", text: WORKFLOW }]
    );
    expect(findings).toEqual([
      {
        template: "template.yaml",
        deployer: ".github/workflows/cd.yml",
        capabilities: ["CAPABILITY_IAM"],
        resources: [{ logicalId: "DeliveryLogRunnerPolicy", type: "AWS::IAM::ManagedPolicy", via: "ManagedPolicyName" }],
      },
    ]);
  });

  it("is quiet once the deploy acknowledges named IAM", () => {
    const fixed = WORKFLOW.replace("CAPABILITY_IAM", "CAPABILITY_IAM CAPABILITY_NAMED_IAM");
    expect(scanDeployCapability([{ path: "template.yaml", text: TEMPLATE }], [{ path: "cd.yml", text: fixed }])).toEqual([]);
  });

  it("is quiet when the change declares no named resource", () => {
    const plain = "Resources:\n  Table:\n    Type: AWS::DynamoDB::Table\n";
    expect(scanDeployCapability([{ path: "template.yaml", text: plain }], [{ path: "cd.yml", text: WORKFLOW }])).toEqual([]);
  });

  it("is quiet when the changed files are not templates", () => {
    expect(scanDeployCapability([{ path: "app/main.py", text: TEMPLATE }], [{ path: "cd.yml", text: WORKFLOW }])).toEqual([]);
  });

  it("is quiet when nothing in the repo deploys", () => {
    // A repo whose deployment this cannot see is a repo it says nothing about.
    // Guessing here would put a paragraph in front of QA on ordinary work.
    expect(scanDeployCapability([{ path: "template.yaml", text: TEMPLATE }], [{ path: "README.md", text: "how to run it" }])).toEqual([]);
  });
});

describe("what the reviewer reads", () => {
  const findings = scanDeployCapability(
    [{ path: "template.yaml", text: TEMPLATE }],
    [{ path: ".github/workflows/cd.yml", text: WORKFLOW }]
  );

  it("says nothing when there is nothing to say", () => {
    expect(renderDeployCapability([])).toBe("");
  });

  it("quotes the error the deployment would give and both ways out", () => {
    const note = renderDeployCapability(findings);
    expect(note).toContain("template.yaml names DeliveryLogRunnerPolicy (AWS::IAM::ManagedPolicy, via ManagedPolicyName)");
    expect(note).toContain(".github/workflows/cd.yml deploys with CAPABILITY_IAM");
    expect(note).toContain("Requires capabilities : [CAPABILITY_NAMED_IAM]");
    expect(note).toContain("add CAPABILITY_NAMED_IAM alongside CAPABILITY_IAM");
    expect(note).toContain("drop the explicit name");
    expect(note).toContain("This is a FAIL rather than a note.");
  });

  it("spells out a deploy that passes no capabilities at all", () => {
    const none = scanDeployCapability([{ path: "template.yaml", text: TEMPLATE }], [{ path: "deploy.sh", text: "sam deploy --stack-name app\n" }]);
    expect(renderDeployCapability(none)).toContain("deploy.sh deploys with no --capabilities at all");
  });
});
