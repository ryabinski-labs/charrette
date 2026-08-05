import { describe, expect, it } from "vitest";
import { RunConfig } from "./config.js";

/**
 * The UI vocabulary, checked directly against a corpus of task text.
 *
 * `skillsInjection.test.ts` already proves routing works end to end, but each
 * of its cases drives a whole run and costs tens of seconds, so it can afford
 * about one example per rule. A keyword gate does not fail on the example
 * someone thought of; it fails on the twenty they did not, and the failure is
 * silent — a task that should have carried a design playbook simply arrives
 * without one and nothing anywhere says so. This is the cheap sweep that makes
 * the vocabulary falsifiable.
 *
 * Both halves matter equally. A miss costs depth, since `INTERFACE_STANDARD`
 * reaches every worker from the prompt whatever this regex decides. A false
 * positive costs one of four skill slots on a task with no interface at all,
 * and the slot it takes belongs to the skill that actually knew the answer.
 */
const uiRule = () => {
  const rule = RunConfig.parse({}).skillRouting.find(
    (r) => !r.roles && r.skills.includes("frontend-design") && r.skills.includes("ui-ux-cx-engineer")
  );
  return new RegExp(rule!.when, "i");
};

const routes = (title: string, spec: string) => uiRule().test(`${title}\n${spec}`);

describe("what counts as interface work", () => {
  it.each([
    ["Pricing page", "Add the pricing page with a plan dropdown and a comparison data table"],
    ["Checkout", "Add the pay button and inline card errors to the checkout flow"],
    ["Invoices", "Show invoices with a loading state and an empty state"],
    ["Settings", "Add a toggle switch for email notifications and a helper text under it"],
    ["Team picker", "Let the admin pick a team from a searchable combo box"],
    ["Date range", "Add a date picker to the reports filter"],
    ["Nav", "Collapse the sidebar navigation on narrow viewports"],
    ["Onboarding", "Three-step wizard the first time someone signs in"],
    ["Empty states", "Every list needs an empty state that explains what goes there"],
    ["Dark mode", "Support dark mode across the app"],
    ["Icons", "Replace the emoji with proper icons"],
    ["Mobile", "Make the report readable on mobile"],
    ["Usage chart", "Add a chart of daily usage to the dashboard"],
    ["Toasts", "Show a toast when the save succeeds and a modal to confirm delete"],
    ["Tooltip", "Add a tooltip explaining what the retention setting does"],
    ["Signup", "Build the signup form with inline validation"],
    ["Focus", "Every interactive element needs a visible focus state"],
    ["Avatar", "Show the member avatar next to their name"],
  ])("routes %s", (title, spec) => {
    expect(routes(title, spec)).toBe(true);
  });

  /**
   * The words that read as interface and are not. Each of these was a real
   * candidate for the vocabulary and is qualified in the regex instead: a
   * database table is not a data table, a dependency graph is not a chart, a
   * feature toggle is not a toggle switch, `page size` is pagination, and "in
   * the form of" is ordinary prose that happens to contain a control.
   */
  it.each([
    ["Ledger schema", "Create the postings table and backfill it, keyed off the accounts table"],
    ["Cursor the API", "Return results in batches with a page size and a page token, no offsets"],
    ["Feature toggles", "Read the toggle from config so a half-built path can ship dark"],
    ["Rotate logs", "Truncate stale files on disk once a week"],
    ["Dep graph", "Build the dependency graph so the scheduler can order tasks"],
    ["Webhooks", "Verify the Stripe signature and store the event in the form of a row"],
    ["Rate limit", "Token bucket per API key, 100 requests per minute"],
    ["Migration", "Add a nullable column to the subscriptions table"],
    ["Auth", "Rotate the signing key and invalidate old sessions"],
  ])("does not spend a skill slot on %s", (title, spec) => {
    expect(routes(title, spec)).toBe(false);
  });

  /**
   * `brand`, `logo` and `visual identity` stay out of this vocabulary on
   * purpose. The marketing rule owns them and sits below this one, so a
   * branding task matching both would fill all four of its slots with frontend
   * skills and drop `branding-manager` — the one skill that knew the job — at
   * the cap.
   */
  it("leaves the branding words to the branding rule", () => {
    expect(routes("Refresh the brand", "Rework the logo and brand voice across the marketing site")).toBe(false);
  });

  it("matches plurals, because nothing makes a planner write the singular", () => {
    // `\bicon\b` does not match "icons". This is how the vocabulary silently
    // under-fired before, and it applied to `component` and `screen` too.
    for (const word of ["icons", "components", "screens", "buttons", "modals", "charts", "empty states"]) {
      expect(routes("Polish", `Tidy up the ${word}`)).toBe(true);
    }
  });
});
