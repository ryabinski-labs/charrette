// @vitest-environment happy-dom

// The feed's describe() lives in the page's client script, which the compiler
// never parses and page.test.ts never calls — its cases were only ever
// syntax-checked. This extracts it the same way mount() does and executes the
// newest case, so a feed line that renders garbage fails a test instead of a
// dashboard.
import { describe as suite, expect, it } from "vitest";
import { PAGE_HTML } from "./page.js";

function extractDescribe(): (ev: Record<string, unknown>) => [string, string, string] {
  const opensAt = PAGE_HTML.indexOf("<script>");
  const closesAt = PAGE_HTML.indexOf("</script>");
  const source = PAGE_HTML.slice(opensAt + "<script>".length, closesAt);
  document.documentElement.innerHTML =
    (PAGE_HTML.slice(0, opensAt) + PAGE_HTML.slice(closesAt + "</script>".length))
      .replace(/^[\s\S]*?<html[^>]*>/, "")
      .replace(/<\/html>\s*$/, "");
  const factory = new Function("fetch", "setInterval", source + "\n;return { describe: describe };");
  return factory(() => new Promise(() => {}), () => 0).describe;
}

suite("the skills.forged feed line", () => {
  it("renders a created skill with its name, size and resting place", () => {
    const describeEv = extractDescribe();
    const [kind, who, text] = describeEv({
      type: "skills.forged", runId: "r1", taskId: "task-a", name: "log-rotation",
      sha256: "abc", path: "/repo/.harness/skills/log-rotation/SKILL.md",
      action: "created", tokensApprox: 412, ts: 1,
    });
    expect(kind).toBe("tool");
    expect(who).toBe("task-a");
    expect(text).toBe("created skill “log-rotation” (~412 tokens) — /repo/.harness/skills/log-rotation/SKILL.md");
  });

  it("says extended when the forge grew an earlier skill", () => {
    const describeEv = extractDescribe();
    const [, , text] = describeEv({
      type: "skills.forged", runId: "r1", taskId: "task-b", name: "log-rotation",
      sha256: "def", path: "/repo/.harness/skills/log-rotation/SKILL.md",
      action: "extended", tokensApprox: 890, ts: 2,
    });
    expect(text).toContain("extended skill “log-rotation” (~890 tokens)");
  });
});
