/**
 * The user's ratings (RFC 0004 §8, US10, A16): `pipeline/ratings.json` ({@link RatingsFileSchema}), written only by
 * `pnpm ref:rate`. Each rating appends one record (the latest rating of a path wins when read); the file is rewritten
 * under a lock beside it (`ratings.json.lock`, created exclusively, broken when stale) with a temporary file and an
 * atomic rename, so concurrent raters never lose a record. A note is the user's words: it also becomes a memory
 * `preference` (src/lib/memory), so the next film starts closer.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  isSafeRelativePath,
  RATING_TARGETS,
  RATINGS_FILE,
  RatingSchema,
  RatingsFileSchema,
  type Rating,
  type RatingsFile,
} from "../../types/console";
import { CliErrorObject } from "../cli";
import { withFileLock } from "./file-lock";
import { ulid } from "./ulid";

export type RatingKind = (typeof RATING_TARGETS)[number];

export const RATINGS_LOCK_WAIT_MS = 10_000;
export const RATINGS_LOCK_STALE_MS = 30_000;

const invalid = (message: string, details?: Record<string, unknown>) =>
  new CliErrorObject({ code: "INVALID_INPUT", message, ...(details ? { details } : {}) });

export const ratingsFileOf = (projectDir: string) => path.join(projectDir, RATINGS_FILE);

/** The ratings file, or an empty one when it does not exist yet; a corrupt file is refused, never overwritten. */
export function readRatings(projectDir: string): RatingsFile {
  const file = ratingsFileOf(projectDir);
  if (!existsSync(file)) return { v: 1, ratings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${RATINGS_FILE} is not readable JSON (${(error as Error).message}): fix or move it; it is never overwritten.`,
    });
  }
  const parsed = RatingsFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${RATINGS_FILE} does not match its schema (${parsed.error.issues[0]?.path.join(".") ?? "root"}: ${parsed.error.issues[0]?.message ?? "invalid"}): fix or move it; it is never overwritten.`,
    });
  return parsed.data;
}

/** The latest rating per target path (by time, then file order). */
export function latestRatings(file: RatingsFile): Map<string, Rating> {
  const latest = new Map<string, Rating>();
  for (const rating of file.ratings) {
    const known = latest.get(rating.target.path);
    if (!known || Date.parse(rating.at) >= Date.parse(known.at)) latest.set(rating.target.path, rating);
  }
  return latest;
}

/** Runs `work` holding `<ratings.json>.lock` (file-lock.ts: owner token, atomic stale takeover, release by token). */
export function withRatingsLock<T>(projectDir: string, work: () => T, waitMs = RATINGS_LOCK_WAIT_MS): T {
  return withFileLock(`${ratingsFileOf(projectDir)}.lock`, work, {
    waitMs,
    staleMs: RATINGS_LOCK_STALE_MS,
    what: `${RATINGS_FILE}.lock`,
  });
}

function writeRatingsAtomic(projectDir: string, value: RatingsFile): void {
  const file = ratingsFileOf(projectDir);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(RatingsFileSchema.parse(value), null, 2)}\n`);
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Kind of a rated path when the caller names none: styleframes under look/ or styleframes/, references, renders. */
export function inferKind(target: string): RatingKind {
  if (/(^|\/)(look|styleframes)\//.test(target)) return "styleframe";
  if (/(^|\/)references?\//.test(target)) return "reference";
  if (/(^|\/)(renders?|out)\//.test(target) || /\.(mp4|mov|webm)$/i.test(target)) return "render";
  return "asset";
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export interface RateTarget {
  /** Project-relative path of the rated file. */
  path: string;
  sha256: string;
}

/**
 * The rated file: a project-relative path to a regular file inside the project (no symlink out of it), with its hash.
 * `expect`, when given, is the hash the user saw: a changed file is refused (FR3).
 */
export function resolveTarget(projectDir: string, target: string, expect?: string): RateTarget {
  const relative = target.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!isSafeRelativePath(relative))
    throw invalid(`--path ${target} is not a path inside the project (project-relative, no "..", not absolute).`);
  const file = path.join(projectDir, relative);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile())
    throw invalid(
      `--path ${relative} is not a file of the project: rate a styleframe, reference or render inside public/projects/<id>/.`,
    );
  const real = realpathSync(file);
  const root = realpathSync(projectDir);
  if (!real.startsWith(`${root}${path.sep}`)) throw invalid(`--path ${relative} resolves outside the project.`);
  const hash = sha256(file);
  if (expect !== undefined && expect !== hash)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${relative} changed since the user saw it (sha256 ${expect.slice(0, 12)}…, now ${hash.slice(0, 12)}…): show them the current file first.`,
      details: { expected: expect, actual: hash },
    });
  return { path: relative, sha256: hash };
}

export interface RateInput {
  target: RateTarget;
  score: number;
  kind: RatingKind;
  note?: string;
  step?: string;
  channel: "console" | "cli";
  at: string;
}

/** Validates a rating record before anything is written. */
export function buildRating(input: RateInput): Rating {
  const parsed = RatingSchema.safeParse({
    id: ulid(Date.parse(input.at)),
    target: { path: input.target.path, sha256: input.target.sha256 },
    kind: input.kind,
    score: input.score,
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.step ? { step: input.step } : {}),
    by: "user",
    channel: input.channel,
    at: input.at,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(`The rating is not valid: ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}.`);
  }
  return parsed.data;
}

/**
 * Appends a rating under the lock. `beforeWrite` runs inside the lock after the file was read and before it is
 * written (the memory entry): when it throws, nothing is written.
 */
export function appendRating(
  projectDir: string,
  rating: Rating,
  beforeWrite?: () => void,
  waitMs?: number,
): { file: string; count: number } {
  return withRatingsLock(
    projectDir,
    () => {
      const current = readRatings(projectDir);
      beforeWrite?.();
      const next: RatingsFile = { v: 1, ratings: [...current.ratings, rating] };
      writeRatingsAtomic(projectDir, next);
      return { file: ratingsFileOf(projectDir), count: next.ratings.length };
    },
    waitMs,
  );
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Memory's one-line summary (8–160 characters): the score, the file and the start of the user's words. */
export function ratingSummary(rating: Pick<Rating, "score" | "kind" | "target">, note: string): string {
  const head = `Rated ${rating.kind} ${path.posix.basename(rating.target.path)} ${rating.score}/5`;
  const room = 160 - head.length - 2;
  const said = oneLine(note);
  if (room < 8) return head.slice(0, 160);
  return `${head}: ${said.length > room ? `${said.slice(0, room - 1)}…` : said}`;
}

/** The memory entry's body: the rating and the user's words, verbatim. */
export function ratingBody(rating: Pick<Rating, "score" | "kind" | "target">, note: string): string {
  return `${[
    `Rating: ${rating.score}/5`,
    `Rated: ${rating.kind} ${rating.target.path}${rating.target.sha256 ? ` (sha256 ${rating.target.sha256})` : ""}`,
    "",
    "The user's words:",
    "",
    note,
  ].join("\n")}\n`;
}
