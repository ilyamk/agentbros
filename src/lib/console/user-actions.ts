/**
 * Decisions the user starts in the console rather than answering a pending one (RFC 0004 §8, WP9): a rating of a
 * styleframe, reference or render (`ref:rate`) and a comment pinned to a frame of a render (`feedback --frame`). Pure:
 * the request's values become one `--flag=value` token each (paths and words never read as flags); the CLI validates
 * again (the file is in the project, the render unchanged, the words the user's). `apply.ts` runs the plan.
 *
 * | Kind           | Request                                    | Command                                                     |
 * |----------------|--------------------------------------------|-------------------------------------------------------------|
 * | rating         | one `ratings` entry, `answer`, `expect`?   | ref:rate --project P --path=F --score N [--note=W] [--expect E] |
 * | frame-feedback | one `frameComments` entry, `expect`?       | feedback --project P --frame N [--region x,y,w,h] --watched=R    |
 * |                |                                            | (`--fps` only when the media names it: the CLI reads the render) |
 * |                |                                            | [--fps F] [--expect E] --answer=W --confirm                 |
 * | frame-note     | one `frameComments` entry, `overlay`?      | frame:note --project P --media=F [--root out] --frame N [--fps F] |
 * |                | (any route; 2026-11-20)                    | [--expect E] --answer=W [--marks-file] [--overlay-file]       |
 * |                |                                            | (a frame-feedback with marks also runs it as a follow-up)     |
 * | policy (film)  | `policy` { autonomy?, ceilingUsd? }        | film:policy --project P [--autonomy M] [--ceiling-usd C] --answer=W |
 * |                |                                            | then, when C lowers the job store's ceiling: budget --project P  |
 * |                |                                            | --ceiling-usd C --answer=W (film:policy never lowers the store)  |
 * | policy (other) | `policy` with a mode (recording only)      | film:policy --project P --autonomy M [--ceiling-usd C] --answer=W |
 * |                | `policy` with a ceiling only               | budget --project P --ceiling-usd C --answer=W (D13)          |
 *
 * A rating's `answer` is the user's note; the bare score (`4/5`), which the console sends when the user wrote nothing,
 * is not a note: no `--note`, so nothing goes to memory.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { Decision, DecisionRequest, FrameComment } from "../../types/console";
import { listFeedback } from "../feedback/store";
import { HttpError } from "../local-server/errors";
import { autonomyCommand, budgetCommand, flagged, type CommandPlan } from "./actions";
import { readRatings } from "./ratings";

/** Kinds the console applies as new decisions, without a pending one. */
export const USER_INPUT_KINDS = ["rating", "frame-feedback", "frame-note", "policy"] as const;
export type UserInputKind = (typeof USER_INPUT_KINDS)[number];

export const isUserInput = (request: DecisionRequest): request is DecisionRequest & { kind: UserInputKind } =>
  !request.decisionId && (USER_INPUT_KINDS as readonly string[]).includes(request.kind ?? "");

const unprocessable = (message: string) => new HttpError(422, "INVALID_INPUT", message);

/** `4/5`: the score alone, sent as the answer when the user wrote no note. */
export const scoreOnly = (words: string, score: number): boolean =>
  new RegExp(`^\\s*${score}\\s*/\\s*5\\s*$`).test(words);

/** The render a frame comment is on, relative to the checkout (what `feedback --watched` reads). */
export const watchedPath = (project: string, comment: FrameComment): string =>
  comment.media.root === "out"
    ? `out/${project}/${comment.media.path}`
    : `public/projects/${project}/${comment.media.path}`;

export interface UserInputPlan {
  command: CommandPlan;
  /** Run after `command` succeeded (a lowered film ceiling also lowers the job store's). */
  followUps?: CommandPlan[];
  /** The decision as the inbox records it, before its id, status and outcome. */
  decision: Pick<Decision, "kind" | "title" | "bindTo"> &
    Partial<Pick<Decision, "media" | "ratings" | "frameComments" | "policy">>;
}

/** What a policy change is planned against: the project's route and the job store's ceiling now. */
export interface PolicyContext {
  route: string;
  storeCeilingUsd?: number;
}

/**
 * Routes (as `detectRoute` names them: a replica is a bespoke `film`) whose autonomy `film:policy` sets
 * (src/lib/autonomy/project.ts); the UI's `modeSettable` (apps/console/shell/autonomy.tsx) follows the same rule.
 */
const POLICY_ROUTES = new Set(["film", "footage"]);

/** `policy` (D13, A10): the user's change of autonomy or ceiling, applied by the CLI that owns it. */
export function planPolicy(
  project: string,
  request: DecisionRequest & { kind: "policy" },
  context: PolicyContext,
): UserInputPlan {
  const words = request.answer;
  const change = request.policy;
  if (!change || (change.autonomy === undefined && change.ceilingUsd === undefined))
    throw unprocessable("A policy change names an autonomy mode or a ceiling.");
  if (request.ratings && Object.keys(request.ratings).length)
    throw unprocessable("A policy change carries no ratings.");
  if (request.frameComments?.length) throw unprocessable("A policy change carries no frame comments.");
  if (request.expect !== undefined) throw unprocessable("A policy change binds no file.");
  const { autonomy, ceilingUsd } = change;
  if (autonomy !== undefined && !POLICY_ROUTES.has(context.route))
    throw unprocessable(`Autonomy is set on a film or a recording, not on a ${context.route} project.`);
  const title = [
    autonomy !== undefined ? `autonomy ${autonomy}` : undefined,
    ceilingUsd !== undefined ? `ceiling $${ceilingUsd}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const decision = { kind: "policy" as const, title: `Policy: ${title}`.slice(0, 200), bindTo: [], policy: change };
  if (context.route === "film" || autonomy !== undefined) {
    const command =
      autonomy !== undefined
        ? autonomyCommand(project, autonomy, words, ceilingUsd)
        : {
            alias: "film:policy" as const,
            args: ["--project", project, flagged("--answer", words), "--ceiling-usd", String(ceilingUsd)],
          };
    const lowers =
      ceilingUsd !== undefined && context.storeCeilingUsd !== undefined && ceilingUsd < context.storeCeilingUsd;
    return {
      command,
      ...(lowers ? { followUps: [budgetCommand(project, ceilingUsd, words)] } : {}),
      decision,
    };
  }
  return { command: budgetCommand(project, ceilingUsd!, words), decision };
}

/** The `frame:note` command for one comment: the frame drawn with the marks (as the overlay shows them) beside the words. */
export function frameNoteCommand(
  project: string,
  comment: FrameComment,
  overlay?: string,
  expect?: string,
): CommandPlan {
  const sha = expect ?? comment.media.sha256;
  const region = comment.region;
  const attachments: CommandPlan["attachments"] = [];
  if (comment.marks?.length)
    attachments.push({ flag: "--marks-file", name: "marks.json", content: `${JSON.stringify(comment.marks)}\n` });
  if (overlay) attachments.push({ flag: "--overlay-file", name: "overlay.png", content: overlay, encoding: "base64" });
  return {
    alias: "frame:note",
    args: [
      "--project",
      project,
      flagged("--media", comment.media.path),
      ...(comment.media.root === "out" ? ["--root", "out"] : []),
      "--frame",
      String(comment.frame),
      ...(comment.media.fps ? ["--fps", String(comment.media.fps)] : []),
      ...(sha ? ["--expect", sha] : []),
      ...(region ? ["--region", [region.x, region.y, region.w, region.h].map(String).join(",")] : []),
      flagged("--answer", comment.text),
    ],
    ...(attachments.length ? { attachments } : {}),
  };
}

/** One frame comment of a frame-feedback or frame-note request, checked against its video. */
function frameCommentOf(request: DecisionRequest): FrameComment {
  if (request.ratings && Object.keys(request.ratings).length) throw unprocessable("Frame feedback carries no ratings.");
  const comments = request.frameComments ?? [];
  if (comments.length !== 1)
    throw unprocessable("Send one frame comment at a time: `frameComments` holds exactly one.");
  const comment = comments[0]!;
  if (comment.media.kind !== "video") throw unprocessable("Frame feedback is on a video render.");
  const { durationSec, fps } = comment.media;
  if (durationSec !== undefined && fps !== undefined && comment.frame >= Math.max(1, Math.round(durationSec * fps)))
    throw unprocessable(
      `Frame ${comment.frame} is past the render's last frame (${Math.round(durationSec * fps)} frames at ${fps} fps).`,
    );
  return comment;
}

export function planUserInput(
  project: string,
  request: DecisionRequest & { kind: UserInputKind },
  context: PolicyContext = { route: "unknown" },
): UserInputPlan {
  const words = request.answer;
  if (request.verdict) throw unprocessable(`A ${request.kind} carries no verdict.`);
  if (request.choice !== undefined) throw unprocessable(`A ${request.kind} has no options to choose.`);
  if (request.kind === "policy") return planPolicy(project, request as DecisionRequest & { kind: "policy" }, context);
  if (request.policy) throw unprocessable(`A ${request.kind} carries no policy change.`);
  if (request.kind === "rating") {
    if (request.frameComments?.length) throw unprocessable("A rating carries no frame comments.");
    const entries = Object.entries(request.ratings ?? {});
    if (entries.length !== 1) throw unprocessable("Rate one file at a time: `ratings` holds exactly one path.");
    const [file, score] = entries[0]!;
    const note = scoreOnly(words, score) ? undefined : words;
    return {
      command: {
        alias: "ref:rate",
        args: [
          "--project",
          project,
          flagged("--path", file),
          "--score",
          String(score),
          ...(note !== undefined ? [flagged("--note", note)] : []),
          ...(request.expect ? ["--expect", request.expect] : []),
        ],
      },
      decision: {
        kind: "rating",
        title: `Rating of ${file}`.slice(0, 200),
        bindTo: request.expect ? [{ path: file, sha256: request.expect }] : [],
        ratings: { [file]: score },
      },
    };
  }
  const comment = frameCommentOf(request);
  if (request.kind === "frame-note")
    return {
      command: frameNoteCommand(project, comment, request.overlay, request.expect),
      decision: {
        kind: "frame-note",
        title: `Note on frame ${comment.frame} of ${comment.media.label ?? comment.media.path}`.slice(0, 200),
        bindTo: [],
        media: [comment.media],
        frameComments: [comment],
      },
    };
  const sha = request.expect ?? comment.media.sha256;
  const region = comment.region;
  return {
    command: {
      alias: "feedback",
      args: [
        "--project",
        project,
        "--frame",
        String(comment.frame),
        ...(region ? ["--region", [region.x, region.y, region.w, region.h].map(String).join(",")] : []),
        flagged("--watched", watchedPath(project, comment)),
        ...(comment.media.fps ? ["--fps", String(comment.media.fps)] : []),
        ...(sha ? ["--expect", sha] : []),
        flagged("--answer", comment.text),
        "--confirm",
      ],
    },
    // The still with the marks, beside the feedback that reopens the build.
    ...(comment.marks?.length || request.overlay
      ? { followUps: [frameNoteCommand(project, comment, request.overlay, request.expect)] }
      : {}),
    decision: {
      kind: "frame-feedback",
      title: `Frame feedback at frame ${comment.frame}`,
      bindTo: [],
      media: [comment.media],
      frameComments: [comment],
    },
  };
}

/** Without a request id, the same rating or comment within this window is one submission (a double click, a retry). */
export const USER_INPUT_WINDOW_MS = 60_000;

/** What a user input says: its kind, the rated file and score or the comment, the words and the hash seen. */
const fingerprint = (request: DecisionRequest) =>
  canonical([
    request.kind,
    request.ratings ?? null,
    request.frameComments ?? null,
    request.policy ?? null,
    request.answer,
    request.expect ?? null,
  ]);

/** The decision id: from the client's request id, else from what it says (stable across retries). */
export function userInputId(project: string, request: DecisionRequest & { kind: UserInputKind }): string {
  const key = request.requestId ? `request:${request.requestId}` : `content:${fingerprint(request)}`;
  return `${request.kind}-${createHash("sha256").update(`${project}\n${key}`).digest("hex").slice(0, 32)}`;
}

/** JSON with sorted keys: a stored record (schema key order) compares equal to a fresh request. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

/** Same content as a stored decision: the same words, rating and frame comments. */
export const sameUserInput = (stored: Decision, fresh: Decision): boolean =>
  stored.kind === fresh.kind &&
  stored.answer === fresh.answer &&
  canonical([stored.ratings ?? null, stored.frameComments ?? null, stored.policy ?? null, stored.bindTo]) ===
    canonical([fresh.ratings ?? null, fresh.frameComments ?? null, fresh.policy ?? null, fresh.bindTo]);

/**
 * Whether the project's files show that an unknown outcome applied: a console rating of the same file and score at or
 * after the decision, or console feedback with the comment's words at its frame. A policy change has none: run again
 * (film:policy and budget apply the same values idempotently).
 */
export function userInputEvidence(rootDir: string, decision: Decision): boolean {
  const projectDir = path.join(rootDir, "public/projects", decision.project);
  const since = Date.parse(decision.createdAt) - 1000;
  if (decision.kind === "policy") return false;
  try {
    if (decision.kind === "rating") {
      const [file, score] = Object.entries(decision.ratings ?? {})[0] ?? [];
      return readRatings(projectDir).ratings.some(
        (rating) =>
          rating.target.path === file &&
          rating.score === score &&
          rating.channel === "console" &&
          Date.parse(rating.at) >= since,
      );
    }
    const comment = decision.frameComments?.[0];
    if (!comment) return false;
    return listFeedback(projectDir).some(
      (record) =>
        record.source.channel === "console" &&
        Date.parse(record.source.at) >= since &&
        record.items.some((item) => item.quote === comment.text.trim() && item.frame === comment.frame),
    );
  } catch {
    return false;
  }
}
