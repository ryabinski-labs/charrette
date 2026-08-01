import { describe, expect, it } from "vitest";
import { runDeterministicChecks } from "./qa.js";

describe("deterministic checks", () => {
  it("reports failures in the configured order, whatever order they finish in", async () => {
    const result = await runDeterministicChecks("/tmp", ["sleep 0.3; echo slowfail >&2; false", "echo fastfail >&2; false", "true"]);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.command)).toEqual(["sleep 0.3; echo slowfail >&2; false", "echo fastfail >&2; false"]);
    expect(result.failures[0]!.output).toContain("slowfail");
  });

  it("runs the commands concurrently — wall clock is the slowest check, not the sum", async () => {
    const started = Date.now();
    const result = await runDeterministicChecks("/tmp", ["sleep 0.6", "sleep 0.6", "sleep 0.6"]);
    expect(result.ok).toBe(true);
    // Serial would be 1.8s+; allow generous headroom for a loaded machine.
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
