/**
 * The user's approval of a recut plan's edit hash from the studio console (RFC 0004 A15; `recut:plan --approve`).
 * footage:next asks a person to add `review` to the recut request by hand, and "an agent never writes this": so this
 * path runs only for a command the console server spawned on the user's click, proven by a console grant signed for
 * exactly this argv and project (src/lib/console/grant.ts), and by the intent the server wrote for this decision just
 * before the spawn (src/lib/console/intent.ts: decision id and argv hash; `--decision=<id>` is in the signed argv), which
 * this approval consumes. The grant alone is not enough: anyone who reads the session token can sign. It writes the same `review` block the person would, bound
 * to the edit hash the plan shows now; a stale hash, a missing plan or a missing grant is refused and nothing is
 * written. The user's words are the decision's record (the console's inbox and journal), not part of the request.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { requireUserWords } from "../cli/user-words";
import { verifyConsoleGrant } from "../console/grant";
import { DECISION_ID_PATTERN, matchesIntent, removeIntent } from "../console/intent";
import { RecordingEditRequestSchema } from "../../types/workflow-recording-edit";
import { readFootageState } from "./next";

/** The reviewer the request records for an approval given in the console. */
export const CONSOLE_REVIEWER = "user (studio console)";

export type ApproveInput = {
  rootDir: string;
  /** The project the console decision is on (the source project, or a recut that resolves to it). */
  project: string;
  editHash: string;
  /** The console decision this approval answers (`--decision`); its intent must be on disk. */
  decision: string | undefined;
  answer: string | undefined;
  /** The arguments after the script, exactly as the process got them (the grant is signed over them). */
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: Date;
};

export type ApproveResult = {
  request: string;
  approvedEditHash: string;
  reviewer: string;
  reviewedAt: string;
  /** The request already carried this approval; nothing was written. */
  unchanged: boolean;
};

const refuse = (code: "INVALID_INPUT" | "VALIDATION" | "STAGE_INCOMPLETE", message: string): never => {
  throw new CliErrorObject({ code, message });
};

export function approveEditHash(input: ApproveInput): ApproveResult {
  requireUserWords(input.answer, "--answer");
  if (!/^[a-f0-9]{64}$/.test(input.editHash))
    refuse("INVALID_INPUT", "--approve takes the plan's 64-character edit hash.");
  if (
    !verifyConsoleGrant({
      rootDir: input.rootDir,
      project: input.project,
      argv: input.argv,
      env: input.env,
      now: input.now,
    })
  )
    refuse(
      "VALIDATION",
      "recut:plan --approve runs only from the studio console on the user's click. An agent never approves a recut plan: ask the user to approve it in the console, or to add the review to the request themselves (footage:next says how).",
    );
  const decision = input.decision ?? "";
  if (
    !DECISION_ID_PATTERN.test(decision) ||
    !matchesIntent({
      rootDir: input.rootDir,
      project: input.project,
      decisionId: decision,
      alias: "recut:plan",
      args: input.argv,
      ...(input.now ? { now: input.now } : {}),
    })
  )
    refuse(
      "VALIDATION",
      "recut:plan --approve found no console intent for this decision and argv: the studio console writes one just before it runs the user's approval. Ask the user to approve the plan in the console.",
    );
  // Single use: the intent is consumed whatever the outcome below (the console removes it after the child too).
  removeIntent(input.rootDir, input.project, decision);
  const state = readFootageState(input.project, { rootDir: input.rootDir, save: false });
  const request = state.request;
  if (!request) return refuse("STAGE_INCOMPLETE", `Project ${state.projectId} has no recut request to approve.`);
  if (!request.planHash)
    return refuse("STAGE_INCOMPLETE", `${request.file} has no recut-plan.md with an edit hash beside it; plan first.`);
  if (request.planHash !== input.editHash)
    return refuse(
      "VALIDATION",
      `The plan's edit hash is now ${request.planHash.slice(0, 12)}…, not ${input.editHash.slice(0, 12)}…: the plan changed since it was shown. Review it again.`,
    );
  const file = path.resolve(input.rootDir, request.file);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const existing = raw.review as { approvedEditHash?: string; reviewer?: string; reviewedAt?: string } | undefined;
  if (existing?.approvedEditHash === input.editHash)
    return {
      request: request.file,
      approvedEditHash: input.editHash,
      reviewer: String(existing.reviewer ?? ""),
      reviewedAt: String(existing.reviewedAt ?? ""),
      unchanged: true,
    };
  const reviewedAt = (input.now ?? new Date()).toISOString();
  const review = { reviewer: CONSOLE_REVIEWER, reviewedAt, approvedEditHash: input.editHash, meaningPreserved: true };
  const next = { ...raw, review };
  const parsed = RecordingEditRequestSchema.safeParse(next);
  if (!parsed.success)
    refuse("VALIDATION", `${request.file} does not validate with the review: ${parsed.error.issues[0]?.message}`);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temporary, file);
  return {
    request: request.file,
    approvedEditHash: input.editHash,
    reviewer: CONSOLE_REVIEWER,
    reviewedAt,
    unchanged: false,
  };
}
