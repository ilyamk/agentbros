/** Choosing a playbook from the user's own words, in English or Russian. Ranked candidates, never one verdict. */
import { existsSync } from "node:fs";
import path from "node:path";
import type { Playbook } from "../../types/playbook";
import { listPlaybookIds, loadPlaybook, playbooksRoot } from "./project";

/** `variant`: the trigger belongs to that variant of the playbook. `generic`: it also describes neighbouring kinds. */
export type PlaybookHit = { trigger: string; words: string; variant?: string; generic?: true };

export type PlaybookCandidate = {
  id: string;
  title: string;
  status: Playbook["status"];
  /**
   * One per distinct trigger that matched, plus 0.5 for each extra word of a phrase (two Chinese characters count as a
   * word): a phrase is more specific than a stem but never outweighs two stems. A generic trigger scores 0.5. A trigger
   * lying wholly inside a longer matched one does not count again.
   */
  score: number;
  /** At least one matched trigger is not generic: only such a candidate can be a clear match. */
  specific: boolean;
  /** Each matched trigger with the request words it matched. */
  matched: PlaybookHit[];
  notFor: Playbook["notFor"];
  /** The variant whose triggers matched most (its triggers add to the playbook's score). */
  variant?: { id: string; title: string };
};

export type PlaybookModifier = "reference-style" | "replica";

/**
 * `clear`: the top candidate matched a specific (not generic) trigger, and its score is at least 2 and leads the next
 * candidate by at least 1, or it is the lone candidate with at least 1.5 (one specific phrase such as "logo reveal").
 * `weak`: anything less, including a tie. `none`: nothing matched. Only a clear match may be bound without asking.
 */
export type MatchStrength = "clear" | "weak" | "none";

export type PlaybookMatch = {
  candidates: PlaybookCandidate[];
  /** More than one candidate shares the top score: ask the user. */
  tie: boolean;
  strength: MatchStrength;
  question?: string;
  /** Orthogonal to the playbook: a reference to follow in style, or an explicit request to copy a film. */
  modifiers: PlaybookModifier[];
  /** The request names a project that exists: continue it (`pnpm next --project <id>`) rather than start a film. */
  existingProject?: string;
};

const URL =
  /\b(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com|vimeo\.com|x\.com|twitter\.com)\/\S*/giu;
const REPLICA =
  /точн\S* копи|скопируй|скопировать|покадров|copy (?:it |this |the film |the video )?exactly|exact copy|replicate|shot[- ]for[- ]shot|一模一样|完全复刻|原样复刻|逐帧复刻|逐个镜头|照搬/iu;
const REFERENCE =
  /в стиле|референс|style of|in the style|like this video|как в этом видео|как в этом ролике|参考视频|参考这个|按照这个|照着这个|仿照|模仿这个|这种风格|同款风格|像这个视频/iu;

const normalise = (text: string) => text.toLowerCase().replaceAll("ё", "е");
/** Chinese has no spaces: each Han character is its own token, and a Chinese trigger matches as a run of them. */
const HAN = /^\p{Script=Han}$/u;
const tokens = (text: string): string[] =>
  normalise(text).match(/\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu) ?? [];
/** A phrase's length in words: two Han characters count as one word. */
const phraseWords = (words: string[]) => {
  const han = words.filter((word) => HAN.test(word)).length;
  return words.length - han + Math.ceil(han / 2);
};

/**
 * A trigger word is a stem: "субтитр" matches "субтитрами". Words of up to 3 letters match whole. A longer request word
 * also matches a near form sharing the trigger's first max(5, length - 2) letters, so "запуск" meets "запуска" and
 * "запусти" but not "запутанная", and "promo" never meets "prompt".
 */
export function wordMatches(token: string, word: string): boolean {
  if (word.length <= 3) return token === word;
  if (token.startsWith(word)) return true;
  const need = Math.max(5, word.length - 2);
  return need < word.length && token.length >= need && token.slice(0, need) === word.slice(0, need);
}

/**
 * Every run of request tokens one trigger covers, in order. Between two words of a phrase one extra request word may
 * stand ("видео с нашей конференции" meets "видео с конференции"); Chinese characters must be adjacent.
 */
function triggerRuns(request: string[], trigger: string): number[][] {
  const words = tokens(trigger);
  if (!words.length) return [];
  const runs: number[][] = [];
  const extend = (run: number[]): number[] | undefined => {
    if (run.length === words.length) return run;
    const last = run[run.length - 1]!;
    const word = words[run.length]!;
    const gap = HAN.test(word) || HAN.test(words[run.length - 1]!) || HAN.test(request[last + 1] ?? "") ? 1 : 2;
    for (let next = last + 1; next <= last + gap && next < request.length; next++)
      if (wordMatches(request[next]!, word)) {
        const done = extend([...run, next]);
        if (done) return done;
      }
    return undefined;
  };
  for (let start = 0; start < request.length; start++) {
    if (!wordMatches(request[start]!, words[0]!)) continue;
    const run = extend([start]);
    if (run) runs.push(run);
  }
  return runs;
}

export function modifiersOf(text: string): PlaybookModifier[] {
  if (REPLICA.test(text)) return ["replica"];
  // A remix clip is the material itself; a link or character reference is not a request to borrow its style.
  const remix =
    /genjutsu|video remix|character swap|object swap|motion transfer|restyle|замен\S* (?:персонаж|человек|лиц|предмет)|перен\S* движен|ремикс видео|换成我的|换人|换脸|动作迁移|转绘|视频二创/iu.test(
      text,
    );
  if (remix && !/в стиле|style of|in the style|like this video|как в этом видео|参考视频|这种风格|仿照/iu.test(text))
    return [];
  URL.lastIndex = 0;
  return REFERENCE.test(text) || URL.test(text) ? ["reference-style"] : [];
}

/** A project the request names: "проект <id>" / "project <id>" / "项目 <id>", or an id with a hyphen or digit, that exists. */
export function existingProjectOf(text: string, exists: (id: string) => boolean): string | undefined {
  const named = [
    ...normalise(text).matchAll(/(?:проект\S*|project|项目)\s*[«"'`“]?([a-z0-9]+(?:[-_][a-z0-9]+)*)/gu),
  ].map((match) => match[1]!);
  const shaped = normalise(text).match(/[a-z0-9]+(?:-[a-z0-9]+)+|[a-z]+[0-9][a-z0-9]*/gu) ?? [];
  return [...named, ...shaped].find((id) => exists(id));
}

export function scorePlaybook(
  text: string,
  playbook: Playbook,
): Pick<PlaybookCandidate, "score" | "specific" | "matched" | "variant"> {
  const request = tokens(text.replace(URL, " "));
  const generic = new Set((playbook.triggers.generic ?? []).map(normalise));
  const variantTriggers = (playbook.variants ?? []).flatMap((variant) =>
    triggersOf(variant.triggers).map((trigger) => ({ trigger, variant: variant.id as string | undefined })),
  );
  // A trigger listed both in the main list and in a variant counts once, as the variant's, so the variant is named.
  const inVariant = new Set(variantTriggers.map((entry) => normalise(entry.trigger)));
  const pool = [
    ...triggersOf(playbook.triggers)
      .filter((trigger) => !inVariant.has(normalise(trigger)))
      .map((trigger) => ({ trigger, variant: undefined as string | undefined })),
    ...variantTriggers,
  ];
  const found = pool
    .map((entry) => ({
      ...entry,
      runs: triggerRuns(request, entry.trigger),
      size: phraseWords(tokens(entry.trigger)),
      generic: generic.has(normalise(entry.trigger)),
    }))
    .filter((entry) => entry.runs.length)
    .sort((a, b) => b.size - a.size);
  const covered = new Set<number>();
  const matched: PlaybookHit[] = [];
  const perVariant = new Map<string, number>();
  let score = 0;
  let specific = false;
  for (const { trigger, variant, runs, size, generic: isGeneric } of found) {
    const fresh = runs.filter((run) => run.some((position) => !covered.has(position)));
    if (!fresh.length) continue;
    const points = isGeneric ? 0.5 : 1 + (size - 1) / 2;
    score += points;
    specific ||= !isGeneric;
    for (const run of fresh) for (const position of run) covered.add(position);
    matched.push({
      trigger,
      words: fresh.map((run) => run.map((position) => request[position]).join(" ")).join(", "),
      ...(variant ? { variant } : {}),
      ...(isGeneric ? { generic: true as const } : {}),
    });
    if (variant) perVariant.set(variant, (perVariant.get(variant) ?? 0) + points);
  }
  const best = [...perVariant].sort((a, b) => b[1] - a[1])[0]?.[0];
  const variant = best ? playbook.variants!.find((entry) => entry.id === best)! : undefined;
  return { score, specific, matched, ...(variant ? { variant: { id: variant.id, title: variant.title } } : {}) };
}

/** Every trigger of a playbook or variant, in all languages (generic ones are already in the lists). */
export function triggersOf(triggers: { en: string[]; ru: string[]; zh?: string[] }): string[] {
  return [...triggers.en, ...triggers.ru, ...(triggers.zh ?? [])];
}

const rank = (status: Playbook["status"]) => (status === "ready" ? 0 : 1);

function question(tied: Playbook[]): string {
  const options = tied.map((playbook) => `"${playbook.title}" (${playbook.summary})`).join(" or ");
  const steers = tied.flatMap((playbook) =>
    playbook.notFor
      .filter((entry) => tied.some((other) => other.id === entry.use))
      .map((entry) => ` "${tied.find((other) => other.id === entry.use)!.title}" fits when ${entry.when}.`),
  );
  return `Which is closer: ${options}?${steers.join("")}`;
}

export type MatchOptions = { projectExists?: (id: string) => boolean };

/** Ranks the given playbooks against a request. Pure apart from `projectExists`: the tests feed it fixtures. */
export function matchAgainst(text: string, playbooks: Playbook[], options: MatchOptions = {}): PlaybookMatch {
  const scored = playbooks
    .map((playbook) => ({ playbook, ...scorePlaybook(text, playbook) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        rank(a.playbook.status) - rank(b.playbook.status) ||
        a.playbook.id.localeCompare(b.playbook.id),
    );
  const candidates = scored.map(({ playbook, score, specific, matched, variant }) => ({
    id: playbook.id,
    title: playbook.title,
    status: playbook.status,
    score,
    specific,
    matched,
    notFor: playbook.notFor,
    ...(variant ? { variant } : {}),
  }));
  const top = scored[0]?.score ?? 0;
  const tied = scored.filter((entry) => entry.score === top).map((entry) => entry.playbook);
  const tie = tied.length > 1;
  const second = scored[1]?.score ?? 0;
  const alone = scored.length === 1 && top >= 1.5;
  const strength: MatchStrength = !scored.length
    ? "none"
    : scored[0]!.specific && ((top >= 2 && top - second >= 1) || alone)
      ? "clear"
      : "weak";
  const existingProject = options.projectExists ? existingProjectOf(text, options.projectExists) : undefined;
  return {
    candidates,
    tie,
    strength,
    ...(tie ? { question: question(tied) } : {}),
    modifiers: modifiersOf(text),
    ...(existingProject ? { existingProject } : {}),
  };
}

export function loadPlaybooks(root = playbooksRoot()): Playbook[] {
  return listPlaybookIds(root).map((id) => loadPlaybook(id, root));
}

/** Projects live in the workspace (`<workspace>/public/projects/<id>`); playbooks in the checkout. */
export const matchPlaybooks = (text: string, root = playbooksRoot(), workspace = process.cwd()): PlaybookMatch =>
  matchAgainst(text, loadPlaybooks(root), {
    projectExists: (id) => existsSync(path.join(workspace, "public", "projects", id)),
  });
