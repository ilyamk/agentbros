import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ChapterManifestSchema,
  ShortSelectionSchema,
  type ChapterManifest,
  type ProtectedSpan,
  type ShortSelection,
} from "../../types/longform";
import { ShortsProposalsSchema } from "../../types/shorts";
import type { TimelineIR, Rational } from "../../types/timeline";
import { ShortsSeriesRequestSchema, type ShortsSeriesRequest } from "../../types/workflow-shorts-series";
import { RecordingEditRequestSchema } from "../../types/workflow-recording-edit";
import { selectionHash, stableHash } from "../longform/plans";
import { compileTimelineIR, clipDuration, sourceToOutput } from "../timeline-ir/compiler";
import { add, compare, fraction, mul, numeric } from "../timeline-ir/rational";
import { inspectShortsSeriesSource, runShortsSeriesWorkflow } from "../workflows/shorts-series";
import { locateRecording } from "./rank";

const PROTECTED_REASON: Record<string, ProtectedSpan["reason"]> = { negation: "negation", caveat: "caveat" };

/**
 * One chapter over the whole timeline, plus the recording-edit request's protected spans mapped from source frames to
 * the timeline's output frames through the clips of the recording (a span partly cut away keeps its kept part; a span
 * cut away entirely is dropped). Without a recording-edit, there are no protected spans.
 */
export function chaptersFromRecordingEdit(
  ir: TimelineIR,
  recordingEdit: unknown | null,
  projectDir: string,
): { manifest: ChapterManifest; dropped: number } {
  const duration = compileTimelineIR(ir).duration;
  const chapters = [{ id: "whole", title: "Whole recording", revision: 1, start: fraction(0), end: duration }];
  if (!recordingEdit)
    return {
      manifest: ChapterManifestSchema.parse({ version: 1, revision: 1, chapters, protectedSpans: [] }),
      dropped: 0,
    };
  const request = RecordingEditRequestSchema.parse(
    z.object({ request: z.unknown() }).passthrough().parse(recordingEdit).request,
  );
  const fps = request.source.fps as Rational;
  const located = locateRecording(
    { ir, projectId: ir.projectId, projectDir, protectedSpans: [] },
    request.source.sha256,
    path.resolve(projectDir, "../.."),
  );
  const clips = located.clips.map((clip) => ({
    clip,
    from: numeric(clip.source.start) / numeric(clip.source.timebase),
    to: numeric(clip.source.end) / numeric(clip.source.timebase),
    end: add(clip.start, clipDuration(clip, ir.timebase)),
  }));
  const at = (sourceFrame: number, side: "start" | "end"): Rational | null => {
    const exact = fraction(sourceFrame * fps.den, fps.num),
      sec = numeric(exact);
    const inside = clips.find((c) => sec >= c.from && sec <= c.to);
    if (inside) {
      const frame = sourceToOutput(inside.clip, mul(exact, inside.clip.source.timebase), ir.timebase);
      return fraction(side === "start" ? Math.floor(numeric(frame)) : Math.ceil(numeric(frame)));
    }
    if (side === "start") {
      const next = clips.filter((c) => c.from > sec).sort((x, y) => x.from - y.from)[0];
      return next ? next.clip.start : null;
    }
    const previous = clips.filter((c) => c.to < sec).sort((x, y) => y.to - x.to)[0];
    return previous ? previous.end : null;
  };
  const protectedSpans: ProtectedSpan[] = [];
  let dropped = 0;
  request.protectedSpans.forEach((span, index) => {
    const start = at(span.startFrame, "start"),
      end = at(span.endFrame, "end");
    if (!start || !end || compare(start, end) >= 0) {
      dropped++;
      return;
    }
    protectedSpans.push({
      id: `p${index + 1}`,
      reason: PROTECTED_REASON[span.kind] ?? "claim-context",
      requires: [],
      note: span.reason.slice(0, 500),
      start,
      end,
    });
  });
  return { manifest: ChapterManifestSchema.parse({ version: 1, revision: 1, chapters, protectedSpans }), dropped };
}

const ApprovedSelectionsSchema = z
  .object({ version: z.literal(1), selections: z.array(ShortSelectionSchema).min(1) })
  .strict();

/**
 * Approved selections from either a file of approved `ShortSelection`s, or `shorts:rank` proposals plus the human
 * approval the user gave (`approvedBy`, the ids they approved). The approval is recorded, never invented.
 */
export function approvedSelections(
  raw: unknown,
  projectId: string,
  approval?: { approvedBy: string; approvedAt: string; ids: string[] },
): ShortSelection[] {
  const approved = ApprovedSelectionsSchema.safeParse(raw);
  if (approved.success) {
    if (approval) throw new Error("These selections already carry approvals; do not pass --approved-by or --ids");
    for (const s of approved.data.selections)
      if (s.approval.selectionHash !== selectionHash(s.ranges))
        throw new Error(`Approval does not match the ranges of ${s.id}`);
    return approved.data.selections;
  }
  const proposals = ShortsProposalsSchema.parse(raw);
  if (!approval)
    throw new Error("Proposals are not approved: pass --approved-by and --ids with the clips the user approved");
  if (proposals.timeline?.projectId !== projectId)
    throw new Error(
      `Proposals were ranked against ${proposals.timeline?.projectId ?? "no project"}, not ${projectId}; rerun shorts:rank --project ${projectId}`,
    );
  return approval.ids.map((id) => {
    const proposal = proposals.proposals.find((p) => p.id === id);
    if (!proposal?.selection) throw new Error(`No proposed selection draft with id ${id}`);
    const { selectionHash: hash, ...draft } = proposal.selection;
    if (hash !== selectionHash(draft.ranges)) throw new Error(`Draft ${id} was edited after shorts:rank`);
    return ShortSelectionSchema.parse({
      ...draft,
      approval: { approvedBy: approval.approvedBy, approvedAt: approval.approvedAt, selectionHash: hash },
    });
  });
}

export type SeriesOptions = {
  rootDir: string;
  projectId: string;
  seriesId: string;
  formats: ("vertical" | "square")[];
  chapterFile: string;
};
/** The shorts-series request with the inspected source pin, checked by the workflow's own read-only plan. */
export function buildSeriesRequest(
  selections: ShortSelection[],
  options: SeriesOptions,
): { request: ShortsSeriesRequest; plan: Record<string, unknown> } {
  const reviewed = inspectShortsSeriesSource(options.projectId, options.chapterFile, { rootDir: options.rootDir });
  const request = ShortsSeriesRequestSchema.parse({
    version: 1,
    seriesId: options.seriesId,
    source: reviewed.source,
    episodes: selections.map((selection) => ({
      selection,
      approvedSourceHash: reviewed.approvalSourceHash,
      formats: options.formats,
    })),
  });
  const plan = runShortsSeriesWorkflow(request, { action: "plan", rootDir: options.rootDir });
  return { request, plan: plan.metadata };
}

export function sameManifest(file: string, manifest: ChapterManifest) {
  return existsSync(file) && stableHash(JSON.parse(readFileSync(file, "utf8"))) === stableHash(manifest);
}
