import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AudioMapSchema, CueSheetSchema, type AudioMap, type CueSheet } from "../../types/film";
import type { FilmEvidence } from "../film/evidence";
import { renderWaveform, writeImage, type VideoInfo } from "../vision/media";
import { maskingFromFiles, readSoundSheet, type MixPlanLike, type SoundSheet } from "./masking-files";
import type { MaskingReport } from "./masking";
import { decodeMono, SPECTRUM_RATE } from "./spectrum";
import {
  buildSyncMap,
  DECLARED_CUT_KINDS,
  drawSyncMap,
  energyPerFrame,
  SYNC_IMAGE_SIZE,
  type DeclaredCut,
  type SyncMap,
} from "./syncmap";

type RawCue = { frame?: number; kind?: string; label?: string; id?: string };
const isCutKind = (kind: unknown): kind is string =>
  typeof kind === "string" && (DECLARED_CUT_KINDS as readonly string[]).includes(kind);

/**
 * Declared cuts in any cue file the chain writes, at `fps`: an edit plan (`kind: "edit-plan"`, events), a sound cue
 * sheet's `blockCues` (sfx:cues), an edit cue sheet (`cues`), placements (`blocks[].cues`) or `{cuts:[{frame}]}`.
 */
export function declaredCuts(raw: Record<string, unknown>, fps: number): DeclaredCut[] {
  const scale = (frame: number) =>
    typeof raw["fps"] === "number" && raw["fps"] !== fps ? Math.round((frame / (raw["fps"] as number)) * fps) : frame;
  const from = (cues: RawCue[], offset = 0) =>
    cues
      .filter((cue) => typeof cue.frame === "number" && isCutKind(cue.kind))
      .map((cue) => ({
        frame: scale(cue.frame! + offset),
        kind: cue.kind!,
        ...((cue.label ?? cue.id) ? { label: cue.label ?? cue.id } : {}),
      }));
  if (raw["kind"] === "edit-plan") return from((raw["events"] as RawCue[]) ?? []);
  if (Array.isArray(raw["cuts"])) return from((raw["cuts"] as RawCue[]).map((cut) => ({ kind: "cut", ...cut })));
  if (Array.isArray(raw["blockCues"])) return from(raw["blockCues"] as RawCue[]);
  if (Array.isArray(raw["blocks"]))
    return (raw["blocks"] as { startFrame?: number; cues?: RawCue[]; extraCues?: RawCue[] }[]).flatMap((block) =>
      from([...(block.cues ?? []), ...(block.extraCues ?? [])], block.startFrame ?? 0),
    );
  if (Array.isArray(raw["cues"])) return from(raw["cues"] as RawCue[]);
  return [];
}

/** A cue file: a sound cue sheet (sfx:cues: `events`), an edit cue sheet (edit:snap: `cues`), an edit plan or placements; each may declare cuts. */
export function readAnyCues(
  file: string,
  fps = 30,
): { sheet?: SoundSheet; cueSheet?: CueSheet; declared: DeclaredCut[] } {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const declared = declaredCuts(raw, fps);
  if (raw["kind"] === "edit-plan" || Array.isArray(raw["blocks"]) || Array.isArray(raw["cuts"])) return { declared };
  if (Array.isArray(raw["events"])) return { sheet: readSoundSheet(file), declared };
  if (Array.isArray(raw["cues"])) return { cueSheet: CueSheetSchema.parse(raw), declared };
  throw new Error(`${file} is not a sound cue sheet, cue sheet, edit plan or placements file.`);
}

/** Mean absolute luma difference of each frame against the one before, on a 64-pixel-wide grey copy. */
export function frameDifferences(render: string, info: VideoInfo): number[] {
  const width = 64;
  const height = Math.max(2, Math.round(((info.height / info.width) * width) / 2) * 2);
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      render,
      "-an",
      "-map",
      "0:v:0",
      "-vf",
      `scale=${width}:${height}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "pipe:1",
    ],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  if (result.status !== 0) return [];
  const bytes = result.stdout as Buffer;
  const size = width * height;
  const frames = Math.floor(bytes.length / size);
  return Array.from({ length: frames }, (_, frame) => {
    if (frame === 0) return 0;
    let sum = 0;
    for (let index = 0; index < size; index++)
      sum += Math.abs(bytes[frame * size + index]! - bytes[(frame - 1) * size + index]!);
    return Math.round((sum / size) * 100) / 100;
  });
}

export function readMapFile(file: string): AudioMap {
  return AudioMapSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/**
 * Builds the sync map JSON and PNG for a render. Masking is read when the sound sheet and a music file are known:
 * `music` first, else the map's own source when it still exists.
 */
export function syncMapForRender(options: {
  render: string;
  info: VideoInfo;
  evidence: FilmEvidence;
  map?: AudioMap;
  musicOffsetSec?: number;
  sheet?: SoundSheet;
  cueSheet?: CueSheet;
  declared?: DeclaredCut[];
  music?: string;
  masking?: MaskingReport;
  plan?: MixPlanLike;
  planPath?: string;
  output: string;
  image: string;
}): { sync: SyncMap; masking?: MaskingReport; json: string; image: string } {
  const { info, map } = options;
  const music = options.music ?? (map && existsSync(map.source.path) ? map.source.path : undefined);
  let masking = options.masking;
  const notes: string[] = [];
  const planMusic = options.plan?.tracks.some((track) => track.role === "music") ?? false;
  if (!masking && options.sheet && (music || planMusic))
    masking = maskingFromFiles({
      cues: options.sheet,
      music,
      musicStartSec: options.musicOffsetSec,
      plan: options.plan,
      planPath: options.planPath,
    });
  else if (!masking && options.sheet)
    notes.push("No music file or mix plan to read masking against: pass --music or --plan.");
  const declared = options.declared ?? [
    ...(options.sheet ? declaredCuts(options.sheet as unknown as Record<string, unknown>, info.fps) : []),
    ...(options.cueSheet ? declaredCuts(options.cueSheet as unknown as Record<string, unknown>, info.fps) : []),
  ];
  const frameDiffs = frameDifferences(options.render, info);
  const sync = buildSyncMap({
    render: options.render,
    fps: info.fps,
    durationSec: info.durationSec,
    cutsSec: options.evidence.boundaries.map((row) => row.timeSec),
    declared,
    frameDiffs,
    map,
    musicOffsetSec: options.musicOffsetSec ?? options.cueSheet?.musicOffsetSec,
    sheet: options.sheet,
    cueSheet: options.cueSheet,
    masking,
  });
  const waveform = info.hasAudio
    ? renderWaveform(options.render, info.durationSec, SYNC_IMAGE_SIZE.width, SYNC_IMAGE_SIZE.waveHeight)
    : undefined;
  const energyDb = info.hasAudio ? energyPerFrame(decodeMono(options.render), SPECTRUM_RATE, info.fps) : undefined;
  const image = writeImage(drawSyncMap(sync, { waveform, energyDb, map }), options.image);
  sync.summary.image = image;
  const withNotes = {
    ...sync,
    ...(masking ? { maskingSummary: masking.summary } : {}),
    ...(notes.length ? { notes } : {}),
  };
  const json = path.resolve(options.output);
  return { sync: withNotes, ...(masking ? { masking } : {}), json, image };
}
