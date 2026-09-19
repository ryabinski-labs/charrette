import { describe, expect, it } from "vitest";
import { invocation } from "./shellParse.js";

/**
 * The two ways a shell is *not* carrying an inline script.
 *
 * `invocation` reaches past `sh -c "..."` so a guard reads the command that will
 * actually run rather than the shell that will run it. Both cases here fall
 * back to reporting the shell itself, which is the right answer: there is no
 * inner command to see past, and returning `null` or the wrong `bin` would take
 * a real invocation out of the guard's view entirely.
 */
describe("invocation past a shell", () => {
  it("reports the shell itself when there is no -c at all", () => {
    expect(invocation("bash deploy.sh --prod")).toEqual({ bin: "bash", args: ["deploy.sh", "--prod"] });
  });

  it("reports the shell itself when -c is given nothing to run", () => {
    // `sh -c -x` is malformed, but a guard that reads `undefined` as "nothing to
    // check" would wave through whatever came after it.
    expect(invocation("sh -c -x")).toEqual({ bin: "sh", args: ["-c", "-x"] });
  });

  it("still reaches the inline script when there is one", () => {
    expect(invocation("bash -c 'terraform apply'")).toEqual({ inline: "terraform apply" });
  });
});
