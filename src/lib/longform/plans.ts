import { createHash } from "node:crypto";
import type { TimelineIR } from "../../types/timeline";
import { ChapterManifestSchema, ShortSelectionSchema, type ChapterManifest } from "../../types/longform";
import { compileTimelineIR } from "../timeline-ir/compiler";
import { add, sub, compare, fraction, numeric } from "../timeline-ir/rational";
import { rebaseCaptionRanges, sliceTimeline, validateContext, type FrameSpan } from "./slice";
import { rebaseOverlays } from "../timeline-ir/overlays";

export function stableHash(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
/** Media references inside scene payloads also belong to a chapter's dependencies. */
export function payloadMediaPaths(value: unknown): string[] {
  const mediaKeys = new Set([
    "imageUrl",
    "videoUrl",
    "source",
    "src",
    "audioUrl",
    "presenterVideo",
    "sourceImage",
    "referenceImageUrls",
    "referenceVideoUrls",
    "referenceAudioUrls",
  ]);
  const sources = (item: unknown): string[] =>
    typeof item === "string" && item.length ? [item] : Array.isArray(item) ? item.flatMap(sources) : [];
  if (Array.isArray(value)) return value.flatMap(payloadMediaPaths);
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) =>
      mediaKeys.has(key) ? sources(item) : payloadMediaPaths(item),
    );
  return [];
}
export type ChapterCache = Record<string, { fingerprint: string; output: string; outputHash: string }>;
export function planChapters(
  ir: TimelineIR,
  raw: unknown,
  {
    assetHashes = {},
    renderConfig = {},
    rendererVersion = "timeline-v1",
    cache = {},
  }: {
    assetHashes?: Record<string, string>;
    renderConfig?: Record<string, unknown>;
    rendererVersion?: string;
    cache?: ChapterCache;
  } = {},
) {
  const manifest = ChapterManifestSchema.parse(raw),
    whole = compileTimelineIR(ir),
    ids = new Set<string>();
  const jobs = manifest.chapters.map((chapter) => {
    if (ids.has(chapter.id)) throw new Error("Duplicate chapter ID");
    ids.add(chapter.id);
    if (compare(chapter.end, whole.duration) > 0) throw new Error(`Chapter exceeds source timeline: ${chapter.id}`);
    const timeline = sliceTimeline(ir, chapter, {
      protectedSpans: manifest.protectedSpans,
    });
    const snapshot = compileTimelineIR(timeline);
    const assetIds = [
      ...new Set(
        timeline.tracks
          .filter((track) => track.kind !== "captions")
          .flatMap((track) =>
            track.clips.flatMap((clip) => [
              clip.assetId,
              ...payloadMediaPaths(clip.payload).map((file) => `path:${file}`),
            ]),
          ),
      ),
    ].sort();
    const dependencies = Object.fromEntries(
      assetIds.map((id) => [id, assetHashes[id] ?? (id.startsWith("scene:") ? "virtual-payload" : "unknown")]),
    );
    const dependencyComplete = Object.values(dependencies).every((hash) => hash !== "unknown");
    const fingerprint = stableHash({
      chapter: { id: chapter.id, revision: chapter.revision },
      timeline,
      dependencies,
      renderConfig,
      rendererVersion,
    });
    const prior = cache[chapter.id];
    return {
      chapterId: chapter.id,
      title: chapter.title,
      revision: chapter.revision,
      fingerprint,
      dependencies,
      timeline,
      snapshot,
      action: dependencyComplete && prior?.fingerprint === fingerprint ? "reuse" : "render",
      previousOutput: prior?.output,
      previousOutputHash: prior?.outputHash,
      cacheReason: dependencyComplete ? "verified-dependencies" : "unknown-asset-dependencies-disable-reuse",
    };
  });
  return { version: 1, manifestRevision: manifest.revision, jobs };
}
export function selectionHash(ranges: FrameSpan[]) {
  return stableHash(ranges);
}
export function compileShort(ir: TimelineIR, raw: unknown, protectedSpans: ChapterManifest["protectedSpans"] = []) {
  const selection = ShortSelectionSchema.parse(raw);
  if (selectionHash(selection.ranges) !== selection.approval.selectionHash)
    throw new Error("Approval does not match these selected intervals");
  const whole = compileTimelineIR(ir);
  let last = fraction(0);
  for (const range of selection.ranges) {
    if (compare(range.start, last) < 0 || compare(range.end, whole.duration) > 0)
      throw new Error("Short ranges must be ordered, non-overlapping and within source");
    last = range.end;
  }
  validateContext(selection.ranges, protectedSpans);
  const pieces = selection.ranges.map((range) => sliceTimeline(ir, range));
  const result = structuredClone(pieces[0]);
  result.projectId = ir.projectId;
  let cursor = fraction(0);
  result.tracks = ir.tracks.map((track) => ({ ...track, clips: [] }));
  const evidence: { range: FrameSpan; sourceClips: unknown[] }[] = [];
  pieces.forEach((piece, index) => {
    for (const track of piece.tracks) {
      const destination = result.tracks.find((item) => item.id === track.id)!;
      for (const clip of track.clips)
        destination.clips.push({
          ...clip,
          id: `${selection.id}-${index}-${clip.id}`,
          start: add(cursor, clip.start),
          transition: clip.transition,
        });
    }
    evidence.push({
      range: selection.ranges[index],
      sourceClips: piece.tracks.flatMap((track) =>
        track.clips.map((clip) => ({
          trackId: track.id,
          assetId: clip.assetId,
          source: clip.source,
          words: clip.captions.map((word) => word.text),
        })),
      ),
    });
    cursor = add(cursor, sub(selection.ranges[index].end, selection.ranges[index].start));
  });
  const seconds = (value: FrameSpan["start"]) => numeric(value) / numeric(ir.timebase);
  let at = fraction(0);
  const placed = selection.ranges.map((range) => {
    const piece = { start: seconds(range.start), end: seconds(range.end), at: seconds(at) };
    at = add(at, sub(range.end, range.start));
    return piece;
  });
  if (ir.captionStyle) result.captionStyle = rebaseCaptionRanges(ir.captionStyle, placed);
  let overlayAt = fraction(0);
  const overlays = rebaseOverlays(
    ir.overlays,
    selection.ranges.map((range) => {
      const piece = { ...range, at: overlayAt };
      overlayAt = add(overlayAt, sub(range.end, range.start));
      return piece;
    }),
    (id, index) => `${selection.id}-${index}-${id}`,
  );
  if (overlays) result.overlays = overlays;
  else delete result.overlays;
  return {
    version: 1,
    shortId: selection.id,
    purpose: selection.purpose,
    approval: selection.approval,
    timeline: result,
    snapshot: compileTimelineIR(result),
    evidence,
    protectedContext: protectedSpans.filter((span) =>
      selection.ranges.some((range) => compare(range.start, span.end) < 0 && compare(range.end, span.start) > 0),
    ),
  };
}
