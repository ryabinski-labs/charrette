import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The security floors this lockfile has to clear.
 *
 * A dependency bump is easy to undo by accident — a merge that keeps the old
 * lockfile, a range narrowed back to a vulnerable line, a `pnpm update` that
 * resolves an old copy for one consumer. The audit that found these ran once;
 * this runs on every CI job because it reads the lockfile the build actually
 * installs, and it fails on the resolved version rather than on a range that
 * looks safe.
 *
 * Floors are the first patched release from the advisory. When one moves, edit
 * the floor here with the advisory id, so the next reader can tell why the
 * number is what it is.
 */
const FLOORS: { name: string; floor: string; advisory: string }[] = [
  // Runtime dependencies and the HTTP transport the MCP SDK installs beside
  // them. Charrette drives the SDK over stdio, but these are installed, they
  // are what an advisory scan sees, and a later transport change would make
  // them reachable.
  { name: "zod", floor: "4.6.6", advisory: "GHSA-mrhx-c7xc-m3w5" },
  { name: "hono", floor: "4.13.11", advisory: "GHSA-5r4p-p66f-jhc7" },
  { name: "ip-address", floor: "10.7.4", advisory: "GHSA-rxp7-6hxx-x8q5 + four earlier" },
  { name: "proxy-addr", floor: "2.0.8", advisory: "GHSA-jqcg-44mw-7w3h" },
  { name: "body-parser", floor: "2.4.0", advisory: "GHSA-27r3-jxmh-p828" },
  { name: "fast-uri", floor: "3.1.9", advisory: "GHSA-w74x-v6f9-j3xg + three more" },
  // Build and test tooling installed into every developer and CI checkout.
  { name: "vite", floor: "7.3.7", advisory: "GHSA-587h-7wmj-h5pm + four more" },
  // Vitest pins its mocker to the same version, so the pair moves together.
  { name: "vitest", floor: "4.1.12", advisory: "lockstep with @vitest/mocker" },
  { name: "@vitest/mocker", floor: "4.1.12", advisory: "GHSA-xp26-3454-mjgp" },
  { name: "happy-dom", floor: "21.0.4", advisory: "GHSA-834v-8h66-3h79" },
  { name: "source-map-js", floor: "1.2.2", advisory: "GHSA-68fv-2mgg-jv7q" },
  { name: "nanoid", floor: "3.3.18", advisory: "GHSA-2v37-7h3g-55p8" },
];

const lockfile = readFileSync(fileURLToPath(new URL("../../../pnpm-lock.yaml", import.meta.url)), "utf8");

/** Every resolved version of `name`, with peer suffixes and build metadata removed. */
function versionsOf(name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = new RegExp(`^  '?${escaped}@(\\d+\\.\\d+\\.\\d+)(?:[-+][^:('\\s]*)?(?:\\([^\\n]*\\))?'?:$`, "gm");
  return [...lockfile.matchAll(line)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

function parts(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return [major, minor, patch];
}

function atLeast(version: string, floor: string): boolean {
  const [aMajor, aMinor, aPatch] = parts(version);
  const [bMajor, bMinor, bPatch] = parts(floor);
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch >= bPatch;
}

describe("security floors in pnpm-lock.yaml", () => {
  it.each(FLOORS)("$name is at least $floor ($advisory)", ({ name, floor }) => {
    const resolved = versionsOf(name);

    expect(resolved.length, `${name} is not in the lockfile at all`).toBeGreaterThan(0);
    for (const version of resolved) {
      expect(atLeast(version, floor), `${name}@${version} is below ${floor}`).toBe(true);
    }
  });

  it("reads versions the way the lockfile writes them, including peer suffixes", () => {
    // Guards the parser above: a change to pnpm's lockfile layout should fail
    // here with a clear message rather than making every floor vacuously pass.
    expect(versionsOf("vite").length).toBeGreaterThan(0);
    expect(lockfile).toMatch(/^  vite@\d+\.\d+\.\d+(?:\([^\n]*\))?:$/m);
  });
});
