import type { TimelineIR, Rational } from "../../types/timeline";
import type { ProtectedSpan } from "../../types/longform";
import { validateTimeline, compileTimelineIR, clipDuration, outputToSource } from "../timeline-ir/compiler";
import { add, sub, compare, fraction, numeric } from "../timeline-ir/rational";
import { rebaseOverlays } from "../timeline-ir/overlays";
export type FrameSpan = { start: Rational; end: Rational };
const overlaps = (a: FrameSpan, b: FrameSpan) => compare(a.start, b.end) < 0 && compare(a.end, b.start) > 0;
const contains = (a: FrameSpan, b: FrameSpan) => compare(a.start, b.start) <= 0 && compare(a.end, b.end) >= 0;
export function validateContext(ranges: FrameSpan[], protectedSpans: ProtectedSpan[]) {
  const ids = new Set<string>();
  for (const span of protectedSpans) {
    if (ids.has(span.id)) throw new Error("Duplicate protected span ID");
    ids.add(span.id);
    if (compare(span.start, span.end) >= 0) throw new Error("Invalid protected span");
  }
  for (const span of protectedSpans) {
    if (!ranges.some((range) => overlaps(range, span))) continue;
    if (!ranges.some((range) => contains(range, span)))
      throw new Error(`Selection cuts protected ${span.reason} span: ${span.id}`);
    for (const id of span.requires) {
      const required = protectedSpans.find((item) => item.id === id);
      if (!required) throw new Error(`Missing context binding: ${id}`);
      if (!ranges.some((range) => contains(range, required)))
        throw new Error(`Selection drops required context: ${id}`);
    }
  }
}
/**
 * `captions:place` records `legibility` and `positions` as [from, to) ranges in the source timeline's output seconds.
 * A short keeps each range only where it overlaps a selected interval, moved to the short's own clock; millisecond
 * bounds are rounded outwards again, as `captions:place` writes them.
 */
export function rebaseCaptionRanges(
  captionStyle: TimelineIR["captionStyle"],
  pieces: { start: number; end: number; at: number }[],
): TimelineIR["captionStyle"] {
  const options = captionStyle?.options;
  if (!captionStyle || !options) return captionStyle;
  const rebased = { ...options };
  for (const key of ["legibility", "positions"] as const) {
    const ranges = options[key];
    if (!Array.isArray(ranges) || ranges.length === 0) continue;
    rebased[key] = ranges
      .flatMap((range: { from: number; to: number }) =>
        pieces.flatMap((piece) => {
          const from = Math.max(range.from, piece.start),
            to = Math.min(range.to, piece.end);
          if (!(from < to)) return [];
          return [
            {
              ...range,
              from: Math.max(0, Math.floor((from - piece.start + piece.at) * 1000) / 1000),
              to: Math.ceil((to - piece.start + piece.at) * 1000) / 1000,
            },
          ];
        }),
      )
      .sort((a, b) => a.from - b.from);
  }
  return { ...captionStyle, options: rebased };
}
/** Exact editorial slice: source media stays immutable, output origin is rebased. */
export function sliceTimeline(
  input: unknown,
  range: FrameSpan,
  { protectedSpans = [], allowWordCut = false }: { protectedSpans?: ProtectedSpan[]; allowWordCut?: boolean } = {},
): TimelineIR {
  const ir = validateTimeline(input);
  if (compare(range.start, fraction(0)) < 0 || compare(range.start, range.end) >= 0)
    throw new Error("Invalid chapter interval");
  validateContext([range], protectedSpans);
  const sliced = structuredClone(ir);
  delete sliced.legacyProject;
  if (ir.captionStyle) {
    const seconds = (value: Rational) => numeric(value) / numeric(ir.timebase);
    sliced.captionStyle = rebaseCaptionRanges(ir.captionStyle, [
      { start: seconds(range.start), end: seconds(range.end), at: 0 },
    ]);
  }
  const overlays = rebaseOverlays(ir.overlays, [{ ...range, at: fraction(0) }]);
  if (overlays) sliced.overlays = overlays;
  else delete sliced.overlays;
  sliced.tracks = ir.tracks.map((track) => ({
    ...track,
    clips: track.clips.flatMap((clip) => {
      const end = add(clip.start, clipDuration(clip, ir.timebase));
      if (!overlaps({ start: clip.start, end }, range)) return [];
      const start = compare(clip.start, range.start) > 0 ? clip.start : range.start;
      const finish = compare(end, range.end) < 0 ? end : range.end;
      const sourceStart = outputToSource(clip, start, ir.timebase),
        sourceEnd = outputToSource(clip, finish, ir.timebase);
      if (!allowWordCut)
        for (const word of clip.captions) {
          if (
            (compare(word.start, sourceStart) < 0 && compare(word.end, sourceStart) > 0) ||
            (compare(word.start, sourceEnd) < 0 && compare(word.end, sourceEnd) > 0)
          )
            throw new Error(`Boundary cuts spoken word: ${word.text}`);
        }
      return [
        {
          ...structuredClone(clip),
          start: sub(start, range.start),
          source: { ...clip.source, start: sourceStart, end: sourceEnd },
          captions: clip.captions.filter(
            (word) => compare(word.end, sourceStart) > 0 && compare(word.start, sourceEnd) < 0,
          ),
        },
      ];
    }),
  }));
  for (const track of sliced.tracks) {
    track.clips.sort((a, b) => compare(a.start, b.start));
    track.clips.forEach((clip, i) => {
      const next = track.clips[i + 1],
        duration = clipDuration(clip, ir.timebase);
      if (
        clip.transition.kind === "fade" &&
        (!next ||
          compare(add(clip.start, duration), next.start) !== 0 ||
          compare(clip.transition.duration, duration) >= 0 ||
          compare(clip.transition.duration, clipDuration(next, ir.timebase)) >= 0)
      )
        clip.transition = { kind: "cut" };
    });
  }
  const validated = validateTimeline(sliced);
  if (compare(compileTimelineIR(validated).duration, sub(range.end, range.start)) !== 0)
    throw new Error("Selection ends in an uncovered output gap; choose a covered boundary");
  return validated;
}
