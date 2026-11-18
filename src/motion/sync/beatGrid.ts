// Music time as frames for scenes. Pure (no Node imports): pass a parsed audio map, e.g. imported JSON.
import type { AudioMap } from "../../types/film";
import { leadFrame, toSheetKind, type LeadOverrides, type SheetCueKind } from "../../lib/audio-map/leads";
import type { CueKind as LibraryCueKind } from "../library/types";

export type GridTrust = AudioMap["tempo"]["gridTrust"] | "assumed";
export type GridSection = { startFrame: number; endFrame: number; level: "low" | "mid" | "high" };

export type BeatGrid = {
  fps: number;
  /** Seconds of the track at the film's first frame. */
  offsetSec: number;
  bpm?: number;
  /** "assumed": built from a bpm with no track behind it. */
  trust: GridTrust;
  durationInFrames: number;
  beats: number[];
  downbeats: number[];
  /** Usable drum and onset events (strength ≥ 0.3). */
  onsets: number[];
  /** Kicks and snares on the beat with strength ≥ 0.5. */
  strongHits: number[];
  /** Surges, drops, impacts and riser ends: the moments a film is built around. */
  surges: number[];
  hardStops: number[];
  phrases: number[];
  sections: GridSection[];
  /** Frame of beat 0 (the drop) when the grid was built around one; `beatAt` counts from it. */
  anchorFrame?: number;
};

const uniqueSorted = (frames: number[]) => [...new Set(frames)].sort((a, b) => a - b);

/** Converts a map (track seconds) into film frames; anything before the film's first frame is dropped. */
export function beatGridFromMap(map: AudioMap, { fps, offsetSec = 0 }: { fps: number; offsetSec?: number }): BeatGrid {
  const toFrames = (seconds: number[]) =>
    uniqueSorted(
      seconds
        .map((sec) => sec - offsetSec)
        .filter((sec) => sec >= 0)
        .map((sec) => Math.round(sec * fps)),
    );
  return {
    fps,
    offsetSec,
    ...(map.tempo.bpm ? { bpm: map.tempo.bpm } : {}),
    trust: map.tempo.gridTrust,
    durationInFrames: Math.max(0, Math.round((map.source.durationSec - offsetSec) * fps)),
    beats: toFrames(map.beatsSec),
    downbeats: toFrames(map.downbeatsSec),
    onsets: toFrames(map.events.filter((event) => event.strength >= 0.3).map((event) => event.timeSec)),
    strongHits: toFrames(
      map.events
        .filter(
          (event) =>
            (event.kind === "kick" || event.kind === "snare") &&
            event.strength >= 0.5 &&
            event.metric !== "off-grid" &&
            event.metric !== "offbeat",
        )
        .map((event) => event.timeSec),
    ),
    surges: toFrames(map.keyMoments.filter((moment) => moment.kind !== "hard-stop").map((moment) => moment.timeSec)),
    hardStops: toFrames(map.keyMoments.filter((moment) => moment.kind === "hard-stop").map((moment) => moment.timeSec)),
    phrases: toFrames([
      ...map.phrases.map((phrase) => phrase.startSec),
      ...map.sections.map((section) => section.startSec),
    ]),
    sections: map.sections
      .map((section) => ({
        startFrame: Math.max(0, Math.round((section.startSec - offsetSec) * fps)),
        endFrame: Math.round((section.endSec - offsetSec) * fps),
        level: section.level,
      }))
      .filter((section) => section.endFrame > section.startFrame),
  };
}

/**
 * A grid from a tempo alone, for drafts before the track exists. It is a metronome, not music: say so.
 * `anchorFrame` puts beat 0 (the drop) on that frame and fills the beats before it as well (negative k), with bars
 * and phrases counted from the anchor; without it the grid starts at `offsetFrames` as before.
 */
export function fallbackGrid({
  bpm,
  fps,
  durationInFrames,
  beatsPerBar = 4,
  offsetFrames = 0,
  anchorFrame,
}: {
  bpm: number;
  fps: number;
  durationInFrames: number;
  beatsPerBar?: number;
  offsetFrames?: number;
  anchorFrame?: number;
}): BeatGrid {
  if (!(bpm > 0) || !(fps > 0)) throw new Error("fallbackGrid needs a positive bpm and fps");
  const step = (60 / bpm) * fps;
  const anchor = anchorFrame ?? offsetFrames;
  const first = anchorFrame === undefined ? 0 : -Math.floor(anchor / step + 1e-9);
  const beats: number[] = [];
  const downbeats: number[] = [];
  const phrases: number[] = [];
  const mod = (k: number, n: number) => ((k % n) + n) % n;
  for (let k = first; anchor + k * step < durationInFrames; k++) {
    const frame = Math.round(anchor + k * step);
    if (frame < 0) continue;
    beats.push(frame);
    if (mod(k, beatsPerBar) === 0) downbeats.push(frame);
    if (mod(k, beatsPerBar * 4) === 0) phrases.push(frame);
  }
  const barFrames = step * beatsPerBar;
  return {
    fps,
    offsetSec: 0,
    bpm,
    trust: "assumed",
    durationInFrames,
    beats,
    downbeats,
    onsets: beats,
    strongHits: downbeats,
    surges: anchorFrame === undefined ? [] : [Math.round(anchorFrame)],
    hardStops: [],
    phrases,
    sections: phrases
      .map((start, index) => ({
        startFrame: start,
        endFrame: Math.min(durationInFrames, phrases[index + 1] ?? Math.round(start + barFrames * 4)),
        level: "mid" as const,
      }))
      .filter((section) => section.endFrame > section.startFrame),
    ...(anchorFrame === undefined ? {} : { anchorFrame }),
  };
}

/**
 * Frame of beat `k` counted from the grid's anchor (beat 0, the drop); `k` may be negative or fractional
 * (`beatAt(grid, -0.5)` is the off-beat before the drop). Needs a bpm; anchors at `anchorFrame`, else the first beat.
 */
export function beatAt(grid: Pick<BeatGrid, "bpm" | "fps" | "anchorFrame" | "beats">, k: number): number {
  if (!grid.bpm) throw new Error("beatAt needs a grid with a bpm");
  const anchor = grid.anchorFrame ?? grid.beats[0] ?? 0;
  return Math.round(anchor + k * (60 / grid.bpm) * grid.fps);
}

export type SnapTarget = "beat" | "downbeat" | "onset" | "strong" | "surge" | "phrase" | "stop";

/** What each kind lands on when nothing is asked, strongest first. */
const DEFAULT_TARGETS: Record<SheetCueKind, SnapTarget[]> = {
  cut: ["surge", "phrase", "downbeat", "strong"],
  transition: ["surge", "phrase", "downbeat", "strong"],
  reveal: ["downbeat", "beat"],
  hit: ["surge", "strong", "downbeat"],
  stop: ["stop", "surge", "phrase", "downbeat"],
  sfx: ["onset", "beat"],
};

const MEASURED: ReadonlySet<SnapTarget> = new Set(["surge", "phrase", "stop"]);

const framesFor = (grid: BeatGrid, target: SnapTarget): number[] =>
  ({
    beat: grid.beats,
    downbeat: grid.downbeats,
    onset: grid.onsets,
    strong: grid.strongHits,
    surge: grid.surges,
    phrase: grid.phrases,
    stop: grid.hardStops,
  })[target];

export type SnapOptions = {
  /** Anchors to try, in order of preference. Without a reliable grid only surges, phrases and stops are used. */
  to?: SnapTarget[];
  /** How far the anchor may be from the asked frame. Default 4 frames (≈0.13 s at 30 fps). */
  toleranceFrames?: number;
  leadFrames?: LeadOverrides;
};

export type Snapped = { frame: number; anchorFrame: number; leadFrames: number; anchor: SnapTarget | "none" };

/**
 * Moves a picture event to the nearest suitable music anchor, then applies the per-kind lead:
 * a cut lands one frame before the beat, a sound effect on it, a hit up to three early.
 * With nothing within tolerance, the frame is returned unchanged with `anchor: "none"`.
 */
export function snap(
  grid: BeatGrid,
  frame: number,
  kind: SheetCueKind | LibraryCueKind,
  options: SnapOptions = {},
): Snapped {
  const sheetKind = toSheetKind(kind);
  const tolerance = options.toleranceFrames ?? 4;
  const trusted = grid.trust === "reliable" || grid.trust === "assumed";
  const targets = (options.to ?? DEFAULT_TARGETS[sheetKind]).filter((target) => trusted || MEASURED.has(target));
  let best: { anchorFrame: number; target: SnapTarget; distance: number; rank: number } | undefined;
  targets.forEach((target, rank) => {
    for (const anchorFrame of framesFor(grid, target)) {
      const distance = Math.abs(anchorFrame - frame);
      if (distance > tolerance) continue;
      // Within a frame of each other the stronger kind wins, then the nearer; otherwise the nearer wins.
      const better =
        !best ||
        (Math.abs(distance - best.distance) <= 1
          ? rank < best.rank || (rank === best.rank && distance < best.distance)
          : distance < best.distance);
      if (better) best = { anchorFrame, target, distance, rank };
    }
  });
  if (!best) return { frame, anchorFrame: frame, leadFrames: 0, anchor: "none" };
  const delivered = leadFrame(best.anchorFrame, sheetKind, options.leadFrames);
  return {
    frame: delivered,
    anchorFrame: best.anchorFrame,
    leadFrames: best.anchorFrame - delivered,
    anchor: best.target,
  };
}

/** Shorthand: the snapped frame only. */
export const snapFrame = (
  grid: BeatGrid,
  frame: number,
  kind: SheetCueKind | LibraryCueKind,
  options?: SnapOptions,
): number => snap(grid, frame, kind, options).frame;

const BEATS_PER_SHOT: Record<GridSection["level"], number> = { low: 8, mid: 4, high: 2 };

/**
 * Shot lengths that follow the music: cuts on downbeats (or beats) every few beats by section level
 * (low 8, mid 4, high 2 beats), a cut at every section start, each cut one frame early.
 * Without a reliable grid it cuts on phrase and section starts only. Lengths sum to `totalFrames`.
 */
export function shotLengthsFromSections(
  grid: BeatGrid,
  {
    totalFrames = grid.durationInFrames,
    minFrames = 8,
    beatsPerShot = BEATS_PER_SHOT,
    leadFrames,
  }: {
    totalFrames?: number;
    minFrames?: number;
    beatsPerShot?: Partial<Record<GridSection["level"], number>>;
    leadFrames?: LeadOverrides;
  } = {},
): number[] {
  const perShot = { ...BEATS_PER_SHOT, ...beatsPerShot };
  const trusted = grid.trust === "reliable" || grid.trust === "assumed";
  const anchors = new Set<number>(grid.sections.map((section) => section.startFrame));
  if (trusted)
    for (const section of grid.sections) {
      const beats = grid.beats.filter((beat) => beat >= section.startFrame && beat < section.endFrame);
      const downbeats = new Set(grid.downbeats);
      const step = Math.max(1, perShot[section.level]);
      for (let index = step; index < beats.length; index += step) {
        // Prefer a downbeat within a beat of the slot, so cuts sit on bar lines when they can.
        const slot = beats[index]!;
        const near = [beats[index - 1], slot, beats[index + 1]].find(
          (beat) => beat !== undefined && downbeats.has(beat),
        );
        anchors.add(near ?? slot);
      }
    }
  else for (const phrase of grid.phrases) anchors.add(phrase);
  const cuts = uniqueSorted(
    [...anchors]
      .map((anchor) => leadFrame(anchor, "cut", leadFrames))
      .filter((cut) => cut >= minFrames && cut <= totalFrames - minFrames),
  );
  const kept: number[] = [];
  for (const cut of cuts) if (cut - (kept.at(-1) ?? 0) >= minFrames) kept.push(cut);
  const edges = [0, ...kept, totalFrames];
  return edges.slice(1).map((edge, index) => edge - edges[index]!);
}

/** Start frames of shots from their lengths. */
export const shotStarts = (lengths: readonly number[]): number[] => {
  let at = 0;
  return lengths.map((length) => {
    const start = at;
    at += length;
    return start;
  });
};
