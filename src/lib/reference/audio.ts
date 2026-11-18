import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeAudio } from "../audio/analysis";
import { analyzeRhythmPcm } from "../audio/rhythm-kernel";
import { ReferenceAudioSchema, type ReferenceAudio } from "../../types/reference";
import { runWorker } from "./worker";
import { separateStems as separateAudioStems, STEM_NAMES } from "../audio-map/stems";

type WorkerAudio = {
  engine: string;
  bpm: number;
  confidence: number;
  beatRegularity: number;
  beatsSec: number[];
  downbeatsSec: number[];
  downbeatConfidence: number;
  onsetsSec: number[];
  sections: { startSec: number; endSec: number; label: string; energy: number }[];
};

/** librosa cannot open every container, so it reads a plain WAV of the same clock. */
function runLibrosa(media: string) {
  const work = mkdtempSync(path.join(tmpdir(), "reference-audio-"));
  try {
    const wav = path.join(work, "audio.wav");
    const decoded = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-i",
        media,
        "-map",
        "0:a:0",
        "-af",
        "aresample=22050:async=1:first_pts=0",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wav,
      ],
      { encoding: "utf8", timeout: 600000, killSignal: "SIGKILL" },
    );
    if (decoded.error || decoded.status !== 0)
      return {
        ok: false as const,
        reason: `ffmpeg could not decode audio: ${decoded.error?.message ?? decoded.stderr.slice(-300)}`,
        fix: "Check the file has a readable audio stream.",
      };
    return runWorker<WorkerAudio>("audio", wav);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function decodePcm(media: string): Buffer {
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-i", media, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
    { maxBuffer: 2 * 1024 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new Error(`ffmpeg could not decode audio: ${result.error?.message ?? result.stderr?.toString().slice(-300)}`);
  return result.stdout;
}

/** Off unless asked for: demucs downloads a large runtime and model on first use. */
export function separateReferenceStems(
  media: string,
  directory: string,
  separate = separateAudioStems,
): NonNullable<ReferenceAudio["stems"]> {
  try {
    const stems = separate(media);
    const output = path.join(directory, "media", "stems", "htdemucs", path.basename(media, path.extname(media)));
    mkdirSync(output, { recursive: true });
    const paths = Object.fromEntries(
      STEM_NAMES.map((name) => {
        const target = path.join(output, name + ".wav");
        copyFileSync(stems.paths[name], target);
        return [name, path.relative(directory, target).split(path.sep).join("/")];
      }),
    );
    return { available: true, engine: "demucs htdemucs", paths };
  } catch (error) {
    return {
      available: false,
      engine: "demucs",
      unavailableReason: `demucs failed: ${error instanceof Error ? error.message.slice(-400) : String(error)}`,
      fix: "Check uv, disk space and network for the first run, then rerun with --stems.",
      paths: {},
    };
  }
}

export function analyseAudio(request: {
  referenceId: string;
  media: string;
  directory: string;
  hasAudio: boolean;
  sha256: string;
  stems?: boolean;
}): ReferenceAudio {
  const base = { schemaVersion: 1 as const, referenceId: request.referenceId, hasAudio: request.hasAudio };
  if (!request.hasAudio)
    return ReferenceAudioSchema.parse({
      ...base,
      status: { available: false, unavailableReason: "Source has no audio stream" },
    });
  let loudness: ReferenceAudio["loudness"];
  let silence: ReferenceAudio["silence"] = [];
  let durationSec = 0;
  const problems: string[] = [];
  try {
    const measured = analyzeAudio(request.media);
    durationSec = measured.durationSec;
    silence = measured.silence;
    loudness = {
      ...(measured.integratedLufs === null ? {} : { integratedLufs: measured.integratedLufs }),
      ...(measured.truePeakDb === null ? {} : { truePeakDb: measured.truePeakDb }),
      ...(measured.loudnessRangeLu === null ? {} : { loudnessRangeLu: measured.loudnessRangeLu }),
    };
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const stems = request.stems ? { stems: separateReferenceStems(request.media, request.directory) } : {};
  const worker = runLibrosa(request.media);
  if (worker.ok) {
    const value = worker.value;
    return ReferenceAudioSchema.parse({
      ...base,
      status: { available: true, engine: `${value.engine}+ffmpeg-loudnorm` },
      ...(value.bpm > 0
        ? {
            tempo: {
              bpm: value.bpm,
              confidence: value.confidence,
              beatRegularity: value.beatRegularity,
              beatsSec: value.beatsSec,
              downbeatsSec: value.downbeatsSec,
              downbeatConfidence: value.downbeatConfidence,
            },
          }
        : {}),
      onsetsSec: value.onsetsSec,
      sections: value.sections,
      ...(loudness ? { loudness } : {}),
      silence,
      ...stems,
    });
  }
  // The existing RMS kernel needs a regular pulse to report a tempo: it gives none on most voice-and-music mixes.
  try {
    const { report } = analyzeRhythmPcm(decodePcm(request.media), durationSec, request.sha256);
    const peak = Math.max(...report.sections.map((section) => section.rms), 1e-6);
    return ReferenceAudioSchema.parse({
      ...base,
      status: {
        available: true,
        engine: `${report.algorithm}+ffmpeg-loudnorm`,
        unavailableReason: `Fell back from librosa: tempo is only reported for a very regular pulse. ${worker.reason}`,
        fix: worker.fix,
      },
      ...(report.tempoBpm
        ? {
            tempo: {
              bpm: report.tempoBpm,
              confidence: report.confidence,
              beatsSec: report.beatCandidatesSec,
              downbeatsSec: [],
            },
          }
        : {}),
      onsetsSec: report.onsetsSec,
      sections: report.sections.map((section, index) => ({
        startSec: section.startSec,
        endSec: section.endSec,
        label: `${index + 1}-fixed-4s`,
        energy: section.rms / peak,
      })),
      ...(loudness ? { loudness } : {}),
      silence,
      ...stems,
    });
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return ReferenceAudioSchema.parse({
      ...base,
      status: { available: false, unavailableReason: `${worker.reason}; ${problems.join("; ")}`, fix: worker.fix },
      ...(loudness ? { loudness } : {}),
      silence,
      ...stems,
    });
  }
}
