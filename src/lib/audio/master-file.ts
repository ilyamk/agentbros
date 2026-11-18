import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { analyzeAudio, mediaProbe } from "./analysis";
import { LOCAL_AUDIO_TIMEOUT_MS, LOCAL_MEDIA_PROTOCOLS, assertRegularLocalInput } from "./local-input";
import { LOUDNESS_PRESETS, buildAudioMix, mixLocalAudio, type LoudnessPreset } from "./local-mix";

const VIDEO_OUTPUTS = new Set([".mp4", ".mov"]);

/** A one-track `audio:mix` plan that loudness-normalises a rendered file's own audio, with no project timeline. */
export function masterPlan(input: string, preset: LoudnessPreset) {
  const probe = mediaProbe(assertRegularLocalInput(input));
  if (!probe.streams.some((stream) => stream.codec_type === "audio")) throw new Error(`Audio stream missing: ${input}`);
  const durationSec = Number(probe.format.duration);
  if (!(durationSec > 0)) throw new Error(`Media duration must be positive: ${input}`);
  const hasVideo = probe.streams.some((stream) => stream.codec_type === "video");
  return {
    plan: {
      version: 1 as const,
      durationSec,
      ...LOUDNESS_PRESETS[preset],
      duckMusic: false,
      tracks: [{ source: input, role: "music" as const }],
    },
    hasVideo,
  };
}

export type MasterFileResult = ReturnType<typeof mixLocalAudio> & {
  output: string;
  container: "wav" | "video";
  delivered: ReturnType<typeof analyzeAudio>;
};

/**
 * Masters a single rendered file to a loudness preset. A `.wav` output is the normalised audio; an `.mp4`/`.mov` output
 * copies the input's video stream untouched and carries the normalised audio as AAC. Nothing is published unless the
 * measured result is within 1 LU of the target and the true peak within 0.3 dB of the ceiling.
 */
export function masterRenderedFile(
  input: string,
  output: string,
  { preset = "social", force = false }: { preset?: LoudnessPreset; force?: boolean } = {},
): MasterFileResult {
  const extension = path.extname(output).toLowerCase();
  if (extension !== ".wav" && !VIDEO_OUTPUTS.has(extension)) throw new Error("Output must be .wav, .mp4 or .mov");
  if (path.resolve(input) === path.resolve(output)) throw new Error("Output must differ from the input");
  if (existsSync(output) && !force) throw new Error(`Output already exists: ${output}`);
  const { plan, hasVideo } = masterPlan(input, preset);
  if (extension === ".wav") {
    const result = mixLocalAudio(plan, output, { force });
    return { ...result, container: "wav", delivered: result.analysis };
  }
  if (!hasVideo) throw new Error(`Video output needs a video stream in the input: ${input}`);
  const directory = path.dirname(path.resolve(output));
  mkdirSync(directory, { recursive: true });
  const wav = path.join(directory, `.${randomUUID()}.master.wav`);
  const temporary = path.join(directory, `.${randomUUID()}.master${extension}`);
  try {
    const result = mixLocalAudio(plan, wav);
    const run = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        LOCAL_MEDIA_PROTOCOLS,
        "-i",
        assertRegularLocalInput(input),
        "-i",
        wav,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "320k",
        "-ar",
        "48000",
        "-t",
        String(plan.durationSec),
        "-movflags",
        "+faststart",
        temporary,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: LOCAL_AUDIO_TIMEOUT_MS, killSignal: "SIGKILL" },
    );
    if (run.error || run.status !== 0)
      throw new Error(`FFmpeg remux failed: ${run.error?.message ?? run.stderr.slice(-2000)}`);
    const delivered = analyzeAudio(temporary);
    if (
      delivered.integratedLufs === null ||
      delivered.truePeakDb === null ||
      Math.abs(delivered.integratedLufs - plan.targetLufs) > 1 ||
      delivered.truePeakDb > plan.truePeakDb + 0.3
    )
      throw new Error(
        `Encoded master failed loudness/true-peak acceptance (${delivered.integratedLufs} LUFS, ${delivered.truePeakDb} dBTP); output not published`,
      );
    if (existsSync(output) && !force) throw new Error(`Output appeared during master: ${output}`);
    if (force) renameSync(temporary, output);
    else linkSync(temporary, output);
    return { ...result, output, container: "video", delivered };
  } finally {
    rmSync(wav, { force: true });
    rmSync(temporary, { force: true });
  }
}

/** Dry run: the graph `audio:mix` would run for this input. */
export const masterGraph = (input: string, preset: LoudnessPreset) => buildAudioMix(masterPlan(input, preset).plan);
