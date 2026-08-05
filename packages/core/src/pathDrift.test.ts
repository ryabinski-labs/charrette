import { describe, expect, it } from "vitest";
import { hasDrift, pathDrift, renderDrift } from "./pathDrift.js";

describe("what the plan said a task would touch, against what it touched", () => {
  it("says nothing when the diff matches the plan", () => {
    const drift = pathDrift(["app/api/bookings.py", "tests/test_bookings.py"], ["app/api/bookings.py", "tests/test_bookings.py"]);
    expect(drift).toEqual({ missing: [], extra: [] });
    expect(hasDrift(drift)).toBe(false);
    expect(renderDrift(drift)).toBe("");
  });

  /**
   * Run da8325bd, Goal 8: a task scoped to remove an unenforced claim from the
   * product's pricing surfaces removed it from one page. Its criteria were met
   * as written, so QA passed it, and twenty other pages kept the claim.
   */
  it("names the declared files a task never touched", () => {
    const drift = pathDrift(
      ["frontend/src/pages/marketing/PricingPage.vue", "frontend/src/pages/marketing/LandingPage.vue", "frontend/src/lib/page-meta.ts"],
      ["frontend/src/pages/marketing/PricingPage.vue"]
    );
    expect(drift.missing).toEqual(["frontend/src/pages/marketing/LandingPage.vue", "frontend/src/lib/page-meta.ts"]);
    expect(drift.extra).toEqual([]);
    expect(renderDrift(drift)).toContain("Declared in the plan and NOT changed");
    expect(renderDrift(drift)).toContain("merges half-done");
  });

  it("names files the plan did not mention", () => {
    const drift = pathDrift(["app/api/bookings.py"], ["app/api/bookings.py", "app/billing/entitlements.py"]);
    expect(drift.extra).toEqual(["app/billing/entitlements.py"]);
    expect(drift.missing).toEqual([]);
    expect(renderDrift(drift)).toContain("Usually fine");
  });

  it("counts a declared directory as satisfied by anything inside it", () => {
    const drift = pathDrift(["frontend/src/pages"], ["frontend/src/pages/a.vue", "frontend/src/pages/nested/b.vue"]);
    expect(drift).toEqual({ missing: [], extra: [] });
  });

  /** `src/api` contains `src/api/orders.ts` but not `src/apiary.ts`. */
  it("does not treat a name that merely starts the same as covered", () => {
    const drift = pathDrift(["src/api"], ["src/apiary.ts"]);
    expect(drift.missing).toEqual(["src/api"]);
    expect(drift.extra).toEqual(["src/apiary.ts"]);
  });

  it("reads the spellings of one path as one path", () => {
    expect(pathDrift(["./app/api/", "app/api"], ["app/api/bookings.py"])).toEqual({ missing: [], extra: [] });
  });

  /**
   * A planner that named nothing has said nothing. Inventing a complaint from
   * silence would put the same warning on every task in the plan.
   */
  it("reports no drift at all when the plan declared no paths", () => {
    const drift = pathDrift([], ["app/api/bookings.py", "anything/else.ts"]);
    expect(drift).toEqual({ missing: [], extra: [] });
    expect(renderDrift(drift)).toBe("");
  });

  it("caps a very long extra list rather than burying the reviewer", () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`);
    const rendered = renderDrift(pathDrift(["src/declared.ts"], ["src/declared.ts", ...many]));
    expect(rendered).toContain("and 5 more");
    expect(rendered).not.toContain("src/file20.ts");
  });
});
