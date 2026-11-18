import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { LocalAudioMixSchema } from "../../types/audio-master";
import { assessMasking, resolveMusic, volumeAt, type MaskingEvent, type MaskingReport } from "./masking";
import { decodeMono, SPECTRUM_RATE } from "./spectrum";

export type SoundSheet = {
  fps: number;
  durationInFrames?: number;
  events: (MaskingEvent & { durationInFrames: number })[];
};

export function readSoundSheet(file: string): SoundSheet {
  const sheet = JSON.parse(readFileSync(file, "utf8")) as Partial<SoundSheet>;
  if (typeof sheet.fps !== "number" || !Array.isArray(sheet.events))
    throw new Error(`${file} is not a sound cue sheet (sfx:cues output with fps and events).`);
  return sheet as SoundSheet;
}

/** A mix plan track, as LocalAudioMixSchema parses it (defaults filled). */
export type PlanTrack = {
  source: string;
  role: "speech" | "music" | "sfx";
  startSec: number;
  sourceStartSec: number;
  sourceEndSec?: number;
  rate: number;
  volume: number;
  keyframes: { atSec: number; volume: number }[];
  loop: boolean;
};
export type MixPlanLike = { durationSec: number; duckMusic?: boolean; duckDb?: number; tracks: PlanTrack[] };

/**
 * Tracks summed on the film timeline at their plan volume and keyframes, as audio:mix places them (rate 1; a looped
 * track repeats its interval). Sources resolve against `root`, like audio:mix's working directory.
 */
export function timelineSignal(
  tracks: PlanTrack[],
  durationSec: number,
  decode: (file: string) => Float32Array,
  root = process.cwd(),
): { signal: Float32Array; notes: string[] } {
  const signal = new Float32Array(Math.ceil(durationSec * SPECTRUM_RATE));
  const notes: string[] = [];
  for (const track of tracks) {
    if (track.rate !== 1) notes.push(`${track.source}: rate ${track.rate} read as 1`);
    const source = decode(path.resolve(root, track.source));
    const from = Math.round(track.sourceStartSec * SPECTRUM_RATE);
    const to = Math.min(
      source.length,
      track.sourceEndSec === undefined ? source.length : Math.round(track.sourceEndSec * SPECTRUM_RATE),
    );
    const length = to - from;
    if (length <= 0) continue;
    const start = Math.round(track.startSec * SPECTRUM_RATE);
    for (let index = start; index < signal.length; index++) {
      const offset = index - start;
      if (!track.loop && offset >= length) break;
      signal[index]! += source[from + (offset % length)]! * volumeAt(track, index / SPECTRUM_RATE);
    }
  }
  return { signal, notes };
}

/** Reads a mix plan for the masking model; undefined when the file is missing or not a plan. */
export function readMixPlan(file: string | undefined): MixPlanLike | undefined {
  if (!file || !existsSync(file)) return undefined;
  const parsed = LocalAudioMixSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  return parsed.success ? (parsed.data as MixPlanLike) : undefined;
}

/**
 * Decodes the sheet's sounds (each file once), the music and the voice, and runs the model. Levels come from the
 * mix plan when given (music and speech tracks with startSec, volume, keyframes and duckDb), then from the flags,
 * then music at 1 with no voice. A plan without a music track takes the music from `music`.
 */
export function maskingFromFiles(options: {
  cues: string | SoundSheet;
  music?: string;
  vo?: string;
  musicGain?: number;
  musicStartSec?: number;
  voGain?: number;
  publicDir?: string;
  plan?: MixPlanLike;
  planPath?: string;
  root?: string;
}): MaskingReport {
  const sheet = typeof options.cues === "string" ? readSoundSheet(options.cues) : options.cues;
  const publicDir = options.publicDir ?? path.resolve("public");
  const sounds = new Map<string, Float32Array>();
  for (const event of sheet.events) {
    if (sounds.has(event.file)) continue;
    const file = path.join(publicDir, event.file);
    if (existsSync(file)) sounds.set(event.file, decodeMono(file));
  }
  const plan = options.plan;
  const musicTracks = plan?.tracks.filter((track) => track.role === "music") ?? [];
  const speechTracks = plan?.tracks.filter((track) => track.role === "speech") ?? [];
  const notes: string[] = [];
  const durationSec = Math.max(
    plan?.durationSec ?? 0,
    (sheet.durationInFrames ?? 0) / sheet.fps,
    ...sheet.events.map((event) => (event.cueFrame + 2) / sheet.fps),
  );
  let music: Float32Array | undefined;
  let musicGain: number | "plan" = options.musicGain ?? 1;
  let musicStartSec: number | "plan" = options.musicStartSec ?? 0;
  if (musicTracks.length) {
    const built = timelineSignal(musicTracks, durationSec, decodeMono, options.root);
    music = built.signal;
    notes.push(...built.notes);
    musicGain = "plan";
    musicStartSec = "plan";
  } else if (options.music) {
    music = decodeMono(resolveMusic(options.music, existsSync, (file) => JSON.parse(readFileSync(file, "utf8"))));
  } else throw new Error("No music: the plan has no music track and no --music was given.");
  let vo: Float32Array | undefined;
  let voGain: number | "plan" | null = null;
  if (speechTracks.length) {
    const built = timelineSignal(speechTracks, durationSec, decodeMono, options.root);
    vo = built.signal;
    notes.push(...built.notes);
    voGain = "plan";
  } else if (options.vo) {
    vo = decodeMono(options.vo);
    voGain = options.voGain ?? 1;
  }
  const fromPlan = musicTracks.length > 0 || speechTracks.length > 0;
  const fromFlags =
    !musicTracks.length &&
    (options.musicGain !== undefined || options.musicStartSec !== undefined || options.vo !== undefined);
  const timeline = musicGain === "plan";
  return assessMasking({
    fps: sheet.fps,
    events: sheet.events,
    sounds,
    music,
    musicGain: timeline ? 1 : (musicGain as number),
    musicStartSec: timeline ? 0 : (musicStartSec as number),
    ...(vo ? { vo, voGain: voGain === "plan" ? 1 : (voGain ?? 1) } : {}),
    ...(plan && fromPlan ? { speechDuckDb: plan.duckMusic === false ? 0 : (plan.duckDb ?? -9) } : {}),
    assumption: {
      from: fromPlan ? "plan" : fromFlags ? "flags" : "default",
      ...(options.planPath && fromPlan ? { plan: options.planPath } : {}),
      musicGain,
      musicStartSec,
      voGain,
      ...(notes.length ? { notes } : {}),
    },
  });
}
