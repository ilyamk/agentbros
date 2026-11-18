/** Leak scanning shared by export:public and memory:upstream: config patterns, hashed name tokens and memory needles. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFrontMatter } from "./memory/frontmatter";
import { CliErrorObject } from "./cli";
import { LocalLeakPatternsSchema, type LeakPattern } from "../types/leak-scan";

/** A regex, or sha256 hashes of lower-case name tokens so the config does not spell out the names it guards. */
export type { LeakPattern } from "../types/leak-scan";
/** `only`: the hit passes only when the line no longer matches after these literal strings are removed (e.g. one placeholder address). */
export type AllowedHit = { glob: string; pattern: string; reason: string; only?: string[] };
export type LeakTester = { name: string; regex: { test: (text: string) => boolean } };

/** The neutral identity of everything published from this repository. */
export const PUBLIC_AUTHOR = "Agent Bros. Pictures contributors";
export const PUBLIC_EMAIL = "noreply@example.com";

/** Export merges local patterns when present; CI opts out and maintainer checks require them. */
export function loadLeakPatterns(
  root: string,
  generic: readonly LeakPattern[],
  local: "optional" | "required" | "none" = "optional",
): { leakPatterns: LeakPattern[]; localPatterns: boolean } {
  const file = path.join(root, "leak-patterns.local.json");
  if (local === "none") return { leakPatterns: [...generic], localPatterns: false };
  if (!existsSync(file)) {
    if (local === "required")
      throw new CliErrorObject({
        code: "FILE_NOT_FOUND",
        message: "--local requires leak-patterns.local.json at the repository root",
      });
    return { leakPatterns: [...generic], localPatterns: false };
  }
  const config = LocalLeakPatternsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return { leakPatterns: [...generic, ...config.leakPatterns], localPatterns: true };
}

/** Whether an allowed-hit rule excuses this line: always, or with `only`, when nothing but its listed literals matched. */
export function excuses(rule: Pick<AllowedHit, "only">, tester: LeakTester, line: string): boolean {
  if (!rule.only) return true;
  const rest = rule.only.reduce((text, literal) => text.split(literal).join(" "), line);
  return !tester.regex.test(rest);
}

export function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

/** Config leak patterns as testers; a sha256 pattern matches lower-case words split at non-alphanumerics and camelCase, plus adjacent pairs inside a hyphenated word. */
export function compileLeakPatterns(leakPatterns: readonly LeakPattern[]): LeakTester[] {
  const digests = new Map<string, string>();
  const digest = (token: string) =>
    digests.get(token) ?? (digests.set(token, createHash("sha256").update(token).digest("hex")), digests.get(token)!);
  const tokenHashes = (text: string) => {
    const tokens = new Set<string>();
    for (const chunk of text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9-]+/)) {
      const words = chunk.split("-").filter(Boolean);
      words.forEach((word, index) => {
        tokens.add(word);
        if (index) tokens.add(`${words[index - 1]}-${word}`);
      });
    }
    return new Set([...tokens].map(digest));
  };
  return leakPatterns.map((item) => {
    if ("sha256" in item) {
      const wanted = new Set(item.sha256);
      return {
        name: item.name,
        regex: { test: (text: string) => [...tokenHashes(text)].some((hash) => wanted.has(hash)) },
      };
    }
    return { name: item.name, regex: new RegExp(item.regex, item.flags ?? "") };
  });
}

/** A needle holds at least this many words made of letters; code spans and table rows are skipped, so separators, code and markup never count. */
export const MEMORY_NEEDLE_WORDS = 4;

export function memoryNeedles(text: string): string[] {
  return text
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^(?:[-*+>#]+|\d+[.)])\s+/, "")
        .trim(),
    )
    .filter((line) => !line.includes("`") && !/^\|.*\|$/.test(line))
    .filter(
      (line) =>
        line.split(/\s+/).filter((word) => /^\p{P}*\p{L}[\p{L}\p{M}'’-]*\p{P}*$/u.test(word)).length >=
        MEMORY_NEEDLE_WORDS,
    );
}

/** The decoded texts of each memory entry under `dirs` (recursively): summary, the user's quote, a proposal's approval and confirmation quotes and verdict, and the body. */
function memoryTexts(dirs: readonly string[], skip: readonly string[]): { id: string; texts: string[] }[] {
  const out: { id: string; texts: string[] }[] = [];
  const visit = (dir: string, top: boolean) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const entry = path.join(dir, name);
      const stat = lstatSync(entry);
      if (stat.isDirectory()) {
        if (!(top && skip.includes(name))) visit(entry, false);
        continue;
      }
      if (!stat.isFile() || !name.endsWith(".md") || (top && name === "AGENTS.md")) continue;
      const raw = readFileSync(entry, "utf8");
      let texts: string[];
      try {
        const { data, body } = parseFrontMatter(raw);
        const source = data.source as { quote?: unknown } | undefined;
        const proposal = data.proposal as
          { approval?: { quote?: unknown }; confirmation?: { quote?: unknown }; verdict?: unknown } | undefined;
        texts = [
          data.summary,
          source?.quote,
          proposal?.approval?.quote,
          proposal?.confirmation?.quote,
          proposal?.verdict,
          body,
        ].filter((value): value is string => typeof value === "string");
      } catch {
        // An entry the parser rejects is still private: scan its raw text.
        texts = [raw];
      }
      out.push({ id: name.slice(0, -3), texts });
    }
  };
  for (const dir of dirs) visit(dir, true);
  return out;
}

/**
 * Distinctive lines of each memory entry under `dirs`, whole: see memoryTexts and memoryNeedles.
 * `skip` names top-level folders that hold output rather than entries (memory/upstream: patches built from tracked text).
 */
export function memoryContent(dirs: readonly string[], skip: readonly string[] = []): { id: string; needle: string }[] {
  const needles = new Map<string, string>();
  for (const { id, texts } of memoryTexts(dirs, skip))
    for (const needle of texts.flatMap(memoryNeedles)) if (!needles.has(needle)) needles.set(needle, id);
  return [...needles].map(([needle, id]) => ({ id, needle }));
}

/** Window length of shingle matching: a memory line of more words is matched by any run of this many of them. */
export const SHINGLE_WORDS = 6;

/** Case-folded words, punctuation and whitespace removed: "Don't  put it — HERE" becomes don, t, put, it, here. */
export function normaliseWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Shingles of a memory text: per line (backticks stripped, table rows skipped, at least MEMORY_NEEDLE_WORDS letter words), the whole line up to SHINGLE_WORDS words, else every overlapping window of SHINGLE_WORDS. */
export function memoryShingles(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw
      .replaceAll("`", "")
      .trim()
      .replace(/^(?:[-*+>#]+|\d+[.)])\s+/, "")
      .trim();
    if (/^\|.*\|$/.test(line)) continue;
    if (
      line.split(/\s+/).filter((word) => /^\p{P}*\p{L}[\p{L}\p{M}'’-]*\p{P}*$/u.test(word)).length < MEMORY_NEEDLE_WORDS
    )
      continue;
    const words = normaliseWords(line);
    if (words.length <= SHINGLE_WORDS) out.push(words.join(" "));
    else for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) out.push(words.slice(i, i + SHINGLE_WORDS).join(" "));
  }
  return out;
}

/** Shingles by word count, each with the entry it came from. */
export type ShingleIndex = Map<number, Map<string, string>>;

export function shingleIndex(sources: readonly { id: string; texts: readonly string[] }[]): ShingleIndex {
  const index: ShingleIndex = new Map();
  for (const { id, texts } of sources) {
    for (const shingle of texts.flatMap(memoryShingles)) {
      const size = shingle.split(" ").length;
      if (!index.has(size)) index.set(size, new Map());
      if (!index.get(size)!.has(shingle)) index.get(size)!.set(shingle, id);
    }
  }
  return index;
}

/** The shingle index of every memory entry under `dirs` (see memoryContent for `skip`). */
export function memoryShingleIndex(dirs: readonly string[], skip: readonly string[] = []): ShingleIndex {
  return shingleIndex(memoryTexts(dirs, skip));
}

/** Where a text holds a memory shingle: its words are normalised and joined across lines, so a quote rewrapped over two lines is found at the line it starts on. */
export function findShingles(text: string, index: ShingleIndex): { line: number; id: string; shingle: string }[] {
  if (index.size === 0) return [];
  const words: string[] = [];
  const lines: number[] = [];
  text.split("\n").forEach((line, number) => {
    for (const word of normaliseWords(line)) {
      words.push(word);
      lines.push(number + 1);
    }
  });
  const hits = new Map<string, { line: number; id: string; shingle: string }>();
  for (const [size, shingles] of index) {
    for (let i = 0; i + size <= words.length; i++) {
      const shingle = words.slice(i, i + size).join(" ");
      const id = shingles.get(shingle);
      if (id && !hits.has(`${lines[i]} ${id}`)) hits.set(`${lines[i]} ${id}`, { line: lines[i]!, id, shingle });
    }
  }
  return [...hits.values()].sort((a, b) => a.line - b.line);
}
