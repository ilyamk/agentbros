import type { z } from "zod";
import type { InlinePronunciationSchema, SpeechCueSchema } from "../../types/elevenlabs";

type SpeechCue = z.infer<typeof SpeechCueSchema>;
export type InlinePronunciation = z.infer<typeof InlinePronunciationSchema>;

const brackets = /\[([^\[\]\r\n]+)\]/gu;

export function removeDirection(text: string, approvedText = "") {
  const literal = [...approvedText.matchAll(brackets)].map(([span]) => span);
  let index = 0;
  return text.replace(brackets, (span: string) => {
    if (span !== literal[index]) return " ";
    index++;
    return span;
  });
}

/** Ignore delivery punctuation without losing signs, decimal values or word boundaries. */
export function spokenTokens(text: string): string[] {
  return (
    text
      .normalize("NFC")
      .toLowerCase()
      .replace(/[’ʼ]/gu, "'")
      .match(
        /[+−-]?\p{N}+(?:[.,:/-]\p{N}+)*(?:\s?[%‰])?|[\p{L}\p{M}][\p{L}\p{M}\p{N}]*(?:['-][\p{L}\p{M}\p{N}]+)*|[+−%‰&\p{Sc}]/gu,
      ) ?? []
  ).map((token) => token.replace(/\s/gu, ""));
}

export function sameSpokenWords(first: string, second: string): boolean {
  return JSON.stringify(spokenTokens(first)) === JSON.stringify(spokenTokens(second));
}

export function validateDirectedText(
  approvedText: string,
  directedText: string,
  pronunciations: InlinePronunciation[] = [],
): void {
  const providerText = compileSpeechCues(approvedText, [], pronunciations);
  if (!sameSpokenWords(removeDirection(directedText, approvedText), providerText))
    throw Error("Directed text must preserve the approved words, numbers and order");
  if (pronunciations.some(({ ipa }) => directedText.split(`/${ipa}/`).length !== providerText.split(`/${ipa}/`).length))
    throw Error("Directed text changed approved inline IPA");
  const literal = [...approvedText.matchAll(brackets)].map(([span]) => span);
  const directedLiteral = [...directedText.matchAll(brackets)]
    .map(([span]) => span)
    .filter((span) => literal.includes(span));
  if (JSON.stringify(literal) !== JSON.stringify(directedLiteral))
    throw Error("Directed text changed literal bracketed text");
  const residue = directedText.replace(brackets, "");
  if (/[\[\]]/u.test(residue) && !/[\[\]]/u.test(approvedText.replace(brackets, "")))
    throw Error("Unbalanced or nested audio tags");
}

export function compileSpeechCues(
  approvedText: string,
  cues: SpeechCue[],
  pronunciations: InlinePronunciation[] = [],
): string {
  if (cues.some((cue, index) => index > 0 && cue.offset < cues[index - 1]!.offset))
    throw Error("Speech cues must be ordered");
  if (pronunciations.some((word, index) => index > 0 && word.start < pronunciations[index - 1]!.end))
    throw Error("Inline IPA substitutions must be ordered and disjoint");
  const segments = [...new Intl.Segmenter("und", { granularity: "word" }).segment(approvedText)];
  const wordStarts = new Set([approvedText.length, ...segments.map((segment) => segment.index)]);
  const patches = [
    ...cues.map((cue) => ({ start: cue.offset, end: cue.offset, text: ` [${cue.direction}] ` })),
    ...pronunciations.map(({ start, end, ipa }) => {
      if (
        !segments.some(
          (segment) => segment.isWordLike && segment.index === start && segment.index + segment.segment.length === end,
        )
      )
        throw Error("Inline IPA must replace one complete approved word");
      return { start, end, text: `/${ipa}/` };
    }),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  let offset = 0;
  let directed = "";
  for (const patch of patches) {
    if (patch.start < offset || !wordStarts.has(patch.start))
      throw Error("Speech cues must be ordered and start at a word boundary");
    directed += approvedText.slice(offset, patch.start) + patch.text;
    offset = patch.end;
  }
  return (directed + approvedText.slice(offset)).trim();
}
