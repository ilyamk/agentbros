import { CliErrorObject } from "../cli";
import type { Modality } from "../../types/references";
import type { ReferenceProfile } from "../../types/reference-profiles";

/**
 * Marker dialects (RFC 0003 §3.9, §7 step 4): how a prompt names an attached reference, and the parser the
 * compiler's bijection check (§7 step 6) runs over the final prompt. Pure: no I/O.
 */

export type DialectKind = ReferenceProfile["dialect"]["kind"];
/** What the dialect needs to know about one attachment (or one element group). */
export type MarkerSubject = {
  modality: Modality;
  /** 1-based ordinal within its marker group (default: its modality), in the compiler's slot order. */
  ordinal: number;
  /** 1-based element index, for element attachments. */
  element?: number;
  /** The requirement key; the source of an at-named tag. */
  requirementKey: string;
};
/**
 * Wording for profiles whose prompts name references in prose (natural dialect). "reference" gives "the first
 * reference image"; "attached" reproduces genjutsuPrompt() with useMarkers false ("attached image 1",
 * "the attached source video").
 */
export type NaturalWording = "reference" | "attached";

const ORDINALS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
];
export function ordinalWord(n: number): string {
  if (ORDINALS[n - 1]) return ORDINALS[n - 1]!;
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10];
  return `${n}${suffix ?? "th"}`;
}

const DEFAULT_TEMPLATES: Record<Modality, string> = { image: "@Image{n}", video: "@Video{n}", audio: "@Audio{n}" };
const PROSE_NOUN: Record<Modality, string> = { image: "image", video: "video", audio: "audio" };
const invalid = (message: string) => new CliErrorObject({ code: "VALIDATION", message });

/** "hero-identity" → "heroidentity"; refuses a tag outside Runway's 3–15 alphanumeric rule. */
export function namedTag(requirementKey: string): string {
  const tag = requirementKey.replace(/[^A-Za-z0-9]/g, "");
  if (!/^[A-Za-z][A-Za-z0-9]{2,14}$/.test(tag))
    throw invalid(
      `Requirement key ${requirementKey} gives the named tag "${tag}", which must be 3–15 letters or digits starting with a letter; rename the requirement key.`,
    );
  return `@${tag}`;
}

function atTemplate(profile: ReferenceProfile, modality: Modality): string {
  const templates = profile.dialect.templates;
  if (templates && !templates[modality])
    throw invalid(
      `Profile ${profile.family} has no ${modality} marker template; a ${modality} reference cannot be named.`,
    );
  return templates?.[modality] ?? DEFAULT_TEMPLATES[modality];
}
function fill(template: string, n: number): string {
  if (!template.includes("{n}")) throw invalid(`Marker template ${template} has no {n}.`);
  return template.replaceAll("{n}", String(n));
}

/**
 * The marker naming one attachment (or element), or null when the dialect has none (parameter, none).
 * For natural dialects it is the description that stands in for a marker.
 */
export function markerFor(
  profile: ReferenceProfile,
  subject: MarkerSubject,
  wording: NaturalWording = "reference",
): string | null {
  const kind = profile.dialect.kind;
  if (kind === "at-element" && subject.element !== undefined)
    return fill(profile.dialect.elementTemplate ?? "@Element{n}", subject.element);
  switch (kind) {
    case "at-indexed":
    case "at-element":
      return fill(atTemplate(profile, subject.modality), subject.ordinal);
    case "at-named":
      return namedTag(subject.requirementKey);
    case "prose-indexed":
      return `${PROSE_NOUN[subject.modality]} ${subject.ordinal}`;
    case "natural":
      if (wording === "attached")
        return subject.modality === "video" && subject.ordinal === 1
          ? "the attached source video"
          : `attached ${PROSE_NOUN[subject.modality]} ${subject.ordinal}`;
      return `the ${ordinalWord(subject.ordinal)} reference ${PROSE_NOUN[subject.modality]}`;
    case "parameter":
    case "none":
      return null;
  }
}

/** True when markers are tokens the parser can find and the bijection check applies. */
export function dialectHasMarkers(kind: DialectKind): boolean {
  return kind === "at-indexed" || kind === "at-element" || kind === "at-named" || kind === "prose-indexed";
}

export type FoundMarker = {
  /** The text as written. */
  text: string;
  /** The canonical marker (the exact form markerFor emits), for own markers. */
  marker?: string;
  /** "own": written in this profile's dialect; "foreign": an at-marker of another dialect or form. */
  kind: "own" | "foreign";
  index: number;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A template's regex with a digit-bounded index group, so @Image1 never matches inside @Image10. */
function templateRegExp(template: string): RegExp {
  const [before, after] = template.split("{n}").map(escapeRegExp);
  const tail = after ? `${after}(?![A-Za-z0-9])` : "(?![0-9])";
  return new RegExp(`(?<![A-Za-z0-9])${before}(\\d+)${tail}`, "g");
}
/** Every at-marker family any dialect uses, including spaced or bracketed variants. */
const GENERIC_AT = /@(?:Image|Video|Audio|Element)\s*\d+(?![0-9])|\[(?:Image|Video|Audio)\d+\]/gi;
const NAMED_AT = /(?<![A-Za-z0-9_.])@[A-Za-z][A-Za-z0-9]*(?![A-Za-z0-9])/g;
const PROSE = /\b(image|video|audio)\s+(\d+)(?![0-9])/gi;

function scan(text: string, pattern: RegExp): { text: string; index: number; groups: string[] }[] {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map((match) => ({
    text: match[0],
    index: match.index,
    groups: match.slice(1),
  }));
}

/**
 * Every marker in `text`: own markers in canonical form (out-of-range indices included, so the caller can refuse
 * them) and foreign markers. Natural, parameter and none dialects have no own markers; any at-marker is foreign.
 */
export function findMarkers(profile: ReferenceProfile, text: string, tags: readonly string[] = []): FoundMarker[] {
  const kind = profile.dialect.kind;
  const own: FoundMarker[] = [];
  const claimed = new Set<number>();
  const claim = (found: { text: string; index: number }, marker: string) => {
    for (let i = found.index; i < found.index + found.text.length; i++) claimed.add(i);
    own.push({ text: found.text, marker, kind: "own", index: found.index });
  };
  if (kind === "at-indexed" || kind === "at-element") {
    const templates = new Set(Object.values(profile.dialect.templates ?? DEFAULT_TEMPLATES));
    if (kind === "at-element") templates.add(profile.dialect.elementTemplate ?? "@Element{n}");
    for (const template of templates)
      for (const found of scan(text, templateRegExp(template))) claim(found, fill(template, Number(found.groups[0])));
  } else if (kind === "at-named") {
    const known = new Set(tags);
    for (const found of scan(text, NAMED_AT)) if (known.has(found.text)) claim(found, found.text);
  } else if (kind === "prose-indexed") {
    for (const found of scan(text, PROSE)) claim(found, `${found.groups[0]!.toLowerCase()} ${Number(found.groups[1])}`);
  }
  const foreign: FoundMarker[] = [];
  const patterns = kind === "at-named" ? [GENERIC_AT, NAMED_AT] : [GENERIC_AT];
  for (const pattern of patterns)
    for (const found of scan(text, pattern)) {
      if (claimed.has(found.index) || foreign.some((item) => item.index === found.index)) continue;
      foreign.push({ text: found.text, kind: "foreign", index: found.index });
    }
  return [...own, ...foreign].sort((a, b) => a.index - b.index);
}
