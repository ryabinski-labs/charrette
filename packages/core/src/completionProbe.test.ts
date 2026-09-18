import { describe, expect, it } from "vitest";
import { usableProbe } from "./completionProbe.js";

describe("the probe a planner is allowed to hand the charrette", () => {
  it("keeps the searches and checks that probes are actually made of", () => {
    expect(usableProbe(`! rg -q "Multi-agent priority" frontend/src`)).toBe(`! rg -q "Multi-agent priority" frontend/src`);
    expect(usableProbe("test $(rg -c TODO app | wc -l) -eq 0")).toBe("test $(rg -c TODO app | wc -l) -eq 0");
    expect(usableProbe("pytest tests/test_entitlements.py -q")).toBe("pytest tests/test_entitlements.py -q");
    expect(usableProbe("npx tsc --noEmit")).toBe("npx tsc --noEmit");
  });

  it("trims, and treats blank as no probe at all", () => {
    expect(usableProbe("  rg -q x  ")).toBe("rg -q x");
    expect(usableProbe("")).toBe("");
    expect(usableProbe("   ")).toBe("");
  });

  /**
   * This is the one command in the system an agent hands the charrette to run
   * with no human in between, so it passes the same guard an agent's own
   * commands pass. A probe that would provision or destroy is dropped, not
   * corrected — the task falls back to being judged by its criteria.
   */
  it("drops a probe that would change real infrastructure", () => {
    expect(usableProbe("terraform apply -auto-approve")).toBe("");
    expect(usableProbe("kubectl delete ns staging")).toBe("");
    expect(usableProbe("rg -q x && terraform destroy")).toBe("");
    expect(usableProbe("aws s3 rm s3://bucket/x")).toBe("");
  });

  it("keeps the read-only forms of the same tools", () => {
    expect(usableProbe("terraform validate")).toBe("terraform validate");
    expect(usableProbe("kubectl --dry-run=server apply -f k8s/")).toBe("kubectl --dry-run=server apply -f k8s/");
  });

  /**
   * The probe is run by the charrette, in the worktree, once per QA iteration —
   * which makes "may the charrette run this again?" exactly the question
   * `repeatable` already answers for the commands a demo agent offers as
   * evidence. Asking it a second way here is how two guards come to disagree,
   * and the disagreement was real: `npm install` and `curl -X POST` were struck
   * from a demo report as unrepeatable while the identical string was accepted
   * as a probe and run on every iteration.
   *
   * `npm install` is the one that would actually have happened. A planner
   * writing "the suite passes" as a probe reaches for `npm install && npm test`
   * without a second thought, and the install rewrites the tree the operator is
   * about to review, several times over.
   */
  it("drops a probe the charrette would refuse to re-run as evidence", () => {
    expect(usableProbe("npm install && npm test")).toBe("");
    expect(usableProbe("curl -X POST https://api.example.com/orders -d '{}'")).toBe("");
    expect(usableProbe("alembic upgrade head")).toBe("");
    expect(usableProbe("rm -rf /")).toBe("");
  });
});
