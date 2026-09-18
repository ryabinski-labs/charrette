import { describe, expect, it } from "vitest";
import { parseRunbook, renderRunbook, runbookEmail, withRunbook } from "./operatorRunbook.js";

const full = {
  blocked: "the endpoints have to be deployed and called with a real magic-link token",
  steps: [
    { do: "Merge the endpoint pull request", command: "gh pr merge 1631 --squash --repo ryabinski-labs/api-service" },
    { do: "Wait for CD to finish", command: "gh run watch --repo ryabinski-labs/api-service" },
    { do: "Sign in as an account you own and copy the bearer token out of devtools" },
  ],
  sendBack: "the HTTP status and the first line of the JSON body from step 3",
};

describe("reading the advisor's runbook", () => {
  it("takes the documented shape whole", () => {
    expect(parseRunbook(full)).toEqual(full);
  });

  /**
   * The three shapes a model reaches for when it has not read the schema
   * closely. All three mean the same thing, and dropping the runbook over the
   * field name loses exactly the part the operator needed.
   */
  it("takes a bare string as a step with no command", () => {
    expect(parseRunbook({ steps: ["approve the plan in the console"] })).toEqual({
      blocked: "",
      steps: [{ do: "approve the plan in the console" }],
      sendBack: "",
    });
  });

  it("takes step/cmd and send_back as the names they are", () => {
    const rb = parseRunbook({ blocked: "needs a credential", steps: [{ step: "issue the key", cmd: "aws iam create-access-key" }], send_back: "the key id" });
    expect(rb).toEqual({ blocked: "needs a credential", steps: [{ do: "issue the key", command: "aws iam create-access-key" }], sendBack: "the key id" });
  });

  it("keeps a command that arrived without prose, using it as its own description", () => {
    expect(parseRunbook({ steps: [{ command: "sam deploy --guided" }] })?.steps).toEqual([{ do: "sam deploy --guided", command: "sam deploy --guided" }]);
  });

  it("is null when there is no step worth showing", () => {
    expect(parseRunbook(null)).toBeNull();
    expect(parseRunbook("a runbook, honestly")).toBeNull();
    expect(parseRunbook(["do this"])).toBeNull();
    expect(parseRunbook({ blocked: "something" })).toBeNull();
    expect(parseRunbook({ steps: "not a list" })).toBeNull();
    expect(parseRunbook({ steps: [{}, null, 7, "  "] })).toBeNull();
  });

  it("bounds a model that decides to write an essay", () => {
    const rb = parseRunbook({
      blocked: "x".repeat(400),
      steps: Array.from({ length: 30 }, (_, i) => ({ do: `step ${i}`.padEnd(400, "y"), command: "z".repeat(900) })),
      sendBack: "s".repeat(400),
    })!;
    expect(rb.steps).toHaveLength(12);
    expect(rb.blocked).toHaveLength(300);
    expect(rb.sendBack).toHaveLength(300);
    expect(rb.steps[0]!.do).toHaveLength(300);
    expect(rb.steps[0]!.command).toHaveLength(600);
  });
});

describe("what the operator reads", () => {
  it("numbers the steps and indents the commands", () => {
    const out = renderRunbook(parseRunbook(full));
    expect(out).toContain("This part is yours, not the agent's: the endpoints have to be deployed");
    expect(out).toContain("1. Merge the endpoint pull request");
    expect(out).toContain("       gh pr merge 1631 --squash --repo ryabinski-labs/api-service");
    expect(out).toContain("3. Sign in as an account you own");
    expect(out).toContain("Then answer this gate with: the HTTP status and the first line");
  });

  it("still says the gate is waiting on a paste when the advisor forgot to say so", () => {
    const out = renderRunbook({ blocked: "", steps: [{ do: "restart the mail host" }], sendBack: "" });
    expect(out.startsWith("This part is yours, not the agent's.")).toBe(true);
    expect(out).toContain("what came back — the output, not just that it is done");
  });

  it("renders nothing at all for no runbook", () => {
    expect(renderRunbook(null)).toBe("");
  });

  it("puts the steps above the advisor's prose, because that is the half that gets done", () => {
    const out = withRunbook("QA is right about the missing fixture.", parseRunbook(full));
    expect(out.indexOf("1. Merge the endpoint")).toBeLessThan(out.indexOf("QA is right"));
    expect(out).toContain("\n\n---\n\n");
  });

  it("leaves the recommendation alone when there is no runbook, and stands alone when there is no prose", () => {
    expect(withRunbook("just retry it", null)).toBe("just retry it");
    expect(withRunbook("", parseRunbook(full))).toBe(renderRunbook(parseRunbook(full)));
  });
});

describe("the same runbook as mail", () => {
  it("names the project in the subject, lists the steps, and links back to the gate", () => {
    const mail = runbookEmail("api-service", "api-deploy-and-live-endpoint-proof", parseRunbook(full), "http://127.0.0.1:4781/#tok", "QA could not reach the deployed host.");
    expect(mail.subject).toBe("api-service: api-deploy-and-live-endpoint-proof needs you");
    expect(mail.html).toContain("<ol>");
    expect(mail.html).toContain("<code>gh pr merge 1631 --squash --repo ryabinski-labs/api-service</code>");
    expect(mail.html).toContain("<strong>Send back:</strong> the HTTP status");
    expect(mail.html).toContain('<a href="http://127.0.0.1:4781/#tok">');
    expect(mail.html).toContain("QA could not reach the deployed host.");
    expect(mail.text).toContain("1. Merge the endpoint pull request");
    expect(mail.text).toContain("Answer the gate: http://127.0.0.1:4781/#tok");
  });

  /**
   * Mail is the one channel that carries a model's words into somebody else's
   * renderer. A task title with a `<` in it must not become markup.
   */
  it("escapes everything that reaches the HTML", () => {
    const mail = runbookEmail("proj<x>", "task & <b>bold</b>", { blocked: '"quoted"', steps: [{ do: "a < b", command: "echo '<script>'" }], sendBack: "x > y" }, "", "");
    expect(mail.html).toContain("task &amp; &lt;b&gt;bold&lt;/b&gt;");
    expect(mail.html).toContain("&quot;quoted&quot;");
    expect(mail.html).toContain("echo &#39;&lt;script&gt;&#39;");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<b>bold</b>");
  });

  it("says something useful with no runbook, no link and no prose", () => {
    const mail = runbookEmail("proj", "some-task", null, "", "");
    expect(mail.html).toContain("This task stopped on something an agent cannot do.");
    expect(mail.html).toContain("the output of the steps above, not just that they are done");
    expect(mail.html).not.toContain("<a href");
    expect(mail.html).not.toContain("<hr>");
    expect(mail.text).toContain("proj — some-task");
    expect(mail.text).not.toContain("Answer the gate:");
  });

  it("drops the step list rather than emitting an empty one", () => {
    expect(runbookEmail("proj", "t", { blocked: "b", steps: [], sendBack: "s" }, "", "").html).not.toContain("<ol>");
  });
});
