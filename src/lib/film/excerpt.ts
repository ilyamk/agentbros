import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Deterministic Markdown excerpts for briefs: a brief quotes the one section of a shared reference its agent needs
 * (a concept team's stance, a script variant, a method, the rubric for one kind of review) instead of telling every
 * agent to open the whole file. Same file, same request, same bytes.
 */

/** Largest excerpt a brief carries; a longer one is cut at a line with a marker naming the file. */
export const EXCERPT_CAP = 8192;

/** A section by its heading text: `body` takes it whole (subsections included), `intro` only up to its first subheading. */
export type ExcerptPart = { heading: string; take: "body" | "intro" };

type Heading = { index: number; level: number; title: string };

function headings(lines: string[]): Heading[] {
  const found: Heading[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^(#{1,6}) (.+?)\s*$/.exec(line);
    if (match) found.push({ index, level: match[1]!.length, title: match[2]! });
  });
  return found;
}

/** Exact heading text, or the text before a parenthesis ("zwicky" finds "zwicky (morphological box)"). */
const matches = (title: string, heading: string) => title === heading || title.startsWith(`${heading} (`);

/** One section's lines, heading included. Throws when the heading is missing or not unique: a renamed heading must fail a test, never drop a rule silently. */
export function markdownSection(text: string, part: ExcerptPart, file = "the reference"): string {
  const lines = text.split("\n");
  const all = headings(lines);
  const hits = all.filter((heading) => matches(heading.title, part.heading));
  if (hits.length !== 1)
    throw new Error(
      `${file}: expected one heading "${part.heading}", found ${hits.length}. Update the excerpt with the reference.`,
    );
  const start = hits[0]!;
  const after = all.filter((heading) => heading.index > start.index);
  const end = part.take === "intro" ? after[0] : after.find((heading) => heading.level <= start.level);
  return lines
    .slice(start.index, end?.index ?? lines.length)
    .join("\n")
    .trim();
}

/** Headings two levels down (# becomes ###), so a quote never opens a section of the brief it sits in. */
export const demoteHeadings = (text: string) =>
  text
    .split("\n")
    .map((line) => (/^#{1,4} /.test(line) ? `##${line}` : line))
    .join("\n");

/** Cuts at the last whole line under the cap, with a marker that names the file. */
export function capExcerpt(text: string, file: string, cap = EXCERPT_CAP): string {
  if (Buffer.byteLength(text) <= cap) return text;
  const marker = `\n[Quote cut at ${cap} bytes: the rest is in ${file}.]`;
  const kept: string[] = [];
  let bytes = Buffer.byteLength(marker);
  for (const line of text.split("\n")) {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > cap) break;
    kept.push(line);
    bytes += size;
  }
  return `${kept.join("\n")}${marker}`;
}

/** The parts of a repository Markdown file, in the order asked, headings demoted, capped. */
export function excerpt(repoRoot: string, file: string, parts: ExcerptPart[], cap = EXCERPT_CAP): string {
  const text = readFileSync(path.join(repoRoot, file), "utf8");
  return capExcerpt(demoteHeadings(parts.map((part) => markdownSection(text, part, file)).join("\n\n")), file, cap);
}
