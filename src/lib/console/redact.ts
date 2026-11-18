/**
 * Journal redaction (RFC 0004 §6.1): values of flags named like key|token|secret|password|auth become `<redacted>`
 * (both `--flag value` and `--flag=value`), strings longer than 512 characters are cut with their length and sha256,
 * `--answer` (the user's words, kept locally) is kept, and event `data` is bounded to 8 KB.
 *
 * Dependency-free on purpose (node:crypto only): runScript loads it in every CLI. The constants mirror
 * src/types/console.ts, which pulls in zod; tests/console-journal.test.ts asserts they stay equal.
 */
import { createHash } from "node:crypto";
import type { Redactor } from "../../types/console";

export const REDACT_FLAG_PATTERN = /key|token|secret|password|auth/i;
export const REDACTED = "<redacted>";
export const REDACT_MAX_STRING = 512;
export const EVENT_DATA_MAX_BYTES = 8 * 1024;
/** Flags whose value is the user's own words: kept verbatim even when a pattern would match (§6.1). */
const KEPT_FLAGS = new Set(["answer"]);
const MAX_ARGV = 256;
const MAX_DEPTH = 6;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A string longer than {@link REDACT_MAX_STRING} becomes its head plus `…[<length> chars, sha256 <hex>]`, 512 chars in all. */
export function redactString(value: string): string {
  if (value.length <= REDACT_MAX_STRING) return value;
  const suffix = `…[${value.length} chars, sha256 ${sha256(value)}]`;
  return value.slice(0, REDACT_MAX_STRING - suffix.length) + suffix;
}

/** The flag name of an argv token (`--api-key=x` → `api-key`), or undefined for a positional value. */
function flagName(token: string): string | undefined {
  if (!/^--?[A-Za-z]/.test(token)) return undefined;
  const bare = token.replace(/^--?/, "");
  const equal = bare.indexOf("=");
  return equal < 0 ? bare : bare.slice(0, equal);
}

/** The one secret-name rule (§6.1), shared by argv, `data` keys and free text: like key|token|secret|password|auth, not `answer`. */
export const isSecretName = (name: string): boolean =>
  !KEPT_FLAGS.has(name.toLowerCase()) && REDACT_FLAG_PATTERN.test(name);
const secretFlag = isSecretName;

/** A token that is unmistakably another long flag (`--name` or `--name=value`), so it is not a secret flag's value. */
const LONG_FLAG = /^--[A-Za-z][\w-]*(?:=.*)?$/s;

/**
 * Scrubs secret flag values out of free text (an error message, a progress line): `--api-key=sk-1`, `--token sk-1`,
 * `--token "a b"` and the parser's `Invalid value "sk-1" for --token` all lose the value. Same name rule as argv.
 * Exported as the one scrubber for messages; the hook script (WP-H) mirrors it.
 */
export function scrubSecrets(text: string): string {
  const quotedBefore = /"((?:[^"\\]|\\.)*)"(\s+for\s+--?([A-Za-z][\w-]*))/g;
  const flagValue = /(^|[^\w-])(--?([A-Za-z][\w-]*))(=|[ \t]+)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+)/g;
  return text
    .replace(quotedBefore, (match, _value: string, rest: string, name: string) =>
      isSecretName(name) ? `"${REDACTED}"${rest}` : match,
    )
    .replace(flagValue, (match, lead: string, flag: string, name: string, separator: string, value: string) =>
      isSecretName(name) && !(separator.trim() === "" && LONG_FLAG.test(value))
        ? `${lead}${flag}${separator}${REDACTED}`
        : match,
    );
}

/** Redacts secret-like flag values and long strings. After a secret flag the next token is always its value (even `-abc`) unless it is exactly another `--flag`. */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i]);
    const name = flagName(token);
    if (name && secretFlag(name)) {
      const equal = token.indexOf("=");
      if (equal >= 0) out.push(`${token.slice(0, equal + 1)}${REDACTED}`);
      else {
        out.push(token);
        const value = argv[i + 1];
        if (value !== undefined && !LONG_FLAG.test(value) && value !== "--") {
          out.push(REDACTED);
          i++;
        }
      }
      continue;
    }
    out.push(redactString(token));
  }
  if (out.length <= MAX_ARGV) return out;
  return [...out.slice(0, MAX_ARGV - 1), `…[${out.length - (MAX_ARGV - 1)} more]`];
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactString(scrubSecrets(value));
  if (value === null || typeof value !== "object") {
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  }
  if (depth >= MAX_DEPTH) return "<omitted: too deep>";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "function" || item === undefined) continue;
    out[key] = secretFlag(key) ? REDACTED : redactValue(item, depth + 1);
  }
  return out;
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

/**
 * Redacts secret-like keys and long strings, then bounds the result to {@link EVENT_DATA_MAX_BYTES}: the largest
 * top-level values are replaced by `<omitted N bytes>` (and `truncated: true` is set) until it fits.
 */
export function redactData(data: Record<string, unknown>): Record<string, unknown> {
  const out = redactValue(data, 0) as Record<string, unknown>;
  if (bytes(out) <= EVENT_DATA_MAX_BYTES) return out;
  const sizes = Object.keys(out)
    .map((key) => [key, bytes(out[key])] as const)
    .sort((a, b) => b[1] - a[1]);
  for (const [key, size] of sizes) {
    out[key] = `<omitted ${size} bytes>`;
    out.truncated = true;
    if (bytes(out) <= EVENT_DATA_MAX_BYTES) return out;
  }
  return { truncated: true };
}

export const redactor: Redactor = { argv: redactArgv, string: redactString, data: redactData };
