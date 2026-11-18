import { z } from "zod";
import { FootageShotsSchema } from "../../types/footage-shots";
import type { CropKeyframe, CropPath } from "../../types/multicam";
import type { Transcript } from "../../types/transcript";
import { positionAt } from "../timeline-ir/reframe";
export { positionAt };

export type Box = { x: number; y: number; w: number; h: number; score: number };
export type Detections = {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  samples: { frame: number; faces: Box[]; people: Box[] }[];
};
export type Format = CropPath["format"];
export type ReframeRules = CropPath["rules"];
/** Where to look in a frame range: a point (normalised source coordinates) the subject nearest to it is followed. */
export type Follow = { startFrame: number; endFrame: number; x: number; y: number }[];

export const DEFAULT_REFRAME_RULES: ReframeRules = { deadzone: 0.5, minMove: 0.05, smoothingSec: 0.5 };
const ASPECT: Record<Format, number> = { vertical: 9 / 16, square: 1, landscape: 16 / 9 };
const SIMPLIFY_TOLERANCE = 0.002;

/** Normalised cover crop of a `width`×`height` source for a format; the moving axis is the one the crop does not fill. */
export function cropSize(
  width: number,
  height: number,
  format: Format,
): { width: number; height: number; axis: "x" | "y" | null } {
  const ratio = ASPECT[format] / (width / height);
  if (Math.abs(ratio - 1) < 1e-6) return { width: 1, height: 1, axis: null };
  return ratio < 1 ? { width: ratio, height: 1, axis: "x" } : { width: 1, height: 1 / ratio, axis: "y" };
}

/** Crop centre (normalised) to CSS object-position fraction for a cover crop of size `crop` on that axis. */
export const centreToPosition = (centre: number, crop: number) =>
  crop >= 1 ? 0.5 : Math.min(1, Math.max(0, (centre - crop / 2) / (1 - crop)));

const centre = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

type Sample = Detections["samples"][number];
type Track = { boxes: Map<number, Box>; meanX: number; meanY: number; meanW: number; coverage: number; weight: number };
/** One followed subject per sample: its point and box (normalised), so the crop can keep the whole face inside. */
export type Subject = {
  frame: number;
  point: { x: number; y: number };
  box: Box;
  kind: "face" | "person" | "speaker";
  track: number;
};

const TRACK_REACH = 0.06;
const PERSISTENT = 0.3;

/** Links boxes across a shot's samples into tracks by nearest centre, so one stray detection cannot steal the crop. */
export function linkTracks(samples: { frame: number; boxes: Box[] }[]): Track[] {
  const tracks: { boxes: Map<number, Box>; last: { x: number; y: number } }[] = [];
  for (const sample of samples) {
    const free = new Set(tracks.keys());
    for (const box of [...sample.boxes].sort((a, b) => b.w * b.h - a.w * a.h)) {
      const point = centre(box);
      let best = -1;
      let distance = TRACK_REACH;
      for (const index of free) {
        const d = Math.hypot(tracks[index]!.last.x - point.x, tracks[index]!.last.y - point.y);
        if (d < distance) [best, distance] = [index, d];
      }
      if (best < 0) tracks.push({ boxes: new Map([[sample.frame, box]]), last: point });
      else {
        free.delete(best);
        tracks[best]!.boxes.set(sample.frame, box);
        tracks[best]!.last = point;
      }
    }
  }
  return tracks.map((track) => {
    const boxes = [...track.boxes.values()];
    const mean = (value: (box: Box) => number) => boxes.reduce((sum, box) => sum + value(box), 0) / boxes.length;
    const coverage = samples.length ? boxes.length / samples.length : 0;
    const meanX = mean((box) => centre(box).x);
    return {
      boxes: track.boxes,
      meanX,
      meanY: mean((box) => centre(box).y),
      meanW: mean((box) => box.w),
      coverage,
      weight: coverage * mean((box) => box.w * box.h * box.score) * (1.25 - Math.abs(meanX - 0.5)),
    };
  });
}

/**
 * Subjects of one shot. Faces are linked into tracks; tracks seen in under 30% of samples are ignored. A follow point
 * (active speaker) picks the persistent track nearest to it; otherwise persistent tracks that fit the crop together are
 * framed together, else the heaviest track (seen most, largest, most confident, nearer the centre) is followed for the
 * whole shot. People stand in only when the shot has no face track.
 */
export function shotSubjects(
  samples: Sample[],
  crop: { width: number; height: number },
  followAt: (frame: number) => { x: number; y: number } | null,
): Subject[] {
  const faceTracks = linkTracks(samples.map((sample) => ({ frame: sample.frame, boxes: sample.faces }))).filter(
    (track) => track.coverage >= PERSISTENT,
  );
  const kind = faceTracks.length ? "face" : "person";
  const tracks = faceTracks.length
    ? faceTracks
    : linkTracks(samples.map((sample) => ({ frame: sample.frame, boxes: sample.people }))).filter(
        (track) => track.coverage >= PERSISTENT,
      );
  if (!tracks.length) return [];
  const main = tracks.reduce((best, track) => (track.weight > best.weight ? track : best));
  const left = Math.min(...tracks.map((track) => track.meanX - track.meanW / 2));
  const right = Math.max(...tracks.map((track) => track.meanX + track.meanW / 2));
  const together = tracks.length > 1 && right - left <= crop.width * 0.9;
  const out: Subject[] = [];
  for (const sample of samples) {
    const follow = followAt(sample.frame);
    if (follow) {
      const present = tracks.filter((track) => track.boxes.has(sample.frame));
      if (present.length) {
        const nearest = present.reduce((best, track) =>
          Math.abs(track.meanX - follow.x) < Math.abs(best.meanX - follow.x) ? track : best,
        );
        const box = nearest.boxes.get(sample.frame)!;
        out.push({ frame: sample.frame, point: centre(box), box, kind: "speaker", track: tracks.indexOf(nearest) });
      }
      continue;
    }
    if (together) {
      const boxes = tracks.flatMap((track) => (track.boxes.has(sample.frame) ? [track.boxes.get(sample.frame)!] : []));
      if (!boxes.length) continue;
      const x = Math.min(...boxes.map((box) => box.x));
      const y = Math.min(...boxes.map((box) => box.y));
      const box = {
        x,
        y,
        w: Math.max(...boxes.map((item) => item.x + item.w)) - x,
        h: Math.max(...boxes.map((item) => item.y + item.h)) - y,
        score: 1,
      };
      out.push({ frame: sample.frame, point: centre(box), box, kind, track: -1 });
      continue;
    }
    const box = main.boxes.get(sample.frame);
    if (box) out.push({ frame: sample.frame, point: centre(box), box, kind, track: tracks.indexOf(main) });
  }
  return out;
}

/** Linear interpolation of sparse samples to every frame in [start, end); ends hold. */
function densify(points: { frame: number; value: number }[], start: number, end: number): number[] {
  const out: number[] = [];
  let index = 0;
  for (let frame = start; frame < end; frame++) {
    while (index + 1 < points.length && points[index + 1]!.frame <= frame) index++;
    const a = points[index]!;
    const b = points[index + 1];
    if (frame <= a.frame || !b) out.push(a.value);
    else out.push(a.value + ((b.value - a.value) * (frame - a.frame)) / (b.frame - a.frame));
  }
  return out;
}

/** Hold the camera until the subject leaves a band of `minMove`, then smooth the held path forwards and backwards. */
export function smoothPath(values: number[], minMove: number, sigmaFrames: number): number[] {
  const held: number[] = [];
  let hold = values[0]!;
  for (const value of values) {
    if (Math.abs(value - hold) > minMove) hold = value;
    held.push(hold);
  }
  if (sigmaFrames < 0.5) return held;
  const radius = Math.ceil(sigmaFrames * 3);
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) =>
    Math.exp(-((i - radius) ** 2) / (2 * sigmaFrames ** 2)),
  );
  return held.map((_, frame) => {
    let sum = 0;
    let weight = 0;
    for (let k = -radius; k <= radius; k++) {
      const value = held[Math.min(held.length - 1, Math.max(0, frame + k))]!;
      sum += value * kernel[k + radius]!;
      weight += kernel[k + radius]!;
    }
    return sum / weight;
  });
}

/** Ramer–Douglas–Peucker on one value per frame: keeps the frames a linear interpolation needs within `tolerance`. */
export function simplify(values: number[], tolerance: number): number[] {
  const keep = new Set([0, values.length - 1]);
  const stack: [number, number][] = [[0, values.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let distance = tolerance;
    for (let i = a + 1; i < b; i++) {
      const line = values[a]! + ((values[b]! - values[a]!) * (i - a)) / (b - a);
      if (Math.abs(values[i]! - line) > distance) {
        distance = Math.abs(values[i]! - line);
        worst = i;
      }
    }
    if (worst >= 0) {
      keep.add(worst);
      stack.push([a, worst], [worst, b]);
    }
  }
  return [...keep].sort((x, y) => x - y);
}

const HEADROOM = 0.1;
const MIN_SEGMENT_SEC = 1;
const TURN_PAN_SEC = 0.5;
type Segment = { startFrame: number; endFrame: number; subjects: Subject[] };
/**
 * Splits a shot where the followed track changes (a new speaker). Each part is planned on its own so smoothing never
 * blends two people into a point between them; a part shorter than `minFrames` joins its neighbour.
 */
function subjectSegments(subjects: Subject[], startFrame: number, endFrame: number, minFrames: number): Segment[] {
  let runs: Subject[][] = [];
  for (const row of subjects) {
    const last = runs.at(-1);
    if (last && last[0]!.track === row.track) last.push(row);
    else runs.push([row]);
  }
  const span = (index: number) =>
    (runs[index + 1]?.[0]!.frame ?? endFrame) - (index ? runs[index]![0]!.frame : startFrame);
  for (
    let index = runs.findIndex((_, i) => span(i) < minFrames);
    index >= 0 && runs.length > 1;
    index = runs.findIndex((_, i) => span(i) < minFrames)
  ) {
    runs.splice(index, 1);
    runs = runs.reduce<Subject[][]>((list, run) => {
      if (list.at(-1)?.[0]!.track === run[0]!.track) list.at(-1)!.push(...run);
      else list.push(run);
      return list;
    }, []);
  }
  return runs.map((run, index) => ({
    startFrame: index ? run[0]!.frame : startFrame,
    endFrame: runs[index + 1]?.[0]!.frame ?? endFrame,
    subjects: run,
  }));
}
const WIDE_FACE = 0.05;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const axisBounds = (box: Box, axis: "x" | "y") => {
  const [start, length] = axis === "x" ? [box.x, box.w] : [box.y, box.h];
  const margin = Math.max(length * 0.5, 0.02);
  return { low: start - margin, high: start + length + margin };
};
/** The subject's box with margin at a frame, from the nearest sample at or before it (or the first). */
function subjectBounds(subjects: Subject[], frame: number, axis: "x" | "y") {
  let row = subjects[0]!;
  for (const item of subjects) if (item.frame <= frame) row = item;
  return axisBounds(row.box, axis);
}
/** Moves a crop centre the least so [low, high] lies inside the crop; a subject wider than the crop stays centred on it. */
function insideCrop(centreValue: number, size: number, bounds: { low: number; high: number }): number {
  if (bounds.high - bounds.low >= size) return (bounds.low + bounds.high) / 2;
  return Math.min(Math.max(centreValue, bounds.high - size / 2), bounds.low + size / 2);
}

/**
 * AutoFlip-style crop path. Per shot: if the subject's motion stays within `deadzone` of the crop, one stationary
 * crop centred on it; otherwise a pan that ignores moves under `minMove` of the frame and is smoothed non-causally.
 * Shots reset the path: no interpolation crosses a boundary.
 */
export function planCropPath(options: {
  detections: Detections;
  format: Format;
  shots?: { startFrame: number; endFrame: number }[];
  follow?: Follow;
  rules?: Partial<ReframeRules>;
}): { crop: { width: number; height: number }; shots: CropPath["shots"]; keyframes: CropKeyframe[] } {
  const rules = { ...DEFAULT_REFRAME_RULES, ...options.rules };
  const { detections } = options;
  const crop = cropSize(detections.width, detections.height, options.format);
  const total = detections.frameCount;
  const shots = (options.shots?.length ? options.shots : [{ startFrame: 0, endFrame: total }])
    .map((shot) => ({ startFrame: Math.max(0, shot.startFrame), endFrame: Math.min(total, shot.endFrame) }))
    .filter((shot) => shot.endFrame > shot.startFrame);
  const followAt = (frame: number) =>
    options.follow?.find((item) => frame >= item.startFrame && frame < item.endFrame) ?? null;
  const outShots: CropPath["shots"] = [];
  const keyframes: CropKeyframe[] = [];
  for (const shot of shots) {
    const samples = detections.samples.filter(
      (sample) => sample.frame >= shot.startFrame && sample.frame < shot.endFrame,
    );
    const subjects = shotSubjects(samples, crop, followAt);
    const coverage = samples.length ? subjects.length / samples.length : 0;
    const kinds = subjects.map((row) => row.kind);
    const subject = !kinds.length ? "none" : kinds.includes("speaker") ? "speaker" : kinds[0]!;
    const axis = crop.axis;
    const size = axis === "y" ? crop.height : crop.width;
    const emit = (frame: number, value: number) =>
      keyframes.push({ frame, x: axis === "x" ? value : 0.5, y: axis === "y" ? value : 0.5 });
    if (!axis || !subjects.length) {
      emit(shot.startFrame, 0.5);
      if (shot.endFrame - 1 > shot.startFrame) emit(shot.endFrame - 1, 0.5);
      outShots.push({ ...shot, mode: "stationary", subject, coverage });
      continue;
    }
    const segments = subjectSegments(
      subjects,
      shot.startFrame,
      shot.endFrame,
      Math.round(MIN_SEGMENT_SEC * detections.fps),
    );
    const wide = median(subjects.map((row) => row.box.w)) < WIDE_FACE;
    const centres: number[] = [];
    let moving = segments.length > 1;
    for (const segment of segments) {
      // Headroom: on a vertical axis the face sits at ~40% of the crop height, not its centre.
      const along = segment.subjects.map((row) => ({
        frame: row.frame,
        value: axis === "x" ? row.point.x : row.point.y + size * HEADROOM,
      }));
      const low = Math.min(...along.map((row) => row.value));
      const high = Math.max(...along.map((row) => row.value));
      if (high - low <= rules.deadzone * size) {
        const value = segment.subjects.reduce(
          (v, row) => insideCrop(v, size, axisBounds(row.box, axis)),
          (low + high) / 2,
        );
        for (let frame = segment.startFrame; frame < segment.endFrame; frame++) centres.push(value);
        continue;
      }
      moving = true;
      const smoothed = smoothPath(
        densify(along, segment.startFrame, segment.endFrame),
        rules.minMove * (wide ? 2 : 1),
        rules.smoothingSec * detections.fps * (wide ? 3 : 1),
      );
      smoothed.forEach((value, index) =>
        centres.push(insideCrop(value, size, subjectBounds(segment.subjects, segment.startFrame + index, axis))),
      );
    }
    const turn = Math.max(1, Math.round(TURN_PAN_SEC * detections.fps));
    for (const segment of segments.slice(1)) {
      const at = segment.startFrame - shot.startFrame;
      const from = centres[at - 1]!;
      const span = Math.min(turn, centres.length - at);
      for (let i = 0; i < span; i++) {
        const x = (i + 1) / span;
        const t = x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
        centres[at + i] = from + (centres[at + i]! - from) * t;
      }
    }
    const dense = centres.map((value) => centreToPosition(value, size));
    if (!moving) {
      emit(shot.startFrame, dense[0]!);
      if (shot.endFrame - 1 > shot.startFrame) emit(shot.endFrame - 1, dense[0]!);
      outShots.push({ ...shot, mode: "stationary", subject, coverage });
      continue;
    }
    for (const index of simplify(dense, SIMPLIFY_TOLERANCE))
      emit(shot.startFrame + index, Number(dense[index]!.toFixed(4)));
    outShots.push({ ...shot, mode: "pan", subject, coverage });
  }
  return { crop: { width: crop.width, height: crop.height }, shots: outShots, keyframes };
}

const ShotsSchema = z
  .object({
    shots: z
      .array(
        z.object({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive() }).passthrough(),
      )
      .min(1),
  })
  .passthrough();

/**
 * footage:shots (`FootageShotsSchema`: inclusive `endFrame`, frames of `analysedPath` at its `fps`, padded back to the
 * container start by `source.startOffsetSec`) as end-exclusive frames of the original stream, or a plain end-exclusive list.
 */
export function shotRanges(raw: unknown, fps: number): { startFrame: number; endFrame: number }[] {
  const footage = FootageShotsSchema.safeParse(raw);
  if (footage.success) {
    const scale = fps / footage.data.fps;
    const pad = Math.round((footage.data.source.startOffsetSec ?? 0) * footage.data.fps);
    const original = (analysed: number) => Math.max(0, Math.round((analysed - pad) * scale));
    return footage.data.shots
      .map((shot) => ({ startFrame: original(shot.startFrame), endFrame: original(shot.endFrame + 1) }))
      .filter((shot) => shot.endFrame > shot.startFrame);
  }
  return ShotsSchema.parse(raw).shots.map((shot) => ({ startFrame: shot.startFrame, endFrame: shot.endFrame }));
}

/**
 * Re-key a crop path from original decoded frames to another frame grid, e.g. a recording-edit 30 fps master
 * (`normalization.masterToDecodedFrame`): each target frame takes the value of the original frame it shows.
 */
export function retimeKeyframes(keyframes: readonly CropKeyframe[], targetToSource: readonly number[]): CropKeyframe[] {
  if (!targetToSource.length) throw new Error("Empty frame mapping");
  const xs = targetToSource.map((frame) => positionAt(keyframes, frame).x);
  const ys = targetToSource.map((frame) => positionAt(keyframes, frame).y);
  const keep = [...new Set([...simplify(xs, SIMPLIFY_TOLERANCE / 4), ...simplify(ys, SIMPLIFY_TOLERANCE / 4)])].sort(
    (a, b) => a - b,
  );
  return keep.map((frame) => ({ frame, x: Number(xs[frame]!.toFixed(4)), y: Number(ys[frame]!.toFixed(4)) }));
}

/** Only the keyframes a clip reading source frames [start, end) needs, with the path's value pinned at both ends. */
export function sliceKeyframes(keyframes: readonly CropKeyframe[], start: number, end: number): CropKeyframe[] {
  const last = Math.max(start, end - 1);
  const edge = (frame: number) => ({ frame, ...positionAt(keyframes, frame) });
  const inside = keyframes.filter((key) => key.frame > start && key.frame < last);
  return last > start ? [edge(start), ...inside, edge(last)] : [edge(start)];
}

/**
 * Follow points from a diarised transcript of this same video: each speaker turn points at that speaker's horizontal
 * place (0–1). Words closer than `gapSec` join a turn; turns shorter than `minTurnSec` (interjections) keep the
 * previous speaker, so the crop does not swing for a one-word reply.
 */
export function followFromTranscript(
  transcript: Transcript,
  positions: Record<string, number>,
  fps: number,
  options = { gapSec: 0.35, minTurnSec: 1.5 },
): Follow {
  const turns: { speaker: string; start: number; end: number }[] = [];
  for (const word of transcript.words) {
    if (!word.speaker || word.kind === "event" || positions[word.speaker] === undefined) continue;
    const last = turns.at(-1);
    if (last && last.speaker === word.speaker && word.startSec - last.end <= options.gapSec)
      last.end = Math.max(last.end, word.endSec);
    else turns.push({ speaker: word.speaker, start: word.startSec, end: word.endSec });
  }
  const kept: typeof turns = [];
  for (const turn of turns) {
    const last = kept.at(-1);
    if (last && (turn.end - turn.start < options.minTurnSec || last.speaker === turn.speaker))
      last.end = Math.max(last.end, turn.end);
    else kept.push({ ...turn });
  }
  return kept
    .map((turn, index) => ({
      startFrame: Math.round(turn.start * fps),
      endFrame: Math.round((kept[index + 1]?.start ?? turn.end) * fps),
      x: positions[turn.speaker]!,
      y: 0.3,
    }))
    .filter((item) => item.endFrame > item.startFrame);
}
