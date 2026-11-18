import type { ReferenceBlueprint, ReferenceSpeechText, ReferenceTechniques } from "../../types/reference";

// A blueprint is the film with its content removed. This finds the film's own words (speech and screen text) still in
// its prose, by stem, so "Portals" and "portal" match; function words, everyday words and the blueprint's own vocabulary
// (schema keys, technique ids) never count.

/** Function words and everyday words that say nothing about a particular film. English; other languages match on stems only. */
export const STOPLIST = new Set(
  `a about above across after again against all almost alone along already also although always am among an and another any anyone anything are around as at away back be because been before behind being below between both but by can cannot could did do does doing done down during each either else enough even ever every few first for from further get gets getting give go goes going gone got had has have having he her here hers him his how however i if in into is it its itself just last least less like made make makes many may me more most much must my near need never new next no none nor not nothing now of off often on once one only onto or other others our out over own part per perhaps quite rather really same see seen several shall she should since so some something still such than that the their them then there these they this those though through thus to together too toward towards under until up upon us very via was way we well were what when where whether which while who whole whom whose why will with within without would yet you your
  ago big small large long short high low left right top bottom middle centre center side front back full half end start begin begins ends open close closed full empty real true false yes no ok okay
  time times day days week year years today now step steps way ways thing things people person one two three four five six seven eight nine ten hundred thousand million first second third last next more most less
  make made use used using get got take took give gave show shows shown see look looks keep set put let run runs work works working help helps try tries need needs want wants know knows find finds call calls come comes move moves turn turns
  text word words line lines letter letters title titles label labels caption captions button buttons screen screens frame frames shot shots cut cuts scene scenes image images photo photos video videos card cards logo logos icon icons page pages app apps window windows field fields bar bars menu cursor click type typed typing
  colour color colours colors white black grey gray red blue green yellow orange purple pink brown dark light bright soft hard bold thin thick plain flat clean simple`
    .split(/\s+/)
    .filter(Boolean),
);

/** Words of the blueprint's own structure: keys and recipe vocabulary. */
const SCHEMA_WORDS = new Set(
  "schema version reference id format width height fps duration sec slot slots role start visual recipe motion sound copy purpose max words technique ids rhythm bpm grid style transfer rules keep must change hook reveal proof transition emphasis cta breath beat beats music voice silence sfx".split(
    " ",
  ),
);

/** A light suffix stemmer: enough that plurals, -ing, -ed and -ly forms of one word meet. */
export function stem(word: string): string {
  let value = word.toLowerCase().replace(/['’]s$/, "");
  if (value.length > 4 && value.endsWith("ies")) value = `${value.slice(0, -3)}y`;
  else if (value.length > 4 && /(?:sses|xes|ches|shes)$/.test(value)) value = value.slice(0, -2);
  else if (value.length > 3 && value.endsWith("s") && !value.endsWith("ss") && !value.endsWith("us"))
    value = value.slice(0, -1);
  if (value.length > 5 && value.endsWith("ing")) value = value.slice(0, -3);
  else if (value.length > 4 && value.endsWith("ed")) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith("ly")) value = value.slice(0, -2);
  return value.replace(/(.)\1$/, "$1");
}

const MIN_LETTERS = 3;
const tokens = (text: string) =>
  (text.normalize("NFKC").match(/\p{L}[\p{L}\p{M}'’]*/gu) ?? [])
    .map((word) => word.replace(/['’]+$/, ""))
    .filter((word) => word.length >= MIN_LETTERS);

export type BlueprintLeak = { word: string; kind: "name" | "word"; where: string[] };

/** Every prose string in the blueprint with its JSON path, leaving out `referenceId`, slot ids and technique ids. */
function prose(value: unknown, at: string, out: { path: string; text: string }[]) {
  if (typeof value === "string") out.push({ path: at, text: value });
  else if (Array.isArray(value)) value.forEach((item, index) => prose(item, `${at}[${index}]`, out));
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (key === "referenceId" || key === "id" || key === "techniqueIds") continue;
      prose(item, at ? `${at}.${key}` : key, out);
    }
  return out;
}

/**
 * Name-like film words: capitalised mid-sentence and never written in lower case in the film (Nexaa, River), or with
 * inner capitals or digits (PayPal, X5). All-caps and title-case lines give no evidence. Everyday words that the film
 * also says are reported apart: a leak only when they carry the film's content.
 */
function filmNames(speechText: ReferenceSpeechText): Set<string> {
  const capitalised = new Set<string>();
  const lower = new Set<string>();
  const read = (words: string[]) => {
    const titleCase = words.length > 1 && words.filter((word) => /^\p{Lu}/u.test(word)).length > words.length / 2;
    words.forEach((raw, index) => {
      for (const word of tokens(raw)) {
        const key = stem(word);
        if (/^\p{Ll}/u.test(word)) lower.add(key);
        const allCaps = word === word.toUpperCase();
        const sentenceStart = index === 0 || /[.!?:]["'’)]*$/.test(words[index - 1]!);
        if (/\p{Ll}\p{Lu}/u.test(word) || /\p{L}\p{N}|\p{N}\p{L}/u.test(raw)) capitalised.add(key);
        else if (!allCaps && !titleCase && !sentenceStart && /^\p{Lu}/u.test(word)) capitalised.add(key);
      }
    });
  };
  read(speechText.speech.words.flatMap((word) => (word.text === undefined ? [] : [word.text])));
  for (const item of speechText.screenText.items)
    if ((item.confidence ?? 1) >= 0.5 && item.text !== undefined) read(item.text.split(/\s+/).filter(Boolean));
  return new Set([...capitalised].filter((key) => !lower.has(key)));
}

/**
 * The film's words left in its blueprint, by stem: `name` leaks (likely brands, products, people) first, then `word`
 * leaks, everyday words the film also says. ref:validate reports both as warnings. Empty without the film's words (a structure-only layer has none: ref:validate reads media/speech-text.full.json).
 */
export function blueprintLeaks(
  blueprint: ReferenceBlueprint,
  speechText: ReferenceSpeechText | undefined,
  techniques?: ReferenceTechniques,
): BlueprintLeak[] {
  if (!speechText) return [];
  const ignored = new Set<string>([...STOPLIST, ...SCHEMA_WORDS].map(stem));
  for (const id of [
    ...(techniques?.techniques.map((technique) => technique.id) ?? []),
    ...blueprint.slots.flatMap((slot) => [slot.id, ...slot.techniqueIds]),
  ])
    for (const word of id.split(/[^\p{L}\p{N}]+/u)) if (word) ignored.add(stem(word));
  const filmText = [
    ...speechText.speech.words.map((word) => word.text),
    ...speechText.screenText.items.filter((item) => (item.confidence ?? 1) >= 0.5).map((item) => item.text),
  ].filter((text): text is string => text !== undefined);
  const film = new Set(
    filmText
      .flatMap(tokens)
      .map(stem)
      .filter((word) => !ignored.has(word)),
  );
  const names = filmNames(speechText);
  const leaks = new Map<string, { kind: BlueprintLeak["kind"]; where: Set<string> }>();
  for (const { path, text } of prose(blueprint, "", []))
    for (const word of tokens(text)) {
      const key = stem(word);
      if (!film.has(key)) continue;
      const row = leaks.get(word.toLowerCase()) ?? { kind: names.has(key) ? "name" : "word", where: new Set<string>() };
      leaks.set(word.toLowerCase(), { ...row, where: row.where.add(path) });
    }
  return [...leaks]
    .map(([word, row]) => ({ word, kind: row.kind, where: [...row.where].sort() }))
    .sort((a, b) => (a.kind === b.kind ? a.word.localeCompare(b.word) : a.kind === "name" ? -1 : 1));
}
