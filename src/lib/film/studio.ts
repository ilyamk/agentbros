import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { ConceptSchema } from "../../types/creative";
import {
  CreativePoolSchema,
  CreativeReviewSchema,
  DEFAULT_TEAMS,
  DEFAULT_VARIANTS,
  CategoryScanSchema,
  JudgedRecordSchema,
  PoolKeySchema,
  PoolReopensSchema,
  ScriptVariantSchema,
  StrategySchema,
  TeamIdeasSchema,
  type CategoryScan,
  type CreativePool,
  type CreativeReview,
  type JudgedRecord,
  type PoolKey,
  type PoolReopen,
} from "../../types/studio";
import { listFeedback, readOpenFeedback } from "../feedback/store";
import {
  AXES,
  LEGACY_RUBRIC_VERSION,
  MAX_LOOPBACKS,
  READING_OVERRUN_CAP,
  isRubricVersion,
  pairwiseIds,
  type RubricVersion,
  rank,
  requiredOrders,
  type ReviewKind,
  type ScoredItem,
} from "./creative-rubric";
import { requiredReadingSec } from "./plan-check";
import type { StimulusMethod } from "./stimuli";

/**
 * The creative department between the strategy and the script: teams write apart, a pool strips who wrote what,
 * a new creative director scores it blind on the frozen rubric, code ranks, and the pick feeds concept.json or script.json.
 */

export const REVIEW_DIR = "creative-review";
const ENTRANCE_SEC = 0.3;

const pipelineDir = (projectDir: string) => path.join(projectDir, "pipeline");
const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const fileSha = (file: string) => (existsSync(file) ? sha256(readFileSync(file)) : undefined);
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

export class StudioRefusal extends Error {}

// --- Files ---

export const laneFile = (projectDir: string, kind: ReviewKind, lane: string) =>
  path.join(pipelineDir(projectDir), kind === "ideas" ? "concepts" : "scripts", `${lane}.json`);
export const poolFile = (projectDir: string, kind: ReviewKind) =>
  path.join(pipelineDir(projectDir), "pools", `${kind}.json`);
export const keyFile = (projectDir: string, kind: ReviewKind) =>
  path.join(pipelineDir(projectDir), "pools", `${kind}-key.json`);
export const reviewFile = (projectDir: string, kind: ReviewKind, round: number) =>
  path.join(pipelineDir(projectDir), REVIEW_DIR, `${kind}-round-${round}.json`);
export const reviewPrefix = (kind: ReviewKind) => `${kind}-round-`;
/** creative:rank's baseline, in a subdirectory the review scan never reads. */
export const judgedFile = (projectDir: string, kind: ReviewKind, round: number) =>
  path.join(pipelineDir(projectDir), REVIEW_DIR, "judged", `${kind}-round-${round}.json`);
export function judgedRecord(projectDir: string, kind: ReviewKind, round: number): JudgedRecord | undefined {
  const parsed = JudgedRecordSchema.safeParse(readJson(judgedFile(projectDir, kind, round)));
  return parsed.success ? parsed.data : undefined;
}

/** The teams the strategy names, or the default three. */
export function teamsFor(projectDir: string): string[] {
  const strategy = StrategySchema.safeParse(readJson(path.join(pipelineDir(projectDir), "strategy.json")));
  return strategy.success && strategy.data.creativeTeams
    ? [...new Set(strategy.data.creativeTeams)]
    : [...DEFAULT_TEAMS];
}

export const lanesFor = (projectDir: string, kind: ReviewKind): string[] =>
  kind === "ideas" ? teamsFor(projectDir) : [...DEFAULT_VARIANTS];

// --- Reviews and rounds ---

export type ReviewRound = { round: number; file: string; review?: CreativeReview; error?: string };

export function reviewRounds(projectDir: string, kind: ReviewKind): ReviewRound[] {
  const directory = path.join(pipelineDir(projectDir), REVIEW_DIR);
  const pattern = new RegExp(`^${reviewPrefix(kind)}(\\d+)\\.json$`);
  const rounds: ReviewRound[] = [];
  for (const name of existsSync(directory) ? readdirSync(directory) : []) {
    const match = pattern.exec(name);
    if (!match) continue;
    const file = path.join(directory, name);
    const result = CreativeReviewSchema.safeParse(readJson(file));
    rounds.push({
      round: Number(match[1]),
      file,
      ...(result.success ? { review: result.data } : { error: result.error.issues[0]?.message ?? "invalid" }),
    });
  }
  return rounds.sort((a, b) => a.round - b.round);
}

export const MAX_REVIEW_ROUNDS = MAX_LOOPBACKS + 1;

/** The best mean of a review: the progress measure between rounds. */
export function bestMean(review: CreativeReview): number {
  const means = review.scores.map((entry) => {
    const values = Object.values(entry.axes).map((value) => value.score);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  });
  return Math.max(0, ...means);
}

export type ReviewOutcome = { action: "none" | "pass" | "loop" | "stop"; why: string };

/**
 * What the latest ranked review means for the authors: pass, another round, or the user decides. Rounds before `start`
 * (the first round since the pool last reopened) belong to an earlier pool: they count neither for the limit nor for progress.
 */
export function reviewOutcome(rounds: ReviewRound[], start = 1): ReviewOutcome {
  const latest = rounds.at(-1);
  if (!latest?.review?.verdict)
    return { action: "none", why: latest ? "The latest review is not ranked yet." : "No review yet." };
  const review = latest.review;
  if (review.verdict === "pass")
    return { action: "pass", why: `Round ${latest.round} passes the threshold: ${(review.passing ?? []).join(", ")}.` };
  const counted = latest.round - Math.max(1, start) + 1;
  if (counted >= MAX_REVIEW_ROUNDS)
    return {
      action: "stop",
      why: `${counted} review rounds and none passes the threshold; the limit is ${MAX_REVIEW_ROUNDS}.`,
    };
  const before = rounds.at(-2);
  const previous = before && before.round >= start ? before.review : undefined;
  if (previous && bestMean(review) <= bestMean(previous))
    return {
      action: "stop",
      why: `No progress: round ${latest.round}'s best mean is ${bestMean(review).toFixed(2)}, round ${previous.round}'s was ${bestMean(previous).toFixed(2)}.`,
    };
  return {
    action: "loop",
    why: `Round ${latest.round} is below the threshold: the authors write round ${latest.round + 1} with the director's notes.`,
  };
}

/** The round the authors write now: the next one after a review that sends them back, or the round the pool reopened at. */
export function authorRound(projectDir: string, kind: ReviewKind): number {
  const rounds = reviewRounds(projectDir, kind);
  const latest = rounds.at(-1);
  const reopened = latestReopen(projectDir, kind)?.round ?? 1;
  if (!latest) return reopened;
  const reviewed =
    reviewOutcome(rounds, roundsStart(projectDir, kind)).action === "loop" ? latest.round + 1 : latest.round;
  return Math.max(reviewed, reopened);
}

// --- Reopening a pool: an upstream change or the user's feedback after the authors finished ---

/** The step whose authors write each pool, and which owns its open feedback. */
export const AUTHOR_STEP: Record<ReviewKind, string> = { ideas: "ideas", scripts: "script-variants" };
/** Reopens a pool may take from the user's feedback before film:next asks them instead: three sets of ideas in all, as the concept step's stop rule. */
export const MAX_FEEDBACK_REOPENS = MAX_LOOPBACKS;
const QUOTES_KEPT = 8;
const LINE_CHARS = 280;
const bounded = (text: string) => (text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text);

export const reopensFile = (projectDir: string, kind: ReviewKind) =>
  path.join(pipelineDir(projectDir), "rounds", `${kind}-reopens.json`);

export function poolReopens(projectDir: string, kind: ReviewKind): PoolReopen[] {
  const parsed = PoolReopensSchema.safeParse(readJson(reopensFile(projectDir, kind)));
  return parsed.success ? parsed.data.reopens : [];
}

export const latestReopen = (projectDir: string, kind: ReviewKind): PoolReopen | undefined =>
  poolReopens(projectDir, kind).at(-1);

/** The first round of the current pool: review limits and progress count from here. */
export const roundsStart = (projectDir: string, kind: ReviewKind): number => latestReopen(projectDir, kind)?.round ?? 1;

/** The previous winner in one bounded line, before the pick is rewritten: the chosen idea, or the winning variant's hook. */
function previousWinner(projectDir: string, kind: ReviewKind): string | undefined {
  if (kind === "ideas") {
    const concept = ConceptSchema.safeParse(readJson(path.join(pipelineDir(projectDir), "concept.json")));
    const chosen = concept.success
      ? concept.data.candidates.find((candidate) => candidate.id === concept.data.selectedId)
      : undefined;
    return chosen ? bounded(`"${chosen.title}": ${chosen.coreImage}`) : undefined;
  }
  const latest = reviewRounds(projectDir, kind).at(-1)?.review;
  const key = PoolKeySchema.safeParse(readJson(keyFile(projectDir, kind)));
  const entry = key.success ? key.data.entries.find((item) => item.id === latest?.ranking?.[0]) : undefined;
  const variant = entry
    ? ScriptVariantSchema.safeParse(readJson(path.join(projectDir, entry.file)))
    : ({ success: false } as const);
  if (!variant.success) return undefined;
  const lines = variant.data.script.beats
    .map((beat) => (beat as { text?: string }).text?.trim())
    .filter((line): line is string => Boolean(line))
    .slice(0, 2);
  return bounded([`hook line "${variant.data.hookLine}"`, ...lines.map((line) => `"${line}"`)].join(", "));
}

export type ReopenPlan = { reopen: PoolReopen } | { refused: string };

/**
 * Steps before each pool whose feedback the authors must read verbatim when it reaches them as an upstream change: the
 * audience (strategy, intake) and the claims (truth), and for the scripts the concept too. Their open files are gone by
 * then (sealing the step settles them), so the quotes come from the records.
 */
export const UPSTREAM_QUOTED: Record<ReviewKind, readonly string[]> = {
  ideas: ["intake", "strategy", "truth"],
  scripts: ["intake", "strategy", "truth", "ideas"],
};

/** The user's feedback routed to the pool's upstream steps that no earlier round of this pool has carried yet. */
function upstreamFeedback(projectDir: string, kind: ReviewKind, earlier: PoolReopen[]) {
  const carried = new Set(earlier.flatMap((entry) => entry.feedbackIds));
  return listFeedback(projectDir)
    .filter((record) => record.verdict === "revise" && !carried.has(record.id))
    .flatMap((record) =>
      record.items
        .filter((item) => UPSTREAM_QUOTED[kind].includes(item.routedTo) && item.status !== "declined")
        .map((item) => ({ feedbackId: record.id, quote: item.quote })),
    );
}

/**
 * What reopening the pool would be now, written nowhere: the round (the next one after a reviewed round, else the same
 * round with the lanes on disk superseded), the cause, the user's quotes from the authors' open feedback and the
 * previous winner. Refused once the user's feedback has reopened this pool MAX_FEEDBACK_REOPENS times, until they clarify.
 */
export function planReopen(
  projectDir: string,
  kind: ReviewKind,
  changed: string[],
  at: string = new Date().toISOString(),
): ReopenPlan {
  const current = authorRound(projectDir, kind);
  const round = reviewRounds(projectDir, kind).some((entry) => entry.round === current) ? current + 1 : current;
  const open = readOpenFeedback(projectDir, AUTHOR_STEP[kind]);
  const items = open?.items ?? [];
  const cause = items.length ? ("feedback" as const) : ("upstream" as const);
  const earlier = poolReopens(projectDir, kind);
  const byFeedback = earlier.filter((entry) => entry.cause === "feedback");
  const lastAt = byFeedback.at(-1)?.at ?? "";
  if (
    cause === "feedback" &&
    byFeedback.length >= MAX_FEEDBACK_REOPENS &&
    !(open?.clarifications ?? []).some((clarification) => clarification.at > lastAt)
  )
    return {
      refused: `The user's feedback has already reopened the ${kind} pool ${byFeedback.length} times (the limit is ${MAX_FEEDBACK_REOPENS}); another blind round would guess again. Ask them what they picture.`,
    };
  const supersedes: Record<string, string> = {};
  for (const lane of lanesFor(projectDir, kind)) {
    const file = laneFile(projectDir, kind, lane);
    const sha = fileSha(file);
    if (sha) supersedes[path.relative(projectDir, file)] = sha;
  }
  const winner = previousWinner(projectDir, kind);
  const upstream = upstreamFeedback(projectDir, kind, earlier);
  return {
    reopen: {
      round,
      cause,
      changed: changed.slice(0, QUOTES_KEPT).map(bounded),
      quotes: [
        ...upstream.map((item) => item.quote),
        ...items.map((item) => item.quote),
        ...(open?.clarifications ?? []).map((clarification) => clarification.quote),
      ]
        .slice(-QUOTES_KEPT)
        .map(bounded),
      feedbackIds: [...new Set([...upstream, ...items].map((item) => item.feedbackId))],
      ...(winner ? { previousWinner: winner } : {}),
      supersedes,
      at,
    },
  };
}

/** Records the reopen planReopen describes, once per round: a second lane's brief for the same round returns the record. */
export function openPoolRound(
  projectDir: string,
  kind: ReviewKind,
  changed: string[],
  at: string = new Date().toISOString(),
): PoolReopen {
  const plan = planReopen(projectDir, kind, changed, at);
  if ("refused" in plan) throw new StudioRefusal(plan.refused);
  const earlier = poolReopens(projectDir, kind);
  writeJson(reopensFile(projectDir, kind), {
    schemaVersion: 1,
    kind,
    reopens: [...earlier, plan.reopen],
  });
  return plan.reopen;
}

// --- Lanes: what each author must still write ---

export type LaneState = {
  lane: string;
  file: string;
  status: "ready" | "missing" | "invalid" | "old-round";
  reason?: string;
};

// --- Discovery and creativity methods ---

export const CATEGORY_SCAN_FILE = "category-scan.json";
/** The category scan, when discovery wrote a valid one. */
export function categoryScan(projectDir: string): CategoryScan | undefined {
  const parsed = CategoryScanSchema.safeParse(readJson(path.join(pipelineDir(projectDir), CATEGORY_SCAN_FILE)));
  return parsed.success ? parsed.data : undefined;
}

/** One creativity method per team, fixed so every team works from a different one; other stances get random entry. */
export const TEAM_METHODS: Record<string, StimulusMethod> = {
  metaphor: "zwicky",
  "product-in-use": "scamper",
  provocation: "triz",
  "human-moment": "synectics",
};
export const methodFor = (team: string): StimulusMethod => TEAM_METHODS[team] ?? "random-entry";
export const stimulusSeed = (projectId: string, team: string) => `${projectId}:${team}`;
export const MIN_STIMULUS_IDEAS = 2;
export const KILLED_OBVIOUS = 10;

/** With a category scan, a team file must show its banned obvious ideas and at least two ideas from its stimuli. */
function methodProblem(raw: unknown): string | undefined {
  const file = raw as { ideas?: { stimulus?: unknown }[]; killedObvious?: string[] };
  const fromStimuli = (file.ideas ?? []).filter((idea) => idea.stimulus).length;
  if ((file.killedObvious?.length ?? 0) < KILLED_OBVIOUS)
    return `killedObvious holds ${file.killedObvious?.length ?? 0} of the ${KILLED_OBVIOUS} obvious ideas to write and ban`;
  if (fromStimuli < MIN_STIMULUS_IDEAS)
    return `${fromStimuli} idea(s) carry a stimulus; at least ${MIN_STIMULUS_IDEAS} must`;
  return undefined;
}

/** Where film:init records the project's rubric version. */
export const rubricRecordFile = (projectDir: string): string => path.join(pipelineDir(projectDir), "rubric.json");

/** The rubric this project is scored with: the version film:init recorded, or v1 for a project from before v2. */
export function projectRubricVersion(projectDir: string): RubricVersion {
  const recorded = (readJson(rubricRecordFile(projectDir)) as { rubricVersion?: unknown } | undefined)?.rubricVersion;
  return isRubricVersion(recorded) ? recorded : LEGACY_RUBRIC_VERSION;
}

/** The strategy's product-only proofs, when it names any. */
export function productOnlyProofs(projectDir: string):
  | {
      proofs: { proof: string; claim: string; looksLike: string }[];
      alternative?: { name: string; whyConsidered: string };
    }
  | undefined {
  const parsed = StrategySchema.safeParse(readJson(path.join(pipelineDir(projectDir), "strategy.json")));
  if (!parsed.success || !parsed.data.productOnlyProofs?.length) return undefined;
  return {
    proofs: parsed.data.productOnlyProofs,
    ...(parsed.data.strongestAlternative ? { alternative: parsed.data.strongestAlternative } : {}),
  };
}

/** With proofs in the strategy, every idea shows one of them in its hook or turn and says which in proofFrame. */
function proofProblem(raw: unknown, proofs: string[]): string | undefined {
  const ideas = (raw as { ideas?: { id?: unknown; proofFrame?: { proof?: string } }[] }).ideas ?? [];
  const without = ideas.filter((idea) => !idea.proofFrame).map((idea) => String(idea.id));
  if (without.length)
    return `idea(s) ${without.join(", ")} have no proofFrame: each idea shows a product-only proof in its hook or turn`;
  const unknown = ideas.filter((idea) => !proofs.includes(idea.proofFrame!.proof ?? "")).map((idea) => String(idea.id));
  return unknown.length ? `idea(s) ${unknown.join(", ")} name a proof the strategy does not list` : undefined;
}

export function laneStates(projectDir: string, kind: ReviewKind): LaneState[] {
  const round = authorRound(projectDir, kind);
  const schema = kind === "ideas" ? TeamIdeasSchema : ScriptVariantSchema;
  return lanesFor(projectDir, kind).map((lane) => {
    const file = laneFile(projectDir, kind, lane);
    if (!existsSync(file)) return { lane, file, status: "missing" };
    const result = (schema as z.ZodType<{ round: number; team?: string; variant?: string }>).safeParse(readJson(file));
    if (!result.success)
      return {
        lane,
        file,
        status: "invalid",
        reason: `${result.error.issues[0]?.path.join(".") || "root"}: ${result.error.issues[0]?.message ?? "invalid"}`,
      };
    if ((result.data.team ?? result.data.variant) !== lane)
      return {
        lane,
        file,
        status: "invalid",
        reason: `the file names ${result.data.team ?? result.data.variant}, not ${lane}`,
      };
    if (result.data.round !== round)
      return { lane, file, status: "old-round", reason: `round ${result.data.round}, the current round is ${round}` };
    const reopen = latestReopen(projectDir, kind);
    if (reopen?.round === round && reopen.supersedes[path.relative(projectDir, file)] === fileSha(file))
      return {
        lane,
        file,
        status: "old-round",
        reason: `written before the pool reopened for round ${round} (${reopen.cause})`,
      };
    const method = kind === "ideas" && categoryScan(projectDir) ? methodProblem(readJson(file)) : undefined;
    if (method) return { lane, file, status: "invalid", reason: method };
    const proofs = kind === "ideas" ? productOnlyProofs(projectDir) : undefined;
    const proof = proofs
      ? proofProblem(
          readJson(file),
          proofs.proofs.map((item) => item.proof),
        )
      : undefined;
    if (proof) return { lane, file, status: "invalid", reason: proof };
    return { lane, file, status: "ready" };
  });
}

// --- Pool ---

/** mulberry32 seeded from a string: the same seed always gives the same order. */
function seededRandom(seed: string): () => number {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const random = seededRandom(seed);
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

export const defaultSeed = (projectId: string, kind: ReviewKind, round: number) => `${projectId}:${kind}:${round}`;

type Beat = { id: string; text?: string; durationSec: number; onScreen?: { text: string; kind?: string }[] };

/** plan:check's reading floor per beat: every `read` line needs its settled time plus an entrance. */
export function readingOverruns(script: { voiceoverEnabled?: boolean; beats: Beat[] }) {
  return script.beats.flatMap((beat) => {
    const lines = beat.onScreen
      ? beat.onScreen.filter((line) => (line.kind ?? "read") === "read").map((line) => line.text)
      : script.voiceoverEnabled
        ? []
        : [beat.text ?? ""];
    const read = lines.filter((line) => line.trim());
    if (!read.length) return [];
    const needSec =
      Math.round(read.reduce((sum, line) => sum + requiredReadingSec(line) + ENTRANCE_SEC, 0) * 100) / 100;
    return needSec > beat.durationSec
      ? [{ beatId: beat.id, text: read.join(" / "), needSec, haveSec: beat.durationSec }]
      : [];
  });
}

/** Pools every lane's current round: authorship stripped, order shuffled with a seed. Writes the pool and its key. */
// --- Round history: every round's pool, key and author files, kept before the next round overwrites them ---

export const roundDir = (projectDir: string, kind: ReviewKind, round: number) =>
  path.join(pipelineDir(projectDir), "rounds", `${kind}-${round}`);

/**
 * Copies the pool on disk, its key and the author files the key names (while they still have the pooled hash) to
 * pipeline/rounds/<kind>-<round>/, with round.json naming the review and creative:rank's judged record of that round.
 */
export function archiveRound(projectDir: string, kind: ReviewKind): string | undefined {
  const pool = CreativePoolSchema.safeParse(readJson(poolFile(projectDir, kind)));
  const key = PoolKeySchema.safeParse(readJson(keyFile(projectDir, kind)));
  if (!pool.success || !key.success || key.data.round !== pool.data.round) return undefined;
  const round = pool.data.round;
  const target = roundDir(projectDir, kind, round);
  mkdirSync(path.join(target, "authors"), { recursive: true });
  const copy = (from: string, to: string) => writeFileSync(to, readFileSync(from));
  copy(poolFile(projectDir, kind), path.join(target, "pool.json"));
  copy(keyFile(projectDir, kind), path.join(target, "key.json"));
  const authors: { file: string; sha256: string; kept: boolean }[] = [];
  for (const file of [...new Set(key.data.entries.map((entry) => entry.file))]) {
    const sha = key.data.entries.find((entry) => entry.file === file)!.sha256;
    const source = path.join(projectDir, file);
    const kept = fileSha(source) === sha;
    if (kept) copy(source, path.join(target, "authors", path.basename(file)));
    authors.push({ file, sha256: sha, kept });
  }
  const relative = (file: string) => path.relative(projectDir, file);
  writeJson(path.join(target, "round.json"), {
    schemaVersion: 1,
    kind,
    round,
    poolSha256: fileSha(poolFile(projectDir, kind)),
    authors,
    review: relative(reviewFile(projectDir, kind, round)),
    judged: relative(judgedFile(projectDir, kind, round)),
  });
  return target;
}

export function buildPool(
  projectDir: string,
  projectId: string,
  kind: ReviewKind,
  options: { seed?: string; write?: boolean } = {},
): { pool: CreativePool; key: PoolKey } {
  const latest = reviewRounds(projectDir, kind).at(-1);
  const round = authorRound(projectDir, kind);
  if (
    latest?.round === round &&
    latest.review?.verdict === "pass" &&
    latest.review.targetSha256 === fileSha(poolFile(projectDir, kind))
  )
    throw new StudioRefusal(`Round ${latest.round} passed on the current pool; there is nothing to pool again.`);
  const states = laneStates(projectDir, kind);
  const notReady = states.filter((state) => state.status !== "ready");
  if (notReady.length)
    throw new StudioRefusal(
      `Round ${round} is not complete: ${notReady.map((state) => `${state.lane} ${state.status}${state.reason ? ` (${state.reason})` : ""}`).join("; ")}.`,
    );
  const entries: {
    author: string;
    sourceId: string;
    file: string;
    content: Record<string, unknown>;
    stimulus?: unknown;
    subverts?: unknown;
    proofFrame?: unknown;
    script?: { voiceoverEnabled?: boolean; beats: Beat[] };
  }[] = [];
  const killedObvious: Record<string, string[]> = {};
  for (const state of states) {
    const raw = readJson(state.file) as Record<string, unknown>;
    const relative = path.relative(projectDir, state.file);
    if (kind === "ideas") {
      // The director judges what is written: where an idea came from stays in the key.
      if (Array.isArray(raw["killedObvious"])) killedObvious[state.lane] = raw["killedObvious"] as string[];
      for (const idea of raw["ideas"] as Record<string, unknown>[]) {
        // subverts names the category's clichés: the director must not judge against a list earlier runs never saw.
        const { id, stimulus, subverts, proofFrame, ...content } = idea;
        entries.push({
          author: state.lane,
          sourceId: String(id),
          file: relative,
          content,
          ...(stimulus !== undefined ? { stimulus } : {}),
          ...(subverts !== undefined ? { subverts } : {}),
          ...(proofFrame !== undefined ? { proofFrame } : {}),
        });
      }
    } else {
      const { schemaVersion: _v, variant: _l, round: _r, markdown: _m, ...content } = raw;
      entries.push({
        author: state.lane,
        sourceId: state.lane,
        file: relative,
        content,
        script: raw["script"] as { beats: Beat[] },
      });
    }
  }
  const seed = options.seed ?? defaultSeed(projectId, kind, round);
  const shuffled = seededShuffle(entries, seed);
  const letter = kind === "ideas" ? "I" : "S";
  const pool: CreativePool = CreativePoolSchema.parse({
    schemaVersion: 1,
    kind,
    round,
    seed,
    rubricVersion: projectRubricVersion(projectDir),
    items: shuffled.map((entry, index) => ({
      id: `${letter}${index + 1}`,
      content: entry.content,
      ...(entry.script ? { readingOverruns: readingOverruns(entry.script) } : {}),
    })),
  });
  const key: PoolKey = PoolKeySchema.parse({
    schemaVersion: 1,
    kind,
    round,
    entries: shuffled.map((entry, index) => ({
      id: `${letter}${index + 1}`,
      author: entry.author,
      sourceId: entry.sourceId,
      file: entry.file,
      sha256: fileSha(path.join(projectDir, entry.file))!,
      ...(entry.stimulus !== undefined ? { stimulus: entry.stimulus } : {}),
      ...(entry.subverts !== undefined ? { subverts: entry.subverts } : {}),
      ...(entry.proofFrame !== undefined ? { proofFrame: entry.proofFrame } : {}),
    })),
    ...(Object.keys(killedObvious).length ? { killedObvious } : {}),
  });
  if (options.write !== false) {
    const previous = CreativePoolSchema.safeParse(readJson(poolFile(projectDir, kind)));
    if (
      previous.success &&
      previous.data.round !== round &&
      !existsSync(path.join(roundDir(projectDir, kind, previous.data.round), "round.json"))
    )
      archiveRound(projectDir, kind);
    writeJson(poolFile(projectDir, kind), pool);
    writeJson(keyFile(projectDir, kind), key);
  }
  return { pool, key };
}

/** Problems with the pool against the lanes on disk: empty when it holds the current round of every lane. */
export function poolProblems(projectDir: string, kind: ReviewKind): string[] {
  const pool = CreativePoolSchema.safeParse(readJson(poolFile(projectDir, kind)));
  const key = PoolKeySchema.safeParse(readJson(keyFile(projectDir, kind)));
  if (!pool.success || !key.success) return ["the pool or its key is missing or invalid: run creative:pool"];
  const problems: string[] = [];
  const round = authorRound(projectDir, kind);
  if (pool.data.round !== round)
    problems.push(`the pool is round ${pool.data.round}, the current round is ${round}: run creative:pool`);
  for (const lane of lanesFor(projectDir, kind))
    if (!key.data.entries.some((entry) => entry.author === lane)) problems.push(`the pool has nothing from ${lane}`);
  for (const entry of key.data.entries)
    if (fileSha(path.join(projectDir, entry.file)) !== entry.sha256)
      problems.push(`${entry.file} changed after pooling: run creative:pool`);
  return [...new Set(problems)];
}

// --- Review: what the director wrote, and what code computes from it ---

const scoredItems = (review: CreativeReview, pool: CreativePool): ScoredItem[] =>
  review.scores.map((entry) => {
    const item = pool.items.find((candidate) => candidate.id === entry.id);
    const axes = Object.fromEntries(Object.entries(entry.axes).map(([axis, value]) => [axis, value.score]));
    if (axes["reading"] !== undefined && item?.readingOverruns?.length)
      axes["reading"] = Math.min(axes["reading"], READING_OVERRUN_CAP);
    return { id: entry.id, axes, order: pool.items.findIndex((candidate) => candidate.id === entry.id) };
  });

/** What creative:rank refuses: unscored items, wrong axes, a missing order among the pairwise ids, no argument against the top. */
export function reviewInputProblems(review: CreativeReview, pool: CreativePool): string[] {
  const problems: string[] = [];
  const axes = AXES[review.kind];
  if (review.kind !== pool.kind) problems.push(`a ${review.kind} review of a ${pool.kind} pool`);
  if (review.round !== pool.round) problems.push(`review round ${review.round}, pool round ${pool.round}`);
  if (review.rubricVersion !== pool.rubricVersion)
    problems.push(
      `the review says rubricVersion ${review.rubricVersion}, but the pool is scored with rubric v${pool.rubricVersion}`,
    );
  for (const item of pool.items) {
    const entry = review.scores.find((score) => score.id === item.id);
    if (!entry) problems.push(`${item.id} is not scored`);
    else {
      const given = Object.keys(entry.axes).sort();
      if (given.join() !== [...axes].sort().join())
        problems.push(`${item.id} scores ${given.join(", ")}; the rubric's axes are ${axes.join(", ")}`);
    }
  }
  for (const entry of review.scores)
    if (!pool.items.some((item) => item.id === entry.id)) problems.push(`${entry.id} is not in the pool`);
  for (const id of (review.sameImage ?? []).flat())
    if (!pool.items.some((item) => item.id === id)) problems.push(`sameImage names ${id}, which is not in the pool`);
  if (problems.length) return problems;
  const ids = pairwiseIds(scoredItems(review, pool));
  for (const [first, second] of requiredOrders(ids))
    if (!review.pairs.some((pair) => pair.first === first && pair.second === second))
      problems.push(`pair ${first} then ${second} is not judged`);
  for (const pair of review.pairs)
    if (![pair.first, pair.second, "tie"].includes(pair.winner))
      problems.push(`pair ${pair.first}/${pair.second} names winner ${pair.winner}`);
  return problems;
}

export type Computed = { ranking: string[]; passing: string[]; top: string[]; verdict: "pass" | "below-threshold" };

/** The group of `sameImage` that holds both ids, if any. */
export const sameImageAs = (review: Pick<CreativeReview, "sameImage">, a: string, b: string): boolean =>
  a !== b && (review.sameImage ?? []).some((group) => group.includes(a) && group.includes(b));

/** The ranking by the frozen rubric; the top takes the ranking in order and skips an item that is the same image as one already in. */
export function computeReview(review: CreativeReview, pool: CreativePool): Computed {
  const result = rank(scoredItems(review, pool), review.pairs);
  const size = review.kind === "ideas" ? 3 : 2;
  const top: string[] = [];
  for (const id of result.ranking)
    if (top.length < size && !top.some((chosen) => sameImageAs(review, chosen, id))) top.push(id);
  return { ranking: result.ranking, passing: result.passing, top, verdict: result.verdict };
}

// --- Rescoring: the judgement creative:rank ranked is kept by hash ---

const scoreTable = (review: CreativeReview): Record<string, Record<string, number>> =>
  Object.fromEntries(
    review.scores.map((entry) => [
      entry.id,
      Object.fromEntries(Object.entries(entry.axes).map(([axis, value]) => [axis, value.score])),
    ]),
  );

/** The hash of what decides the ranking: scores, pairs and sameImage. Notes and arguments may change freely. */
const pairsSha = (review: CreativeReview): string =>
  sha256(
    canonical({
      pairs: [...review.pairs].map((pair) => `${pair.first}>${pair.second}:${pair.winner}`).sort(),
      sameImage: (review.sameImage ?? []).map((group) => [...group].sort().join("=")).sort(),
    }),
  );
export const judgementSha = (review: CreativeReview): string =>
  sha256(canonical({ scores: scoreTable(review), pairs: pairsSha(review) }));

function scoreChanges(before: Record<string, Record<string, number>>, after: Record<string, Record<string, number>>) {
  const changes: { id: string; axis: string; from: number | null; to: number | null }[] = [];
  for (const id of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort())
    for (const axis of [...new Set([...Object.keys(before[id] ?? {}), ...Object.keys(after[id] ?? {})])].sort()) {
      const from = before[id]?.[axis] ?? null,
        to = after[id]?.[axis] ?? null;
      if (from !== to) changes.push({ id, axis, from, to });
    }
  return changes;
}

/** One line per rescore after a verdict, for film:status and the user's question. */
export function rescoreLines(projectDir: string, kind: ReviewKind): string[] {
  return reviewRounds(projectDir, kind).flatMap((round) =>
    (judgedRecord(projectDir, kind, round.round)?.rescoredAfterVerdict ?? round.review?.rescoredAfterVerdict ?? []).map(
      (entry) => {
        const moved = entry.changes
          .map((change) => `${change.id} ${change.axis} ${change.from ?? "-"}→${change.to ?? "-"}`)
          .join(", ");
        return `${kind} round ${round.round} was rescored after its verdict (${entry.previousVerdict}, top ${entry.previousTop.join(", ")} → ${entry.verdict}, top ${entry.top.join(", ")}): ${moved || "pairs or sameImage changed"}. Reason: ${entry.reason}`;
      },
    ),
  );
}

/** Everything wrong with a stored review against the pool it names: empty when code would write the same ranking and verdict. */
export function reviewProblems(review: CreativeReview, pool: CreativePool, record?: JudgedRecord): string[] {
  const input = reviewInputProblems(review, pool);
  if (input.length) return input;
  const computed = computeReview(review, pool);
  const problems: string[] = [];
  if (
    !review.verdict ||
    JSON.stringify(review.ranking) !== JSON.stringify(computed.ranking) ||
    review.verdict !== computed.verdict ||
    JSON.stringify(review.top) !== JSON.stringify(computed.top)
  )
    problems.push("the ranking or verdict is not what creative:rank computes: run creative:rank");
  for (const id of computed.top)
    if (!review.against.some((entry) => entry.id === id)) problems.push(`no argument against ${id}, one of the top`);
  if (computed.verdict === "below-threshold" && !review.notes.length)
    problems.push("a round below the threshold needs notes for the authors");
  const baseline = record?.judged ?? review.judged;
  if (baseline && baseline.sha256 !== judgementSha(review))
    problems.push("the scores changed after creative:rank ranked them: run creative:rank with --rescore-reason");
  return problems;
}

/** Ranks the latest review in place. A changed judgement after a verdict needs a reason and is recorded with its diff. */
export function rankLatest(
  projectDir: string,
  kind: ReviewKind,
  options: { rescoreReason?: string } = {},
): { file: string; review: CreativeReview; computed: Computed; rescored?: boolean } {
  const latest = reviewRounds(projectDir, kind).at(-1);
  if (!latest)
    throw new StudioRefusal(
      `No ${kind} review is written yet: ${path.relative(projectDir, reviewFile(projectDir, kind, 1))}.`,
    );
  if (!latest.review) throw new StudioRefusal(`${path.basename(latest.file)} does not validate: ${latest.error}.`);
  const poolPath = poolFile(projectDir, kind);
  const pool = CreativePoolSchema.parse(readJson(poolPath));
  if (latest.review.targetSha256 !== fileSha(poolPath))
    throw new StudioRefusal(
      `${path.basename(latest.file)} names another pool: targetSha256 must be the SHA-256 of ${path.relative(projectDir, poolPath)}.`,
    );
  const version = projectRubricVersion(projectDir);
  if (latest.review.rubricVersion !== version)
    throw new StudioRefusal(
      `${path.basename(latest.file)} says rubricVersion ${latest.review.rubricVersion}, but this project is scored with rubric v${version} (${path.relative(projectDir, rubricRecordFile(projectDir))}): score it with that rubric. Nothing was written.`,
    );
  const problems = reviewInputProblems(latest.review, pool);
  if (problems.length) throw new StudioRefusal(problems.join("; "));
  const computed = computeReview(latest.review, pool);
  const unargued = computed.top.filter((id) => !latest.review!.against.some((entry) => entry.id === id));
  if (unargued.length)
    throw new StudioRefusal(
      `The ranked top is ${computed.top.join(", ")}: add an argument against ${unargued.join(", ")} in "against", then run creative:rank again. Nothing was written.`,
    );
  if (computed.verdict === "below-threshold" && !latest.review.notes.length)
    throw new StudioRefusal(
      "Nothing passes the threshold: write notes for the authors, then run creative:rank again. Nothing was written.",
    );
  const sha = judgementSha(latest.review);
  const record = judgedRecord(projectDir, kind, latest.round);
  const judged = record?.judged ?? latest.review.judged;
  const before = record?.rescoredAfterVerdict ?? latest.review.rescoredAfterVerdict ?? [];
  const rescores = [...before];
  if (judged && judged.sha256 !== sha) {
    const changes = scoreChanges(judged.scores, scoreTable(latest.review));
    if (!options.rescoreReason?.trim()) {
      const moved =
        changes.map((change) => `${change.id} ${change.axis} ${change.from ?? "-"}→${change.to ?? "-"}`).join(", ") ||
        "pairs or sameImage";
      throw new StudioRefusal(
        `The judgement changed after its verdict (${judged.verdict}, top ${judged.top.join(", ")}): ${moved}. A rescore after the verdict needs --rescore-reason "<why>"; it is recorded as rescoredAfterVerdict and shown to the user. Nothing was written.`,
      );
    }
    rescores.push({
      reason: options.rescoreReason.trim(),
      previousSha256: judged.sha256,
      sha256: sha,
      changes,
      pairsOrSameImageChanged: judged.pairsSha256 !== pairsSha(latest.review),
      previousTop: judged.top,
      top: computed.top,
      previousVerdict: judged.verdict,
      verdict: computed.verdict,
    });
  }
  const nowJudged = {
    sha256: sha,
    pairsSha256: pairsSha(latest.review),
    scores: scoreTable(latest.review),
    top: computed.top,
    verdict: computed.verdict,
  };
  const review = {
    ...(readJson(latest.file) as CreativeReview),
    ...computed,
    judged: nowJudged,
    ...(rescores.length ? { rescoredAfterVerdict: rescores } : {}),
  };
  writeJson(latest.file, review);
  writeJson(judgedFile(projectDir, kind, latest.round), {
    schemaVersion: 1,
    judged: nowJudged,
    rescoredAfterVerdict: rescores,
  });
  archiveRound(projectDir, kind);
  const after = reviewProblems(CreativeReviewSchema.parse(review), pool);
  if (after.length) throw new StudioRefusal(`Ranked, and still: ${after.join("; ")}.`);
  return { file: latest.file, review, computed, ...(rescores.length > before.length ? { rescored: true } : {}) };
}

// --- Pick ---

function latestRanked(projectDir: string, kind: ReviewKind) {
  const latest = reviewRounds(projectDir, kind).at(-1);
  if (!latest?.review?.verdict || !latest.review.ranking)
    throw new StudioRefusal(`No ranked ${kind} review: the director writes one and runs creative:rank.`);
  const pool = CreativePoolSchema.parse(readJson(poolFile(projectDir, kind)));
  const key = PoolKeySchema.parse(readJson(keyFile(projectDir, kind)));
  if (latest.review.targetSha256 !== fileSha(poolFile(projectDir, kind)))
    throw new StudioRefusal("The latest review judged another pool.");
  return { review: latest.review, pool, key, file: latest.file };
}

const argumentFor = (review: CreativeReview, id: string) => review.against.find((entry) => entry.id === id)?.argument;

/** concept.json from the review: its top three, the first selected, the rest rejected with their rank. */
export function pickIdeas(projectDir: string): { concept: z.infer<typeof ConceptSchema>; file: string } {
  const { review, pool } = latestRanked(projectDir, "ideas");
  const truth = readJson(path.join(pipelineDir(projectDir), "product-truth.json")) as
    { sources?: string[]; claims?: { text: string; status: string }[] } | undefined;
  const top = review.top ?? [];
  if (top.length < 3) throw new StudioRefusal(`The review ranks ${top.length} ideas; the user chooses from three.`);
  const candidates = top.map((id) => {
    const content = pool.items.find((item) => item.id === id)!.content as Record<string, unknown>;
    const against = argumentFor(review, id);
    return {
      ...content,
      id,
      risks: [
        ...((content["risks"] as string[] | undefined) ?? []),
        ...(against ? [`Creative director: ${against}`] : []),
      ],
    };
  });
  const rejected = review
    .ranking!.filter((id) => !top.includes(id))
    .map((id) => {
      const twin = top.find((chosen) => sameImageAs(review, chosen, id));
      return {
        id,
        reason: `Rank ${review.ranking!.indexOf(id) + 1} in review round ${review.round}${twin ? `, the same image as ${twin}` : ""}${review.passing?.includes(id) ? "" : ", below the threshold"}.`,
      };
    });
  const concept = ConceptSchema.parse({
    schemaVersion: 1,
    candidates,
    selectedId: top[0],
    rejected,
    productTruth: {
      sources: truth?.sources ?? [],
      claims: (truth?.claims ?? []).map((claim) => ({ text: claim.text, status: claim.status })),
    },
  });
  const file = path.join(pipelineDir(projectDir), "concept.json");
  writeJson(file, { ...concept, candidates });
  return { concept, file };
}

/**
 * The user's pick among the concept's ideas: sets concept.json's `selectedId` (what every later step reads as the chosen
 * idea) to `id`, validated against the candidates. Returns the file's previous text when it changed (to restore if the
 * approval that follows is refused), else undefined. The candidates, their order and the director's arguments stay.
 */
export function chooseIdea(projectDir: string, id: string): { changed: boolean; previous: string; file: string } {
  const file = path.join(pipelineDir(projectDir), "concept.json");
  const previous = existsSync(file) ? readFileSync(file, "utf8") : "";
  const parsed = ConceptSchema.safeParse(readJson(file));
  if (!parsed.success) throw new StudioRefusal("concept.json does not validate: there is no idea to choose.");
  const ids = parsed.data.candidates.map((candidate) => candidate.id);
  if (!ids.includes(id)) throw new StudioRefusal(`Idea "${id}" is not one of the concept's ideas (${ids.join(", ")}).`);
  if (parsed.data.selectedId === id) return { changed: false, previous, file };
  const raw = JSON.parse(previous) as Record<string, unknown>;
  writeJson(file, { ...raw, selectedId: id });
  return { changed: true, previous, file };
}

/** script.json and its music map from the winning variant, the runner-up beside it. */
export function pickScript(projectDir: string): { outputs: string[]; winner: string; runnerUp?: string } {
  const { review, key } = latestRanked(projectDir, "scripts");
  const [winner, runnerUp] = review.ranking!;
  const variantOf = (id: string) => {
    const entry = key.entries.find((item) => item.id === id)!;
    return readJson(path.join(projectDir, entry.file)) as {
      script: unknown;
      musicMap?: unknown;
      markdown: string;
      variant: string;
    };
  };
  const pipeline = pipelineDir(projectDir);
  const best = variantOf(winner!);
  const outputs = [path.join(pipeline, "script.json"), path.join(pipeline, "script.md")];
  writeJson(outputs[0]!, best.script);
  writeFileSync(outputs[1]!, best.markdown.endsWith("\n") ? best.markdown : `${best.markdown}\n`);
  if (best.musicMap) {
    outputs.push(path.join(pipeline, "script-music-map.json"));
    writeJson(outputs.at(-1)!, best.musicMap);
  }
  if (runnerUp) {
    const second = variantOf(runnerUp);
    outputs.push(path.join(pipeline, "script-alternative.json"), path.join(pipeline, "script-alternative.md"));
    writeJson(outputs.at(-2)!, second);
    writeFileSync(outputs.at(-1)!, second.markdown.endsWith("\n") ? second.markdown : `${second.markdown}\n`);
  }
  return { outputs, winner: winner!, ...(runnerUp ? { runnerUp } : {}) };
}

/** Problems with concept.json against the review: the user must see the director's top three. */
export function conceptFromReviewProblems(projectDir: string): string[] {
  const latest = reviewRounds(projectDir, "ideas").at(-1);
  const concept = readJson(path.join(pipelineDir(projectDir), "concept.json")) as
    { candidates?: { id: string }[] } | undefined;
  if (!latest?.review?.top) return ["no ranked idea review"];
  const ids = (concept?.candidates ?? []).map((candidate) => candidate.id).sort();
  return ids.join() === [...latest.review.top].sort().join()
    ? []
    : [`concept.json holds ${ids.join(", ")}; the review's top is ${latest.review.top.join(", ")}: run creative:pick`];
}

export function scriptFromReviewProblems(projectDir: string): string[] {
  const latest = reviewRounds(projectDir, "scripts").at(-1);
  if (!latest?.review?.ranking) return ["no ranked script review"];
  const key = PoolKeySchema.safeParse(readJson(keyFile(projectDir, "scripts")));
  const entry = key.success ? key.data.entries.find((item) => item.id === latest.review!.ranking![0]) : undefined;
  const variant = entry ? (readJson(path.join(projectDir, entry.file)) as { script?: unknown } | undefined) : undefined;
  const script = readJson(path.join(pipelineDir(projectDir), "script.json"));
  return variant && canonical(variant.script) === canonical(script)
    ? []
    : ["script.json is not the review's winning variant: run creative:pick --kind scripts"];
}

/** Review files relative to the root, for brief tokens. */
export const latestReviewPath = (projectDir: string, kind: ReviewKind): string | undefined =>
  reviewRounds(projectDir, kind).at(-1)?.file;
