import type { AudioMap, CueSheet } from "../../types/film";
import { textWidth } from "../vision/bitmap-font";
import { BACKGROUND, RgbImage, type Colour } from "../vision/image";
import type { MaskingReport } from "./masking";
import { STRONG_TOLERANCE_SEC } from "../audio-map/snap";

// One picture of how picture and sound line up: the final mix, the music grid, every cut and every placed sound.

export const SYNC_TOLERANCE_FRAMES = 1;
/** A cut this close to a phrase or section boundary is structural: it should land on a downbeat. */
export const STRUCTURAL_WITHIN_SEC = 0.25;

export type SyncCut = {
  timeSec: number;
  frame: number;
  nearestBeatSec: number | null;
  /** Cut minus beat, in frames: negative means the picture leads. */
  errorFrames: number | null;
  structural: boolean;
  nearestDownbeatSec: number | null;
  downbeatErrorFrames: number | null;
  status: "on-beat" | "off-beat" | "missed-downbeat" | "no-grid";
  /** Without a reliable grid: the nearest phrase, section or key-moment start within the snap window, and the cut's error to it. */
  anchor?: { sec: number; kind: string; errorFrames: number };
  /** "declared" from a cue sheet, edit plan or placements; "detected" from the picture; "both" when they agree within 2 frames. */
  source: "declared" | "detected" | "both";
  declaredFrame?: number;
  declaredKind?: string;
  label?: string;
  /** The detected change's shape: peak frame difference over the larger of its two neighbours. */
  spike?: { peak: number; neighbour: number; ratio: number };
  /** The judgement: "miss" is a sync error (red). On a reliable grid it follows the beat status; otherwise only anchored cuts are judged. */
  verdict: "ok" | "miss" | "none";
};

export type SyncSound = {
  id: string;
  sfx: string;
  cueFrame: number;
  startFrame: number;
  endFrame: number;
  errorFramesToBeat: number | null;
  masked: boolean;
  marginDb?: number;
};
export type SyncCue = { id: string; kind: string; frame: number; errorFramesToBeat: number | null };

export type SyncMap = {
  schemaVersion: 1;
  render: string;
  fps: number;
  durationSec: number;
  musicOffsetSec: number;
  gridTrust: AudioMap["tempo"]["gridTrust"] | "none";
  /** False when the map says the bar is unknown: no "missed-downbeat" verdicts. */
  barKnown: boolean;
  /** "low" unless the grid is reliable: off-beat cuts are shown grey and are not sync errors. */
  verdictWeight: "high" | "low";
  gridNote?: string;
  rule: string;
  cuts: SyncCut[];
  /** Detected changes shaped like a ramp (an eased move, a zoom), not a cut: no verdict. */
  moves: { frame: number; timeSec: number; peak: number; neighbour: number; ratio: number }[];
  sounds: SyncSound[];
  cues: SyncCue[];
  summary: {
    cuts: number;
    declared: number;
    detected: number;
    both: number;
    moves: number;
    misses: number;
    onBeat: number;
    offBeat: number;
    structural: number;
    structuralMissedDownbeat: number;
    medianAbsErrorFrames: number | null;
    worstErrorFrames: number | null;
    sounds: number;
    masked: number;
    image?: string;
  };
};

export type SoundSheetLike = {
  fps: number;
  events: { id: string; sfx: string; cueFrame: number; startFrame: number; durationInFrames: number }[];
};

const round = (value: number, digits = 3) => Number(value.toFixed(digits));
const nearest = (times: number[], at: number) =>
  times.length ? times.reduce((a, b) => (Math.abs(b - at) < Math.abs(a - at) ? b : a)) : null;

export function shiftedGrid(map: AudioMap | undefined, offsetSec: number) {
  const shift = (times: number[]) => times.map((time) => round(time - offsetSec)).filter((time) => time >= 0);
  if (!map) return { beats: [], downbeats: [], boundaries: [], phrases: [] as { startSec: number; endSec: number }[] };
  const phrases = map.phrases
    .map((phrase) => ({ startSec: round(phrase.startSec - offsetSec), endSec: round(phrase.endSec - offsetSec) }))
    .filter((phrase) => phrase.endSec > 0);
  const boundaries = shift([
    ...map.phrases.map((phrase) => phrase.startSec),
    ...map.sections.map((section) => section.startSec),
  ]).filter((time) => time > 0);
  return { beats: shift(map.beatsSec), downbeats: shift(map.downbeatsSec), boundaries, phrases };
}

/** Phrase, section and key-moment starts in film seconds: what edit:snap snaps to without a reliable grid. */
function measuredAnchors(map: AudioMap, offsetSec: number): { sec: number; kind: string }[] {
  const structure = (
    map as { structure?: { phrases?: { startSec: number }[]; sections?: { startSec: number; label?: string }[] } }
  ).structure;
  return [
    ...map.keyMoments.map((moment) => ({ sec: moment.timeSec, kind: moment.kind })),
    ...map.phrases.map((phrase) => ({ sec: phrase.startSec, kind: "phrase-start" })),
    ...map.sections.map((section) => ({ sec: section.startSec, kind: "section-start" })),
    ...(structure?.phrases ?? []).map((phrase) => ({ sec: phrase.startSec, kind: "phrase-start" })),
    ...(structure?.sections ?? []).map((section) => ({
      sec: section.startSec,
      kind: `${section.label ?? "section"}-start`,
    })),
  ]
    .map((item) => ({ ...item, sec: round(item.sec - offsetSec) }))
    .filter((item) => item.sec > 0);
}

export type DeclaredCut = { frame: number; kind: string; label?: string };
/** Cut kinds a cue file can declare. */
export const DECLARED_CUT_KINDS = ["cut", "transition", "ground-swap"] as const;
/** A cut is a one-frame spike: its peak at least this many times the larger neighbour. An eased move ramps up and down. */
export const CUT_SPIKE_RATIO = 2;
const MATCH_FRAMES = 2;

/**
 * Where a detected change really peaks (within `search` frames) and whether it is a cut or a move, from the per-frame
 * mean luma difference (`diffs[f]` is frame f against f−1).
 */
export function classifySpike(
  diffs: number[],
  frame: number,
  search = 3,
): { frame: number; peak: number; neighbour: number; ratio: number; shape: "cut" | "move" } {
  let peakFrame = Math.min(Math.max(frame, 1), diffs.length - 1);
  for (let at = Math.max(1, frame - search); at <= Math.min(diffs.length - 1, frame + search); at++)
    if (diffs[at]! > diffs[peakFrame]!) peakFrame = at;
  const peak = diffs[peakFrame] ?? 0;
  const neighbour = Math.max(diffs[peakFrame - 1] ?? 0, diffs[peakFrame + 1] ?? 0);
  const ratio = peak / Math.max(neighbour, 0.5);
  return {
    frame: peakFrame,
    peak: round(peak, 2),
    neighbour: round(neighbour, 2),
    ratio: round(ratio, 2),
    shape: ratio >= CUT_SPIKE_RATIO ? "cut" : "move",
  };
}

type CutCandidate = {
  frame: number;
  source: SyncCut["source"];
  declaredFrame?: number;
  declaredKind?: string;
  label?: string;
  spike?: SyncCut["spike"];
};

/** Declared cuts merged with detected ones; detected ramps that no declaration claims become moves. */
export function mergeCuts(
  declared: DeclaredCut[],
  detected: ReturnType<typeof classifySpike>[],
): { cuts: CutCandidate[]; moves: ReturnType<typeof classifySpike>[] } {
  const unique = <T extends { frame: number }>(items: T[]) =>
    items.filter((item, index) => items.findIndex((other) => other.frame === item.frame) === index);
  const found = unique([...detected].sort((a, b) => a.frame - b.frame));
  const claimed = new Set<number>();
  const cuts: CutCandidate[] = unique([...declared].sort((a, b) => a.frame - b.frame)).map((cut) => {
    const match = found
      .filter((item) => !claimed.has(item.frame) && Math.abs(item.frame - cut.frame) <= MATCH_FRAMES)
      .sort((a, b) => Math.abs(a.frame - cut.frame) - Math.abs(b.frame - cut.frame))[0];
    const base = { declaredFrame: cut.frame, declaredKind: cut.kind, ...(cut.label ? { label: cut.label } : {}) };
    if (!match) return { frame: cut.frame, source: "declared" as const, ...base };
    claimed.add(match.frame);
    return {
      frame: match.frame,
      source: "both" as const,
      ...base,
      spike: { peak: match.peak, neighbour: match.neighbour, ratio: match.ratio },
    };
  });
  for (const item of found)
    if (!claimed.has(item.frame) && item.shape === "cut")
      cuts.push({
        frame: item.frame,
        source: "detected",
        spike: { peak: item.peak, neighbour: item.neighbour, ratio: item.ratio },
      });
  return {
    cuts: cuts.sort((a, b) => a.frame - b.frame),
    moves: found.filter((item) => !claimed.has(item.frame) && item.shape === "move"),
  };
}

/** Per-event offsets: each cut to its nearest beat (and to a downbeat when structural), each sound and cue to its nearest beat. */
export function buildSyncMap(options: {
  render: string;
  fps: number;
  durationSec: number;
  cutsSec: number[];
  declared?: DeclaredCut[];
  frameDiffs?: number[];
  map?: AudioMap;
  musicOffsetSec?: number;
  sheet?: SoundSheetLike;
  cueSheet?: CueSheet;
  masking?: MaskingReport;
}): SyncMap {
  const { fps, map } = options;
  const offset = options.musicOffsetSec ?? 0;
  // Older maps have no barKnown: treat the bar as known, as before.
  const barKnown = (map?.grid as { barKnown?: boolean } | undefined)?.barKnown !== false;
  const grid = shiftedGrid(map, offset);
  const reliable = map?.tempo.gridTrust === "reliable";
  const anchors = map ? measuredAnchors(map, offset) : [];
  // Beats only judge cuts inside the span the grid covers; outside it (an intro before the drums) the anchors do.
  const periods = grid.beats
    .slice(1)
    .map((beat, index) => beat - grid.beats[index]!)
    .sort((a, b) => a - b);
  const halfPeriod = periods.length ? periods[Math.floor(periods.length / 2)]! / 2 : 0;
  const inGrid = (time: number) =>
    grid.beats.length > 0 && time >= grid.beats[0]! - halfPeriod && time <= grid.beats.at(-1)! + halfPeriod;
  const toFrames = (seconds: number) => Math.round(seconds * fps);
  const snappedToDownbeat = (time: number) =>
    options.cueSheet?.cues.some(
      (cue) =>
        (cue.kind === "cut" || cue.kind === "transition") &&
        (cue.snap === "downbeat" || cue.snap === "phrase") &&
        Math.abs(cue.frame / fps - time) <= 2 / fps,
    ) ?? false;
  const detected = options.cutsSec.map((timeSec) =>
    options.frameDiffs?.length
      ? classifySpike(options.frameDiffs, toFrames(timeSec))
      : { frame: toFrames(timeSec), peak: 0, neighbour: 0, ratio: 0, shape: "cut" as const },
  );
  const merged = mergeCuts(options.declared ?? [], detected);
  const cuts: SyncCut[] = merged.cuts.map((declaredOrFound) => {
    // A declared cut the detector missed (a flat text swap) is measured where the frame difference still spikes, within 2 frames.
    const local =
      declaredOrFound.source === "declared" && options.frameDiffs?.length
        ? classifySpike(options.frameDiffs, declaredOrFound.frame, MATCH_FRAMES)
        : undefined;
    const candidate =
      local && local.shape === "cut" && local.peak >= 1
        ? {
            ...declaredOrFound,
            frame: local.frame,
            spike: { peak: local.peak, neighbour: local.neighbour, ratio: local.ratio },
          }
        : declaredOrFound;
    const { frame } = candidate;
    const timeSec = frame / fps;
    const beat = nearest(grid.beats, timeSec);
    const downbeat = nearest(grid.downbeats, timeSec);
    const errorFrames = beat === null ? null : frame - toFrames(beat);
    const downbeatErrorFrames = downbeat === null ? null : frame - toFrames(downbeat);
    const structural =
      grid.boundaries.some((boundary) => Math.abs(boundary - timeSec) <= STRUCTURAL_WITHIN_SEC) ||
      snappedToDownbeat(timeSec);
    const status: SyncCut["status"] =
      errorFrames === null || !inGrid(timeSec)
        ? "no-grid"
        : reliable &&
            barKnown &&
            structural &&
            (downbeatErrorFrames === null || Math.abs(downbeatErrorFrames) > SYNC_TOLERANCE_FRAMES)
          ? "missed-downbeat"
          : Math.abs(errorFrames) > SYNC_TOLERANCE_FRAMES
            ? "off-beat"
            : "on-beat";
    const byGrid = reliable && status !== "no-grid";
    const near = (byGrid ? [] : anchors)
      .filter((item) => Math.abs(item.sec - timeSec) <= STRONG_TOLERANCE_SEC)
      .sort((a, b) => Math.abs(a.sec - timeSec) - Math.abs(b.sec - timeSec))[0];
    const anchor = near ? { sec: near.sec, kind: near.kind, errorFrames: frame - toFrames(near.sec) } : undefined;
    const verdict: SyncCut["verdict"] = byGrid
      ? status === "off-beat" || status === "missed-downbeat"
        ? "miss"
        : status === "on-beat"
          ? "ok"
          : "none"
      : anchor
        ? Math.abs(anchor.errorFrames) > SYNC_TOLERANCE_FRAMES
          ? "miss"
          : "ok"
        : "none";
    return {
      timeSec: round(timeSec),
      frame,
      nearestBeatSec: beat,
      errorFrames,
      structural,
      nearestDownbeatSec: downbeat,
      downbeatErrorFrames,
      status,
      ...(anchor ? { anchor } : {}),
      source: candidate.source,
      ...(candidate.declaredFrame !== undefined
        ? { declaredFrame: candidate.declaredFrame, declaredKind: candidate.declaredKind }
        : {}),
      ...(candidate.label ? { label: candidate.label } : {}),
      ...(candidate.spike && options.frameDiffs?.length ? { spike: candidate.spike } : {}),
      verdict,
    };
  });
  const beatError = (frame: number) => {
    const beat = nearest(grid.beats, frame / fps);
    return beat === null ? null : frame - toFrames(beat);
  };
  const masked = new Map((options.masking?.cues ?? []).map((cue) => [cue.id, cue]));
  const sheetFps = options.sheet?.fps ?? fps;
  const reframe = (frame: number) => Math.round((frame / sheetFps) * fps);
  const sounds: SyncSound[] = (options.sheet?.events ?? []).map((event) => {
    const reading = masked.get(event.id);
    const cueFrame = reframe(event.cueFrame);
    return {
      id: event.id,
      sfx: event.sfx,
      cueFrame,
      startFrame: reframe(event.startFrame),
      endFrame: reframe(event.startFrame + event.durationInFrames),
      errorFramesToBeat: beatError(cueFrame),
      masked: reading?.status === "masked",
      ...(reading ? { marginDb: reading.marginDb } : {}),
    };
  });
  const cues: SyncCue[] = (options.cueSheet?.cues ?? []).map((cue) => ({
    id: cue.id,
    kind: cue.kind,
    frame: Math.round((cue.frame / options.cueSheet!.fps) * fps),
    errorFramesToBeat: beatError(Math.round((cue.frame / options.cueSheet!.fps) * fps)),
  }));
  const errors = cuts
    .flatMap((cut) => (cut.errorFrames === null || cut.status === "no-grid" ? [] : [Math.abs(cut.errorFrames)]))
    .sort((a, b) => a - b);
  return {
    schemaVersion: 1,
    render: options.render,
    fps,
    durationSec: round(options.durationSec),
    musicOffsetSec: offset,
    gridTrust: map?.tempo.gridTrust ?? "none",
    barKnown,
    verdictWeight: reliable ? "high" : "low",
    ...(reliable
      ? {}
      : {
          gridNote: `Grid trust is ${map?.tempo.gridTrust ?? "none"}: beats and downbeats may be the tracker's guess, so beat offsets are information (grey). Cuts are judged only against phrase, section and key-moment starts within ${STRONG_TOLERANCE_SEC} s, the anchors edit:snap falls back to.`,
        }),
    rule: !reliable
      ? `No reliable grid: a cut within ${STRONG_TOLERANCE_SEC} s of a phrase, section or key-moment start is judged against it (red when > ${SYNC_TOLERANCE_FRAMES} frame off; negative: picture leads); every other cut gets no verdict. Beat offsets are information only.`
      : `${barKnown ? "" : "Bar unknown (downbeat confidence < 0.2): cuts are judged against beats only, never downbeats. "}Error is cut frame minus nearest beat frame (negative: picture leads). Red when |error| > ${SYNC_TOLERANCE_FRAMES} frame, or when a structural cut (within ${STRUCTURAL_WITHIN_SEC} s of a phrase or section start, or a cue snapped to a downbeat or phrase) is more than ${SYNC_TOLERANCE_FRAMES} frame off a downbeat. Cuts outside the grid's span are judged as on a weak grid, against phrase, section and key-moment starts. Detected changes whose peak is under ${CUT_SPIKE_RATIO}x their larger neighbour are moves, with no verdict; declared cuts come from the cue files.`,
    cuts,
    moves: options.frameDiffs?.length
      ? merged.moves.map((move) => ({
          frame: move.frame,
          timeSec: round(move.frame / fps),
          peak: move.peak,
          neighbour: move.neighbour,
          ratio: move.ratio,
        }))
      : [],
    sounds,
    cues,
    summary: {
      cuts: cuts.length,
      declared: cuts.filter((cut) => cut.source === "declared").length,
      detected: cuts.filter((cut) => cut.source === "detected").length,
      both: cuts.filter((cut) => cut.source === "both").length,
      moves: options.frameDiffs?.length ? merged.moves.length : 0,
      misses: cuts.filter((cut) => cut.verdict === "miss").length,
      onBeat: cuts.filter((cut) => cut.status === "on-beat").length,
      offBeat: cuts.filter((cut) => cut.status === "off-beat").length,
      structural: cuts.filter((cut) => cut.structural).length,
      structuralMissedDownbeat: cuts.filter((cut) => cut.status === "missed-downbeat").length,
      medianAbsErrorFrames: errors.length ? errors[Math.floor(errors.length / 2)]! : null,
      worstErrorFrames: errors.length ? errors.at(-1)! : null,
      sounds: sounds.length,
      masked: sounds.filter((sound) => sound.masked).length,
    },
  };
}

const RED: Colour = [239, 68, 68];
const GREEN: Colour = [74, 222, 128];
const ORANGE: Colour = [251, 146, 60];
const BLUE: Colour = [96, 165, 250];
const MUTED: Colour = [150, 150, 160];
const WHITE: Colour = [235, 235, 240];
const YELLOW: Colour = [250, 204, 21];
const PHRASE_A: Colour = [30, 30, 44];
const VIOLET: Colour = [167, 139, 250];
const PHRASE_B: Colour = [44, 40, 30];

export function drawLine(
  image: RgbImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  colour: Colour,
  thickness = 2,
): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let step = 0; step <= steps; step++)
    image.fillRect(
      Math.round(x0 + ((x1 - x0) * step) / steps),
      Math.round(y0 + ((y1 - y0) * step) / steps),
      thickness,
      thickness,
      colour,
    );
}

const WIDTH = 1800;
const WAVE = 160;
const GRID = 70;
const CUTS = 110;
const SOUNDS = 80;
const BAND = 26;

/** The sync map picture. `waveform` is the render's waveform at WIDTH × WAVE; `energyDb` one reading per film frame. */
export function drawSyncMap(
  sync: SyncMap,
  options: { waveform?: RgbImage; energyDb?: number[]; map?: AudioMap },
): RgbImage {
  const height = BAND + WAVE + BAND + GRID + BAND + CUTS + BAND + SOUNDS + BAND * 2;
  const image = RgbImage.filled(WIDTH, height, BACKGROUND);
  const x = (seconds: number) =>
    Math.max(0, Math.min(WIDTH - 2, Math.round((seconds / sync.durationSec) * (WIDTH - 1))));
  const xf = (frame: number) => x(frame / sync.fps);
  const s = sync.summary;
  image.drawText(
    `SYNC MAP. ${s.cuts} CUTS (${s.both} BOTH, ${s.declared} DECL, ${s.detected} PIC), ${s.moves} MOVES, ${s.misses} MISSES; ${s.onBeat} ON BEAT, ${s.offBeat} OFF; MED ${s.medianAbsErrorFrames ?? "-"} F, WORST ${s.worstErrorFrames ?? "-"} F; GRID ${sync.gridTrust.toUpperCase()}${sync.barKnown ? "" : " BAR?"}; ${s.masked}/${s.sounds} SFX MASKED`,
    6,
    5,
    2,
    WHITE,
  );

  let top = BAND;
  if (options.waveform) image.blit(options.waveform, 0, top);
  if (options.energyDb?.length) {
    let previous: { px: number; py: number } | undefined;
    options.energyDb.forEach((db, frame) => {
      const px = xf(frame);
      const py = top + WAVE - 1 - Math.round(Math.max(0, Math.min(1, (db + 60) / 60)) * (WAVE - 1));
      if (previous) drawLine(image, previous.px, previous.py, px, py, YELLOW, 2);
      previous = { px, py };
    });
  }
  image.drawText("FINAL MIX: WAVEFORM, YELLOW RMS ENERGY (-60..0 DB)", 6, top + WAVE + 6, 2, MUTED);

  top += WAVE + BAND;
  const grid = shiftedGrid(options.map, sync.musicOffsetSec);
  grid.phrases.forEach((phrase, index) =>
    image.fillRect(
      x(Math.max(0, phrase.startSec)),
      top,
      Math.max(1, x(phrase.endSec) - x(Math.max(0, phrase.startSec))),
      GRID,
      index % 2 ? PHRASE_B : PHRASE_A,
    ),
  );
  for (const beat of grid.beats) image.fillRect(x(beat), top + GRID - 22, 2, 22, MUTED);
  for (const downbeat of grid.downbeats) image.fillRect(x(downbeat), top, 3, GRID, WHITE);
  image.drawText("MUSIC: WHITE DOWNBEATS, GREY BEATS, SHADED PHRASES", 6, top + GRID + 6, 2, MUTED);

  top += GRID + BAND;
  sync.cuts.forEach((cut, index) => {
    const colour = cut.verdict === "miss" ? RED : cut.verdict === "ok" ? GREEN : MUTED;
    const target = cut.anchor
      ? cut.anchor.sec
      : cut.status === "no-grid"
        ? null
        : cut.status === "missed-downbeat"
          ? cut.nearestDownbeatSec
          : cut.nearestBeatSec;
    if (target === null)
      image.drawText(
        `NO GRID${cut.source === "declared" ? " D" : cut.source === "detected" ? " P" : ""}`,
        Math.min(WIDTH - 110, x(cut.timeSec) + 5),
        top + 3 + (index % 3) * 13,
        2,
        colour,
      );
    // Solid when the picture shows the cut (detected or both); dashed when only declared.
    if (cut.source === "declared")
      for (let y = top + 44; y < top + CUTS; y += 8) image.fillRect(x(cut.timeSec), y, 3, 4, colour);
    else image.fillRect(x(cut.timeSec), top + 44, 3, CUTS - 44, colour);
    if (target !== null) {
      drawLine(image, x(cut.timeSec), top + CUTS - 1, x(target), top - BAND - GRID / 2, colour, 2);
      const error = cut.anchor
        ? cut.anchor.errorFrames
        : cut.status === "missed-downbeat"
          ? cut.downbeatErrorFrames!
          : cut.errorFrames!;
      const label = `${error > 0 ? "+" : ""}${error}F${cut.anchor ? " A" : cut.structural ? " S" : ""}${cut.source === "declared" ? " D" : cut.source === "detected" ? " P" : ""}`;
      const lx = Math.min(WIDTH - textWidth(label, 2) - 2, x(cut.timeSec) + 5);
      image.drawText(label, lx, top + 3 + (index % 3) * 13, 2, colour);
    }
  });
  for (const move of sync.moves) {
    image.fillRect(x(move.timeSec), top + 44, 1, CUTS - 44, VIOLET);
    image.drawText("M", x(move.timeSec) + 3, top + CUTS - 12, 1, VIOLET);
  }
  image.drawText(
    sync.verdictWeight === "high"
      ? "CUTS: GREEN ON BEAT, RED >1 F OFF OR STRUCTURAL (S) OFF DOWNBEAT. DASHED/D DECLARED ONLY, P PICTURE ONLY, THIN VIOLET M = MOVE"
      : "CUTS (WEAK GRID): JUDGED ON ANCHORS (A) ONLY, RED >1 F OFF; GREY BEAT INFO. DASHED/D DECLARED, P PICTURE, VIOLET M = MOVE",
    6,
    top + CUTS + 6,
    2,
    MUTED,
  );

  top += CUTS + BAND;
  for (const cue of sync.cues) image.fillRect(xf(cue.frame), top, 2, 22, BLUE);
  sync.sounds.forEach((sound, index) => {
    const colour = sound.masked ? ORANGE : GREEN;
    const row = top + 26 + (index % 3) * 16;
    image.fillRect(
      xf(sound.startFrame),
      row + 5,
      Math.max(2, xf(sound.endFrame) - xf(sound.startFrame)),
      3,
      sound.masked ? ORANGE : [60, 110, 80],
    );
    image.fillRect(xf(sound.cueFrame), row, 3, 13, colour);
    image.drawText(sound.sfx, xf(sound.cueFrame) + 5, row, 1, colour);
  });
  image.drawText(
    "BLUE CUE-SHEET CUES; SFX: TICK ON ITS CUE, BAR OVER THE FILE; ORANGE MASKED",
    6,
    top + SOUNDS + 6,
    2,
    MUTED,
  );

  top += SOUNDS + BAND;
  const interval = [0.5, 1, 2, 5, 10, 15, 30, 60].find((candidate) => sync.durationSec / candidate <= 15) ?? 120;
  for (let seconds = 0; seconds <= sync.durationSec; seconds += interval) {
    image.fillRect(x(seconds), top, 1, 8, MUTED);
    if (x(seconds) + 40 < WIDTH) image.drawText(`${seconds}S`, x(seconds) + 3, top + 10, 2, MUTED);
  }
  return image;
}

/** RMS of the decoded mix per film frame, in dBFS. */
export function energyPerFrame(samples: Float32Array, sampleRate: number, fps: number): number[] {
  const step = sampleRate / fps;
  const frames = Math.floor(samples.length / step);
  return Array.from({ length: frames }, (_, frame) => {
    let sum = 0;
    const start = Math.round(frame * step);
    const end = Math.min(samples.length, Math.round((frame + 1) * step));
    for (let index = start; index < end; index++) sum += samples[index]! ** 2;
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    return rms > 1e-6 ? round(20 * Math.log10(rms), 1) : -120;
  });
}

export const SYNC_IMAGE_SIZE = { width: WIDTH, waveHeight: WAVE };
