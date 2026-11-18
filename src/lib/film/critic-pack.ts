import { boundAudioReview, type SoundReview } from "../audio/review-evidence";
import { sfxDensityComparison } from "../audio/sfx-map";
import { SfxMapSchema } from "../../types/sfx-map";
import { attachVideoReview } from "../vision/review-adapters";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { emitProgress } from "../cli";
import { BACKGROUND, RgbImage } from "../vision/image";
import { decodeFrame, probeVideo, renderWaveform, writeImage, type VideoInfo } from "../vision/media";
import {
  buildReviewSheet,
  buildStrip,
  composeGrid,
  formatTimecode,
  MAX_TILES,
  resolveTileWidth,
  tileSize,
  type Cell,
} from "../vision/sheets";
import type { AudioMap, CueSheet } from "../../types/film";
import type { MixPlanLike, SoundSheet } from "../audio/masking-files";
import { syncMapForRender } from "../audio/syncmap-files";
import type { FilmEvidence } from "./evidence";
import { gridFromMap, readCues, readSections, readStills, readSync, STILL_CHANGED_SHARE } from "./readings";
import { round } from "./stats";

// Everything a fresh critic needs to judge a film. Pixels and numbers only: nothing here says what the film was trying to do.

const SHEET_INTERVAL_SEC = 0.2;
const WINDOW_AROUND_SEC = 0.3;
const CHART_WIDTH = 1800;
const CURVE_HEIGHT = 300;
const WAVE_HEIGHT = 200;
const LABEL_BAND = 24;
const CUT: [number, number, number] = [239, 68, 68];
const CUE: [number, number, number] = [96, 165, 250];
const FROZEN: [number, number, number] = [64, 48, 16];
const LINE: [number, number, number] = [110, 231, 183];
const MUTED: [number, number, number] = [150, 150, 150];
const PHONE_FRAMES = 10;
const SIDE_BY_SIDE_FRAMES = 24;
const CLIP_SEC = 1.6;
const MAX_CLIPS = 12;

const name = (seconds: number) => seconds.toFixed(2).padStart(6, "0");

/** Windows around each time, merged where they overlap and split where one sheet could not hold them. */
export function windowsAround(
  times: number[],
  durationSec: number,
  fps: number,
  aroundSec = WINDOW_AROUND_SEC,
  maxFrames = MAX_TILES,
): { startSec: number; endSec: number }[] {
  const merged: { startSec: number; endSec: number }[] = [];
  for (const time of [...times].sort((a, b) => a - b)) {
    const startSec = Math.max(0, time - aroundSec);
    const endSec = Math.min(durationSec, time + aroundSec);
    const last = merged.at(-1);
    if (last && startSec <= last.endSec) last.endSec = Math.max(last.endSec, endSec);
    else if (endSec > startSec) merged.push({ startSec, endSec });
  }
  const limit = (maxFrames - 1) / fps;
  return merged.flatMap((span) => {
    const parts: { startSec: number; endSec: number }[] = [];
    for (let start = span.startSec; start < span.endSec - 1e-6; start += limit)
      parts.push({ startSec: round(start), endSec: round(Math.min(span.endSec, start + limit)) });
    return parts;
  });
}

function timelineSheets(render: string, info: VideoInfo, directory: string): string[] {
  const step = Math.max(1, Math.round(info.fps * SHEET_INTERVAL_SEC));
  const vertical = info.height > info.width;
  const span = (MAX_TILES * step) / info.fps;
  const outputs: string[] = [];
  for (let start = 0, index = 1; start < info.durationSec - 1e-6; start += span, index++) {
    const { image } = buildStrip(render, info, {
      startSec: start,
      endSec: Math.min(info.durationSec, start + span),
      step,
      columns: vertical ? 15 : 10,
      width: vertical ? 124 : 186,
    });
    outputs.push(writeImage(image, path.join(directory, `sheets/sheet-${String(index).padStart(2, "0")}.jpg`)));
  }
  return outputs;
}

function windowStrips(render: string, info: VideoInfo, times: number[], directory: string): string[] {
  // With --diff each frame takes two tiles, so a window holds half as many frames.
  return windowsAround(times, info.durationSec, info.fps, WINDOW_AROUND_SEC, Math.floor((MAX_TILES + 1) / 2)).map(
    (span) => {
      const { image } = buildStrip(render, info, {
        ...span,
        diff: true,
        columns: 10,
        width: info.height > info.width ? 124 : 186,
      });
      return writeImage(image, path.join(directory, `transitions/at-${name(span.startSec)}.jpg`));
    },
  );
}

/** Short clips around cuts, so motion, easing and sync can be watched or stripped, not only seen as stills. */
function cutClips(render: string, info: VideoInfo, cuts: number[], directory: string): string[] {
  mkdirSync(path.join(directory, "clips"), { recursive: true });
  return cuts.slice(0, MAX_CLIPS).flatMap((cut) => {
    const start = Math.max(0, Math.min(info.durationSec - CLIP_SEC, cut - CLIP_SEC / 2));
    const output = path.join(directory, `clips/cut-${name(cut)}.mp4`);
    const result = spawnSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      start.toFixed(3),
      "-i",
      render,
      "-t",
      String(CLIP_SEC),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      ...(info.hasAudio ? ["-c:a", "aac"] : ["-an"]),
      output,
    ]);
    return result.status === 0 ? [output] : [];
  });
}

function markTimes(
  chart: RgbImage,
  top: number,
  height: number,
  info: VideoInfo,
  times: number[],
  colour: [number, number, number],
) {
  for (const time of times)
    chart.fillRect(
      Math.min(chart.width - 2, Math.round((time / info.durationSec) * (chart.width - 1))),
      top,
      2,
      height,
      colour,
    );
}

function rulerLabels(chart: RgbImage, y: number, info: VideoInfo) {
  const interval = [1, 2, 5, 10, 15, 30, 60, 120].find((candidate) => info.durationSec / candidate <= 12) ?? 300;
  for (let seconds = 0; seconds <= info.durationSec; seconds += interval) {
    const x = Math.round((seconds / info.durationSec) * (chart.width - 1));
    if (x + 80 < chart.width) chart.drawText(formatTimecode(seconds).slice(0, 5), x + 3, y, 2, MUTED);
  }
}

/** Share of pixels changing per sample, on a square-root scale so small movement stays visible. Tinted spans are frozen. */
export function frameDifferenceCurve(evidence: FilmEvidence, info: VideoInfo, cues: number[]): RgbImage {
  const chart = RgbImage.filled(CHART_WIDTH, CURVE_HEIGHT + LABEL_BAND * 2, BACKGROUND);
  const top = LABEL_BAND;
  chart.drawText(
    `CHANGED PIXELS PER 0.1 S (SQRT). RED CUTS, BLUE CUES, TINT FROZEN UNDER ${STILL_CHANGED_SHARE * 100}%`,
    6,
    4,
    2,
    MUTED,
  );
  const xOf = (time: number) => Math.min(CHART_WIDTH - 1, Math.round((time / info.durationSec) * (CHART_WIDTH - 1)));
  for (const span of readStills(evidence.motion, info.durationSec).spans)
    chart.fillRect(xOf(span.startSec), top, Math.max(1, xOf(span.endSec) - xOf(span.startSec)), CURVE_HEIGHT, FROZEN);
  markTimes(chart, top, CURVE_HEIGHT, info, cues, CUE);
  markTimes(
    chart,
    top,
    CURVE_HEIGHT,
    info,
    evidence.boundaries.map((row) => row.timeSec),
    CUT,
  );
  let previous: { x: number; y: number } | undefined;
  for (const row of evidence.motion) {
    const x = xOf(row.timeSec);
    const y = top + CURVE_HEIGHT - 1 - Math.round(Math.sqrt(row.changed) * (CURVE_HEIGHT - 1));
    if (previous)
      chart.fillRect(
        previous.x,
        Math.min(previous.y, y),
        Math.max(1, x - previous.x),
        Math.max(2, Math.abs(previous.y - y)),
        LINE,
      );
    previous = { x, y };
  }
  rulerLabels(chart, top + CURVE_HEIGHT + 4, info);
  return chart;
}

export function waveformWithCuts(render: string, evidence: FilmEvidence, info: VideoInfo, cues: number[]): RgbImage {
  const chart = RgbImage.filled(CHART_WIDTH, WAVE_HEIGHT + LABEL_BAND * 2, BACKGROUND);
  chart.drawText("WAVEFORM. RED CUTS, BLUE CUES", 6, 4, 2, MUTED);
  if (info.hasAudio) chart.blit(renderWaveform(render, info.durationSec, CHART_WIDTH, WAVE_HEIGHT), 0, LABEL_BAND);
  else {
    chart.fillRect(0, LABEL_BAND, CHART_WIDTH, WAVE_HEIGHT, [0, 0, 0]);
    chart.drawText("NO AUDIO STREAM", 12, LABEL_BAND + 12, 3, CUT);
  }
  markTimes(chart, LABEL_BAND, WAVE_HEIGHT, info, cues, CUE);
  markTimes(
    chart,
    LABEL_BAND,
    WAVE_HEIGHT,
    info,
    evidence.boundaries.map((row) => row.timeSec),
    CUT,
  );
  rulerLabels(chart, LABEL_BAND + WAVE_HEIGHT + 4, info);
  return chart;
}

export function loudnessTable(evidence: FilmEvidence): string {
  const audio = evidence.audio;
  if (!audio) return "no audio stream\n";
  const lines = [
    `integrated_lufs\t${audio.integratedLufs ?? "silent"}`,
    `loudness_range_lu\t${audio.loudnessRangeLu ?? ""}`,
    `true_peak_dbfs\t${audio.truePeakDb ?? ""}`,
    "",
    "section_start_sec\tsection_end_sec\tlufs",
  ];
  for (const section of readSections(audio, evidence.video.durationSec))
    lines.push(`${section.startSec}\t${section.endSec}\t${section.lufs ?? "silent"}`);
  lines.push("", "silence_start_sec\tsilence_end_sec");
  for (const span of audio.silences) lines.push(`${span.startSec}\t${span.endSec}`);
  lines.push("", "second\tmomentary_lufs");
  for (const row of audio.perSecond) lines.push(`${row.timeSec}\t${row.lufs ?? "silent"}`);
  return `${lines.join("\n")}\n`;
}

/** Fits a video into a tile without stretching it, so films of different shapes can sit together. */
function fittedFrame(input: string, info: VideoInfo, timeSec: number, width: number, height: number): RgbImage {
  const frame = Math.min(info.frameCount - 1, Math.floor(timeSec * info.fps));
  const scale = Math.min(width / info.width, height / info.height);
  const inner = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  const { image } = decodeFrame(input, info, frame, inner(info.width), inner(info.height));
  const tile = RgbImage.filled(width, height, [0, 0, 0]);
  tile.blit(image, Math.floor((width - image.width) / 2), Math.floor((height - image.height) / 2));
  return tile;
}

/** Pairs of times to set side by side: the i-th downbeat of each film when both have them, else matching shares of the shorter. */
export function matchingTimes(
  filmSec: number,
  referenceSec: number,
  filmDownbeats: number[] = [],
  referenceDownbeats: number[] = [],
  count = SIDE_BY_SIDE_FRAMES,
): { film: number; reference: number; label: string }[] {
  const film = filmDownbeats.filter((time) => time >= 0 && time < filmSec);
  const reference = referenceDownbeats.filter((time) => time >= 0 && time < referenceSec);
  const pairs = Math.min(film.length, reference.length);
  if (pairs >= 2) {
    const picks = [
      ...new Set(
        Array.from({ length: Math.min(count, pairs) }, (_, index) =>
          Math.round((index * (pairs - 1)) / Math.max(1, Math.min(count, pairs) - 1)),
        ),
      ),
    ];
    return picks.map((index) => ({ film: film[index]!, reference: reference[index]!, label: `DOWNBEAT ${index + 1}` }));
  }
  const shared = Math.min(filmSec, referenceSec);
  return Array.from({ length: count }, (_, index) => {
    const timeSec = ((index + 0.5) * shared) / count;
    return { film: timeSec, reference: timeSec, label: "" };
  });
}

export function sideBySideSheet(
  render: string,
  info: VideoInfo,
  reference: string,
  beats: { film?: number[]; reference?: number[] } = {},
  count = SIDE_BY_SIDE_FRAMES,
): RgbImage {
  const other = probeVideo(reference);
  const { width, height } = tileSize(info, info.height > info.width ? 180 : 300);
  const pairs = matchingTimes(info.durationSec, other.durationSec, beats.film, beats.reference, count);
  const onBeats = pairs.some((pair) => pair.label);
  const cells: Cell[] = pairs.flatMap((pair) => [
    {
      image: fittedFrame(render, info, pair.film, width, height),
      label: `FILM ${pair.label ? `${pair.label} ` : ""}${formatTimecode(pair.film)}`,
    },
    {
      image: fittedFrame(reference, other, pair.reference, width, height),
      label: `REF ${pair.label ? `${pair.label} ` : ""}${formatTimecode(pair.reference)}`,
    },
  ]);
  return composeGrid(cells, {
    title: onBeats ? "FILM AND REFERENCE ON MATCHING DOWNBEATS" : "FILM AND REFERENCE AT MATCHING TIMES",
    columns: info.height > info.width ? 10 : 6,
    groupSize: 2,
  });
}

/** A reference's library folder, from its media path (`<library>/<id>/media/source.mp4`), when it is one. */
export function referenceDirOf(reference: string): string | undefined {
  const directory = path.dirname(path.dirname(path.resolve(reference)));
  return existsSync(path.join(directory, "source.json")) || existsSync(path.join(directory, "audio.json"))
    ? directory
    : undefined;
}

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

type Tempo = { tempo?: { downbeatsSec?: number[]; beatsSec?: number[] } };

/** The mixed master's loudness and duck depth from audio:mix's result, sync v2 of this film, and the reference's own sync. */
export function soundMeasures(options: {
  cuts: number[];
  durationSec: number;
  fps: number;
  audioMap?: AudioMap;
  musicOffsetSec?: number;
  mixReport?: string;
  referenceDir?: string;
}) {
  const mix = options.mixReport ? readJson(options.mixReport) : undefined;
  const metadata = (mix?.["metadata"] ?? {}) as {
    analysis?: Record<string, unknown>;
    duck?: unknown;
    warnings?: unknown;
  };
  const analysis = metadata.analysis;
  const referenceSync = options.referenceDir ? readJson(path.join(options.referenceDir, "sync.json")) : undefined;
  return {
    note: "Lifts are ratio / chance: 1 is what random cuts score. Downbeats are judged within one frame; a negative signed median means cuts lead the beat.",
    ...(analysis
      ? {
          mix: {
            source: path.resolve(options.mixReport!),
            integratedLufs: analysis["integratedLufs"] ?? null,
            truePeakDb: analysis["truePeakDb"] ?? null,
            loudnessRangeLu: analysis["loudnessRangeLu"] ?? null,
          },
        }
      : {}),
    ...(analysis ? { duck: metadata.duck ?? null } : {}),
    ...(options.audioMap
      ? {
          sync: {
            gridTrust: options.audioMap.tempo.gridTrust,
            cuts: options.cuts.length,
            ...readSync(
              options.cuts,
              gridFromMap(options.audioMap, options.musicOffsetSec ?? 0),
              options.durationSec,
              options.fps,
            ),
          },
        }
      : {}),
    ...(referenceSync?.["metrics"] ? { referenceSync: referenceSync["metrics"] } : {}),
  };
}

/** What sound.json says about the sync map: the counts, then only the events a critic should look at. */
export function syncmapSection(result: ReturnType<typeof syncMapForRender>) {
  const { sync, masking } = result;
  return {
    image: result.image,
    json: result.json,
    rule: sync.rule,
    gridTrust: sync.gridTrust,
    ...sync.summary,
    verdictWeight: sync.verdictWeight,
    moves: sync.moves.map((move) => move.frame),
    ...(sync.gridNote ? { gridNote: sync.gridNote } : {}),
    // Only verdicts escalate. On a weak grid those are anchor misses; beat offsets are listed apart as information.
    offCuts: sync.cuts
      .filter((cut) => cut.verdict === "miss")
      .map((cut) => ({
        timeSec: cut.timeSec,
        frame: cut.frame,
        source: cut.source,
        ...(cut.anchor
          ? { against: cut.anchor.kind, errorFrames: cut.anchor.errorFrames }
          : {
              against: cut.status === "missed-downbeat" ? "downbeat" : "beat",
              errorFrames: cut.status === "missed-downbeat" ? cut.downbeatErrorFrames : cut.errorFrames,
            }),
        structural: cut.structural,
      })),
    ...(sync.verdictWeight === "low"
      ? {
          beatOffsetsAdvisory: sync.cuts
            .filter((cut) => cut.status === "off-beat")
            .map((cut) => ({ timeSec: cut.timeSec, frame: cut.frame, errorFrames: cut.errorFrames })),
        }
      : {}),
    ...(masking
      ? {
          masking: { ...masking.summary, assumed: masking.inputs },
          maskedSfx: masking.cues
            .filter((cue) => cue.status === "masked" || cue.status === "marginal")
            .map((cue) => ({
              id: cue.id,
              cueSec: cue.cueSec,
              status: cue.status,
              marginDb: cue.marginDb,
              masker: cue.masker,
              fixes: cue.fixes.map((fix) => fix.type),
            })),
          collisions: masking.collisions,
        }
      : {}),
  };
}

export type CriticPack = {
  reviewPack?: string;
  reviewWarnings?: string[];
  schemaVersion: 1;
  render: string;
  renderSha256: string;
  durationSec: number;
  sheets: string[];
  transitions: string[];
  clips: string[];
  frameDifferenceCurve: string;
  waveform: string;
  loudness: string;
  phoneSheet: string;
  numbers: string;
  sideBySide?: string;
  /** Mixed loudness, duck depth and sync v2, beside the reference's sync; `syncmap` holds the sync map's summary. */
  sound?: string;
  /** Cuts against beats and downbeats, placed SFX and masking, over the final mix (audio:syncmap). */
  syncmap?: string;
  /** The reference's own spec of the stretch our film answers, when its analyst wrote one. */
  pilotSpec?: string;
  audioReview?: string;
  /** Every saved Earshot audit of the render's or a placed sound's exact bytes (advisory). */
  audioReviews?: string;
  previousCritique?: string;
  readingOrder: string[];
};

export function buildCriticPack(options: {
  render: string;
  evidence: FilmEvidence;
  directory: string;
  cueSheet?: CueSheet;
  reference?: string;
  referenceDir?: string;
  audioMap?: AudioMap;
  mixReport?: string;
  previousCritique?: string;
  soundCues?: SoundSheet;
  music?: string;
  mixPlan?: MixPlanLike;
  mixPlanPath?: string;
  audioReview?: string;
  /** Saved audits by file (readSoundReviews); only those with a review are written. */
  audioReviews?: SoundReview[];
}): CriticPack {
  const { render, evidence, directory, cueSheet, reference, audioMap, mixReport, previousCritique, soundCues } =
    options;
  const audioReview = options.audioReview ? path.join(directory, "audio-review.json") : undefined;
  const audioEvidence = options.audioReview
    ? boundAudioReview(options.audioReview, [
        render,
        ...(soundCues?.events ?? []).map((event) => path.resolve("public", event.file)),
      ])
    : undefined;
  const referenceDir = options.referenceDir ?? (reference ? referenceDirOf(reference) : undefined);
  mkdirSync(directory, { recursive: true });
  if (audioReview) writeFileSync(audioReview, `${JSON.stringify(audioEvidence, null, 2)}\n`);
  const reviewed = (options.audioReviews ?? []).filter((row) => row.review);
  const audioReviews = reviewed.length ? path.join(directory, "audio-reviews.json") : undefined;
  if (audioReviews)
    writeFileSync(
      audioReviews,
      `${JSON.stringify(
        {
          engine: "earshot",
          advisory: true,
          notice:
            "Saved model-free audits of these exact bytes. Advisory and uncalibrated; agents cannot hear. Judge the film, not the score.",
          files: reviewed.map((row) => ({
            file: row.file,
            sha256: row.sha256,
            ok: row.review!.ok,
            warnings: row.review!.warnings,
            notes: row.review!.notes,
          })),
          unaudited: (options.audioReviews ?? []).filter((row) => !row.review).map((row) => row.file),
        },
        null,
        2,
      )}\n`,
    );
  const info = probeVideo(render);
  const cues = (cueSheet?.cues ?? []).map((cue) => round(cue.frame / cueSheet!.fps));
  const cuts = evidence.boundaries.map((row) => row.timeSec);

  emitProgress("Drawing sheets every 0.2 s");
  const sheets = timelineSheets(render, info, directory);
  emitProgress("Drawing frames around cuts and cues");
  const transitions = windowStrips(render, info, [...cuts, ...cues], directory);
  emitProgress("Cutting clips around cuts");
  const clips = cutClips(render, info, cuts, directory);
  emitProgress("Drawing curves, table and phone sheet");
  const curve = writeImage(frameDifferenceCurve(evidence, info, cues), path.join(directory, "frame-difference.png"));
  const waveform = writeImage(
    waveformWithCuts(render, evidence, info, cues),
    path.join(directory, "waveform-cuts.png"),
  );
  const loudness = path.join(directory, "loudness.tsv");
  writeFileSync(loudness, loudnessTable(evidence));
  const { image: phone } = buildReviewSheet(render, info, {
    count: PHONE_FRAMES,
    columns: 5,
    width: resolveTileWidth(true, undefined),
    marks: cuts,
  });
  const phoneSheet = writeImage(phone, path.join(directory, "phone-sheet.jpg"));
  const numbers = path.join(directory, "numbers.json");
  writeFileSync(
    numbers,
    `${JSON.stringify({ video: evidence.video, cutsSec: cuts.map((cut) => round(cut, 2)), cuesSec: cues, frozenSpans: readStills(evidence.motion, info.durationSec).spans }, null, 2)}\n`,
  );
  const offset = cueSheet?.musicOffsetSec ?? 0;
  const filmDownbeats = audioMap ? gridFromMap(audioMap, offset).downbeatsSec : undefined;
  const referenceDownbeats = referenceDir
    ? (readJson(path.join(referenceDir, "audio.json")) as Tempo | undefined)?.tempo?.downbeatsSec
    : undefined;
  const sideBySide = reference
    ? writeImage(
        sideBySideSheet(render, info, reference, { film: filmDownbeats, reference: referenceDownbeats }),
        path.join(directory, "side-by-side.jpg"),
      )
    : undefined;
  const syncCuts =
    cueSheet && cueSheet.cues.some((cue) => cue.kind === "cut" || cue.kind === "transition")
      ? readCues(evidence, cueSheet).confirmedTimes
      : cuts;
  let syncmap: ReturnType<typeof syncMapForRender> | undefined;
  if (audioMap || soundCues) {
    emitProgress("Drawing the sync map");
    syncmap = syncMapForRender({
      render,
      info,
      evidence,
      map: audioMap,
      musicOffsetSec: offset,
      sheet: soundCues,
      cueSheet,
      music: options.music,
      plan: options.mixPlan,
      planPath: options.mixPlanPath,
      output: path.join(directory, "syncmap.json"),
      image: path.join(directory, "syncmap.png"),
    });
    writeFileSync(
      syncmap.json,
      `${JSON.stringify(syncmap.masking ? { ...syncmap.sync, masking: syncmap.masking } : syncmap.sync, null, 2)}\n`,
    );
  }
  const sound = audioMap || mixReport || referenceDir || syncmap ? path.join(directory, "sound.json") : undefined;
  // The reference's sound map (sfx:map), when its analyst made one, beside the sounds this film placed.
  const referenceSfx = referenceDir
    ? SfxMapSchema.safeParse(readJson(path.join(referenceDir, "sfx-map.json")))
    : undefined;
  const sfxDensity =
    referenceSfx?.success && soundCues
      ? sfxDensityComparison(
          referenceSfx.data,
          soundCues.events as { sfx: string; layerOf?: string }[],
          info.durationSec,
        )
      : undefined;
  if (sound)
    writeFileSync(
      sound,
      `${JSON.stringify({ ...soundMeasures({ cuts: syncCuts, durationSec: info.durationSec, fps: info.fps, audioMap, musicOffsetSec: offset, mixReport, referenceDir }), ...(syncmap ? { syncmap: syncmapSection(syncmap) } : {}), ...(sfxDensity ? { sfxDensity } : {}) }, null, 2)}\n`,
    );
  const spec = referenceDir ? path.join(referenceDir, "pilot-spec.md") : undefined;
  const pilotSpec = spec && existsSync(spec) ? spec : undefined;

  const review = attachVideoReview(
    render,
    directory,
    [...cuts, ...cues].map((time) => ({
      frame: Math.min(info.frameCount - 1, Math.round(time * info.fps)),
      reasons: ["cut or cue"],
      basis: "declared",
    })),
    { profile: "motion" },
  );
  return {
    reviewPack: review.reviewPack,
    reviewWarnings: review.reviewWarnings,
    schemaVersion: 1,
    render: path.resolve(render),
    renderSha256: evidence.sha256,
    durationSec: evidence.video.durationSec,
    sheets,
    transitions,
    clips,
    frameDifferenceCurve: curve,
    waveform,
    loudness,
    phoneSheet,
    numbers,
    ...(sideBySide ? { sideBySide } : {}),
    ...(sound ? { sound } : {}),
    ...(syncmap ? { syncmap: syncmap.image } : {}),
    ...(pilotSpec ? { pilotSpec } : {}),
    ...(audioReview ? { audioReview } : {}),
    ...(audioReviews ? { audioReviews } : {}),
    ...(previousCritique ? { previousCritique: path.resolve(previousCritique) } : {}),
    // The previous critique comes last, so the critic forms a view before reading what was said last round.
    readingOrder: [
      ...(review.outputs.length ? review.outputs : sheets),
      phoneSheet,
      curve,
      waveform,
      ...(syncmap ? [syncmap.image] : []),
      loudness,
      ...(sound ? [sound] : []),
      ...(audioReview ? [audioReview] : []),
      ...(audioReviews ? [audioReviews] : []),
      numbers,
      ...transitions,
      ...clips,
      ...(sideBySide ? [sideBySide] : []),
      ...(pilotSpec ? [pilotSpec] : []),
      ...(previousCritique ? [path.resolve(previousCritique)] : []),
    ],
  };
}
