import { describe, expect, it } from "vitest";
import { MASK, environmentSecrets, harvestSecrets, isSecretName, maskSecrets, payloadMasker } from "./redact.js";

// Assembled at runtime so no literal here reads as a credential to a scanner.
const fake = (head: string, tail: string, n = 40) => head + tail + "x1".repeat(n / 2);

describe("masking a whole payload", () => {
  const SECRET = fake("wJalr", "XUtnFEMI");
  const mask = payloadMasker();

  it("masks a command inside a tool call and keeps the summary parseable", () => {
    const event = {
      type: "agent.tool_use",
      runId: "r1",
      sessionId: "s1",
      tool: "Bash",
      summary: JSON.stringify({ command: `cd app && AWS_SECRET_ACCESS_KEY=${SECRET} aws s3 ls`, description: 'says "hello"' }),
      ts: 5,
    };

    const out = mask(event);

    expect(JSON.stringify(out)).not.toContain(SECRET);
    const parsed = JSON.parse(out.summary) as { command: string; description: string };
    expect(parsed.command).toBe(`cd app && AWS_SECRET_ACCESS_KEY=${MASK} aws s3 ls`);
    expect(parsed.description).toBe('says "hello"');
  });

  it("does not let an escaped quote in a value break the JSON around it", () => {
    const summary = JSON.stringify({ command: `TOKEN=ab"cd${SECRET} run` });
    expect(() => JSON.parse(mask({ summary }).summary)).not.toThrow();
  });

  it("leaves a JSON string with nothing to mask byte for byte", () => {
    const summary = '{ "file_path":  "/repo/src/key.ts" }';
    expect(mask({ summary }).summary).toBe(summary);
  });

  it("masks a truncated tool call, which is not JSON any more", () => {
    const out = mask({ summary: `{"command":"API_TOKEN=${SECRET} curl` });
    expect(out.summary).not.toContain(SECRET);
  });

  it("masks pit stop markdown", () => {
    const out = mask({ pitStop: { markdown: `## Report\n\nRan \`DB_PASSWORD=${SECRET} npm start\` and it worked.` } });
    expect(out.pitStop.markdown).toContain(`DB_PASSWORD=${MASK}`);
    expect(out.pitStop.markdown).not.toContain(SECRET);
  });

  it("keeps every key, array, number, boolean and null where it was", () => {
    const value = { a: [1, true, null, { b: 2.5 }], inputTokens: 900, costUsd: 1.25, done: false, none: null, text: "plain words" };
    expect(mask(value)).toEqual(value);
  });

  it("leaves the fields the page routes on alone, even when they look like a secret", () => {
    const id = "sk-abcdefghijklmnopqrstuv";
    const value = { id, runId: id, taskId: id, sessionId: id, type: "agent.log", state: "MERGED", model: "claude-opus-5-5" };
    expect(mask(value)).toEqual(value);
  });

  it("masks by the key a value sits under, and keeps the shape below it", () => {
    const out = mask({ credentials: { user: "someone", tokens: ["one-long-value", ""], retries: 3, on: true }, password: "hunter2", api_key: 12345 });
    expect(out).toEqual({ credentials: { user: MASK, tokens: [MASK, ""], retries: 3, on: true }, password: MASK, api_key: 12345 });
  });

  it("leaves an inert value under a secret name", () => {
    expect(mask({ token: "null", secret: true })).toEqual({ token: "null", secret: true });
  });

  it("removes a known value with no name beside it", () => {
    const value = "plainvalue-with-no-hint-99";
    expect(payloadMasker([value])({ text: `the log said ${value} here` }).text).toBe(`the log said ${MASK} here`);
  });

  it("does not modify what it was given", () => {
    const input = { text: `TOKEN=${SECRET}`, nested: { password: "hunter2" } };
    const copy = JSON.parse(JSON.stringify(input));
    mask(input);
    expect(input).toEqual(copy);
  });

  it("gives the same answer from its cache", () => {
    const m = payloadMasker();
    const text = `TOKEN=${SECRET}`;
    expect(m({ text }).text).toBe(m({ text }).text);
    expect(m({ text }).text).toBe(`TOKEN=${MASK}`);
  });

  it("does not remember strings without limit", () => {
    const m = payloadMasker();
    for (let i = 0; i < 5_100; i++) expect(m({ text: `TOKEN=value-${i}` }).text).toBe(`TOKEN=${MASK}`);
  });

  it("masks a string too long to be worth caching", () => {
    const text = `TOKEN=${SECRET} ${"word ".repeat(2_000)}`;
    expect(mask({ text }).text).not.toContain(SECRET);
  });

  it.each([
    ["a bearer header", (s: string) => `Authorization: Bearer ${s}`],
    ["basic auth", () => `Basic ${"QWxhZGRpbjpvcGVuc2VzYW1l"}`],
    ["a GitHub token", () => fake("gh", "p_")],
    ["a fine-grained GitHub token", () => fake("github_", "pat_")],
    ["an OpenAI-shaped key", () => fake("sk", "-")],
    ["a Stripe key", () => fake("sk_", "live_")],
    ["a webhook secret", () => fake("whsec", "_")],
    ["a Slack token", () => fake("xoxb", "-")],
    ["an AWS key id", () => `AKIA${"ABCDEFGHIJKLMNOP"}`],
    ["a Google key", () => fake("AIza", "Sy")],
    ["a Google access token", () => fake("ya29", ".a")],
    ["a GitLab token", () => fake("glpat", "-")],
    ["an npm token", () => fake("npm", "_")],
    ["a Hugging Face token", () => fake("hf", "_")],
    ["a SendGrid key", () => `SG.${"a".repeat(20)}.${"b".repeat(20)}`],
    ["a JWT", () => `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`],
    ["URL credentials", () => "postgres://admin:s3cretvalue@db.internal/app"],
    ["a private key", () => ["BEGIN", "END"].map((edge) => `-----${edge} RSA PRIVATE ${"KEY"}-----`).join("\nabc\n")],
    ["a flag", () => "--password hunter2value"],
  ])("does not let the fast path skip %s", (_name, make) => {
    const text = `ran it with ${make(SECRET)} today`;
    expect(payloadMasker()({ text }).text).toBe(maskSecrets(text).text);
    expect(maskSecrets(text).masked).toBeGreaterThan(0);
  });

  /**
   * The event stream is masked on the same event loop that drives the run, and
   * agent output is whatever an agent printed. A rule that goes quadratic on a
   * long line stalls every session; the recursion overflowed the stack outright.
   */
  it.each([
    ["a long run of spaces", "password: x" + " ".repeat(400_000) + "y"],
    ["chained pairs", "a=".repeat(200_000)],
    ["a long dashed word", "--" + "a-".repeat(200_000)],
    ["a long dotted word", "a.".repeat(200_000)],
  ])("stays fast and does not throw on %s", (_name, text) => {
    const started = performance.now();
    expect(() => maskSecrets(text)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("masks the rest of a pair chain too deep to follow", () => {
    const text = `${"a=".repeat(20)}hunter2value`;
    expect(maskSecrets(text).text).not.toContain("hunter2value");
  });

  it("keeps a trailing comma and blanks outside the mask on a colon line", () => {
    expect(maskSecrets("password: hunter2value,   ").text).toBe(`password: ${MASK},   `);
  });

  it("reads a lone comma as no value at all", () => {
    expect(maskSecrets("password: ,").text).toBe("password: ,");
  });
});

describe("isSecretName", () => {
  it.each([
    "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "PAID_ADS_GOOGLE_ADS_ACCESS_TOKEN", "password", "DB_PASSWD",
    "apiKey", "APIKey", "api-key", "x-api-key", "client_secret", "Authorization", "Set-Cookie", "cookie",
    "refresh_token", "secretAccessKey", "GOOGLE_APPLICATION_CREDENTIALS", "auth", "signing_key",
  ])("treats %s as holding a secret", (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each([
    "key", "primary_key", "sort_key", "cache-key", "public_key", "max_tokens", "inputTokens", "token_count",
    "token_type", "author", "authenticated", "campaign_id", "___", "", "password_required", "keyboard",
  ])("leaves %s alone", (name) => {
    expect(isSecretName(name)).toBe(false);
  });
});

describe("maskSecrets", () => {
  const masked = (text: string, known?: string[]) => maskSecrets(text, known).text;

  it("masks env lines, with export and with either quote", () => {
    const out = masked(
      ['AWS_SECRET_ACCESS_KEY=plainvalue1', 'export API_TOKEN=exportedvalue', 'export DB_PASSWORD="quoted value"', "CLIENT_SECRET='single value'", "PLAIN=visible"].join("\n")
    );
    expect(out).toBe(
      [`AWS_SECRET_ACCESS_KEY=${MASK}`, `export API_TOKEN=${MASK}`, `export DB_PASSWORD=${MASK}`, `CLIENT_SECRET=${MASK}`, "PLAIN=visible"].join("\n")
    );
  });

  it("masks Authorization and Set-Cookie headers whole, including what follows a space", () => {
    const out = masked("Authorization: Bearer abc.def-ghi\nSet-Cookie: sid=abc123; Path=/; HttpOnly\nContent-Type: text/html");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("HttpOnly");
    expect(out).toContain("Content-Type: text/html");
  });

  it("masks a header quoted inside a command", () => {
    const out = masked(`curl -H 'Cookie: a=hidden1; b=hidden2' -H "X-Api-Key: hidden3" https://x.test`);
    expect(out).not.toMatch(/hidden/);
    expect(out).toContain("https://x.test");
  });

  it("does not count a value twice as it passes the later rules", () => {
    expect(maskSecrets("Authorization: Bearer abcdefghijkl").masked).toBe(1);
    expect(maskSecrets("API_TOKEN=abcdefghijkl").masked).toBe(1);
  });

  it("keeps JSON valid and masks under secret keys however deep", () => {
    const out = maskSecrets(JSON.stringify({ user: "ok", list: [{ password: "p4ssw0rd!" }], credentials: { value: "nested" }, token: null, auth: true, n: 1 }));
    const doc = JSON.parse(out.text);
    expect(doc.user).toBe("ok");
    expect(doc.list[0].password).toBe(MASK);
    expect(doc.credentials).toBe(MASK);
    expect(doc.token).toBeNull();
    expect(doc.auth).toBe(true);
    expect(out.masked).toBe(2);
  });

  it("leaves JSON with nothing to mask byte for byte", () => {
    const text = '{"a":1,   "b":[true,null]}';
    expect(masked(text)).toBe(text);
  });

  it("masks text that only looks like JSON, and escaped JSON inside a log", () => {
    // What a size cap leaves behind: a value with no closing quote.
    expect(masked('{"password": "cut-off-val')).not.toContain("cut-off");
    expect(masked("{'password': 'cut-off-val")).not.toContain("cut-off");
    expect(masked('{"token": "abc123xyz", broken')).toContain(`"token": "${MASK}"`);
    expect(masked('body={\\"password\\":\\"hunter22\\"}')).not.toContain("hunter22");
  });

  it("keeps each value's quoting in inline pairs", () => {
    expect(masked(`x password="dq value" y`)).toContain(`password="${MASK}" y`);
    expect(masked(`x password='sq value' y`)).toContain(`password='${MASK}' y`);
    expect(masked("see ?access_token=abc123&page=2")).toBe(`see ?access_token=${MASK}&page=2`);
  });

  it("finds a pair carried inside another value", () => {
    expect(masked(`data="password=hunter22" next`)).not.toContain("hunter22");
  });

  it("leaves inert and numeric values under weak names", () => {
    for (const line of ["API_TOKEN=true", "API_TOKEN=", "token: null", "API_TOKEN=12", 'x token="false" y', "x token=5 y"]) {
      expect(masked(line)).toBe(line);
    }
  });

  it("masks a number under a password name", () => {
    expect(masked("DB_PASSWORD=123456")).toBe(`DB_PASSWORD=${MASK}`);
  });

  it("masks YAML values to the end of the line and keeps a trailing comma", () => {
    expect(masked("  password: two words")).toBe(`  password: ${MASK}`);
    expect(masked('  "token": 998877665544a,')).toBe(`  "token": ${MASK},`);
  });

  it("masks array and object values under a secret name", () => {
    expect(masked('x "set-cookie": ["a=1", "b=2"] y')).not.toMatch(/a=1|b=2/);
    expect(masked('x "secret": {"a": "b"} y')).toContain(`"secret": ${MASK}`);
  });

  it("masks private key blocks, finished or cut off", () => {
    const head = "-----BEGIN RSA " + "PRIVATE KEY-----";
    const tail = "-----END RSA " + "PRIVATE KEY-----";
    expect(masked(`a\n${head}\nAAAA\n${tail}\nb`)).toBe(`a\n${MASK}\nb`);
    expect(masked(`a\n${head}\nAAAA`)).toBe(`a\n${MASK}`);
  });

  it("masks flags and URL passwords", () => {
    expect(masked("tool --api-key hunter22 --verbose")).toBe(`tool --api-key ${MASK} --verbose`);
    expect(masked("tool --token=hunter22")).toBe(`tool --token=${MASK}`);
    expect(masked("tool --db-password hunter22")).toBe(`tool --db-password ${MASK}`);
    expect(masked("tool --token-count 40")).toBe("tool --token-count 40");
    expect(masked("postgres://user:hunter22@db:5432/app")).toBe(`postgres://user:${MASK}@db:5432/app`);
  });

  it.each([
    ["GitHub", fake("gh", "p_")],
    ["GitHub fine-grained", fake("github", "_pat_")],
    ["Anthropic or OpenAI", fake("sk", "-ant-")],
    ["Stripe", fake("sk", "_live_")],
    ["Stripe webhook", fake("whsec", "_")],
    ["Slack", fake("xox", "b-")],
    ["AWS", "AK" + "IA" + "ABCDEFGHIJKLMNOP"],
    ["Google", fake("AI", "za")],
    ["Google OAuth", fake("ya29", ".")],
    ["GitLab", fake("glpat", "-")],
    ["npm", fake("npm", "_")],
    ["Hugging Face", fake("hf", "_")],
    ["SendGrid", "SG" + "." + "a".repeat(20) + "." + "b".repeat(20)],
    ["JWT", "ey" + "JhbGciOi" + ".eyJzdWIiOjE." + "c2lnbmF0dXJl"],
  ])("recognises a bare %s token in a log line", (_name, token) => {
    const out = maskSecrets(`INFO connected with ${token} ok`);
    expect(out.text).toBe(`INFO connected with ${MASK} ok`);
    expect(out.masked).toBe(1);
  });

  it("removes known values wherever they appear", () => {
    const out = maskSecrets("echoed zzqqvalue and zzqqvalue again, plain elsewhere", ["zzqqvalue", "notpresent"]);
    expect(out.text).toBe(`echoed ${MASK} and ${MASK} again, plain elsewhere`);
    expect(out.masked).toBe(2);
  });

  it("stays fast on a long run of word characters", () => {
    const start = Date.now();
    maskSecrets("a".repeat(1024 * 1024));
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("harvestSecrets", () => {
  it("collects values assigned to secret names and nothing else", () => {
    const found = harvestSecrets(
      ['export API_TOKEN="longenough1"', "DB_PASSWORD=longenough2", "API_TOKEN=short", "NAME=notsecretvalue", "OTHER_TOKEN=12345678", "API_TOKEN=longenough1"].join("\n")
    );
    expect(found).toEqual(["longenough1", "longenough2"]);
  });
});

describe("environmentSecrets", () => {
  it("takes long values under secret names only", () => {
    expect(environmentSecrets({ API_TOKEN: "longenough1", OTHER_TOKEN: "short", HOME: "/users/somebody", UNSET_TOKEN: undefined, NUM_TOKEN: "12345678" })).toEqual(["longenough1"]);
  });
});
