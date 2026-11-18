import { execFileSync } from "node:child_process";
import { CliErrorObject } from "../cli";
/** ASR samples may be converted only after proving a contiguous original audio clock. */
export function inspectLocalAudioClock(file: string, sourceDurationSec: number) {
  const fail = (message: string) =>
    new CliErrorObject({
      code: "VALIDATION",
      message,
    });
  const streams = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-of", "json", file], {
      encoding: "utf8",
      timeout: 30000,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    }),
  ).streams;
  const audio = streams.filter((s: { codec_type: string }) => s.codec_type === "audio");
  if (audio.length !== 1) throw fail("Local ASR requires exactly one audio stream");
  const stream = audio[0],
    rate = Number(stream.sample_rate),
    match = /^(\d+)\/(\d+)$/.exec(stream.time_base ?? "");
  if (!match || !Number(match[1]) || !Number(match[2]) || !Number.isSafeInteger(rate) || rate < 8000 || rate > 192000)
    throw fail("ASR audio clock unavailable");
  const tick = Number(match[1]) / Number(match[2]);
  const frames = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-select_streams",
        "a:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp,nb_samples",
        "-of",
        "json",
        file,
      ],
      {
        encoding: "utf8",
        timeout: 120000,
        killSignal: "SIGKILL",
        maxBuffer: 32 * 1024 * 1024,
      },
    ),
  ).frames;
  if (!Array.isArray(frames) || !frames.length || frames.length > 400000)
    throw fail("ASR audio needs bounded decoded frame timestamps");
  let samples = 0;
  for (const frame of frames) {
    const pts = Number(frame.best_effort_timestamp),
      count = Number(frame.nb_samples);
    if (
      !Number.isSafeInteger(pts) ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      Math.abs(pts * tick - samples / rate) > 1 / rate + 1e-8
    )
      throw fail("ASR audio has discontinuous timestamps/offsets; explicit reviewed normalization required");
    samples += count;
  }
  for (const video of streams.filter((s: { codec_type: string }) => s.codec_type === "video"))
    if (!Number.isFinite(Number(video.start_time)) || Math.abs(Number(video.start_time)) > 1 / rate)
      throw fail("ASR video/audio origin mismatch; explicit reviewed normalization required");
  const declared = stream.duration === undefined ? samples / rate : Number(stream.duration);
  const durationSec = Math.min(declared, samples / rate, sourceDurationSec);
  if (
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    Math.abs(sourceDurationSec - samples / rate) > 2 / 30 ||
    Math.abs(sourceDurationSec - declared) > 2 / 30
  )
    throw fail("ASR audio does not cover source clock");
  return {
    durationSec,
    decodedSamples: samples,
    sampleRate: rate,
  };
}
