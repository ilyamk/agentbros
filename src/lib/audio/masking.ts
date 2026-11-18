import { BAND_COUNT, bandCentreHz, bandLevels, HOP_SIZE, SILENT_DB, SPECTRUM_RATE, sumDb } from "./spectrum";

// Predicted audibility of placed SFX against music and voice. A model, not a listening test: agents cannot hear.

export const MASKING_RULE = {
  windowSec: 0.1,
  /** A masker spreads to higher bands more than to lower ones (simultaneous masking is asymmetric). */
  spreadUpDbPerBand: 10,
  spreadDownDbPerBand: 20,
  /** A noise-like masker hides a sound this many dB below its own level in the same band. */
  maskingIndexDb: -4,
  /** Bands of the SFX quieter than this are ignored: they would not be heard even alone. */
  floorDb: -75,
  /** Only bands within this of the SFX's own peak count: a faint residue elsewhere is not the sound being heard. */
  characterDb: 15,
  audibleDb: 3,
  /** Sidechain duck the mixer applies to music under speech (audio:mix duckDb default). */
  speechDuckDb: -9,
  speechThresholdDb: -50,
  consonantFromHz: 3000,
  consonantShare: 0.35,
  description:
    "Per 11.6 ms frame and third-octave band inside ±100 ms of the cue: margin = SFX level − (music+VO spread across bands, 10 dB/band upward, 20 dB/band downward, −4 dB masking index). The cue's margin is the best band (within 15 dB of the SFX's own peak, above −75 dB) in the best frame; masked < 0 dB, marginal < 3 dB.",
} as const;

export type MaskingEvent = {
  id: string;
  sfx: string;
  weight?: "hero" | "support";
  cueFrame: number;
  startFrame: number;
  file: string;
  gain: number;
  label?: string;
};

export type Fix =
  | { type: "gain"; safe: true; fromGain: number; toGain: number; db: number }
  | { type: "duck"; safe: true; db: number; fromSec: number; toSec: number }
  | { type: "shift"; safe: false; frames: number; marginDb: number }
  | { type: "filter"; safe: false; filter: "high-pass" | "low-pass"; target: "sfx" | "music"; hz: number; why: string }
  | { type: "swap"; safe: false; towardHz: number; kinds: string[]; why: string };

export type CueAudibility = {
  id: string;
  sfx: string;
  label?: string;
  cueFrame: number;
  cueSec: number;
  gain: number;
  marginDb: number;
  status: "audible" | "marginal" | "masked" | "silent";
  bestBandHz?: number;
  /** The SFX's loudest band and what sits there. */
  peakBandHz?: number;
  sfxDb?: number;
  musicDb?: number;
  voDb?: number;
  masker?: "music" | "vo" | "none";
  fixes: Fix[];
};

export type Collision = {
  kind: "sfx-sfx" | "sfx-vo-consonant";
  ids: string[];
  atSec: number;
  bandsHz: number[];
  layered?: boolean;
  suggestion: string;
};

export type MaskingReport = {
  schemaVersion: 1;
  rule: typeof MASKING_RULE;
  fps: number;
  /** The mix the reading assumed: a wrong music gain or a missing voice moves every margin. */
  inputs: MixAssumption;
  cues: CueAudibility[];
  collisions: Collision[];
  summary: {
    cues: number;
    audible: number;
    marginal: number;
    masked: number;
    silent: number;
    collisions: number;
    worstMarginDb: number | null;
  };
};

/** Where the music and voice levels came from: the project's mix plan, the command's flags, or the default (music at 1, no voice). */
export type MixAssumption = {
  from: "plan" | "flags" | "default";
  plan?: string;
  musicGain: number | "plan";
  musicStartSec: number | "plan";
  voGain: number | "plan" | null;
  speechDuckDb: number;
  notes?: string[];
};

export type MaskingInput = {
  fps: number;
  events: MaskingEvent[];
  /** Decoded at SPECTRUM_RATE, by event file. */
  sounds: Map<string, Float32Array>;
  music?: Float32Array;
  musicGain?: number;
  /** Film seconds where the music file's 0 plays. */
  musicStartSec?: number;
  vo?: Float32Array;
  voGain?: number;
  voStartSec?: number;
  /** Gain ceilings for a safe raise. */
  ceiling?: { hero: number; support: number };
  /** Deepest duck applied as a safe fix, dB (negative). */
  maxDuckDb?: number;
  /** Music dip under speech; the plan's duckDb when known. */
  speechDuckDb?: number;
  /** Recorded in the report; default describes the gains above. */
  assumption?: Omit<MixAssumption, "speechDuckDb">;
};

const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const HIGH_KINDS = ["tick", "glass", "chime", "click"];
const LOW_KINDS = ["sub-drop", "impact"];
const MID_KINDS = ["pop", "click", "whoosh"];

function spread(masker: Float64Array): Float64Array {
  return masker.map((_, band) => {
    let level = SILENT_DB;
    for (let source = 0; source < BAND_COUNT; source++) {
      const distance = band - source;
      const slope = distance >= 0 ? MASKING_RULE.spreadUpDbPerBand : MASKING_RULE.spreadDownDbPerBand;
      level = Math.max(level, masker[source]! - slope * Math.abs(distance));
    }
    return level + MASKING_RULE.maskingIndexDb;
  });
}

type Frame = { sec: number; sfx: Float64Array; music: Float64Array; vo: Float64Array; threshold: Float64Array };

const sampleAt = (sec: number, startSec: number) => (sec - startSec) * SPECTRUM_RATE;

function frames(input: MaskingInput, event: MaskingEvent, shiftFrames = 0): Frame[] {
  const { fps } = input;
  const cueSec = event.cueFrame / fps;
  const startSec = (event.startFrame + shiftFrames) / fps;
  const sound = input.sounds.get(event.file);
  const hop = HOP_SIZE / SPECTRUM_RATE;
  const out: Frame[] = [];
  for (let sec = cueSec - MASKING_RULE.windowSec; sec <= cueSec + MASKING_RULE.windowSec + 1e-9; sec += hop) {
    const sfx = sound
      ? bandLevels(sound, sampleAt(sec, startSec), event.gain)
      : new Float64Array(BAND_COUNT).fill(SILENT_DB);
    const vo = input.vo
      ? bandLevels(input.vo, sampleAt(sec, input.voStartSec ?? 0), input.voGain ?? 1)
      : new Float64Array(BAND_COUNT).fill(SILENT_DB);
    const speaking = sumDb(...vo) > MASKING_RULE.speechThresholdDb;
    const musicGain =
      (input.musicGain ?? 1) * (speaking ? 10 ** ((input.speechDuckDb ?? MASKING_RULE.speechDuckDb) / 20) : 1);
    const music = input.music
      ? bandLevels(input.music, sampleAt(sec, input.musicStartSec ?? 0), musicGain)
      : new Float64Array(BAND_COUNT).fill(SILENT_DB);
    const masker = music.map((level, band) => sumDb(level, vo[band]!));
    out.push({ sec, sfx, music, vo, threshold: spread(masker) });
  }
  return out;
}

function bestMargin(window: Frame[]): { marginDb: number; band: number; frame: number } | undefined {
  let best: { marginDb: number; band: number; frame: number } | undefined;
  const peak = Math.max(...window.map((frame) => Math.max(...frame.sfx)));
  const floor = Math.max(MASKING_RULE.floorDb, peak - MASKING_RULE.characterDb);
  window.forEach((frame, index) => {
    for (let band = 0; band < BAND_COUNT; band++) {
      if (frame.sfx[band]! < floor) continue;
      const marginDb = frame.sfx[band]! - frame.threshold[band]!;
      if (!best || marginDb > best.marginDb) best = { marginDb, band, frame: index };
    }
  });
  return best;
}

/** Bands within 6 dB of the SFX's loudest over the window, its "colour". */
function dominantBands(window: Frame[], pick: (frame: Frame) => Float64Array): number[] {
  const peak = new Float64Array(BAND_COUNT).fill(SILENT_DB);
  for (const frame of window) pick(frame).forEach((level, band) => (peak[band] = Math.max(peak[band]!, level)));
  const top = Math.max(...peak);
  if (top < MASKING_RULE.floorDb) return [];
  return [...peak.keys()].filter((band) => peak[band]! >= top - 6);
}

function suggestFixes(
  input: MaskingInput,
  event: MaskingEvent,
  marginDb: number,
  masker: "music" | "vo" | "none",
  window: Frame[],
  peakBand: number,
): Fix[] {
  const fixes: Fix[] = [];
  let deficit = MASKING_RULE.audibleDb - marginDb;
  const ceiling = (input.ceiling ?? { hero: 0.4, support: 0.2 })[event.weight ?? "support"];
  if (deficit > 0 && event.gain < ceiling) {
    const db = Math.min(deficit, 20 * Math.log10(ceiling / event.gain), 6);
    const toGain = round(event.gain * 10 ** (db / 20), 3);
    if (db >= 0.5) {
      fixes.push({ type: "gain", safe: true, fromGain: event.gain, toGain, db: round(db) });
      deficit -= db;
    }
  }
  const cueSec = event.cueFrame / input.fps;
  if (deficit > 0 && masker === "music") {
    const db = Math.min(deficit, -(input.maxDuckDb ?? -6));
    fixes.push({
      type: "duck",
      safe: true,
      db: -round(db),
      fromSec: round(Math.max(0, cueSec - MASKING_RULE.windowSec), 3),
      toSec: round(cueSec + MASKING_RULE.windowSec, 3),
    });
    deficit -= db;
  }
  if (deficit <= 0) return fixes;
  for (const shift of [1, -1, 2, -2]) {
    const shifted = bestMargin(frames(input, event, shift));
    if (shifted && shifted.marginDb >= marginDb + 3) {
      fixes.push({ type: "shift", safe: false, frames: shift, marginDb: round(shifted.marginDb) });
      break;
    }
  }
  // The quietest band of the masker between 150 Hz and 9 kHz: where a different sound would read.
  const threshold = window[Math.floor(window.length / 2)]!.threshold;
  const usable = [...threshold.keys()].filter((band) => bandCentreHz(band) >= 150 && bandCentreHz(band) <= 9000);
  const open = usable.reduce((a, b) => (threshold[b]! < threshold[a]! ? b : a), usable[0]!);
  const towardHz = bandCentreHz(open);
  const kinds = towardHz >= 3000 ? HIGH_KINDS : towardHz < 250 ? LOW_KINDS : MID_KINDS;
  if (Math.abs(open - peakBand) >= 3)
    fixes.push({
      type: "swap",
      safe: false,
      towardHz,
      kinds: kinds.filter((kind) => kind !== event.sfx),
      why: `The ${masker} leaves most room near ${towardHz} Hz; this sound peaks near ${bandCentreHz(peakBand)} Hz.`,
    });
  if (masker === "music" && bandCentreHz(peakBand) < 300)
    fixes.push({
      type: "filter",
      safe: false,
      filter: "high-pass",
      target: "music",
      hz: 120,
      why: "Low SFX against the bass: thin the music's low end for the hit (not in audio:mix; do it in the music edit).",
    });
  else if (masker === "vo" && bandCentreHz(peakBand) >= MASKING_RULE.consonantFromHz)
    fixes.push({
      type: "filter",
      safe: false,
      filter: "low-pass",
      target: "sfx",
      hz: 3000,
      why: "The voice's consonants own the top; a darker SFX sits under them.",
    });
  return fixes;
}

/** Audibility of each placed SFX, collisions between them and with voice consonants, and a fix for each problem. */
export function assessMasking(input: MaskingInput): MaskingReport {
  const windows = new Map(input.events.map((event) => [event.id, frames(input, event)]));
  const cues: CueAudibility[] = input.events.map((event) => {
    const window = windows.get(event.id)!;
    const best = bestMargin(window);
    const base = {
      id: event.id,
      sfx: event.sfx,
      ...(event.label ? { label: event.label } : {}),
      cueFrame: event.cueFrame,
      cueSec: round(event.cueFrame / input.fps, 3),
      gain: event.gain,
    };
    if (!best) return { ...base, marginDb: -99, status: "silent" as const, fixes: [] };
    const loudest = window.reduce((a, b) => (Math.max(...b.sfx) > Math.max(...a.sfx) ? b : a));
    const peakBand = loudest.sfx.reduce((a, _, band, all) => (all[band]! > all[a]! ? band : a), 0);
    const musicDb = loudest.music[peakBand]!;
    const voDb = loudest.vo[peakBand]!;
    const masker = Math.max(musicDb, voDb) <= SILENT_DB + 1 ? "none" : musicDb >= voDb ? "music" : "vo";
    const marginDb = round(best.marginDb);
    const status = marginDb < 0 ? "masked" : marginDb < MASKING_RULE.audibleDb ? "marginal" : "audible";
    return {
      ...base,
      marginDb,
      status,
      bestBandHz: bandCentreHz(best.band),
      peakBandHz: bandCentreHz(peakBand),
      sfxDb: round(loudest.sfx[peakBand]!),
      musicDb: round(musicDb),
      voDb: round(voDb),
      masker,
      fixes: status === "audible" ? [] : suggestFixes(input, event, marginDb, masker, window, peakBand),
    };
  });

  const collisions: Collision[] = [];
  const sorted = [...input.events].sort((a, b) => a.cueFrame - b.cueFrame);
  for (const [index, a] of sorted.entries())
    for (const b of sorted.slice(index + 1)) {
      if ((b.cueFrame - a.cueFrame) / input.fps > 2 * MASKING_RULE.windowSec) break;
      const shared = intersect(
        dominantBands(windows.get(a.id)!, (frame) => frame.sfx),
        dominantBands(windows.get(b.id)!, (frame) => frame.sfx),
      );
      if (!shared.length) continue;
      const layered = a.cueFrame === b.cueFrame;
      collisions.push({
        kind: "sfx-sfx",
        ids: [a.id, b.id],
        atSec: round(a.cueFrame / input.fps, 3),
        bandsHz: shared.map(bandCentreHz),
        ...(layered ? { layered } : {}),
        suggestion: layered
          ? "Layered on one cue: fine if both were asked for; otherwise high-pass one or drop the support sound."
          : "Two sounds in the same band within 200 ms read as one smeared hit: move one by 2+ frames, filter one, or drop the support sound.",
      });
    }
  if (input.vo)
    for (const event of input.events) {
      const window = windows.get(event.id)!;
      const consonants = window.filter((frame) => {
        const total = sumDb(...frame.vo);
        if (total < MASKING_RULE.speechThresholdDb) return false;
        const high = sumDb(...[...frame.vo].filter((_, band) => bandCentreHz(band) >= MASKING_RULE.consonantFromHz));
        return 10 ** ((high - total) / 10) >= MASKING_RULE.consonantShare;
      });
      if (!consonants.length) continue;
      const bands = dominantBands(window, (frame) => frame.sfx).filter(
        (band) => bandCentreHz(band) >= MASKING_RULE.consonantFromHz,
      );
      if (!bands.length) continue;
      collisions.push({
        kind: "sfx-vo-consonant",
        ids: [event.id],
        atSec: round(consonants[0]!.sec, 3),
        bandsHz: bands.map(bandCentreHz),
        suggestion:
          "A bright SFX on a consonant blurs the word: shift it 1–2 frames into the vowel, or low-pass it at 3 kHz.",
      });
    }

  const count = (status: CueAudibility["status"]) => cues.filter((cue) => cue.status === status).length;
  const margins = cues.filter((cue) => cue.status !== "silent").map((cue) => cue.marginDb);
  return {
    schemaVersion: 1,
    rule: MASKING_RULE,
    fps: input.fps,
    inputs: {
      ...(input.assumption ?? {
        from: "flags",
        musicGain: input.musicGain ?? 1,
        musicStartSec: input.musicStartSec ?? 0,
        voGain: input.vo ? (input.voGain ?? 1) : null,
      }),
      speechDuckDb: input.speechDuckDb ?? MASKING_RULE.speechDuckDb,
    },
    cues,
    collisions,
    summary: {
      cues: cues.length,
      audible: count("audible"),
      marginal: count("marginal"),
      masked: count("masked"),
      silent: count("silent"),
      collisions: collisions.length,
      worstMarginDb: margins.length ? Math.min(...margins) : null,
    },
  };
}

const intersect = (a: number[], b: number[]) => a.filter((value) => b.includes(value));

/** A track's volume at a film second, as audio:mix's volume() evaluates it: ramps between keyframes from (0, volume), then the last value. */
export function volumeAt(
  track: { volume: number; keyframes?: { atSec: number; volume: number }[] },
  sec: number,
): number {
  const keyframes = track.keyframes ?? [];
  if (!keyframes.length) return track.volume;
  const after = keyframes.findIndex((frame) => frame.atSec >= sec);
  if (after === -1) return keyframes.at(-1)!.volume;
  const next = keyframes[after]!;
  const previous = keyframes[after - 1] ?? { atSec: 0, volume: track.volume };
  return next.atSec === previous.atSec
    ? next.volume
    : previous.volume + ((sec - previous.atSec) * (next.volume - previous.volume)) / (next.atSec - previous.atSec);
}

export type DuckWindow = { fromSec: number; toSec: number; db: number };

/**
 * Duck windows as absolute music keyframes for audio:mix: 50 ms down before each window, 150 ms back up after,
 * overlapping windows merged at the deeper duck, multiplied into the track's own keyframes.
 */
export function duckKeyframes(
  ducks: DuckWindow[],
  base: { volume: number; keyframes?: TaggedKeyframe[] },
  attackSec = 0.05,
  releaseSec = 0.15,
): TaggedKeyframe[] {
  const merged: DuckWindow[] = [];
  for (const duck of [...ducks].sort((a, b) => a.fromSec - b.fromSec)) {
    const last = merged.at(-1);
    if (last && duck.fromSec - attackSec <= last.toSec + releaseSec) {
      last.toSec = Math.max(last.toSec, duck.toSec);
      last.db = Math.min(last.db, duck.db);
    } else merged.push({ ...duck });
  }
  const existing = base.keyframes ?? [];
  const levelAt = (sec: number) => volumeAt(base, sec);
  const factorAt = (sec: number) => {
    for (const duck of merged) {
      const depth = 10 ** (duck.db / 20);
      if (sec >= duck.fromSec && sec <= duck.toSec) return depth;
      if (sec > duck.fromSec - attackSec && sec < duck.fromSec)
        return 1 + ((depth - 1) * (sec - (duck.fromSec - attackSec))) / attackSec;
      if (sec > duck.toSec && sec < duck.toSec + releaseSec)
        return depth + ((1 - depth) * (sec - duck.toSec)) / releaseSec;
    }
    return 1;
  };
  const times = new Set<number>(existing.map((frame) => frame.atSec));
  for (const duck of merged)
    for (const sec of [duck.fromSec - attackSec, duck.fromSec, duck.toSec, duck.toSec + releaseSec])
      times.add(Math.max(0, sec));
  return [...times]
    .map((sec) => Math.round(sec * 1000) / 1000)
    .sort((a, b) => a - b)
    .filter((sec, index, all) => index === 0 || sec > all[index - 1]!)
    .map((atSec) => {
      const own = existing.find((frame) => Math.abs(frame.atSec - atSec) < 5e-4);
      const factor = factorAt(atSec);
      if (own && factor === 1) return own;
      const volume = Math.round(Math.min(1, levelAt(atSec) * factor) * 10000) / 10000;
      return own
        ? { atSec, volume, source: FIX_MASKING, baseVolume: own.volume }
        : { atSec, volume, source: FIX_MASKING };
    });
}

export const FIX_MASKING = "fix-masking" as const;
export type TaggedKeyframe = { atSec: number; volume: number; source?: typeof FIX_MASKING; baseVolume?: number };

/** Undoes an earlier fix-masking run: drops the keyframes it added and restores the track's own keyframes it scaled. */
export function stripFixMasking<T extends TaggedKeyframe>(keyframes: T[] = []): TaggedKeyframe[] {
  return keyframes.flatMap((frame) => {
    if (frame.source !== FIX_MASKING) return [frame];
    if (frame.baseVolume === undefined) return [];
    const { source: _source, baseVolume, ...rest } = frame;
    return [{ ...rest, volume: baseVolume }];
  });
}

/** Applies the safe fixes: gains on the events, and the duck windows for the music. */
export function safeFixes<T extends MaskingEvent>(
  events: T[],
  report: MaskingReport,
): { events: T[]; ducks: DuckWindow[]; changed: string[] } {
  const changed: string[] = [];
  const ducks: DuckWindow[] = [];
  const byId = new Map(report.cues.map((cue) => [cue.id, cue]));
  const next = events.map((event) => {
    const cue = byId.get(event.id);
    const gain = cue?.fixes.find((fix) => fix.type === "gain");
    for (const fix of cue?.fixes ?? [])
      if (fix.type === "duck") ducks.push({ fromSec: fix.fromSec, toSec: fix.toSec, db: fix.db });
    if (!gain) return event;
    changed.push(`${event.id}: gain ${gain.fromGain} → ${gain.toGain}`);
    return { ...event, gain: gain.toGain };
  });
  for (const duck of ducks) changed.push(`music ducked ${duck.db} dB ${duck.fromSec}–${duck.toSec} s`);
  return { events: next, ducks, changed };
}

/** Reads the music argument: an audio file, or an audio map whose `source.path` still exists. */
export function resolveMusic(
  arg: string,
  exists: (file: string) => boolean,
  readJson: (file: string) => unknown,
): string {
  if (!arg.endsWith(".json")) return arg;
  const source = (readJson(arg) as { source?: { path?: string } }).source?.path;
  if (!source) throw new Error(`${arg} has no source.path: pass the music file itself.`);
  if (!exists(source))
    throw new Error(`The map's source ${source} is missing: pass the music file itself with --music.`);
  return source;
}
