import path from "node:path";
import { buildAudioMap } from "../audio-map/analyse";
import { CliErrorObject, emitProgress } from "../cli";
import { analyseSpeechAndText } from "../local-engines/speech-text";
import { probeVideo, type VideoInfo } from "../vision/media";
import {
  ReferenceSpeechTextSchema,
  type ReferenceAudio,
  type ReferenceMotion,
  type ReferenceShots,
  type ReferenceSpeechText,
  type ReferenceSync,
} from "../../types/reference";
import { sampleFilm } from "./align";
import { analyseAudio } from "./audio";
import { readAnalysisMedia, readLayer, referenceDirectory, writeLayer } from "./library";
import { shotColour } from "./look";
import { analyseMotion } from "./motion";
import { analyseShots } from "./shots";
import { readSpeechText } from "./speech-text";
import { buildSync } from "./sync";
import { buildVisuals } from "./visuals";

/** `colour` re-measures each shot's Lab on the existing shots.json without detecting shots again; `shots` measures it too. */
export const ANALYSIS_LAYERS = [
  "shots",
  "colour",
  "speech-text",
  "audio",
  "audiomap",
  "motion",
  "sync",
  "visuals",
] as const;
export type AnalysisLayer = (typeof ANALYSIS_LAYERS)[number];

type LayerReport = { available: boolean; engine?: string; reason?: string; fix?: string };
const report = (status?: {
  available: boolean;
  engine?: string;
  unavailableReason?: string;
  fix?: string;
}): LayerReport => ({
  available: status?.available ?? true,
  ...(status?.engine ? { engine: status.engine } : {}),
  ...(status?.unavailableReason ? { reason: status.unavailableReason } : {}),
  ...(status?.fix ? { fix: status.fix } : {}),
});

async function speechTextLayer(
  referenceId: string,
  media: string,
  language?: string,
  engineDir?: string,
): Promise<ReferenceSpeechText> {
  try {
    const { speech, screenText } = await analyseSpeechAndText({
      mediaFile: media,
      language,
      engineDir,
      onProgress: emitProgress,
    });
    return ReferenceSpeechTextSchema.parse({ schemaVersion: 1, referenceId, speech, screenText });
  } catch (error) {
    const unavailableReason = error instanceof Error ? error.message : String(error);
    const fix = "pnpm media:prepare --engines asr,ocr";
    return ReferenceSpeechTextSchema.parse({
      schemaVersion: 1,
      referenceId,
      speech: { available: false, unavailableReason, fix, words: [] },
      screenText: { available: false, unavailableReason, fix, items: [] },
    });
  }
}

/** Each shot's Lab, so a replica's colour targets come from measurement before the first render. */
function withColour(shots: ReferenceShots, media: string, info: VideoInfo): ReferenceShots {
  if (!shots.shots.length) return shots;
  try {
    const samples = sampleFilm(media, info);
    return samples.length
      ? { ...shots, shots: shots.shots.map((shot) => ({ ...shot, colour: shotColour(samples, shot) })) }
      : shots;
  } catch (error) {
    emitProgress(`Shot colour not measured: ${error instanceof Error ? error.message : String(error)}`);
    return shots;
  }
}

export function parseLayers(value: string | undefined): AnalysisLayer[] {
  if (!value) return [...ANALYSIS_LAYERS];
  const layers = value
    .split(",")
    .map((part) => part.trim().replace(/\.json$/, ""))
    .filter(Boolean);
  const unknown = layers.filter((layer) => !(ANALYSIS_LAYERS as readonly string[]).includes(layer));
  if (unknown.length)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Unknown layers: ${unknown.join(", ")}. Choose from ${ANALYSIS_LAYERS.join(", ")}.`,
    });
  return ANALYSIS_LAYERS.filter((layer) => layers.includes(layer));
}

/** Runs the requested layers in dependency order. A layer that fails is written as unavailable and the rest continue. */
export async function analyseReference(request: {
  libraryRoot: string;
  id: string;
  layers: AnalysisLayer[];
  stems?: boolean;
  language?: string;
  engineDir?: string;
}) {
  const directory = referenceDirectory(request.libraryRoot, request.id);
  // Picture layers read the cropped copy when the frame holds bars or a phone UI; sound is measured on the source.
  const { source, media: sourceMedia, analysisMedia: media } = readAnalysisMedia(directory, { persist: true });
  const info = probeVideo(media);
  const durationSec = source.probe.durationSec;
  const referenceId = source.referenceId;
  const wanted = new Set(request.layers);
  const outputs: string[] = [];
  const layers: Partial<Record<AnalysisLayer, LayerReport | Record<string, LayerReport>>> = {};
  let shots: ReferenceShots | undefined = readLayer(directory, "shots.json");
  // The full layer when this machine has the film's words, so the onset update below keeps them.
  let speechText: ReferenceSpeechText | undefined = readSpeechText(directory);
  let audio: ReferenceAudio | undefined = readLayer(directory, "audio.json");
  let motion: ReferenceMotion | undefined = readLayer(directory, "motion.json");
  let sync: ReferenceSync | undefined = readLayer(directory, "sync.json");

  if (wanted.has("shots")) {
    emitProgress("Detecting shots and transitions");
    shots = withColour(analyseShots(referenceId, media, durationSec), media, info);
    outputs.push(writeLayer(directory, "shots.json", shots));
    layers.shots = report(shots.status);
  }
  if (wanted.has("colour") && !wanted.has("shots")) {
    emitProgress("Measuring each shot's colour");
    if (!shots?.shots.length)
      layers.colour = {
        available: false,
        reason: "No shots.json to measure.",
        fix: "Run ref:analyze --layers shots first.",
      };
    else {
      shots = withColour({ ...shots, shots: shots.shots.map(({ colour: _old, ...shot }) => shot) }, media, info);
      outputs.push(writeLayer(directory, "shots.json", shots));
      layers.colour = { available: shots.shots.some((shot) => shot.colour !== undefined) };
    }
  }
  if (wanted.has("speech-text")) {
    emitProgress("Recognising speech and screen text");
    speechText = await speechTextLayer(referenceId, media, request.language, request.engineDir);
    outputs.push(writeLayer(directory, "speech-text.json", speechText));
    layers["speech-text"] = { speech: report(speechText.speech), screenText: report(speechText.screenText) };
  }
  if (wanted.has("audio")) {
    emitProgress("Measuring tempo, onsets, sections and loudness");
    audio = analyseAudio({
      referenceId,
      media: sourceMedia,
      directory,
      hasAudio: source.probe.hasAudio,
      sha256: source.sha256,
      stems: request.stems,
    });
    outputs.push(writeLayer(directory, "audio.json", audio));
    layers.audio = report(audio.status);
  }
  if (wanted.has("audiomap")) {
    // An optional extra beside audio.json, not a layer of its own: a film without it still validates.
    emitProgress("Reading beats and dynamics into the audio map");
    try {
      if (!source.probe.hasAudio) throw new Error("Source has no audio stream");
      const map = buildAudioMap({
        input: sourceMedia,
        output: path.join(directory, "audiomap.json"),
        imagePath: path.join(directory, "visuals", "audiomap.png"),
        imageRef: "visuals/audiomap.png",
        sourcePath: path.relative(directory, sourceMedia).split(path.sep).join("/"),
        title: referenceId,
      });
      outputs.push(map.jsonPath, map.imagePath!);
      layers.audiomap = { available: true, engine: map.diagnostics.engine };
    } catch (error) {
      layers.audiomap = {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        fix: "Check uv and ffmpeg, then rerun ref:analyze --layers audiomap.",
      };
    }
  }
  if (wanted.has("motion")) {
    emitProgress("Measuring motion per shot");
    const result = analyseMotion({
      referenceId,
      media,
      info,
      shots: shots?.shots ?? [],
      screenText: speechText?.screenText.items,
    });
    motion = result.layer;
    outputs.push(writeLayer(directory, "motion.json", motion));
    layers.motion = report(motion.status);
    if (speechText && result.textOnSec?.length === speechText.screenText.items.length) {
      const onsets = result.textOnSec;
      speechText = {
        ...speechText,
        screenText: {
          ...speechText.screenText,
          items: speechText.screenText.items.map((item, index) => ({ ...item, onsetSec: onsets[index]! })),
        },
      };
      writeLayer(directory, "speech-text.json", speechText);
    }
  }
  if (wanted.has("sync")) {
    sync = buildSync({ referenceId, durationSec, shots, audio, speechText, motion, fps: info.fps });
    outputs.push(writeLayer(directory, "sync.json", sync));
    layers.sync = report(sync.status);
  }
  if (wanted.has("visuals")) {
    emitProgress("Drawing contact sheets, strips and the edit map");
    try {
      if (!shots?.shots.length) throw new Error("No shots to draw. Run --layers shots first.");
      const visuals = buildVisuals({ directory, media, info, shots, audio, speechText, motion, sync });
      writeLayer(directory, "shots.json", visuals.shots);
      outputs.push(...visuals.outputs);
      layers.visuals = { available: true };
    } catch (error) {
      layers.visuals = {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        fix: "Check ffmpeg is installed, then rerun ref:analyze --layers visuals.",
      };
    }
  }
  return {
    directory,
    outputs,
    layers,
    crop: source.crop ?? null,
    summary: {
      shots: shots?.summary,
      bpm: audio?.tempo?.bpm,
      words: speechText?.speech.words.length,
      screenTextItems: speechText?.screenText.items.length,
      sync: sync?.metrics,
    },
  };
}
