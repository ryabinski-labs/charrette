import { describe, expect, it } from "vitest";
import { RunConfig } from "@charrette/shared";
import { FileConfig } from "./defaults.js";

/**
 * The one place a typo in `agentEnv.allow` is still cheap.
 *
 * Both schemas are strict, so an invalid entry that one of them waved through
 * would either be silently ignored (the operator believes a key reaches the
 * agent when it does not) or accepted by the file and rejected only when the
 * run is already under way. The rule is checked at parse time in both.
 */

const RULE = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;

describe("agentEnv.allow validation", () => {
  it("SC-003-c an invalid allow entry is refused with the entry and the rule", () => {
    const file = FileConfig.safeParse({ agentEnv: { allow: ["1BAD-NAME"] } });
    expect(file.success).toBe(false);
    const message = file.success ? "" : file.error.issues.map((i) => i.message).join("\n");
    expect(message).toContain("1BAD-NAME");
    expect(message).toMatch(/A-Za-z_|prefix ending in \*/);

    expect(() => RunConfig.parse({ agentEnv: { allow: ["1BAD-NAME"] } })).toThrow(/1BAD-NAME/);
    expect(() => RunConfig.parse({ agentEnv: { allow: ["1BAD-NAME"] } })).toThrow(/A-Za-z_|prefix ending in \*/);

    // The rule accepts what the base list itself uses, and an absent block is
    // the allowlist rather than inherit — which is what keeps old runs working.
    for (const entry of ["STRIPE_TEST_KEY", "_PRIVATE", "LC_*", "CHARRETTE_*"]) {
      expect(RULE.test(entry)).toBe(true);
      expect(FileConfig.safeParse({ agentEnv: { allow: [entry] } }).success).toBe(true);
    }
    expect(RunConfig.parse({}).agentEnv).toEqual({ allow: [], inherit: false });
  });
});
