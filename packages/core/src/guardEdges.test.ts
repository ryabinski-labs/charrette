import { describe, expect, it } from "vitest";
import { priceFor, costUsd, BudgetExceeded } from "./budget.js";
import { infraGuardHook, infraMutation } from "./infraGuard.js";
import { plannerRepairPrompt, qaSystemPrompt, qaTaskPrompt, validatorPrompt, prodValidatorPrompt } from "./prompts.js";

const TASK = { id: "t1", title: "T", spec: "s", acceptanceCriteria: ["it works"] } as never;

/**
 * Arms of the guard, the pricer and the prompt builders that the happy path
 * never reaches. The infra guard's in particular are the ones that matter
 * most: agents run under `bypassPermissions`, so a command it fails to
 * recognise is a command that runs against the operator's account.
 */

describe("pricing a model nobody has priced", () => {
  it("prices a known model exactly", () => {
    expect(priceFor("claude-opus-5")).toEqual(expect.objectContaining({ in: expect.any(Number), out: expect.any(Number) }));
  });

  it("matches a dated variant against its family", () => {
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual(priceFor("claude-haiku-4-5"));
  });

  it("matches a family name against a longer key", () => {
    // The other direction: a bare family name where the table holds the dated id.
    const table = priceFor("claude-haiku");
    expect(table.in).toBeGreaterThan(0);
  });

  it("prices something it has never heard of at the top tier, never under", () => {
    // Under-pricing an unknown model is how a budget cap silently stops binding.
    expect(priceFor("some-future-model")).toEqual({ in: 5, out: 25 });
  });

  it("charges cache reads and writes at their own rates", () => {
    const plain = costUsd("claude-opus-5", { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const cached = costUsd("claude-opus-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 0 });

    expect(cached).toBeGreaterThan(0);
    expect(cached).toBeLessThan(plain);
  });
});

describe("what a budget refusal tells the operator", () => {
  it("says how to pick the run back up when it knows which run it was", () => {
    const e = new BudgetExceeded("run", 31.5, 30, "40da9337");

    expect(e.message).toContain("$31.50 >= $30.00");
    expect(e.message).toContain("harness resume 40da9337");
  });

  it("says only what it knows when there is no run to name", () => {
    const e = new BudgetExceeded("task", 11, 10);

    expect(e.message).toBe("task budget exceeded: $11.00 >= $10.00");
    expect(e.message).not.toContain("resume");
  });
});

describe("recognising an apply however it is written", () => {
  const denied = (cmd: string) => infraMutation(cmd)?.what;

  it("sees through a wrapper and its own flags", () => {
    expect(denied("timeout 300 terraform apply")).toBe("`terraform apply`");
    expect(denied("nice -n 10 terraform destroy")).toBe("`terraform destroy`");
    expect(denied("sudo -u deploy terraform apply")).toBe("`terraform apply`");
    expect(denied("env FOO=bar terraform apply")).toBe("`terraform apply`");
  });

  it("sees through leading environment assignments", () => {
    expect(denied("AWS_PROFILE=prod TF_LOG=debug terraform apply")).toBe("`terraform apply`");
  });

  it("sees through quoting and an absolute path", () => {
    expect(denied('"/usr/local/bin/terraform" apply')).toBe("`terraform apply`");
    expect(denied("/opt/homebrew/bin/terraform destroy")).toBe("`terraform destroy`");
  });

  it("sees an apply hidden behind a plan that succeeded", () => {
    expect(denied("terraform plan && terraform apply -auto-approve")).toBe("`terraform apply`");
  });

  it("gives up rather than looping on a command nested past any real idiom", () => {
    const nested = `bash -c "bash -c \\"bash -c 'bash -c \\\\\\"terraform apply\\\\\\"'\\""`;

    expect(infraMutation(nested)).toBeNull();
  });

  it("stops at a wrapper with nothing after it", () => {
    expect(infraMutation("timeout 300")).toBeNull();
    expect(infraMutation("sudo")).toBeNull();
  });

  it("allows the read-only halves of the same tools", () => {
    for (const safe of [
      "terraform plan",
      "terraform state list",
      "kubectl get pods",
      "kubectl describe deploy/api",
      "helm template ./chart",
      "aws s3 ls",
      "az group list",
    ]) {
      expect(infraMutation(safe), safe).toBeNull();
    }
  });

  it("denies a shell inside a live pod, which is not a read", () => {
    expect(denied("kubectl exec -it api-0 -- sh")).toBe("`kubectl exec`");
    expect(denied("kubectl port-forward svc/api 8080:80")).toBe("`kubectl port-forward`");
    expect(denied("kubectl cp ./x api-0:/tmp/x")).toBe("`kubectl cp`");
  });

  it("denies terraform state surgery by subcommand", () => {
    expect(denied("terraform state rm aws_s3_bucket.logs")).toBe("`terraform state rm`");
    expect(denied("terraform state mv a b")).toBe("`terraform state mv`");
    // `state list` and `state show` are reads.
    expect(infraMutation("terraform state show aws_s3_bucket.logs")).toBeNull();
  });

  it("takes a dry run at its word", () => {
    expect(infraMutation("kubectl apply -f manifest.yaml --dry-run=client")).toBeNull();
    expect(infraMutation("helm upgrade api ./chart --dry-run")).toBeNull();
    expect(infraMutation("az group create -n x -l y --what-if")).toBeNull();
  });

  it("says nothing about a bare verb with no command", () => {
    expect(infraMutation("kubectl")).toBeNull();
    expect(infraMutation("helm")).toBeNull();
    expect(infraMutation("az")).toBeNull();
    expect(infraMutation("terraform")).toBeNull();
  });

  it("names a plan or dry run for a tool it has no better advice for", () => {
    const found = infraMutation("kubectl delete ns prod");

    expect(found?.instead).toBeTruthy();
  });

  it("names the tool's own safe mode where there is one to name", () => {
    expect(infraMutation("terraform apply")?.instead).toMatch(/plan/i);
  });

  it("says nothing about a command that is only whitespace or separators", () => {
    expect(infraMutation("")).toBeNull();
    expect(infraMutation("   ")).toBeNull();
    expect(infraMutation("&& ||")).toBeNull();
  });

  it("reads past a heredoc body rather than parsing it as commands", () => {
    // The body is data, not a command list — a manifest that happens to
    // contain the word `apply` must not be read as running it.
    expect(infraMutation("cat <<'EOF' > out.yaml\nterraform apply\nEOF")).toBeNull();
  });

  it("gives up at the recursion floor", () => {
    // Depth is bounded so a pathological nesting cannot loop; past the floor
    // the guard reports nothing rather than spinning.
    expect(infraMutation("terraform apply", 4)).toBeNull();
  });
});

describe("the guard as the agent session runs it", () => {
  it("stays out of the way of anything that is not a Bash command", async () => {
    const hook = infraGuardHook();
    const fire = (input: unknown) => hook(input as never);

    expect(await fire({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "terraform apply" } })).toEqual({});
    expect(await fire({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} })).toEqual({});
  });

  it("stays out of the way of a Bash call with no command to inspect", async () => {
    const hook = infraGuardHook();
    const fire = (input: unknown) => hook(input as never);

    expect(await fire({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: null })).toEqual({});
    expect(await fire({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} })).toEqual({});
    expect(await fire({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "  " } })).toEqual({});
  });

  it("denies an apply and says what to do instead", async () => {
    const hook = infraGuardHook();

    const out = (await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "terraform apply -auto-approve" },
    } as never)) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("terraform apply");
  });
});

describe("prompts that change shape with what they are given", () => {
  it("tells a truncated planner to emit less, and a rejected one to fix what it emitted", () => {
    expect(plannerRepairPrompt("{...", "cut off", true)).toContain("SHORTER");
    expect(plannerRepairPrompt("{...}", "epics.0.id: Invalid")).toContain("epics.0.id: Invalid");
  });

  it("keeps only the tail of an enormous previous attempt", () => {
    const huge = `START${"x".repeat(80_000)}END`;

    const prompt = plannerRepairPrompt(huge, "too long");

    expect(prompt).toContain("END");
    expect(prompt).not.toContain("START");
  });

  it("carries the operator's mid-flight feedback into QA's judgement", () => {
    const withNote = qaTaskPrompt(TASK, "did the work", "1 file changed", "the table is never created");

    expect(withNote).toContain("the table is never created");
  });

  it("tells QA which red checks arrived through the base, so it does not fail the task for them", () => {
    const inherited = qaTaskPrompt(TASK, "did the work", "1 file changed", "", ["npm test"]);

    expect(inherited).toContain("somebody else's bug arriving through the base");
    expect(inherited).not.toContain("The operator sent feedback");
  });

  it("shows the validator the PRD when there is one, and copes when there is not", () => {
    expect(validatorPrompt("build it", "# The PRD", "- t1 merged", "1 file changed")).toContain("# The PRD");
    expect(validatorPrompt("build it", "", "- t1 merged", "1 file changed")).not.toContain("The PRD the plan was built from");
  });

  it("shows the production check the PRD when there is one, and copes when there is not", () => {
    const url = "https://app.example.com";

    expect(prodValidatorPrompt("build it", "# The PRD", url, "- t1 merged")).toContain("# The PRD");
    expect(prodValidatorPrompt("build it", "", url, "- t1 merged")).not.toContain("The PRD the plan was built from");
  });

  it("names running the application as QA's job, not reasoning about it", () => {
    expect(qaSystemPrompt("")).toContain("UNVERIFIED");
  });
});
