/**
 * Static console snapshot (RFC 0004 D18, WP15, US22): one self-contained HTML file with the console bundle's script and
 * style inlined and the project's view embedded as JSON (`<script type="application/json" id="agentbros-snapshot">`),
 * which the bundle's boot reads to run read-only with no server (apps/console/api/snapshot.ts).
 *
 * What goes in is what the console shows, nothing more: the projector's view (blind pools stay blind; the user's
 * words appear only where the view carries them) and the project's home row. No journal, no token, no server URL, no
 * media (the page names each file and links it by a path relative to `out/<id>/`). Every string is scrubbed: secret
 * flag values (`scrubSecrets`), the values of secret-named variables in the checkout's `.env` files and the session
 * token, and the checkout and home folders (`<checkout>`, `~`). The result is capped in size. Publishing it is the
 * user's call, never this module's.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  ProjectSummarySchema,
  ProjectViewSchema,
  REDACTED,
  REDACT_FLAG_PATTERN,
  type ProjectSummary,
  type ProjectView,
} from "../../types/console";
import { scrubSecrets } from "./redact";
import { readCredentialSessionToken, readSessionToken } from "./session";
import { readManagedCredentials } from "../setup/credential-store";

export const SNAPSHOT_FILE = "console-snapshot.html";
export const SNAPSHOT_ELEMENT_ID = "agentbros-snapshot";
/** The whole page at most; the bundle is about 1.5 MB, a view a few hundred KB. */
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
/** Secrets shorter than this are not replaced by value (too likely to hit ordinary words). */
const SECRET_MIN_LENGTH = 8;
const ENV_FILES = [".env", ".env.local"];

export interface SnapshotData {
  v: 1;
  takenAt: string;
  view: ProjectView;
  summary: ProjectSummary;
}

export class SnapshotTooLarge extends Error {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`The snapshot would be ${bytes} bytes; the cap is ${maxBytes} bytes.`);
  }
}

/** Values of secret-named variables (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AUTH`) in the checkout's `.env` files. */
export function envSecretValues(rootDir: string): string[] {
  const values: string[] = [];
  for (const name of ENV_FILES) {
    let text: string;
    try {
      text = readFileSync(path.join(rootDir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match || !REDACT_FLAG_PATTERN.test(match[1]!)) continue;
      const value = match[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
      if (value.length >= SECRET_MIN_LENGTH) values.push(value);
    }
  }
  return values;
}

/** The scrubber of every string in the snapshot. */
export function snapshotScrubber(options: { rootDir: string; secrets?: readonly string[]; home?: string }) {
  const secrets = [...new Set((options.secrets ?? []).filter((value) => value.length >= SECRET_MIN_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
  const prefixes = [
    [path.resolve(options.rootDir), "<checkout>"],
    [options.home ?? homedir(), "~"],
  ].filter(([prefix]) => prefix && prefix.length > 1 && prefix !== "/") as [string, string][];
  return (text: string): string => {
    let out = scrubSecrets(text);
    for (const secret of secrets) out = out.split(secret).join(REDACTED);
    for (const [prefix, name] of prefixes) out = out.split(prefix).join(name);
    return out;
  };
}

/** A deep copy of `value` with every string (keys too) passed through `scrub`. */
export function scrubDeep<T>(value: T, scrub: (text: string) => string): T {
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, scrub)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [scrub(key), scrubDeep(item, scrub)]),
    ) as T;
  return value;
}

/** Scrubs the data and re-validates it: a scrub that broke a field is an error, never a silently wrong page. */
export function scrubSnapshotData(data: SnapshotData, scrub: (text: string) => string): SnapshotData {
  const scrubbed = scrubDeep(data, scrub);
  return {
    v: 1,
    takenAt: data.takenAt,
    view: ProjectViewSchema.parse(scrubbed.view),
    summary: ProjectSummarySchema.parse(scrubbed.summary),
  };
}

/** JSON safe inside a `<script>` element: no `<`, `>` or `&` as such, and no line or paragraph separators. */
export const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/** Script text that cannot close its element (`</script` → `<\/script`, also in strings and regexps, where it is equal). */
export const inlineScript = (code: string): string => code.replace(/<\/(script)/gi, "<\\/$1");
/** Style text that cannot close its element. */
export const inlineStyle = (css: string): string => css.replace(/<\/(style)/gi, "<\\/$1");

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The snapshot page (pure). Throws {@link SnapshotTooLarge} beyond `maxBytes`. */
export function renderSnapshot(options: { data: SnapshotData; js: string; css: string; maxBytes?: number }): string {
  const { data } = options;
  const title = `${data.view.project.title ?? data.view.project.id} · console snapshot`;
  // Parts are joined, never `String.replace`d into a template: `$&` and friends in minified code would be expanded.
  const html = [
    "<!doctype html>",
    '<html lang="en" class="dark">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark light">',
    '<meta name="robots" content="noindex">',
    `<meta name="generator" content="pnpm console:snapshot">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${inlineStyle(options.css)}</style>`,
    "</head>",
    "<body>",
    '<div id="root"></div>',
    `<script type="application/json" id="${SNAPSHOT_ELEMENT_ID}">${scriptJson(data)}</script>`,
    `<script type="module">${inlineScript(options.js)}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
  const bytes = Buffer.byteLength(html);
  const maxBytes = options.maxBytes ?? SNAPSHOT_MAX_BYTES;
  if (bytes > maxBytes) throw new SnapshotTooLarge(bytes, maxBytes);
  return html;
}

/** Every secret the snapshot must not carry: `.env` values and the console's session token. */
export function knownSecrets(rootDir: string): string[] {
  const token = readSessionToken(rootDir);
  const managed = Object.values(readManagedCredentials(rootDir).values);
  return [...envSecretValues(rootDir), ...managed, token, readCredentialSessionToken(rootDir)].filter(
    (value): value is string => typeof value === "string",
  );
}
