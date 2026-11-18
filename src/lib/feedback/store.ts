/**
 * The user's feedback on disk: `pipeline/feedback/fb-NNN.json` (the record, FeedbackSchema) and
 * `pipeline/feedback/open/<step>.json` (a step's open items, a tracked input of that step). Reads the chain's files only:
 * state.ts imports this, never the other way round.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  FeedbackSchema,
  OpenFeedbackSchema,
  type Aspect,
  type Feedback,
  type OpenFeedback,
} from "../../types/feedback";

export const feedbackDir = (projectDir: string) => path.join(projectDir, "pipeline", "feedback");
export const feedbackFile = (projectDir: string, id: string) => path.join(feedbackDir(projectDir), `${id}.json`);
export const openFeedbackFile = (projectDir: string, stepId: string) =>
  path.join(feedbackDir(projectDir), "open", `${stepId}.json`);

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

/** Every valid record, oldest first. */
export function listFeedback(projectDir: string): Feedback[] {
  const dir = feedbackDir(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^fb-\d{3,}\.json$/.test(name))
    .sort((a, b) => Number(a.slice(3, -5)) - Number(b.slice(3, -5)))
    .flatMap((name) => {
      const result = FeedbackSchema.safeParse(readJson(path.join(dir, name)));
      return result.success ? [result.data] : [];
    });
}

export function nextFeedbackId(projectDir: string): string {
  const dir = feedbackDir(projectDir);
  const numbers = existsSync(dir)
    ? readdirSync(dir).flatMap((name) => (/^fb-(\d{3,})\.json$/.exec(name) ? [Number(name.slice(3, -5))] : []))
    : [];
  return `fb-${String(Math.max(0, ...numbers) + 1).padStart(3, "0")}`;
}

export function readOpenFeedback(projectDir: string, stepId: string): OpenFeedback | undefined {
  const result = OpenFeedbackSchema.safeParse(readJson(openFeedbackFile(projectDir, stepId)));
  return result.success ? result.data : undefined;
}

/** A `revise` record on one of these exact renders, given after `since` (the latest acceptance): the acceptance no longer stands. */
export function revisionSince(
  projectDir: string,
  renderHashes: string[],
  since: string | undefined,
): Feedback | undefined {
  return listFeedback(projectDir)
    .filter(
      (record) =>
        record.verdict === "revise" &&
        renderHashes.includes(record.watched.sha256) &&
        (!since || record.source.at > since),
    )
    .at(-1);
}

export type Repeat = { aspect: Aspect; earlier: { feedbackId: string; quote: string }[]; now: string[] };

/**
 * Aspects of a step's open items that an earlier record already sent to this step and that were answered there
 * (addressed or declined): the same objection twice. Cleared once the user's clarification is recorded.
 */
export function repeatedAspects(projectDir: string, stepId: string): Repeat[] {
  const open = readOpenFeedback(projectDir, stepId);
  if (!open || open.clarifications.length) return [];
  const current = new Set(open.items.map((item) => item.feedbackId));
  const earlier = listFeedback(projectDir).filter((record) => !current.has(record.id));
  const aspects = [...new Set(open.items.map((item) => item.aspect))];
  return aspects.flatMap((aspect) => {
    const before = earlier.flatMap((record) =>
      record.items
        .filter((item) => item.routedTo === stepId && item.aspect === aspect && item.status !== "open")
        .map((item) => ({ feedbackId: record.id, quote: item.quote })),
    );
    return before.length
      ? [
          {
            aspect,
            earlier: before,
            now: open.items.filter((item) => item.aspect === aspect).map((item) => item.quote),
          },
        ]
      : [];
  });
}

/**
 * Called when a step with open feedback is sealed: its items become addressed (outputs changed) or declined (the
 * owner's --unchanged-because), in their records, and the open file is removed so the receipt does not depend on it.
 */
export function settleOpenFeedback(
  projectDir: string,
  stepId: string,
  outcome: { declinedBecause?: string } = {},
): { feedbackId: string; itemId: string; status: "addressed" | "declined" }[] {
  const open = readOpenFeedback(projectDir, stepId);
  const settled: { feedbackId: string; itemId: string; status: "addressed" | "declined" }[] = [];
  const status = outcome.declinedBecause ? ("declined" as const) : ("addressed" as const);
  for (const record of listFeedback(projectDir)) {
    const ids = new Set((open?.items ?? []).filter((item) => item.feedbackId === record.id).map((item) => item.itemId));
    let changed = false;
    const items = record.items.map((item) => {
      if (item.routedTo !== stepId || item.status !== "open" || (open && !ids.has(item.id))) return item;
      changed = true;
      settled.push({ feedbackId: record.id, itemId: item.id, status });
      return { ...item, status, ...(outcome.declinedBecause ? { declinedBecause: outcome.declinedBecause } : {}) };
    });
    if (changed) writeJson(feedbackFile(projectDir, record.id), FeedbackSchema.parse({ ...record, items }));
  }
  rmSync(openFeedbackFile(projectDir, stepId), { force: true });
  return settled;
}

/** Where an item points in the watched film, for the spine and the briefs: frame and region, time or shot. */
export function feedbackWhere(item: {
  at?: { fromSec: number; toSec: number };
  shotId?: string;
  frame?: number;
  region?: { x: number; y: number; w: number; h: number };
}): string {
  const region = item.region
    ? `, region x=${item.region.x} y=${item.region.y} w=${item.region.w} h=${item.region.h} of the frame`
    : "";
  if (item.frame !== undefined) return ` at frame ${item.frame}${item.at ? ` (${item.at.fromSec}s)` : ""}${region}`;
  if (item.at) return ` at ${item.at.fromSec}-${item.at.toSec}s${region}`;
  return item.shotId ? ` in ${item.shotId}` : "";
}
