/**
 * The user's own words, as an `--answer`, `--quote` or `--clarify` value: one shared check that refuses what an agent
 * writes when it has not asked. Empty text, an unfilled template placeholder ("<the user's words>", "THE USER'S WORDS",
 * TODO), an agent's narration of the user ("the user approved") and a hint or question repeated back are refused.
 * Short real answers ("yes", "ok", "да", "approved") always pass: the check looks for what is not the user's, never
 * for how much they said.
 */
import { CliErrorObject } from "./index";

/** The exact placeholders the hints print (film:next, footage:next, budget, film:policy, campaign docs), normalised. */
const PLACEHOLDERS = new Set(
  [
    "the user's words",
    "the user's own words",
    "the users words",
    "user_words",
    "user words",
    "users_words",
    "user's words",
    "users words",
    "user's own words",
    "their words",
    "their own words",
    "the user's answer",
    "user answer",
    "answer",
    "your answer",
    "your words",
    "quote",
    "the quote",
    "verbatim",
    "todo",
    "tbd",
    "tba",
    "fixme",
    "xxx",
    "placeholder",
    "lorem ipsum",
    "n/a",
    "null",
    "undefined",
    "...",
    "…",
  ].map((text) => normalise(text)),
);

/** An agent describing the user instead of quoting them. */
const NARRATION = [
  /^(the )?user (has )?(approved|approves|accepted|accepts|agreed|agrees|confirmed|confirms|said|says|wants|chose|picked|is happy|is fine|gave)\b/i,
  /^(approved|accepted|confirmed) by (the )?user\b/i,
  /^(per|as per|according to) (the )?user\b/i,
  /^(the )?user'?s? (approval|confirmation|go-ahead|decision)$/i,
  /^(auto|automatic(ally)?)[- ]?(approved|approval|accepted)\b/i,
];

function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”«»"`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^['.:;,!\-\s]+|['.:;,!\-\s]+$/g, "")
    .toLowerCase();
}

export type UserWordsOptions = {
  /** The hint, question or example text the agent was shown: an answer that repeats one back is refused. */
  hints?: readonly (string | undefined)[];
};

/** Why `text` is not the user's own words, or undefined when it may be. */
export function userWordsProblem(text: string | undefined, options: UserWordsOptions = {}): string | undefined {
  const raw = (text ?? "").trim();
  if (!raw) return "it is empty";
  if (
    /^<[^]*>$/.test(raw) ||
    /<\s*(the |your |their )?(user|answer|words|quote|own words|name|reason)[^<>]*>/i.test(raw)
  )
    return `it still holds a template placeholder (${raw.length > 60 ? `${raw.slice(0, 59)}…` : raw})`;
  const flat = normalise(raw);
  if (!flat) return "it holds no words";
  if (PLACEHOLDERS.has(flat)) return `"${raw}" is a placeholder, not an answer`;
  if (/^(todo|tbd|fixme)\b/i.test(flat)) return `"${raw}" is a placeholder, not an answer`;
  if (NARRATION.some((pattern) => pattern.test(flat)))
    return "it narrates the user in the third person: pass their own words, verbatim";
  for (const hint of options.hints ?? []) {
    if (!hint) continue;
    const shown = normalise(hint);
    if (!shown) continue;
    if (flat === shown || (flat.length >= 24 && shown.includes(flat)))
      return "it repeats the hint or question back instead of the user's answer";
  }
  return undefined;
}

/** Throws INVALID_INPUT naming the flag when `text` is not the user's own words; returns the trimmed text. */
export function requireUserWords(text: string | undefined, flag: string, options: UserWordsOptions = {}): string {
  const problem = userWordsProblem(text, options);
  if (problem)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `${flag} must be the user's own words, verbatim: ${problem}. Ask the user and pass exactly what they said.`,
    });
  return text!.trim();
}
