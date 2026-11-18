import type { CaptionWord } from "./pages";

/**
 * Connective words that carry grammar, not meaning: they are set small in mixed-scale pages and never become the
 * page's key word. English and Russian; other languages fall back to length and position alone.
 */
const STOP_WORDS = new Set(
  (
    "a an the and or but nor so yet if then than that this these those there here of to in on at by for from with into onto over under about as is are was were be been being am do does did done have has had having will would shall should can could may might must " +
    "i me my mine you your yours he him his she her hers it its we us our ours they them their theirs who whom whose which what when where why how not no just very really also too only even still all any some each every both either neither " +
    "it's i'm you're we're they're that's there's here's what's don't doesn't didn't can't won't isn't aren't wasn't weren't i've we've you've they've i'll you'll we'll they'll i'd you'd we'd let's oh um uh like know mean " +
    "и в во не на я что он она оно они мы вы ты с со как а то все всё но да к ко у же бы по за из от о об для до при над под без так это этот эта эти тот та те там тут вот ну ли или если чтобы когда где уже ещё еще только мне меня мой моя мои его её ее их нас вас нам вам был была было были быть есть будет"
  ).split(/\s+/),
);

export type WordTier = "small" | "base" | "key";

const normalise = (text: string, language: string) =>
  text
    .toLocaleLowerCase(language)
    .replace(/[^\p{L}\p{N}'’]+/gu, "")
    .replace(/’/g, "'");

const isNumeric = (text: string) => /\p{N}/u.test(text);

/**
 * Importance of one word, a pure function of its text: marked emphasis 100, listed keyword 90, a number or amount 60,
 * an exclamation 45, a content word 10 + its letters (so longer content words win ties), a connective word 0.
 */
export const wordImportance = (
  word: CaptionWord,
  language: string,
  keywords: ReadonlySet<string> = new Set(),
): number => {
  const plain = normalise(word.text, language);
  if (word.emphasis) return 100;
  if (keywords.has(plain)) return 90;
  if (!plain || word.kind === "filler") return 0;
  if (isNumeric(plain)) return 60;
  if (STOP_WORDS.has(plain)) return 0;
  return (/!$/.test(word.text) ? 45 : 10) + Math.min(plain.length, 14);
};

/**
 * Tiers for one page: the single most important word is `key` when it beats the rest (a marked or listed word, a number,
 * or a content word of five letters or more); connective words are `small`; the rest `base`. Ties go to the later
 * word, where English and Russian put new information. `maxKeys` above 1 adds the next most important words.
 */
export const pageTiers = (
  words: readonly CaptionWord[],
  language: string,
  options: { keywords?: readonly string[]; source: "auto" | "marked" | "off"; maxKeys?: number },
): WordTier[] => {
  const keywords = new Set((options.keywords ?? []).map((keyword) => normalise(keyword, language)));
  const scores = words.map((word) => wordImportance(word, language, keywords));
  const tiers: WordTier[] = scores.map((score) => (score === 0 ? "small" : "base"));
  if (options.source === "off") return tiers;
  const eligible = (score: number) => (options.source === "marked" ? score >= 90 : score >= 15);
  const order = scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score || b.index - a.index);
  for (const { score, index } of order.slice(0, options.maxKeys ?? 1)) if (eligible(score)) tiers[index] = "key";
  return tiers;
};
