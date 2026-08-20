import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { infraGuardHook, infraMutation, unsatisfiableCriteria } from "./infraGuard.js";

const blocked = (cmd: string) => infraMutation(cmd) !== null;

describe("what counts as changing real infrastructure", () => {
  it("blocks the commands that provision, mutate or destroy", () => {
    for (const cmd of [
      "terraform apply",
      "terraform apply -auto-approve",
      "terraform -chdir=infra apply",
      "terraform destroy",
      "terraform state rm aws_s3_bucket.old",
      "tofu apply",
      "pulumi up --yes",
      "pulumi state delete urn:x",
      "cdk deploy MyStack",
      "cdk destroy",
      "helm install api ./chart",
      "helm upgrade --install api ./chart",
      "kubectl apply -f manifests/",
      "kubectl delete deploy/api",
      "kubectl scale deploy/api --replicas=0",
      "aws s3 rm s3://bucket/key",
      "aws ec2 terminate-instances --instance-ids i-123",
      "aws cloudformation delete-stack --stack-name prod",
      "aws iam create-user --user-name x",
      "gcloud compute instances create vm-1",
      "az group delete --name rg",
      "docker push registry.example.com/api:latest",
      "podman push registry.example.com/api:latest",
    ]) {
      expect(blocked(cmd), cmd).toBe(true);
    }
  });

  it("leaves the verification loop alone — that is how infra gets checked", () => {
    for (const cmd of [
      "terraform init -backend=false",
      "terraform validate",
      "terraform plan -out=tfplan",
      "terraform fmt -check",
      "tofu plan",
      "pulumi preview",
      "cdk synth",
      "cdk diff",
      "helm lint ./chart",
      "helm template api ./chart",
      "helm install api ./chart --dry-run",
      "kubectl apply -f manifests/ --dry-run=server",
      "kubectl diff -f manifests/",
      "kubectl get pods",
      "kubectl explain deployment.spec",
      "aws s3 ls s3://bucket",
      "aws ec2 describe-instances",
      "aws sts get-caller-identity",
      "gcloud compute instances list",
      "gcloud compute instances create vm-1 --dry-run",
      "az deployment group what-if --template-file main.bicep",
      "conftest test infra/",
      "checkov -d infra/",
      "tflint --recursive",
      "docker build -t api .",
      "npm test",
      "git commit -m 'wire up terraform'",
    ]) {
      expect(blocked(cmd), cmd).toBe(false);
    }
  });

  it("reads every segment of a compound command, not just the first", () => {
    // The realistic shape: an agent checks its work and then ships it.
    expect(blocked("terraform plan && terraform apply -auto-approve")).toBe(true);
    expect(blocked("cd infra; terraform validate; terraform apply")).toBe(true);
    expect(blocked("terraform plan | tee plan.txt")).toBe(false);
  });

  it("does not mistake prose about a command for the command", () => {
    // Quoted spans are stripped first, so writing about infrastructure — which
    // workers do constantly — is never a mutation.
    expect(blocked('git commit -m "add terraform apply step to the runbook"')).toBe(false);
    expect(blocked("echo 'run kubectl delete when decommissioning' >> README.md")).toBe(false);
    expect(blocked('grep -rn "helm upgrade" docs/')).toBe(false);
  });

  it("treats a live pod as production, not a workspace", () => {
    expect(blocked("kubectl exec -it api-0 -- sh")).toBe(true);
    expect(blocked("kubectl port-forward svc/db 5432:5432")).toBe(true);
  });

  it("distinguishes reading a bucket from writing to one", () => {
    expect(blocked("aws s3 cp s3://bucket/config.json ./config.json")).toBe(false);
    expect(blocked("aws s3 cp ./build s3://bucket/build --recursive")).toBe(true);
    expect(blocked("aws s3 sync ./dist s3://bucket/dist")).toBe(true);
  });

  it("survives an env-prefixed invocation", () => {
    expect(blocked("AWS_PROFILE=prod terraform apply")).toBe(true);
    expect(blocked("TF_LOG=DEBUG terraform plan")).toBe(false);
  });

  it("allows anything it does not recognise, rather than guessing", () => {
    // A denylist that grows into a permission system would break ordinary work.
    expect(blocked("./scripts/deploy.sh")).toBe(false);
    expect(blocked("make apply")).toBe(false);
  });

  it("follows the command through an inline shell", () => {
    // `bash -c` is the idiom an agent reaches for the moment it wants a `cd`
    // and a command together — and, read naively, the one that would make
    // every rule above decorative.
    expect(blocked('bash -c "cd infra && terraform apply -auto-approve"')).toBe(true);
    expect(blocked("sh -c 'kubectl delete ns staging'")).toBe(true);
    expect(blocked('bash -lc "terraform destroy"')).toBe(true);
    expect(blocked('bash -c "terraform plan && terraform show tfplan"')).toBe(false);
  });

  it("looks past wrappers that only prefix another command", () => {
    expect(blocked("timeout 600 terraform apply")).toBe(true);
    expect(blocked("sudo kubectl delete pod api-0")).toBe(true);
    expect(blocked("env TF_LOG=DEBUG terraform apply")).toBe(true);
    expect(blocked("nohup pulumi up --yes")).toBe(true);
    expect(blocked("timeout 600 terraform plan")).toBe(false);
  });

  it("does not read a heredoc body as commands", () => {
    // Writing the deployment runbook is ordinary work on an infra task, and a
    // runbook lists the commands a human runs, one per line.
    const runbook = ["cat > RUNBOOK.md <<'EOF'", "## Release", "terraform init", "terraform apply", "EOF"].join("\n");
    expect(blocked(runbook)).toBe(false);
    // A heredoc is not a hiding place either: the command after it still counts.
    expect(blocked("cat > x.md <<'EOF'\nnotes\nEOF\nterraform apply")).toBe(true);
  });

  it("does not split a quoted separator into a command of its own", () => {
    expect(blocked('echo "kubectl delete && kubectl apply -f x" >> notes.md')).toBe(false);
    expect(blocked('git commit -m "plan; terraform apply -auto-approve; done"')).toBe(false);
  });
});

describe("the guard as a PreToolUse hook", () => {
  const bash = (command: string) =>
    ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }) as unknown as HookInput;

  it("denies with a reason that names the safe verb instead", async () => {
    const out = (await infraGuardHook()(bash("terraform apply"))) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    const reason = out.hookSpecificOutput!.permissionDecisionReason!;
    expect(reason).toContain("`terraform apply`");
    expect(reason).toContain("`terraform plan`");
    // And it closes the obvious workaround: escalate, do not route around.
    expect(reason).toMatch(/do not try to work around this/);
  });

  it("stays out of the way of everything else", async () => {
    expect(await infraGuardHook()(bash("terraform plan"))).toEqual({});
    expect(await infraGuardHook()(bash("npm test"))).toEqual({});
    expect(await infraGuardHook()({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} } as unknown as HookInput)).toEqual({});
  });

  it("opens the gate when an operator genuinely wants provisioning", async () => {
    expect(await infraGuardHook(true)(bash("terraform apply"))).toEqual({});
  });
});

/**
 * The check that ran too late in run bc691359: tier1-three-arm-capture's
 * criteria required a committed teardown.log showing `terraform destroy`
 * completing, three workers each rediscovered that no session may run it, and
 * the escalation reached the operator only after all three had spent their
 * attempts. The criterion named the command on day one.
 */
describe("finding the criteria no worker will be allowed to satisfy", () => {
  it("catches a denied command quoted in backticks", () => {
    const found = unsatisfiableCriteria([
      {
        id: "tier1-three-arm-capture",
        acceptanceCriteria: ["teardown.log is committed and shows `terraform destroy` completing with the instances destroyed."],
      },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.taskId).toBe("tier1-three-arm-capture");
    expect(found[0]!.what).toBe("`terraform destroy`");
  });

  it("catches the same command written as prose, up to the end of its sentence", () => {
    const found = unsatisfiableCriteria([{ id: "t", acceptanceCriteria: ["The pipeline runs terraform apply against staging. A separate doc exists."] }]);
    expect(found.map((f) => f.what)).toEqual(["`terraform apply`"]);
  });

  it("does not read a backticked command's words as prose", () => {
    // The span is removed before the prose scan, so `terraform plan` in
    // backticks cannot be re-read as "terraform plan output is committed"
    // and accidentally matched against something later in the sentence.
    expect(unsatisfiableCriteria([{ id: "t", acceptanceCriteria: ["`terraform plan` output is committed for review, then apply is left to the operator."] }])).toEqual([]);
  });

  it("lets the verifying verbs through", () => {
    expect(
      unsatisfiableCriteria([
        { id: "a", acceptanceCriteria: ["`terraform validate` and `terraform plan` both exit 0."] },
        { id: "b", acceptanceCriteria: ["`kubectl apply --dry-run=server` succeeds against the rendered manifests."] },
        { id: "c", acceptanceCriteria: ["`cargo test --workspace` passes.", "The docker image builds."] },
      ])
    ).toEqual([]);
  });

  it("names every offending criterion, not just the first", () => {
    const found = unsatisfiableCriteria([
      { id: "a", acceptanceCriteria: ["`terraform apply` completes.", "`helm install api ./chart` succeeds."] },
      { id: "b", acceptanceCriteria: ["Nothing suspicious here."] },
    ]);
    expect(found.map((f) => [f.taskId, f.what])).toEqual([
      ["a", "`terraform apply`"],
      ["a", "`helm install`"],
    ]);
  });

  it("scans past an innocent mention of a tool to the guilty one", () => {
    // "docker" appears first and is harmless; the kubectl later in the same
    // criterion is not. One tool word must not shadow the next.
    const found = unsatisfiableCriteria([{ id: "t", acceptanceCriteria: ["The docker image is built, and kubectl delete removes the old deployment"] }]);
    expect(found.map((f) => f.what)).toEqual(["`kubectl delete`"]);
  });
});
