import { describe, expect, it } from "vitest";
import { formatBuild, harnessBuild } from "./build.js";

describe("formatBuild", () => {
  it("names the version and the commit that produced it", () => {
    expect(formatBuild("0.4.0", (args) => (args[0] === "rev-parse" ? "7453d60" : ""))).toBe("0.4.0@7453d60");
  });

  it("marks a modified checkout, because the sha then names a tree that did not run", () => {
    expect(formatBuild("0.4.0", (args) => (args[0] === "rev-parse" ? "7453d60" : " M packages/core/src/pool.ts"))).toBe("0.4.0@7453d60+");
  });

  it("falls back to the bare version rather than inventing a commit when there is no checkout", () => {
    // Installed from a tarball: `git rev-parse` exits non-zero and execFileSync throws.
    expect(
      formatBuild("0.4.0", () => {
        throw new Error("not a git repository");
      })
    ).toBe("0.4.0");
  });
});

describe("harnessBuild", () => {
  it("reports this process's own build, and reports the same one twice", () => {
    const first = harnessBuild();
    // Resolved once on purpose: Node loaded this build at process start and
    // cannot load another, so a second answer would be a bug, not a refresh.
    expect(harnessBuild()).toBe(first);
    expect(first).toMatch(/^\d+\.\d+\.\d+(@[0-9a-f]{7}\+?)?$/);
  });
});
