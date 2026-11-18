import { TimelineIRSchema, type TimelineIR, type TimelineClip, type Rational } from "../../types/timeline";
import { clipAudioGain } from "../audio/clip-gain";
import { add, sub, mul, div, compare, fraction, numeric } from "./rational";

export const clipDuration = (clip: TimelineClip, timebase: Rational) =>
  mul(div(sub(clip.source.end, clip.source.start), clip.rate), div(timebase, clip.source.timebase));
export const sourceToOutput = (clip: TimelineClip, sourceFrame: Rational, timebase: Rational) =>
  add(clip.start, mul(div(sub(sourceFrame, clip.source.start), clip.rate), div(timebase, clip.source.timebase)));
export const outputToSource = (clip: TimelineClip, outputFrame: Rational, timebase: Rational) =>
  add(clip.source.start, mul(mul(sub(outputFrame, clip.start), clip.rate), div(clip.source.timebase, timebase)));

export function validateTimeline(input: unknown): TimelineIR {
  const ir = TimelineIRSchema.parse(input);
  const ids = new Set<string>();
  for (const track of ir.tracks) {
    if (ids.has(track.id)) throw new Error(`Duplicate track ID: ${track.id}`);
    ids.add(track.id);
    const clipIds = new Set<string>();
    const clips = [...track.clips].sort((a, b) => compare(a.start, b.start));
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i],
        duration = clipDuration(clip, ir.timebase),
        end = add(clip.start, duration);
      if (clip.payload?.audioGain !== undefined) {
        if (track.kind !== "music" && track.kind !== "sfx")
          throw new Error("Audio gain supports music/SFX tracks only");
        clipAudioGain(clip.payload);
      }
      if (clip.payload?.speechMuted !== undefined && (track.kind !== "presenter" || clip.payload.speechMuted !== true))
        throw Error("Speech mute is valid only on a presenter clip");
      if (clipIds.has(clip.id)) throw new Error(`Duplicate clip ID: ${clip.id}`);
      clipIds.add(clip.id);
      if (
        compare(clip.start, fraction(0)) < 0 ||
        compare(clip.source.start, fraction(0)) < 0 ||
        compare(duration, fraction(0)) <= 0
      )
        throw new Error(`Invalid interval: ${clip.id}`);
      const next = clips[i + 1];
      if (next && compare(end, next.start) > 0) throw new Error(`Overlapping clips on ${track.id}: ${clip.id}`);
      if (clip.transition.kind === "fade") {
        const fade = clip.transition.duration;
        if (
          !next ||
          compare(end, next.start) !== 0 ||
          compare(fade, fraction(0)) <= 0 ||
          compare(fade, duration) >= 0 ||
          compare(fade, clipDuration(next, ir.timebase)) >= 0
        )
          throw new Error(`Invalid transition: ${clip.id}`);
        if (track.kind !== "visual")
          throw new Error("Speech and caption tracks cannot crossfade; use explicit audio automation");
      }
      const wordIds = new Set<string>();
      for (const word of clip.captions) {
        if (wordIds.has(word.id) || compare(word.start, word.end) >= 0 || compare(word.start, fraction(0)) < 0)
          throw new Error(`Invalid caption: ${word.id}`);
        wordIds.add(word.id);
      }
    }
  }
  const overlayIds = new Set<string>();
  for (const overlay of ir.overlays ?? []) {
    if (overlayIds.has(overlay.id)) throw new Error(`Duplicate overlay ID: ${overlay.id}`);
    overlayIds.add(overlay.id);
    if (
      compare(overlay.start, fraction(0)) < 0 ||
      compare(overlay.end, overlay.start) <= 0 ||
      (overlay.offset && compare(overlay.offset, fraction(0)) <= 0)
    )
      throw new Error(`Invalid overlay interval: ${overlay.id}`);
  }
  return ir;
}

/** Frozen serializable snapshot; captions follow trims, rates and source edits. */
export function compileTimelineIR(input: unknown) {
  const ir = structuredClone(validateTimeline(input));
  let duration = fraction(0);
  const tracks = ir.tracks.map((track) => ({
    ...track,
    clips: [...track.clips]
      .sort((a, b) => compare(a.start, b.start))
      .map((clip) => {
        const end = add(clip.start, clipDuration(clip, ir.timebase));
        if (compare(end, duration) > 0) duration = end;
        const captions = clip.captions.flatMap((word) => {
          if (compare(word.end, clip.source.start) <= 0 || compare(word.start, clip.source.end) >= 0) return [];
          const start = compare(word.start, clip.source.start) < 0 ? clip.source.start : word.start;
          const finish = compare(word.end, clip.source.end) > 0 ? clip.source.end : word.end;
          return [
            {
              ...word,
              start: sourceToOutput(clip, start, ir.timebase),
              end: sourceToOutput(clip, finish, ir.timebase),
            },
          ];
        });
        return {
          ...clip,
          end,
          duration: clipDuration(clip, ir.timebase),
          captions,
        };
      }),
  }));
  const snapshot = {
    version: 1 as const,
    projectId: ir.projectId,
    timebase: ir.timebase,
    duration,
    durationInFrames: Math.ceil(numeric(duration)),
    tracks,
    ...(ir.overlays ? { overlays: [...ir.overlays].sort((a, b) => compare(a.start, b.start)) } : {}),
  };
  const freeze = (value: unknown, seen = new WeakSet<object>()): void => {
    if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      Object.values(value).forEach((child) => freeze(child, seen));
      Object.freeze(value);
    }
  };
  freeze(snapshot);
  return snapshot;
}
