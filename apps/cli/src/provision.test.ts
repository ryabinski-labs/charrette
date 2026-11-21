import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The provisioning script, exercised without a Linux host.
 *
 * Three things can be proved on the machine that is running the tests: the
 * script refuses an unsupported OS and a bad key before it does anything, a
 * dry run prints every step and writes nothing, and the session wrapper parses
 * and names the two files it needs. The part that only a clean Debian 13 or
 * Ubuntu 24.04 VM can prove — a real install from SSH access to a first run —
 * is a release check, not a unit test, and the guide says so.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts/remote/provision.sh");
const SESSION = path.join(ROOT, "scripts/remote/charrette-session");

const OS_FIXTURES = {
  debian: 'ID=debian\nVERSION_ID="13"\n',
  ubuntu: 'ID=ubuntu\nVERSION_ID="24.04"\n',
  fedora: 'ID=fedora\nVERSION_ID="41"\n',
};

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnlyKeyForProvisioning charrette@test\n";

let dir: string;
let target: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "charrette-provision-"));
  target = path.join(dir, "target");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name: keyof typeof OS_FIXTURES): string {
  const file = path.join(dir, `${name}.release`);
  writeFileSync(file, OS_FIXTURES[name]);
  return file;
}

function keyFile(text = PUBLIC_KEY): string {
  const file = path.join(dir, "id_test.pub");
  writeFileSync(file, text);
  return file;
}

function run(os: keyof typeof OS_FIXTURES, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CHARRETTE_OS_RELEASE: fixture(os),
      // Every path the script writes is under here, so a real run on a machine
      // that is not the target cannot touch the machine running the test.
      CHARRETTE_PROVISION_ROOT: target,
    },
  });
}

describe("provision.sh refuses what it cannot do", () => {
  it("SC-013-a an unsupported operating system is refused before anything changes", () => {
    const result = run("fedora", ["--user", "charrette", "--ssh-key", keyFile()]);

    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toContain("Debian 13");
    expect(String(result.stderr)).toContain("Ubuntu 24.04");
  });

  it("SC-013-b a missing or malformed public key is refused before anything changes", () => {
    const missing = run("debian", ["--user", "charrette"]);
    expect(missing.status).not.toBe(0);
    expect(String(missing.stderr)).toContain("ssh-key");

    const malformed = run("debian", ["--user", "charrette", "--ssh-key", keyFile("not a public key\n")]);
    expect(malformed.status).not.toBe(0);
    expect(String(malformed.stderr)).toMatch(/public key/i);
  });
});

describe("provision.sh --dry-run", () => {
  it("SC-013-c a dry run prints the plan and changes nothing", () => {
    const result = run("debian", ["--user", "charrette", "--ssh-key", keyFile(), "--dry-run"]);

    expect(result.status, String(result.stderr)).toBe(0);
    const plan = String(result.stdout);
    for (const step of [
      "useradd",
      "Node 22",
      "pnpm",
      "gh",
      "tmux",
      "tailscale",
      "authorized_keys",
      "unattended-upgrades",
      "nftables",
    ]) {
      expect(plan, `the plan does not mention ${step}`).toContain(step);
    }
    // Nothing under the target root was created: no home, no env file, no
    // wrapper, no nftables fragment.
    expect(() => readdirSync(target)).toThrow();

    const ubuntu = run("ubuntu", ["--user", "charrette", "--ssh-key", keyFile(), "--dry-run"]);
    expect(ubuntu.status, String(ubuntu.stderr)).toBe(0);
    expect(String(ubuntu.stdout)).toContain("Ubuntu 24.04");
  });
});

describe("the session wrapper", () => {
  it("SC-013-d the session wrapper loads the env file and attaches to tmux", () => {
    const syntax = spawnSync("bash", ["-n", SESSION], { encoding: "utf8" });
    expect(syntax.status, String(syntax.stderr)).toBe(0);

    const text = readFileSync(SESSION, "utf8");
    expect(text).toContain(".config/charrette/env");
    expect(text).toContain("tmux");
    expect(text).toContain("new-session -A -s charrette");
  });
});
