/**
 * The film chain's material for the console's film panels (RFC 0004 G2, §5.2, §5.4; WP10b): the brief and strategy,
 * the category scan and the product's claims, the idea and script pools with their blind scores and pairwise results,
 * the styleframes with the user's ratings, the shot list and cue sheet over the music, the narration's direction,
 * takes and caption words, every critic round with its ranked fixes and frames, and the project's frozen rubric.
 *
 * Read-only and advisory: each section is read on its own; a missing file leaves the section out, a malformed one
 * leaves it out with an advisory. Never throws. Blind (US9): the pools' keys and the lanes' own files are never opened,
 * so no author, team or variant letter reaches the view; `chosen` appears only once the user's step closed. Cheap
 * (§4.4): JSON parses are memoised by (path, size, mtime) and nothing is hashed.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
  FilmMaterialSchema,
  FILM_EXCERPT_MAX,
  RatingsFileSchema,
  type FilmBeats,
  type FilmBrief,
  type FilmCriticRound,
  type FilmDiscovery,
  type FilmLook,
  type FilmMaterial,
  type FilmNarration,
  type FilmPool,
  type MediaRef,
} from "../../../types/console";
import { CategoryScanSchema, CreativePoolSchema, CreativeReviewSchema, StrategySchema } from "../../../types/studio";
import { ConceptSchema, CritiqueSchema, MotionPlanSchema } from "../../../types/creative";
import { AudioMapSchema, CueSheetSchema } from "../../../types/film";
import { NarrationDirectionSchema, NarrationSchema } from "../../../types/narration";
import { ProductTruthSchema } from "../../film/chain";
import { AXES, IDEA_AXES, SCRIPT_AXES, agreedPairs, meanOf, passes, type ReviewKind } from "../../film/creative-rubric";
import { projectRubricVersion } from "../../film/studio";
import { critiqueTotal } from "../../film/versions";
import { locate, mediaKind, statOf, text, type ProjectPaths } from "./files";

/** Step status by id, as `deriveChain` gives it; only "is it closed" matters here. */
export type StepStatusById = ReadonlyMap<string, string>;

const CLOSED = new Set(["done", "skipped"]);
const MAX_WORDS = 600;
const MAX_FRAMES = 12;
const MAX_STYLEFRAMES = 24;
const IMAGE = /\.(png|jpe?g|webp|avif)$/i;
/** Agents cannot hear (§2.2): a fix or note claiming something sounds good is not shown (same rule as the UI's). */
const SOUND_CLAIM =
  /\b(sounds?|sounding|the (mix|music|track|voice|audio) (is|feels))\s+(really\s+|very\s+)?(good|great|fine|right|perfect|better|amazing|excellent|balanced|clean|nice)\b/i;

// --- Cheap, memoised reads ---

const MEMO_MAX = 512;
const memo = new Map<string, { key: string; value: unknown }>();

/** Parsed JSON of a file, memoised by size and mtime; undefined when absent, `CORRUPT` when unreadable. */
const CORRUPT = Symbol("corrupt");
function readJson(file: string): unknown {
  const info = statOf(file);
  if (!info?.isFile()) return undefined;
  const key = `${info.size}:${info.mtimeMs}`;
  const known = memo.get(file);
  if (known?.key === key) return known.value;
  let value: unknown;
  try {
    value = info.size > 8 * 1024 * 1024 ? CORRUPT : (JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch {
    value = CORRUPT;
  }
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value!);
  memo.set(file, { key, value });
  return value;
}

/** The start of a text file, at most {@link FILM_EXCERPT_MAX} characters. */
function excerptOf(file: string): string | undefined {
  const info = statOf(file);
  if (!info?.isFile()) return undefined;
  try {
    const raw = readFileSync(file, "utf8").slice(0, FILM_EXCERPT_MAX + 1);
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    return trimmed.length > FILM_EXCERPT_MAX ? `${trimmed.slice(0, FILM_EXCERPT_MAX - 1)}…` : trimmed;
  } catch {
    return undefined;
  }
}

type Reader = { paths: ProjectPaths; advisories: string[] };

/** A schema-checked artefact: undefined when absent, undefined with an advisory when malformed. */
function artefact<S extends z.ZodType>(reader: Reader, relative: string, schema: S): z.output<S> | undefined {
  const value = readJson(path.join(reader.paths.projectDir, relative));
  if (value === undefined) return undefined;
  const parsed = value === CORRUPT ? undefined : schema.safeParse(value);
  if (parsed?.success) return parsed.data;
  reader.advisories.push(`film material: ${relative} is not readable; its panel shows less.`);
  return undefined;
}

const cut = (value: unknown, max: number): string | undefined => {
  const found = text(value, max + 1);
  if (!found) return undefined;
  return found.length > max ? `${found.slice(0, max - 1)}…` : found;
};
const cutList = (values: readonly unknown[] | undefined, count: number, max: number): string[] =>
  (values ?? []).flatMap((value) => cut(value, max) ?? []).slice(0, count);

/** A file as a media reference, without hashing; undefined when it is outside the project and its renders. */
export function fileRef(
  paths: ProjectPaths,
  file: string,
  extra: Partial<MediaRef> = {},
  kind?: MediaRef["kind"],
): MediaRef | undefined {
  const candidates = path.isAbsolute(file) ? [file] : [file, path.join(paths.projectDir, file)];
  for (const candidate of candidates) {
    const where = locate(paths, candidate);
    if (!where) continue;
    const absolute =
      where.root === "out" ? path.join(paths.outDir, where.path) : path.join(paths.projectDir, where.path);
    if (!statOf(absolute)?.isFile()) continue;
    const found = mediaKind(where.path);
    if (!found) return undefined;
    return {
      ...(where.root === "out" ? { root: "out" as const } : {}),
      path: where.path,
      kind: kind ?? found,
      ...extra,
    };
  }
  return undefined;
}

// --- Sections ---

function readBrief(reader: Reader): FilmBrief | undefined {
  const { paths } = reader;
  const pipeline = path.join(paths.projectDir, "pipeline");
  const briefDoc = fileRef(paths, "pipeline/brief.md", { label: "brief.md" });
  let excerpt = excerptOf(path.join(pipeline, "brief.md"));
  if (!excerpt) {
    const brief = readJson(path.join(pipeline, "brief.json"));
    if (brief && brief !== CORRUPT && typeof brief === "object") {
      const record = brief as Record<string, unknown>;
      const parts = ["productName", "topic", "audience", "tone", "tagline", "callToAction"]
        .map((key) => cut(record[key], 600))
        .filter(Boolean);
      if (parts.length) excerpt = parts.join("\n").slice(0, FILM_EXCERPT_MAX);
    }
  }
  const strategy = artefact(reader, "pipeline/strategy.json", StrategySchema);
  const strategyExcerpt = excerptOf(path.join(pipeline, "strategy.md"));
  const strategyDoc = fileRef(paths, "pipeline/strategy.md", { label: "strategy.md" });
  if (!excerpt && !strategy && !strategyExcerpt) return undefined;
  const platform = strategy
    ? cut(
        Object.values(strategy.platform as Record<string, unknown>)
          .filter((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
          .join(" · "),
        500,
      )
    : undefined;
  return {
    ...(excerpt ? { excerpt } : {}),
    ...(briefDoc ? { doc: briefDoc } : {}),
    ...(strategy
      ? {
          strategy: {
            proposition: cut(strategy.proposition, 2000) ?? "—",
            audience: {
              who: cut(strategy.audience.who, 1000) ?? "—",
              moment: cut(strategy.audience.moment, 1000) ?? "—",
            },
            ...(platform ? { platform } : {}),
            hook: {
              mechanic: cut(strategy.hook.mechanic, 1000) ?? "—",
              firstTwoSeconds: cut(strategy.hook.firstTwoSeconds, 1000) ?? "—",
            },
            tone: cutList(strategy.tone, 16, 120),
            mandatories: cutList(strategy.mandatories, 24, 500),
            forbidden: cutList(strategy.forbidden, 24, 500),
            successCriteria: cutList(strategy.successCriteria, 24, 500),
            ...(cut(strategy.filmType, 64) ? { filmType: cut(strategy.filmType, 64) } : {}),
            ...(cut(strategy.language, 32) ? { language: cut(strategy.language, 32) } : {}),
          },
        }
      : {}),
    ...(strategyExcerpt ? { strategyExcerpt } : {}),
    ...(strategyDoc ? { strategyDoc } : {}),
  };
}

function readDiscovery(reader: Reader): FilmDiscovery | undefined {
  const scan = artefact(reader, "pipeline/category-scan.json", CategoryScanSchema);
  const truth = artefact(reader, "pipeline/product-truth.json", ProductTruthSchema);
  if (!scan && !truth) return undefined;
  return {
    ...(scan ? { category: cut(scan.category, 200) } : {}),
    cliches: (scan?.cliches ?? []).slice(0, 40).map((item) => ({
      cliche: cut(item.cliche, 300) ?? "—",
      ...(cut(item.description, 1000) ? { description: cut(item.description, 1000) } : {}),
      ...(cut(item.seenIn, 300) ? { seenIn: cut(item.seenIn, 300) } : {}),
    })),
    whiteSpace: cutList(scan?.whiteSpace, 24, 500),
    learn: cutList(scan?.learn, 24, 500),
    claims: (truth?.claims ?? [])
      .flatMap((claim) => {
        const line = cut(claim.text, 1000);
        if (!line) return [];
        const source = cut(claim.source, 300);
        return [{ text: line, status: claim.status, ...(source ? { source } : {}) }];
      })
      .slice(0, 100),
    ...(cut(truth?.publicRule, 1000) ? { publicRule: cut(truth?.publicRule, 1000) } : {}),
  };
}

const IDEA_TEXT_KEYS = ["premise", "coreImage", "openingFrame", "turn", "lastFrame", "whyWatch"] as const;

function poolText(kind: ReviewKind, content: Record<string, unknown>): { title?: string; text: string } {
  if (kind === "ideas") {
    const body = IDEA_TEXT_KEYS.map((key) => cut(content[key], 800)).filter(Boolean);
    return {
      ...(cut(content.title, 200) ? { title: cut(content.title, 200) } : {}),
      text: body.join("\n").slice(0, 2048),
    };
  }
  const script = content.script as { beats?: { text?: unknown }[] } | undefined;
  const beats = (script?.beats ?? []).map((beat) => cut(beat?.text, 600)).filter(Boolean);
  const hook = cut(content.hookLine, 200);
  return { ...(hook ? { title: hook } : {}), text: beats.join("\n").slice(0, 2048) };
}

function latestReview(reader: Reader, kind: ReviewKind) {
  const directory = path.join(reader.paths.projectDir, "pipeline", "creative-review");
  const pattern = new RegExp(`^${kind}-round-(\\d+)\\.json$`);
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return undefined;
  }
  const rounds = names
    .flatMap((name) => {
      const match = pattern.exec(name);
      return match ? [{ name, round: Number(match[1]) }] : [];
    })
    .sort((a, b) => b.round - a.round);
  for (const { name } of rounds) {
    const review = artefact(reader, `pipeline/creative-review/${name}`, CreativeReviewSchema);
    if (review) return review;
  }
  return undefined;
}

function readPool(reader: Reader, kind: ReviewKind, steps: StepStatusById): FilmPool | undefined {
  const { paths } = reader;
  const poolPath = `pipeline/pools/${kind}.json`;
  const pool = artefact(reader, poolPath, CreativePoolSchema);
  if (!pool || pool.kind !== kind) return undefined;
  const review = latestReview(reader, kind);
  const current = review && review.round === pool.round ? review : undefined;
  const ids = new Set(pool.items.map((item) => item.id));
  const axes = [...AXES[kind]];
  const scoreOf = new Map(
    (current?.scores ?? []).map((entry) => [
      entry.id,
      Object.fromEntries(Object.entries(entry.axes).map(([axis, value]) => [axis.slice(0, 64), value.score])),
    ]),
  );
  // Anonymous ids in id order: the pool's shuffled order is the writing order's cover, the id order carries no rank.
  const items = [...pool.items]
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))
    .slice(0, 60)
    .map((item) => {
      const scores = scoreOf.get(item.id);
      return {
        id: item.id,
        ...poolText(kind, item.content),
        ...(scores && Object.keys(scores).length ? { scores, mean: meanOf(scores), passes: passes(scores) } : {}),
        ...(item.readingOverruns?.length ? { overruns: item.readingOverruns.length } : {}),
      };
    });
  const known = (id: string) => ids.has(id) && /^[IS]\d{1,4}$/.test(id);
  const pairs = current
    ? agreedPairs(current.pairs)
        .filter((pair) => known(pair.a) && known(pair.b))
        .slice(0, 120)
        .map((pair) => ({
          a: pair.a,
          b: pair.b,
          agreed: pair.agreed,
          ...(pair.winner && known(pair.winner) ? { winner: pair.winner } : {}),
        }))
    : [];
  const top = (current?.top ?? []).filter(known).slice(0, 3);
  const against = (current?.against ?? [])
    .filter((entry) => known(entry.id) && top.includes(entry.id) && !SOUND_CLAIM.test(entry.argument))
    .slice(0, 6)
    .map((entry) => ({ id: entry.id, argument: cut(entry.argument, 1000) ?? "—" }));
  let chosen: string | undefined;
  if (kind === "ideas" && CLOSED.has(steps.get("concept") ?? "")) {
    const concept = artefact(reader, "pipeline/concept.json", ConceptSchema);
    if (concept && known(concept.selectedId)) chosen = concept.selectedId;
  } else if (kind === "scripts" && CLOSED.has(steps.get("script") ?? "")) {
    const winner = current?.ranking?.[0];
    if (winner && known(winner)) chosen = winner;
  }
  const boards = kind === "ideas" ? fileRef(paths, "pipeline/boards/boards.jpg", { label: "boards.jpg" }) : undefined;
  return {
    kind,
    round: pool.round,
    rubricVersion: pool.rubricVersion,
    axes,
    items,
    pairs,
    top,
    ...(current?.verdict ? { verdict: current.verdict } : {}),
    against,
    ...(chosen ? { chosen } : {}),
    ...(boards ? { docs: [boards] } : {}),
  };
}

function readLook(reader: Reader): FilmLook | undefined {
  const { paths } = reader;
  const directory = path.join(paths.projectDir, "pipeline", "look");
  let names: string[] = [];
  try {
    names = readdirSync(directory).filter((name) => IMAGE.test(name) && !name.startsWith("."));
  } catch {
    names = [];
  }
  names.sort((a, b) =>
    a === "styleframes.png" ? -1 : b === "styleframes.png" ? 1 : a.localeCompare(b, "en", { numeric: true }),
  );
  const ratingsFile = readJson(path.join(paths.projectDir, "pipeline", "ratings.json"));
  const ratings = new Map<string, { score: number; at: number }>();
  if (ratingsFile !== undefined) {
    const parsed = ratingsFile === CORRUPT ? undefined : RatingsFileSchema.safeParse(ratingsFile);
    if (parsed?.success)
      for (const rating of parsed.data.ratings) {
        const at = Date.parse(rating.at);
        const known = ratings.get(rating.target.path);
        if (!known || at >= known.at) ratings.set(rating.target.path, { score: rating.score, at });
      }
    else reader.advisories.push("film material: pipeline/ratings.json is not readable; ratings are not shown.");
  }
  const styleframes = names.slice(0, MAX_STYLEFRAMES).flatMap((name) => {
    const media = fileRef(paths, `pipeline/look/${name}`, { label: name.slice(0, 160) }, "image");
    if (!media) return [];
    const rating = ratings.get(media.path);
    return [{ media, ...(rating ? { rating: rating.score } : {}) }];
  });
  return styleframes.length ? { styleframes } : undefined;
}

function readBeats(reader: Reader): FilmBeats | undefined {
  const { paths } = reader;
  const plan = artefact(reader, "pipeline/motion-plan.json", MotionPlanSchema);
  const sheet = artefact(reader, "pipeline/cue-sheet.json", CueSheetSchema);
  if (!plan && !sheet) return undefined;
  const fps = sheet?.fps ?? plan?.fps ?? 30;
  const map = artefact(reader, "pipeline/audio-map.json", AudioMapSchema);
  const offset = sheet?.musicOffsetSec ?? 0;
  const track = map
    ? fileRef(
        paths,
        map.source.path,
        { label: path.basename(map.source.path).slice(0, 160), durationSec: map.source.durationSec },
        "audio",
      )
    : undefined;
  const round3 = (value: number) => Math.round(value * 1000) / 1000;
  return {
    fps,
    shots: (plan?.shots ?? []).slice(0, 120).map((shot) => ({
      id: shot.id.slice(0, 64) || "shot",
      ...(shot.beatId ? { beatId: shot.beatId.slice(0, 64) } : {}),
      startFrame: shot.startFrame,
      durationFrames: shot.durationFrames,
      intent: shot.intent.slice(0, 500),
      ...(cut(shot.subject, 200) ? { subject: cut(shot.subject, 200) } : {}),
      ...(cut(shot.transitionToNext, 160) ? { transitionToNext: cut(shot.transitionToNext, 160) } : {}),
    })),
    cues: (sheet?.cues ?? []).slice(0, 400).map((cue) => ({
      id: cue.id.slice(0, 64) || "cue",
      kind: String(cue.kind).slice(0, 32) || "cue",
      frame: cue.frame,
      sec: round3(cue.frame / fps),
      trackSec: round3(Math.max(0, cue.snappedSec + offset)),
      ...(cue.shotId ? { shotId: cue.shotId.slice(0, 64) } : {}),
      ...(cue.snap ? { snap: String(cue.snap).slice(0, 32) } : {}),
    })),
    ...(track ? { track } : {}),
    ...(map
      ? {
          sections: map.sections
            .slice(0, 64)
            .map((section) => ({ startSec: section.startSec, endSec: section.endSec, level: section.level })),
        }
      : {}),
  };
}

type CaptionWord = { text: string; start: number; end: number; emphasis?: boolean };

/** Caption words of a take: `{ words: [...] }` or a bare list of `{ text|word, start, end, emphasis? }`; bad entries dropped. */
function captionWords(value: unknown): CaptionWord[] {
  const list = Array.isArray(value) ? value : (value as { words?: unknown } | undefined)?.words;
  if (!Array.isArray(list)) return [];
  return list.flatMap((word) => {
    const item = (word ?? {}) as Record<string, unknown>;
    const said = typeof item.text === "string" ? item.text : typeof item.word === "string" ? item.word : undefined;
    const start = Number(item.start);
    const end = Number(item.end);
    if (!said?.trim() || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return [];
    return [{ text: said.trim().slice(0, 64), start, end, ...(item.emphasis === true ? { emphasis: true } : {}) }];
  });
}

function readNarration(reader: Reader): FilmNarration | undefined {
  const { paths } = reader;
  const direction = artefact(reader, "pipeline/narrator-direction.json", NarrationDirectionSchema);
  const narration = artefact(reader, "pipeline/narration.json", NarrationSchema);
  if (!direction && !narration) return undefined;
  const takes: FilmNarration["takes"] = [];
  const words: FilmNarration["words"] = [];
  if (narration)
    for (const beat of narration.beats.slice(0, 60)) {
      const media = fileRef(
        paths,
        beat.file,
        { label: beat.beatId.slice(0, 160), durationSec: beat.durationSec },
        "audio",
      );
      if (!media) continue;
      takes.push({
        beatId: beat.beatId.slice(0, 64),
        media,
        startSec: beat.startSec,
        wordCount: beat.wordCount,
        emphasisCount: beat.emphasisCount,
      });
      if (words.length >= MAX_WORDS) continue;
      const captions = readJson(path.join(paths.projectDir, beat.captions));
      if (captions === undefined || captions === CORRUPT) continue;
      for (const word of captionWords(captions).slice(0, MAX_WORDS - words.length))
        words.push({ beatId: beat.beatId.slice(0, 64), ...word });
    }
  else if (direction) {
    // Before narration:check: the takes the direction names, when they exist (voiceover/<beat>[.take-<n>].mp3).
    const take = direction.take ?? 1;
    for (const beat of direction.beats.slice(0, 60)) {
      const name = take > 1 ? `${beat.beatId}.take-${take}.mp3` : `${beat.beatId}.mp3`;
      const media = fileRef(paths, `voiceover/${name}`, { label: beat.beatId.slice(0, 160) }, "audio");
      if (media) takes.push({ beatId: beat.beatId.slice(0, 64), media });
    }
  }
  return {
    ...((direction?.route ?? narration?.route) ? { route: direction?.route ?? narration?.route } : {}),
    ...(cut(direction?.voiceWhy, 1000) ? { voiceWhy: cut(direction?.voiceWhy, 1000) } : {}),
    ...(direction?.modelId ? { modelId: direction.modelId.slice(0, 64) } : {}),
    ...(cut(direction?.pacingNote, 1000) ? { pacingNote: cut(direction?.pacingNote, 1000) } : {}),
    ...((narration?.take ?? direction?.take) ? { take: narration?.take ?? direction?.take } : {}),
    direction: (direction?.beats ?? []).slice(0, 60).map((beat) => ({
      beatId: beat.beatId.slice(0, 64) || "beat",
      text: beat.directedText.slice(0, 1000),
      emphasis: cutList(beat.emphasisWords, 16, 64),
    })),
    takes,
    words,
    ...(narration ? { totalSec: narration.totalSec } : {}),
  };
}

/** Critic prefixes by step: `pipeline/critique/<prefix><n>.json` (src/lib/film/chain.ts). */
const CRITIC_PREFIXES: [step: string, pattern: RegExp][] = [
  ["look", /^look-round-(\d+)\.json$/],
  ["critic", /^round-(\d+)\.json$/],
];

function readCritic(reader: Reader): { rounds: FilmCriticRound[] } | undefined {
  const { paths } = reader;
  const directory = path.join(paths.projectDir, "pipeline", "critique");
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return undefined;
  }
  const rounds: FilmCriticRound[] = [];
  for (const [step, pattern] of CRITIC_PREFIXES) {
    const found = names
      .flatMap((name) => {
        const match = pattern.exec(name);
        return match ? [{ name, round: Number(match[1]) }] : [];
      })
      .sort((a, b) => a.round - b.round)
      .slice(-12);
    for (const { name, round } of found) {
      const critique = artefact(reader, `pipeline/critique/${name}`, CritiqueSchema);
      if (!critique || round < 1) continue;
      const scores = Object.fromEntries(
        Object.entries(critique.scores).flatMap(([axis, value]) => (value ? [[axis.slice(0, 64), value.score]] : [])),
      );
      const frames = critique.framesReviewed.slice(0, MAX_FRAMES).flatMap((frame) => {
        const label = frame.timeSec !== undefined ? `${frame.timeSec.toFixed(2)} s` : path.basename(frame.path);
        const media = fileRef(paths, frame.path, { label: label.slice(0, 160) });
        if (!media || (media.kind !== "image" && media.kind !== "video" && media.kind !== "strip")) return [];
        const note = SOUND_CLAIM.test(frame.note) ? undefined : cut(frame.note, 500);
        return [
          { media, ...(frame.timeSec !== undefined ? { timeSec: frame.timeSec } : {}), ...(note ? { note } : {}) },
        ];
      });
      const sheet =
        step === "critic"
          ? fileRef(paths, `pipeline/critic-pack/round-${round}/phone-sheet.jpg`, { label: `round ${round}` }, "image")
          : undefined;
      rounds.push({
        step,
        round,
        verdict: critique.verdict,
        total: critiqueTotal(critique),
        scores,
        fixes: cutList(
          critique.actions.filter((action) => !SOUND_CLAIM.test(action)),
          7,
          1000,
        ),
        frames,
        ...(sheet ? { sheet } : {}),
      });
    }
  }
  return rounds.length ? { rounds: rounds.slice(-24) } : undefined;
}

/** The axes of the project's frozen rubric (film:init records its version): idea axes, then the script axes not yet named. */
export function rubricAxes(): string[] {
  return [...new Set<string>([...IDEA_AXES, ...SCRIPT_AXES])];
}

/** Reads every section the project has; never throws, adds advisories for malformed files. */
export function readFilmMaterial(
  paths: ProjectPaths,
  steps: StepStatusById,
  advisories: string[],
): FilmMaterial | undefined {
  const reader: Reader = { paths, advisories: [] };
  const section = <T>(name: string, work: () => T | undefined): T | undefined => {
    try {
      return work();
    } catch (error) {
      reader.advisories.push(
        `film material: the ${name} section failed: ${(error as Error)?.message ?? String(error)}`,
      );
      return undefined;
    }
  };
  const material: FilmMaterial = {};
  const sections: [keyof FilmMaterial, () => unknown][] = [
    ["brief", () => readBrief(reader)],
    ["discovery", () => readDiscovery(reader)],
    ["ideas", () => readPool(reader, "ideas", steps)],
    ["scripts", () => readPool(reader, "scripts", steps)],
    ["look", () => readLook(reader)],
    ["beats", () => readBeats(reader)],
    ["narration", () => readNarration(reader)],
    ["critic", () => readCritic(reader)],
    ["human", () => ({ rubric: { version: projectRubricVersion(paths.projectDir), axes: rubricAxes() } })],
  ];
  for (const [name, work] of sections) {
    const value = section(name, work);
    if (value === undefined) continue;
    // Each section is checked on its own: one that does not validate is dropped with an advisory, never the block.
    const parsed = FilmMaterialSchema.shape[name].safeParse(value);
    if (parsed.success) (material as Record<string, unknown>)[name] = parsed.data;
    else
      reader.advisories.push(
        `film material: the ${name} section did not validate (${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}).`,
      );
  }
  advisories.push(...[...new Set(reader.advisories)].map((line) => line.slice(0, 2000)));
  return Object.keys(material).length ? material : undefined;
}
