/**
 * Masks credentials in text before it leaves the dashboard.
 *
 * Demo agents write what they see: env files they sourced, request headers,
 * API captures, server logs. Run 614e06d5 left an `AWS_SECRET_ACCESS_KEY` line
 * in a `demo.env` inside its evidence. Charrette had no redaction helper, so
 * this is the one, and it deliberately prefers masking a harmless value to
 * showing a real one.
 *
 * Two kinds of evidence decide what is a secret: the *name* a value is stored
 * under, and the *shape* of a value that carries a known vendor prefix.
 */

export const MASK = "<masked>";

/** A name holding one of these words holds a secret, wherever the word sits. */
const SECRET_WORDS = new Set([
  "password", "passwd", "pwd", "passphrase", "secret", "secrets", "token", "apikey", "privatekey",
  "credential", "credentials", "auth", "oauth", "authorization", "cookie", "cookies", "jwt", "bearer",
]);

/** `key` alone is usually a column name. These neighbours keep it one. */
const BENIGN_KEY_NEIGHBOURS = new Set([
  "primary", "partition", "sort", "foreign", "cache", "group", "row", "object", "map", "dedupe", "hash",
  "range", "index", "table", "unique", "lookup", "join", "list", "item", "metric", "dimension", "react",
  "event", "hot", "shortcut", "keyboard", "press", "public",
]);

/** A trailing word that says the name describes a secret rather than holding one. */
const BENIGN_TAILS = new Set([
  "count", "counts", "name", "names", "type", "types", "limit", "limits", "length", "size", "usage", "used",
  "total", "expires", "expiry", "at", "ttl", "enabled", "disabled", "required", "present", "configured",
  "format", "field", "header", "budget", "estimate", "ceiling",
]);

const INERT = /^(?:true|false|null|none|nil|undefined|yes|no)?$/i;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const PASSWORD_LIKE = /pass|pwd|secret/i;

/** Whether a variable, header or JSON key names something that holds a secret. */
export function isSecretName(name: string): boolean {
  const words = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!words.length || BENIGN_TAILS.has(words[words.length - 1]!)) return false;
  if (words.some((w) => SECRET_WORDS.has(w))) return true;
  const at = words.indexOf("key");
  if (at < 0 || words.length === 1) return false;
  return !words.some((w, i) => i !== at && BENIGN_KEY_NEIGHBOURS.has(w));
}

/** Strip the wrapping a value arrives in, so `"true",` reads as `true`. */
function bare(value: string): string {
  return value.trim().replace(/,$/, "").replace(/^\\?["']|\\?["']$/g, "");
}

function worthMasking(name: string, value: string): boolean {
  const v = bare(value);
  if (v === MASK || INERT.test(v)) return false;
  return !NUMBER.test(v) || PASSWORD_LIKE.test(name);
}

/** The same quoting the value came in, so JSON that was valid stays valid. */
function requote(value: string): string {
  if (value.startsWith('\\"')) return `\\"${MASK}\\"`;
  if (value.startsWith('"')) return `"${MASK}"`;
  if (value.startsWith("'")) return `'${MASK}'`;
  return MASK;
}

const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
const ENV_LINE = /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][\w.-]*)([ \t]*=[ \t]*)(.*)$/gm;
const COLON_LINE = /^([ \t]*(?:-[ \t]+)?["']?)([A-Za-z_][\w.-]*)(["']?[ \t]*:[ \t]*)(?!["'{[])(\S.*)$/gm;
/** A header quoted inside a command, whose value runs to the closing quote. */
const HEADER_INLINE = /\b(proxy-authorization|authorization|set-cookie|cookie|x-api-key|x-auth-token|x-amz-security-token|x-goog-api-key)(\s*:\s*)([^\n"']+)/gi;
const INLINE =
  /(?<![\w.-])([A-Za-z_][\w.-]{0,80})(\\?["']?)(\s*[:=]\s*)(\\"(?:[^"\\]|\\[^"])*\\"|"(?:[^"\\\n]|\\.)*(?:"|$)|'(?:[^'\\\n]|\\.)*(?:'|$)|\[[^\]]{0,4096}\]|\{[^{}]{0,4096}\}|[^\s,;&"'{}[\])]+)/gm;
// The prefix of a flag and a URL scheme are bounded: left open, each rescans to
// the end of a long `a-a-a-...` from every word boundary, which is quadratic.
const FLAG = /(--?(?:[A-Za-z][\w-]{0,60}?[-_])?(?:password|passwd|token|secret|api-?key)[\w-]*)(\s+|=)([^\s"']+|"[^"\n]*"|'[^'\n]*')/gi;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]+):([^\s@/]+)@/gi;

/**
 * How deep `a=b=c=...` is followed before the rest is masked whole. Unbounded,
 * a long enough line overflowed the stack, and on the event stream that throw
 * would land in a timer inside the process driving the run.
 */
const MAX_INLINE_DEPTH = 8;

/**
 * A value and its trailing `,` and blanks. Done by hand because the regex for it
 * was quadratic in a run of spaces: 32 KB of them took over a second, on the
 * same event loop as the run.
 */
function splitTail(value: string): [string, string] {
  let end = value.length;
  while (end > 1 && (value[end - 1] === " " || value[end - 1] === "\t")) end--;
  if (end > 1 && value[end - 1] === ",") end--;
  return [value.slice(0, end), value.slice(end)];
}

/** Credentials recognisable with no name beside them. */
const TOKEN_SHAPES: RegExp[] = [
  /\bBearer\s+[\w.~+/=-]{4,}/g,
  /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_\w{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b[spr]k_(?:live|test)_\w{10,}/g,
  /\bwhsec_\w{10,}/g,
  /\bxox[abprs]-[\w-]{10,}/g,
  /\bA(?:KIA|SIA)[A-Z0-9]{16}\b/g,
  /\bAIza[\w-]{30,}/g,
  /\bya29\.[\w-]{20,}/g,
  /\bglpat-[\w-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bSG\.[\w-]{16,}\.[\w-]{16,}/g,
  /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g,
];

/** A parsed document: everything under a secret name goes, however deep. */
function maskTree(value: unknown, hit: () => void): unknown {
  if (Array.isArray(value)) return value.map((v) => maskTree(v, hit));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const nested = typeof v === "object" && v !== null;
    if (isSecretName(k) && (nested || worthMasking(k, String(v)))) {
      hit();
      out[k] = MASK;
    } else {
      out[k] = maskTree(v, hit);
    }
  }
  return out;
}

function parsedJson(text: string): { value: unknown } | null {
  if (!/^\s*[{[]/.test(text)) return null;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/**
 * Mask every credential this can recognise.
 *
 * `known` is exact values to remove wherever they appear, so a secret read from
 * an env file is also gone from the log line that echoed it with no name beside it.
 */
export function maskSecrets(text: string, known: readonly string[] = []): { text: string; masked: number } {
  let masked = 0;
  const hit = () => {
    masked++;
  };
  const counted = () => {
    hit();
    return MASK;
  };
  let out = text;

  const doc = parsedJson(out);
  if (doc) {
    const tree = maskTree(doc.value, hit);
    if (masked) out = JSON.stringify(tree, null, 2);
  }
  out = out.replace(PEM, counted);
  for (const value of known) {
    const parts = out.split(value);
    if (parts.length > 1) {
      masked += parts.length - 1;
      out = parts.join(MASK);
    }
  }
  // Shapes first: `Authorization: Bearer abc` has to go as one value, and the
  // name-based rules below would otherwise stop at the space after `Bearer`.
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, counted);
  out = out.replace(ENV_LINE, (line, lead: string, name: string, eq: string, value: string) => {
    if (!isSecretName(name) || !worthMasking(name, value)) return line;
    hit();
    return `${lead}${name}${eq}${MASK}`;
  });
  out = out.replace(COLON_LINE, (line, lead: string, name: string, sep: string, rest: string) => {
    if (!isSecretName(name)) return line;
    const [value, tail] = splitTail(rest);
    if (!worthMasking(name, value)) return line;
    hit();
    return `${lead}${name}${sep}${MASK}${tail}`;
  });
  out = out.replace(HEADER_INLINE, (whole, name: string, sep: string, value: string) => {
    if (value.trim() === MASK) return whole;
    hit();
    return `${name}${sep}${MASK}`;
  });
  out = out.replace(FLAG, (whole, flag: string, sep: string) => {
    if (!isSecretName(flag)) return whole;
    hit();
    return `${flag}${sep}${MASK}`;
  });
  const inline = (chunk: string, depth = 0): string =>
    chunk.replace(INLINE, (whole, name: string, close: string, sep: string, value: string) => {
      if (isSecretName(name)) {
        if (!worthMasking(name, value)) return whole;
        hit();
        return `${name}${close}${sep}${requote(value)}`;
      }
      if (depth >= MAX_INLINE_DEPTH) {
        hit();
        return `${name}${close}${sep}${requote(value)}`;
      }
      // A value can carry its own pair: data="password=hunter2".
      return `${name}${close}${sep}${inline(value, depth + 1)}`;
    });
  out = inline(out);
  out = out.replace(URL_USERINFO, (_whole, head: string) => {
    hit();
    return `${head}:${MASK}@`;
  });
  return { text: out, masked };
}

/**
 * Fields the page uses as identifiers or to branch on. Charrette writes them,
 * they hold no agent output, and a false match in one would break a link or a
 * route rather than hide a credential.
 */
const STRUCTURAL_KEYS = new Set([
  "id", "runId", "taskId", "epicId", "sessionId", "gateId", "questionId", "type", "state", "from", "to", "role", "model", "tool",
]);

/**
 * Whether a string could hold anything `maskSecrets` would change: every secret
 * word, the `key` rule, every token prefix and URL credentials. Most strings on
 * a long event stream fail this one linear test and skip the full set of rules.
 */
const MAY_HOLD_SECRET =
  /pass|pwd|secret|token|key|credential|auth|cookie|jwt|bearer|basic\s|\bgh[pousr]_|github_pat_|\bsk-|\b[spr]k_(?:live|test)_|whsec_|xox[abprs]-|\bA(?:KIA|SIA)|\bAIza|\bya29\.|glpat-|\bnpm_|\bhf_|\bSG\.|\beyJ|:\/\/[^\s/]*@/i;

/** How many masked strings are remembered, and the longest worth remembering. */
const MASK_CACHE_ENTRIES = 5_000;
const MASK_CACHE_LENGTH = 8_192;

/**
 * A function that masks everything in a JSON-shaped value and leaves its shape
 * alone: same keys, same arrays, same numbers and booleans, a new object. The
 * input is never modified, because it can be the dashboard's own live gate state.
 *
 * A string that is itself JSON (a tool call's summary is) is parsed, masked leaf
 * by leaf and serialized again. Masking its raw text could swallow a `\"` and
 * leave the page something it can no longer parse.
 *
 * Results are cached because `/api/state` resends the same specs and summaries
 * every five seconds.
 */
export function payloadMasker(known: readonly string[] = []): <T>(value: T) => T {
  const cache = new Map<string, string>();
  const secretNames = new Map<string, boolean>();
  const named = (key: string): boolean => {
    let hit = secretNames.get(key);
    if (hit === undefined) {
      hit = isSecretName(key);
      secretNames.set(key, hit);
    }
    return hit;
  };

  const maskText = (text: string): string => {
    const doc = parsedJson(text);
    if (doc) {
      const before = JSON.stringify(doc.value);
      const after = JSON.stringify(walk(doc.value));
      return after === before ? text : after;
    }
    return maskSecrets(text, known).text;
  };

  const maskString = (text: string): string => {
    if (!MAY_HOLD_SECRET.test(text) && !known.some((k) => text.includes(k))) return text;
    const cached = cache.get(text);
    if (cached !== undefined) return cached;
    const out = maskText(text);
    if (text.length <= MASK_CACHE_LENGTH) {
      if (cache.size >= MASK_CACHE_ENTRIES) cache.clear();
      cache.set(text, out);
    }
    return out;
  };

  /** Everything under a secret name: its strings go, its shape stays. */
  const blank = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(blank);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blank(v)]));
    }
    return typeof value === "string" && !INERT.test(bare(value)) ? MASK : value;
  };

  function walk(value: unknown): unknown {
    if (typeof value === "string") return maskString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (STRUCTURAL_KEYS.has(k)) out[k] = v;
      else if (!named(k)) out[k] = walk(v);
      else if (typeof v === "object" && v !== null) out[k] = blank(v);
      else out[k] = worthMasking(k, String(v)) ? MASK : v;
    }
    return out;
  }

  return <T>(value: T): T => walk(value) as T;
}

/**
 * The values an env-style file assigns to secret names.
 *
 * Eight characters is the floor because a shorter value (`local`, `test`) is a
 * stand-in, and removing every occurrence of it would shred ordinary prose.
 */
export function harvestSecrets(text: string): string[] {
  const found = new Set<string>();
  for (const [, , name, , value] of text.matchAll(ENV_LINE)) {
    const v = bare(value!);
    if (v.length >= 8 && isSecretName(name!) && worthMasking(name!, v)) found.add(v);
  }
  return [...found];
}

/** Secret-named variables in this process's environment. */
export function environmentSecrets(env: Record<string, string | undefined>): string[] {
  const found: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && isSecretName(name) && worthMasking(name, value)) found.push(value);
  }
  return found;
}
