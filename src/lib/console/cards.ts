/**
 * Agent cards (RFC 0004 D14, §6.4): the store behind `console:card` (post), the server's
 * `POST /api/projects/:id/cards/:cardId/answer` (answer) and the project view's `cards` (list).
 *
 * One card per file, `public/projects/<id>/pipeline/cards/<cardId>.json` ({@link CardSchema}), written atomically
 * (a temporary `<id>.json.<pid>.<n>.tmp`, never `*.json`, so the hooks' readers never see half a file). Posting never
 * creates a project: the project folder must exist (a `project.json` or a `pipeline/brief.json`), only
 * `pipeline/cards/` is created inside it. Media are confined to `public/projects/<id>/` or, with `root: "out"`,
 * `out/<id>/`, must exist as regular files and be of a type the console serves (the same resolver as `/media/`).
 * Agent text is Markdown without HTML: a tag-like `<` in the body, the title, a label or the sender is refused, never
 * sanitised away. Errors are {@link HttpError}s (the server replies with them; the CLI maps them to its codes).
 */
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  CARDS_DIR,
  CardAnswerRequestSchema,
  CardInputSchema,
  CardSchema,
  ConsoleIdSchema,
  PROJECTS_DIR,
  ProjectIdSchema,
  cardFile,
  projectFile,
  type Card,
  type CardAnswer,
  type CardAnswerRequest,
  type CardAnswerResponse,
  type CardInput,
  type CardKind,
  type MediaRef,
} from "../../types/console";
import { HttpError, badRequest, notFound } from "../local-server/errors";
import { openRegularFile } from "../local-server/paths";
import type { ConsoleActions } from "./data";
import { projectTarget, recordEvent } from "./journal";
import { OUT_PREFIX } from "./urls";
import { resolveMedia } from "./media";
import { ulid } from "./ulid";

/** Largest `--data` file `console:card` reads (the schema bounds every field; this bounds the parse). */
export const CARD_DATA_MAX_BYTES = 256 * 1024;
/** The view carries at most this many cards ({@link ProjectViewSchema}): open ones first, then the newest. */
export const MAX_VIEW_CARDS = 200;
/** Longest `--expires-in` (30 days). */
export const MAX_EXPIRES_IN_MS = 30 * 24 * 60 * 60 * 1000;

const TAG_LIKE = /<[/!?A-Za-z]/;
const validation = (message: string) => badRequest(message, "VALIDATION");
const conflict = (message: string) => new HttpError(409, "CONFLICT", message);

// ---------------------------------------------------------------------------
// Project and files
// ---------------------------------------------------------------------------

/** Absolute directory of an existing, non-symlinked project (`project.json` or `pipeline/brief.json`); 404 otherwise. */
export function cardProjectDir(rootDir: string, project: string): string {
  if (!ProjectIdSchema.safeParse(project).success) throw badRequest("Invalid project id");
  const projects = path.join(rootDir, PROJECTS_DIR);
  const directory = path.join(projects, project);
  const real = (target: string) => {
    const info = lstatSync(target, { throwIfNoEntry: false });
    return !!info && info.isDirectory() && !info.isSymbolicLink();
  };
  const marker = (relative: string) => !!lstatSync(path.join(directory, relative), { throwIfNoEntry: false })?.isFile();
  if (!real(projects) || !real(directory) || !(marker("project.json") || marker("pipeline/brief.json")))
    throw notFound(`Project ${project} not found`, "PROJECT_NOT_FOUND");
  return directory;
}

/** The cards folder of a project; `create` makes `pipeline/cards/` (never the project). Refuses symlinked folders. */
function cardsDir(projectDir: string, create: boolean): string {
  const pipeline = path.join(projectDir, "pipeline");
  const directory = path.join(projectDir, CARDS_DIR);
  if (create) mkdirSync(directory, { recursive: true });
  for (const folder of [pipeline, directory]) {
    const info = lstatSync(folder, { throwIfNoEntry: false });
    if (info && (info.isSymbolicLink() || !info.isDirectory()))
      throw new HttpError(403, "FORBIDDEN", "The cards folder must be a real directory");
  }
  return directory;
}

let temporaryCounter = 0;
const temporaryName = (file: string) => `${file}.${process.pid}.${++temporaryCounter}.tmp`;

/** Writes a new file atomically; refuses to replace an existing one (409). */
function createAtomically(file: string, text: string): void {
  const temporary = temporaryName(file);
  writeFileSync(temporary, text, { flag: "wx", mode: 0o644 });
  try {
    linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict("A card with this id already exists");
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Replaces a file atomically. */
function replaceAtomically(file: string, text: string): void {
  const temporary = temporaryName(file);
  writeFileSync(temporary, text, { flag: "wx", mode: 0o644 });
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

const serialise = (card: Card) => `${JSON.stringify(CardSchema.parse(card), null, 2)}\n`;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Parses `--expires-in`: `90s`, `30m`, `2h`, `1d` or plain minutes; positive and at most 30 days. */
export function parseExpiresIn(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)?\s*$/i.exec(value);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  const ms = match ? Number(match[1]) * unit[(match[2]?.toLowerCase() ?? "m") as keyof typeof unit] : Number.NaN;
  if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_EXPIRES_IN_MS)
    throw badRequest("--expires-in takes a duration from 1s to 30d, such as 45m, 2h or 1d (plain numbers are minutes)");
  return Math.round(ms);
}

const firstIssue = (error: { issues: { path: PropertyKey[]; message: string }[] }) => {
  const issue = error.issues[0];
  return issue ? `${issue.path.map(String).join(".") || "card"}: ${issue.message}` : "Invalid card";
};

/** Tag-like text outside the Markdown body (title, labels, sender, step) is refused too. */
function assertNoMarkup(input: CardInput): void {
  const texts: [string, string | undefined][] = [
    ["title", input.title],
    ["step", input.step],
    ["from.agent", input.from.agent],
    ["from.role", input.from.role],
  ];
  if ("options" in input) input.options?.forEach((option, i) => texts.push([`options.${i}.label`, option.label]));
  if ("media" in input) input.media?.forEach((item, i) => texts.push([`media.${i}.label`, item.label]));
  for (const [where, text] of texts)
    if (text !== undefined && TAG_LIKE.test(text)) throw validation(`${where}: plain text without HTML`);
}

/**
 * Validates a posted card ({@link CardInputSchema}). `kind`, when given (the CLI's `--kind`), must agree with the
 * data's `kind` and fills it in when the data has none.
 */
export function parseCardInput(raw: unknown, kind?: CardKind): CardInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw validation("The card data is a JSON object");
  const data = { ...(raw as Record<string, unknown>) };
  if (kind !== undefined) {
    if (data.kind !== undefined && data.kind !== kind)
      throw validation(`--kind ${kind} disagrees with the data's kind ${String(data.kind)}`);
    data.kind = kind;
  }
  const parsed = CardInputSchema.safeParse(data);
  if (!parsed.success) throw validation(firstIssue(parsed.error));
  assertNoMarkup(parsed.data);
  return parsed.data;
}

/** Every media item exists as a regular, servable file inside the project (or its `out/<id>/`); 404 or 403 else. */
export function checkCardMedia(rootDir: string, project: string, media: readonly MediaRef[]): void {
  const seen = new Set<string>();
  media.forEach((item, index) => {
    const key = `${item.root ?? "project"}:${item.path}`;
    if (seen.has(key)) throw validation(`media.${index}: ${item.path} appears twice`);
    seen.add(key);
    try {
      const resolved = resolveMedia(rootDir, project, [
        ...(item.root === "out" ? [OUT_PREFIX] : []),
        ...item.path.split("/"),
      ]);
      closeSync(openRegularFile(resolved.file).fd);
    } catch (error) {
      if (error instanceof HttpError)
        throw new HttpError(error.status, error.code, `media.${index} (${item.path}): ${error.message}`);
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Post, read, list
// ---------------------------------------------------------------------------

export interface PostCardOptions {
  now?: number;
  /** Overrides `expiresAt` in the input: the card expires this long after posting. */
  expiresInMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface PostedCard {
  card: Card;
  /** Repository-relative card file. */
  file: string;
}

/** Validates (media included), writes `pipeline/cards/<id>.json` and journals `card.posted`. */
export function postCard(
  rootDir: string,
  project: string,
  input: CardInput,
  options: PostCardOptions = {},
): PostedCard {
  const projectDir = cardProjectDir(rootDir, project);
  const now = options.now ?? Date.now();
  const parsed = parseCardInput(input);
  if ("media" in parsed && parsed.media) checkCardMedia(rootDir, project, parsed.media);
  const expiresAt =
    options.expiresInMs !== undefined ? new Date(now + options.expiresInMs).toISOString() : parsed.expiresAt;
  if (expiresAt !== undefined && Date.parse(expiresAt) <= now) throw validation("expiresAt is in the past");
  const id = `card-${ulid(now).toLowerCase()}`;
  const card = CardSchema.parse({
    v: 1,
    id,
    project,
    createdAt: new Date(now).toISOString(),
    ...parsed,
    ...(expiresAt ? { expiresAt } : {}),
  });
  const directory = cardsDir(projectDir, true);
  createAtomically(path.join(directory, `${id}.json`), serialise(card));
  recordEvent(
    projectTarget(rootDir, project),
    {
      kind: "card.posted",
      project,
      ...(card.step ? { step: card.step } : {}),
      agent: { name: card.from.agent, ...(card.from.role ? { role: card.from.role } : {}) },
      outputs: [cardFile(id)],
      data: { cardId: id, cardKind: card.kind, title: card.title, expectsAnswer: card.expectsAnswer },
    },
    { env: options.env, now },
  );
  return { card, file: projectFile(project, cardFile(id)) };
}

/** Reads and validates one card; 404 when absent, 500 when the file is not a valid card of this project. */
export function readCard(rootDir: string, project: string, cardId: string): Card {
  if (!ConsoleIdSchema.safeParse(cardId).success) throw badRequest("Invalid card id");
  const directory = cardsDir(cardProjectDir(rootDir, project), false);
  const file = path.join(directory, `${cardId}.json`);
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) throw notFound(`Card ${cardId} not found`, "NOT_FOUND");
  if (!info.isFile()) throw new HttpError(403, "FORBIDDEN", "A card is a regular file");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new HttpError(500, "INTERNAL", `Card ${cardId} is not valid JSON`);
  }
  const parsed = CardSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== cardId || parsed.data.project !== project)
    throw new HttpError(500, "INTERNAL", `Card ${cardId} does not match the card schema`);
  return parsed.data;
}

/** The card waits for the user: it expects an answer, has none and has not expired. */
export const cardIsOpen = (card: Card, now: number = Date.now()) =>
  card.expectsAnswer && !card.answer && !(card.expiresAt !== undefined && Date.parse(card.expiresAt) <= now);

/** What {@link scanCards} found: valid cards (expired unanswered ones apart) and how many files did not validate. */
export interface CardScan {
  cards: Card[];
  /** Past `expiresAt` without an answer: left out of the view. */
  expired: Card[];
  invalid: number;
}

/**
 * The one reader of `pipeline/cards/` (the projector and the server use it): every `<id>.json` that is a valid card of
 * this project, in file-name order; a file that is not (corrupt, half-written, another project, an id that is not its
 * name, a symlink) counts as invalid.
 */
export function scanCards(projectDir: string, project: string, now: number = Date.now()): CardScan {
  const scan: CardScan = { cards: [], expired: [], invalid: 0 };
  let names: string[];
  try {
    names = readdirSync(path.join(projectDir, CARDS_DIR)).filter((name) => name.endsWith(".json"));
  } catch {
    return scan;
  }
  for (const name of names.sort()) {
    const file = path.join(projectDir, CARDS_DIR, name);
    let card: Card | undefined;
    try {
      if (lstatSync(file).isFile()) {
        const parsed = CardSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
        if (parsed.success && parsed.data.project === project && `${parsed.data.id}.json` === name) card = parsed.data;
      }
    } catch {
      card = undefined;
    }
    if (!card) scan.invalid += 1;
    else if (!card.answer && card.expiresAt !== undefined && Date.parse(card.expiresAt) <= now) scan.expired.push(card);
    else scan.cards.push(card);
  }
  return scan;
}

/** View order: cards waiting for an answer first, then the rest, newest first within each; at most {@link MAX_VIEW_CARDS}. */
export function orderViewCards(cards: readonly Card[]): Card[] {
  const waits = (card: Card) => card.expectsAnswer && !card.answer;
  return [...cards]
    .sort(
      (a, b) =>
        Number(waits(b)) - Number(waits(a)) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    )
    .slice(0, MAX_VIEW_CARDS);
}

/** The project's cards as the view shows them ({@link scanCards}, then {@link orderViewCards}). */
export const listCards = (projectDir: string, project: string, now: number = Date.now()): Card[] =>
  orderViewCards(scanCards(projectDir, project, now).cards);

// ---------------------------------------------------------------------------
// Answer
// ---------------------------------------------------------------------------

/** Kind rules beyond the contract's: what an answer must say for this card. */
function checkAnswerFits(card: Card, request: CardAnswerRequest): void {
  if (!card.expectsAnswer) throw badRequest("This card expects no answer");
  if (request.ratings && card.kind !== "rating") throw badRequest("Only a rating card takes ratings");
  const options = "options" in card ? (card.options ?? []) : [];
  if (request.choice !== undefined && !options.some((option) => option.id === request.choice))
    throw badRequest(`Unknown option ${request.choice}`);
  if ((card.kind === "choice" || card.kind === "compare") && request.choice === undefined)
    throw badRequest(`A ${card.kind} card is answered with one of its options`);
  if (card.kind === "rating" && !request.ratings) throw badRequest("A rating card is answered with ratings");
}

const sameAnswer = (answer: CardAnswer, request: CardAnswerRequest) => {
  const normal = (value: { choice?: string; text?: string; ratings?: Record<string, number> }) =>
    JSON.stringify([
      value.choice ?? null,
      value.text ?? null,
      Object.entries(value.ratings ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ]);
  return normal(answer) === normal(request);
};

export interface AnswerCardOptions {
  now?: number;
  /** Journal environment (the events switch); the answer is recorded as the user's on the console. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Records the user's answer: 404 for an unknown card, 400 for an answer that does not fit the card, 409 for an
 * expired card or one already answered differently; the same answer again returns the stored card (idempotent, no
 * second event). Synchronous from read to write, so two requests in the server process never interleave.
 */
export function answerCardSync(
  rootDir: string,
  project: string,
  cardId: string,
  raw: CardAnswerRequest,
  options: AnswerCardOptions = {},
): CardAnswerResponse {
  const parsedRequest = CardAnswerRequestSchema.safeParse(raw);
  if (!parsedRequest.success) throw validation(firstIssue(parsedRequest.error));
  const request = parsedRequest.data;
  const now = options.now ?? Date.now();
  const card = readCard(rootDir, project, cardId);
  if (card.answer) {
    if (sameAnswer(card.answer, request)) return { ok: true, card };
    throw conflict(`Card ${cardId} was already answered`);
  }
  checkAnswerFits(card, request);
  if (card.expiresAt !== undefined && Date.parse(card.expiresAt) <= now) throw conflict(`Card ${cardId} has expired`);
  const answer: CardAnswer = {
    ...(request.choice !== undefined ? { choice: request.choice } : {}),
    ...(request.text !== undefined ? { text: request.text } : {}),
    ...(request.ratings ? { ratings: request.ratings } : {}),
    at: new Date(now).toISOString(),
  };
  const checked = CardSchema.safeParse({ ...card, answer });
  if (!checked.success) throw validation(firstIssue(checked.error));
  const file = path.join(cardsDir(cardProjectDir(rootDir, project), false), `${cardId}.json`);
  replaceAtomically(file, serialise(checked.data));
  recordEvent(
    projectTarget(rootDir, project),
    {
      kind: "card.answered",
      project,
      // The server answers in-process for the user: trusted, so set here rather than claimed through the env.
      actor: "user",
      channel: "console",
      ...(card.step ? { step: card.step } : {}),
      outputs: [cardFile(cardId)],
      data: {
        cardId,
        cardKind: card.kind,
        ...(answer.choice !== undefined ? { choice: answer.choice } : {}),
        ...(answer.text !== undefined ? { text: answer.text } : {}),
        ...(answer.ratings ? { ratings: answer.ratings } : {}),
      },
    },
    { env: options.env, now },
  );
  return { ok: true, card: checked.data };
}

/** The server's `answerCard` action (WP11) over the checkout at `rootDir`. */
export function cardAnswerer(rootDir: string): ConsoleActions["answerCard"] {
  return async (project, cardId, answer) => answerCardSync(rootDir, project, cardId, answer);
}
