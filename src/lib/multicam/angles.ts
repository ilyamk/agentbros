import type { AngleMap, AnglePlan, AngleSegment, AsdResult, MulticamSource, MulticamSync } from "../../types/multicam";
import type { Transcript } from "../../types/transcript";
import type { EditCommand, Rational, TimelineClip } from "../../types/timeline";
import { add, fraction, mul } from "../timeline-ir/rational";

export type AngleRules = AnglePlan["rules"];
export const DEFAULT_RULES: AngleRules = {
  minShotSec: 1.5,
  overlapWideSec: 2,
  sentenceSnapSec: 0.6,
  dominanceDb: 6,
  hopSec: 0.1,
};
const SPEECH_ABOVE_FLOOR_DB = 10;
const WORD_GAP_SEC = 0.35;

type Label = { kind: "speaker"; speaker: string } | { kind: "overlap"; speakers: string[] } | { kind: "silence" };
/** Active speakers per hop on the reference timeline. */
export type Activity = { hopSec: number; hops: string[][]; focus?: ({ x: number; y: number } | null)[] };

/** Offset of a source at a reference time: the overlap-start offset plus measured drift. */
export const offsetAt = (source: MulticamSource, referenceSec: number) =>
  source.offsetSec + (source.drift.ppm ?? 0) * 1e-6 * (referenceSec - source.overlap.startSec);
export const toReference = (source: MulticamSource, sec: number) => sec + offsetAt(source, sec + source.offsetSec);
export const toSource = (source: MulticamSource, referenceSec: number) => referenceSec - offsetAt(source, referenceSec);

const percentile = (values: number[], p: number) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : -120;
};

/** Per-mic level series (dB, own time) to reference-time activity: a mic speaks when it is clearly above its floor and within `dominanceDb` of the loudest mic. */
export function activityFromEnergy(
  mics: { speaker: string; source: MulticamSource; levels: number[]; hopSec: number }[],
  durationSec: number,
  rules: AngleRules,
): Activity {
  const floors = mics.map((mic) => percentile(mic.levels, 0.2));
  const count = Math.ceil(durationSec / rules.hopSec);
  const hops: string[][] = [];
  for (let hop = 0; hop < count; hop++) {
    const t = (hop + 0.5) * rules.hopSec;
    const levels = mics.map((mic) => {
      const index = Math.floor(toSource(mic.source, t) / mic.hopSec);
      return index >= 0 && index < mic.levels.length ? mic.levels[index]! : -Infinity;
    });
    const loudest = Math.max(...levels);
    hops.push(
      mics
        .filter((_, i) => levels[i]! >= floors[i]! + SPEECH_ABOVE_FLOOR_DB && levels[i]! >= loudest - rules.dominanceDb)
        .map((mic) => mic.speaker),
    );
  }
  return { hopSec: rules.hopSec, hops };
}

/** Diarised transcript (own time of `source`) to reference-time activity; words closer than a short gap join one turn. */
export function activityFromTranscript(
  transcript: Transcript,
  source: MulticamSource,
  durationSec: number,
  rules: AngleRules,
): Activity {
  const count = Math.ceil(durationSec / rules.hopSec);
  const hops: string[][] = Array.from({ length: count }, () => []);
  const turns: { speaker: string; start: number; end: number }[] = [];
  for (const word of transcript.words) {
    if (!word.speaker || word.kind === "event") continue;
    const start = toReference(source, word.startSec);
    const end = toReference(source, word.endSec);
    const last = turns.at(-1);
    if (last && last.speaker === word.speaker && start - last.end <= WORD_GAP_SEC) last.end = Math.max(last.end, end);
    else turns.push({ speaker: word.speaker, start, end });
  }
  for (const turn of turns) {
    for (
      let hop = Math.max(0, Math.floor(turn.start / rules.hopSec));
      hop < Math.min(count, Math.ceil(turn.end / rules.hopSec));
      hop++
    ) {
      if (!hops[hop]!.includes(turn.speaker)) hops[hop]!.push(turn.speaker);
    }
  }
  return { hopSec: rules.hopSec, hops };
}

const labelOf = (speakers: string[]): Label =>
  speakers.length === 0
    ? { kind: "silence" }
    : speakers.length === 1
      ? { kind: "speaker", speaker: speakers[0]! }
      : { kind: "overlap", speakers: [...speakers].sort() };
const sameLabel = (a: Label, b: Label) => JSON.stringify(a) === JSON.stringify(b);

type Span = {
  start: number;
  end: number;
  angle: string;
  speaker: string | null;
  reason: AngleSegment["reason"];
  focus: { x: number; y: number } | null;
};

const covers = (sync: MulticamSync, angle: string, start: number, end: number) => {
  const source = sync.sources.find((item) => item.id === angle);
  if (!source?.video || source.videoOffsetSec === null) return false;
  return source.videoOffsetSec <= start + 1e-6 && source.videoOffsetSec + source.durationSec >= end - 1e-6;
};

/**
 * Angle proposal from activity. Rules, in order: a single speaker gets their angle; a short overlap holds the
 * current shot, a long one goes wide; silence holds; nothing known yet is wide. Then cuts snap to sentence starts,
 * shots shorter than `minShotSec` are absorbed by the shot before them, and an angle without picture there falls back to
 * the wide shot (or any covering camera).
 */
export function proposeAngles(options: {
  sync: MulticamSync;
  syncFile: { file: string; sha256: string };
  map: AngleMap | null;
  activity: Activity | null;
  method: AnglePlan["method"];
  fps: { num: number; den: number };
  rules?: Partial<AngleRules>;
  sentenceStartsSec?: number[];
  focusSource?: string | null;
}): AnglePlan {
  const rules = { ...DEFAULT_RULES, ...options.rules };
  const { sync, map } = options;
  const reference = sync.sources.find((source) => source.id === sync.referenceId)!;
  const cameras = sync.sources.filter((source) => source.video && source.videoOffsetSec !== null);
  if (!cameras.length) throw new Error("No synced source has video");
  const wide = map?.wide ?? (reference.video ? reference.id : cameras[0]!.id);
  const angleOf = new Map((map?.speakers ?? []).map((row) => [row.speaker, row.angle]));
  const notes: string[] = [];
  const programmeEnd = reference.durationSec;
  const spans: Span[] = [];
  const activity = options.activity;
  if (!activity || !map) {
    spans.push({ start: 0, end: programmeEnd, angle: wide, speaker: null, reason: "fallback-wide", focus: null });
    notes.push(
      activity
        ? "No angle map: wide shot only."
        : "No speaker evidence (mics, diarisation or visual detection): wide shot only.",
    );
  } else {
    const runs: { start: number; end: number; label: Label; focus: { x: number; y: number } | null }[] = [];
    activity.hops.forEach((speakers, hop) => {
      const known = speakers.filter((speaker) => angleOf.has(speaker));
      const label = labelOf(known);
      const start = hop * activity.hopSec;
      const end = Math.min(programmeEnd, start + activity.hopSec);
      if (start >= programmeEnd) return;
      const focus = activity.focus?.[hop] ?? null;
      const last = runs.at(-1);
      if (last && sameLabel(last.label, label)) last.end = end;
      else runs.push({ start, end, label, focus });
    });
    if (!runs.length || runs.at(-1)!.end < programmeEnd)
      runs.push({ start: runs.at(-1)?.end ?? 0, end: programmeEnd, label: { kind: "silence" }, focus: null });
    for (const run of runs) {
      const previous = spans.at(-1);
      if (run.label.kind === "speaker")
        spans.push({
          start: run.start,
          end: run.end,
          angle: angleOf.get(run.label.speaker)!,
          speaker: run.label.speaker,
          reason: "speaker",
          focus: run.focus,
        });
      else if (run.label.kind === "overlap" && run.end - run.start >= rules.overlapWideSec)
        spans.push({ start: run.start, end: run.end, angle: wide, speaker: null, reason: "overlap-wide", focus: null });
      else if (previous)
        spans.push({
          ...previous,
          start: run.start,
          end: run.end,
          reason: run.label.kind === "overlap" ? "overlap-hold" : "silence-hold",
        });
      else
        spans.push({
          start: run.start,
          end: run.end,
          angle: wide,
          speaker: null,
          reason: "fallback-wide",
          focus: null,
        });
    }
  }
  const merged = mergeSame(spans);
  snapCuts(merged, options.sentenceStartsSec ?? [], rules.sentenceSnapSec);
  const held = absorbShort(
    merged.filter((span) => span.end - span.start > 1e-9),
    rules.minShotSec,
  );
  for (const span of held) {
    if (covers(sync, span.angle, span.start, span.end)) continue;
    const fallback = [wide, ...cameras.map((camera) => camera.id)].find((angle) =>
      covers(sync, angle, span.start, span.end),
    );
    if (!fallback) {
      notes.push(`No camera covers ${span.start.toFixed(2)}–${span.end.toFixed(2)} s; left as a gap.`);
      span.angle = "";
      continue;
    }
    notes.push(`${span.angle} has no picture at ${span.start.toFixed(2)}–${span.end.toFixed(2)} s; using ${fallback}.`);
    Object.assign(span, { angle: fallback, reason: "fallback-wide", focus: null });
  }
  const fps = options.fps.num / options.fps.den;
  const segments: AngleSegment[] = [];
  for (const span of mergeSame(held)) {
    const startFrame = Math.round(span.start * fps);
    const endFrame = Math.round(span.end * fps);
    if (!span.angle || endFrame <= startFrame) continue;
    segments.push({
      startFrame,
      endFrame,
      angle: span.angle,
      speaker: span.speaker,
      reason: span.reason,
      focus: span.focus,
    });
  }
  return {
    version: 1,
    sync: options.syncFile,
    method: options.method,
    rules,
    fps: options.fps,
    focusSource: options.focusSource ?? null,
    segments,
    notes,
  };
}

function mergeSame(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const last = out.at(-1);
    if (last && last.angle === span.angle && Math.abs(last.end - span.start) < 1e-9) last.end = span.end;
    else out.push({ ...span });
  }
  return out;
}

function snapCuts(spans: Span[], starts: number[], window: number): void {
  if (!starts.length) return;
  for (let i = 1; i < spans.length; i++) {
    const cut = spans[i]!.start;
    const nearest = starts.reduce(
      (best, t) => (Math.abs(t - cut) < Math.abs(best - cut) ? t : best),
      Number.POSITIVE_INFINITY,
    );
    if (Math.abs(nearest - cut) <= window && nearest > spans[i - 1]!.start && nearest < spans[i]!.end) {
      spans[i - 1]!.end = nearest;
      spans[i]!.start = nearest;
    }
  }
}

function absorbShort(spans: Span[], minSec: number): Span[] {
  const out = spans.map((span) => ({ ...span }));
  for (;;) {
    const index = out.findIndex((span) => span.end - span.start < minSec - 1e-9);
    if (index < 0 || out.length < 2) return out;
    const short = out[index]!;
    if (index > 0) out[index - 1]!.end = short.end;
    else out[1]!.start = short.start;
    out.splice(index, 1);
    const collapsed = mergeSame(out);
    out.splice(0, out.length, ...collapsed);
  }
}

/** Seconds to an exact rational frame count at `fps`, at sample (1/48000 s) precision. */
const secondsToFrames = (sec: number, fps: Rational) =>
  fraction(BigInt(Math.round(sec * 48000)) * BigInt(fps.num), 48000n * BigInt(fps.den));

/**
 * One visual track whose clips switch assets: each segment reads its camera from
 * `referenceSec - videoOffset(t)`, with drift taken at the segment start. Output frames are the timeline's own.
 */
export function angleTrackCommand(
  plan: AnglePlan,
  sync: MulticamSync,
  options: {
    trackId: string;
    timebase: Rational;
    assetIds?: Record<string, string>;
    soundTrackId?: string;
    soundSource?: string;
  },
): EditCommand {
  if (plan.fps.num * options.timebase.den !== options.timebase.num * plan.fps.den)
    throw new Error("Angle plan fps must equal the timeline timebase");
  const sourceById = new Map(sync.sources.map((source) => [source.id, source]));
  const assetId = (source: MulticamSource) => options.assetIds?.[source.id] ?? `sha256:${source.sha256}`;
  const clips: TimelineClip[] = plan.segments.map((segment, index) => {
    const source = sourceById.get(segment.angle);
    if (!source?.video || source.videoOffsetSec === null) throw new Error(`Angle ${segment.angle} has no synced video`);
    const startSec = (segment.startFrame * plan.fps.den) / plan.fps.num;
    const offset = source.videoOffsetSec + offsetAt(source, startSec) - source.offsetSec;
    const sourceStart = secondsToFrames(Math.max(0, startSec - offset), source.video.fps);
    const length = mul(
      fraction(segment.endFrame - segment.startFrame),
      fraction(source.video.fps.num * plan.fps.den, source.video.fps.den * plan.fps.num),
    );
    return {
      id: `${options.trackId}-${String(index + 1).padStart(3, "0")}`,
      assetId: assetId(source),
      start: fraction(segment.startFrame),
      source: { start: sourceStart, end: add(sourceStart, length), timebase: source.video.fps },
      rate: { num: 1, den: 1 },
      transition: { kind: "cut" },
      captions: [],
    };
  });
  const commands: EditCommand[] = [{ type: "add-track", track: { id: options.trackId, kind: "visual", clips } }];
  if (options.soundTrackId && plan.segments.length) {
    const sound = sourceById.get(options.soundSource ?? sync.referenceId);
    if (!sound) throw new Error(`Unknown sound source ${options.soundSource}`);
    if (sound.video && !options.assetIds?.[sound.id])
      throw new Error(
        `Sound source ${sound.id} is a video file; voiceover tracks render audio assets only. Extract its audio (ffmpeg -i FILE -vn -c:a pcm_s16le sound.wav), import that, and pass --assets ${sound.id}=<audio asset id>, or map an audio-only source as "audio"`,
      );
    const first = plan.segments[0]!.startFrame;
    const last = plan.segments.at(-1)!.endFrame;
    const startSec = (first * plan.fps.den) / plan.fps.num;
    const sourceStart = secondsToFrames(Math.max(0, toSource(sound, startSec)), plan.fps);
    commands.push({
      type: "add-track",
      track: {
        id: options.soundTrackId,
        kind: "voiceover",
        clips: [
          {
            id: `${options.soundTrackId}-001`,
            assetId: assetId(sound),
            start: fraction(first),
            source: { start: sourceStart, end: add(sourceStart, fraction(last - first)), timebase: plan.fps },
            rate: { num: 1, den: 1 },
            transition: { kind: "cut" },
            captions: [],
          },
        ],
      },
    });
  }
  return commands.length === 1 ? commands[0]! : { type: "batch", commands };
}

/** Visual speaker scores of one camera to activity: each face is the mapped speaker nearest its horizontal position. */
export function activityFromAsd(
  asd: AsdResult,
  source: MulticamSource,
  map: AngleMap,
  durationSec: number,
  rules: AngleRules,
): Activity {
  const placed = map.speakers.filter((row) => row.position !== undefined);
  const speakerOf = (x: number) =>
    placed.length
      ? placed.reduce((best, row) => (Math.abs(row.position! - x) < Math.abs(best.position! - x) ? row : best)).speaker
      : null;
  const count = Math.ceil(durationSec / rules.hopSec);
  const hops: string[][] = Array.from({ length: count }, () => []);
  const focus: ({ x: number; y: number } | null)[] = Array.from({ length: count }, () => null);
  for (let hop = 0; hop < count; hop++) {
    const own = Math.floor(toSource(source, (hop + 0.5) * rules.hopSec) / asd.hopSec);
    let best = 0;
    for (const face of asd.faces) {
      const score = own >= 0 ? face.scores[own] : null;
      const speaker = speakerOf(face.x);
      if (score === null || score === undefined || score <= 0 || !speaker) continue;
      if (!hops[hop]!.includes(speaker)) hops[hop]!.push(speaker);
      if (score > best) {
        best = score;
        focus[hop] = { x: face.x, y: face.y };
      }
    }
  }
  return { hopSec: rules.hopSec, hops, focus };
}
