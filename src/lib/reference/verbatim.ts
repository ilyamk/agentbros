import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ReferenceSpeechText } from "../../types/reference";
import { STOPLIST } from "./blueprint-content";

// Our analyses may quote a film's words only briefly: a few words to name a move or a label. Longer copy (a headline,
// a sentence, a script) is the makers' text: describe it instead (its role, length in words, case, size, timing).
// Two detectors: quoted spans longer than the limit, which need nothing but the text, and runs of the film's own words
// copied without quotes, which need this machine's media/speech-text.full.json.

/** The most words a quotation of a film may hold in a tracked file. */
export const MAX_QUOTE_WORDS = 4;

/** Words that count toward the limit: tokens holding a letter, so timecodes, numbers and curves do not. */
export const quoteWordCount = (text: string) => text.split(/\s+/).filter((token) => /\p{L}/u.test(token)).length;

// Straight, curly, guillemet and low-9 double quotes; curly and straight single quotes, where an apostrophe inside a
// word (it's, don't) does not close the quote.
const QUOTES =
  /"([^"\n]+)"|“([^”\n]+)”|«([^»\n]+)»|„([^“”\n]+)[“”]|‘((?:[^’\n]|’(?=\p{L}))+)’(?!\p{L})|(?<![\p{L}\p{N}])'((?:[^'\n]|'(?=\p{L}))+)'(?![\p{L}\p{N}])/gu;

/** Quoted spans of more than `limit` words. */
export function longQuotes(text: string, limit = MAX_QUOTE_WORDS): { quote: string; words: number }[] {
  const out: { quote: string; words: number }[] = [];
  for (const match of text.matchAll(QUOTES)) {
    const quote = match.slice(1).find((group) => group !== undefined)!;
    const words = quoteWordCount(quote);
    if (words > limit) out.push({ quote, words });
  }
  return out;
}

const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
// Words holding a letter: numbers between them (timecodes, counts) do not break a copied run.
const tokensOf = (text: string) =>
  (text.normalize("NFKC").toLowerCase().match(TOKEN) ?? []).filter((token) => /\p{L}/u.test(token));

/**
 * Runs of the film's words: every window of `limit + 1` consecutive words, from the speech as one stream, from each
 * screen text, and from the screen texts in order of appearance (so short quotes chained one after another count).
 */
export function filmRuns(film: ReferenceSpeechText, limit = MAX_QUOTE_WORDS): Set<string> {
  const size = limit + 1;
  const runs = new Set<string>();
  const add = (tokens: string[]) => {
    for (let index = 0; index + size <= tokens.length; index++) {
      const window = tokens.slice(index, index + size);
      // Function words alone ("in the top of the") say nothing about a film: a run needs two content words.
      if (window.filter((token) => !STOPLIST.has(token)).length >= 2) runs.add(window.join(" "));
    }
  };
  add(film.speech.words.flatMap((word) => (word.text ? tokensOf(word.text) : [])));
  const screen = film.screenText.items
    .filter((item) => item.text && (item.confidence ?? 1) >= 0.5)
    .sort((a, b) => a.startSec - b.startSec);
  for (const item of screen) add(tokensOf(item.text!));
  const stream: string[] = [];
  let previous = "";
  for (const item of screen) {
    const tokens = tokensOf(item.text!);
    if (tokens.join(" ") !== previous) stream.push(...tokens);
    previous = tokens.join(" ");
  }
  add(stream);
  return runs;
}

/** The first run of the film's words in `text`, extended as far as it goes. */
export function copiedRun(
  text: string,
  runs: Set<string>,
  limit = MAX_QUOTE_WORDS,
): { run: string; words: number } | undefined {
  if (!runs.size) return undefined;
  const size = limit + 1;
  const tokens = tokensOf(text);
  for (let index = 0; index + size <= tokens.length; index++) {
    if (!runs.has(tokens.slice(index, index + size).join(" "))) continue;
    let end = index + size;
    while (end < tokens.length && runs.has(tokens.slice(end - size + 1, end + 1).join(" "))) end += 1;
    return { run: tokens.slice(index, end).join(" "), words: end - index };
  }
  return undefined;
}

export type VerbatimFinding = {
  file: string;
  where: string;
  kind: "quote" | "film-words" | "speech-text";
  words: number;
  excerpt: string;
};

/** The start of a finding, enough to find it, never the whole copy. */
const excerpt = (text: string) => {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length > MAX_QUOTE_WORDS ? `${words.slice(0, MAX_QUOTE_WORDS).join(" ")} …` : text;
};

function strings(value: unknown, at: string, out: { where: string; text: string }[]) {
  if (typeof value === "string") out.push({ where: at || "(root)", text: value });
  else if (Array.isArray(value)) value.forEach((item, index) => strings(item, `${at}[${index}]`, out));
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) strings(item, at ? `${at}.${key}` : key, out);
  return out;
}

/** Prose of one file: every JSON string with its path, or each Markdown line with its number. */
export function proseOf(file: string, raw: string): { where: string; text: string }[] {
  if (file.endsWith(".json")) {
    try {
      return strings(JSON.parse(raw), "", []);
    } catch {
      return [{ where: "(unparsed)", text: raw }];
    }
  }
  const lines = raw.split("\n");
  const frontMatterEnd = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  return lines.map((text, index) => ({
    where: `line ${index + 1}`,
    text: index > 0 && index < frontMatterEnd ? yamlValue(text) : text,
  }));
}

/** A front-matter line's value without its YAML quoting: `key: "text"` and `key: ["a", "b"]` are not quotations. */
function yamlValue(line: string): string {
  const match = /^\s*[\w-]+:\s*(.*)$/.exec(line);
  if (!match) return line;
  const value = match[1]!.trim();
  const unquote = (item: string) => (/^".*"$/.test(item) ? item.slice(1, -1).replace(/\\"/g, "'") : item);
  if (/^\[.*\]$/.test(value))
    return value
      .slice(1, -1)
      .replace(/"\s*,\s*"/g, "; ")
      .replace(/^"|"$/g, "");
  return unquote(value);
}

/** Long quotations and, with the film's words, unquoted copies of them, in one text file. */
export function verbatimInText(file: string, raw: string, runs?: Set<string>): VerbatimFinding[] {
  const findings: VerbatimFinding[] = [];
  for (const { where, text } of proseOf(file, raw)) {
    for (const { quote, words } of longQuotes(text))
      findings.push({ file, where, kind: "quote", words, excerpt: excerpt(quote) });
    const copied = runs && copiedRun(text, runs);
    if (copied) findings.push({ file, where, kind: "film-words", words: copied.words, excerpt: excerpt(copied.run) });
  }
  return findings;
}

const LOCAL_DIRECTORIES = new Set(["media", "visuals", "compare"]);

/** Tracked-candidate text files of a reference: .json and .md outside media/, visuals/ and compare/, relative to it. */
export function referenceTextFiles(directory: string): string[] {
  const out: string[] = [];
  const visit = (relative: string) => {
    for (const name of readdirSync(path.join(directory, relative)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const stat = statSync(path.join(directory, child));
      if (stat.isDirectory()) {
        if (!(relative === "" && LOCAL_DIRECTORIES.has(name))) visit(child);
      } else if (/\.(json|md)$/.test(name)) out.push(child);
    }
  };
  if (existsSync(directory)) visit("");
  return out;
}

/**
 * Verbatim text in a reference's tracked-candidate files: the film's words left in speech-text.json, quotations over
 * MAX_QUOTE_WORDS anywhere else, and, when `film` (the local full text) is given, unquoted runs of its words.
 */
export function referenceVerbatim(directory: string, film?: ReferenceSpeechText): VerbatimFinding[] {
  const runs = film ? filmRuns(film) : undefined;
  const findings: VerbatimFinding[] = [];
  for (const file of referenceTextFiles(directory)) {
    const raw = readFileSync(path.join(directory, file), "utf8");
    if (file === "speech-text.json") {
      let layer: ReferenceSpeechText | undefined;
      try {
        layer = JSON.parse(raw) as ReferenceSpeechText;
      } catch {
        continue;
      }
      const words =
        (layer.speech?.words ?? []).filter((word) => typeof word.text === "string").length +
        (layer.screenText?.items ?? []).filter((item) => typeof item.text === "string").length;
      if (words)
        findings.push({
          file,
          where: "speech.words[].text, screenText.items[].text",
          kind: "speech-text",
          words,
          excerpt: `${words} entries hold the film's words; run pnpm ref:redact`,
        });
      continue;
    }
    findings.push(...verbatimInText(file, raw, runs));
  }
  return findings;
}
