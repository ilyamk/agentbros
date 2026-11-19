import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { RecordingEditRequest } from "../../types/workflow-recording-edit";

export type RecordingNormalizationMapping = {
  sourceBoundaries: { sourceFrame: number; sourceSec: number; masterFrame: number }[];
  masterToDecodedFrame: number[];
  masterFrameCount: number;
  droppedDecodedFrames: number;
  repeatedMasterFrames: number;
};
/** Stable hash of reviewed mapping fields; ignores unrelated report metadata. */
export function hashRecordingNormalizationMapping(mapping: RecordingNormalizationMapping): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceBoundaries: mapping.sourceBoundaries,
        masterToDecodedFrame: mapping.masterToDecodedFrame,
        masterFrameCount: mapping.masterFrameCount,
        droppedDecodedFrames: mapping.droppedDecodedFrames,
        repeatedMasterFrames: mapping.repeatedMasterFrames,
      }),
    )
    .digest("hex");
}

export type RecordingTimingSummary = {
  originalDurationSec: number;
  outputDurationSec: number;
  authenticAudioDurationSec: number;
  decodedAudioDurationSec: number;
  authenticContentDurationSec: number;
  clockToleranceSec: number;
  boundaryMaxErrorSec: number;
};
export function hashRecordingTimingSummary(summary: RecordingTimingSummary): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        originalDurationSec: summary.originalDurationSec,
        outputDurationSec: summary.outputDurationSec,
        authenticAudioDurationSec: summary.authenticAudioDurationSec,
        decodedAudioDurationSec: summary.decodedAudioDurationSec,
        authenticContentDurationSec: summary.authenticContentDurationSec,
        clockToleranceSec: summary.clockToleranceSec,
        boundaryMaxErrorSec: summary.boundaryMaxErrorSec,
      }),
    )
    .digest("hex");
}

/** A decoded-frame boundary table; the terminal boundary is measured, not extrapolated. */
export function probeRecordingTiming(file: string, source: RecordingEditRequest["source"]) {
  const probe = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30000,
    }),
  );
  const videos = probe.streams.filter((s: any) => s.codec_type === "video");
  const audios = probe.streams.filter((s: any) => s.codec_type === "audio");
  if (videos.length !== 1 || audios.length !== 1)
    throw new Error("Recording requires exactly one video and one authentic audio stream");
  const video = videos[0],
    audio = audios[0];
  if (
    ![video.width, video.height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 4096) ||
    video.width * video.height > 3840 * 2160
  )
    throw new Error("Recording dimensions must fit a 4K frame");
  const normalizerVersion = execFileSync("ffmpeg", ["-version"], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 65536,
  }).split("\n")[0];
  const rational = (value: string) => {
    const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
    if (
      !match ||
      !Number.isSafeInteger(Number(match[1])) ||
      !Number.isSafeInteger(Number(match[2])) ||
      !Number(match[1]) ||
      !Number(match[2])
    )
      throw new Error("Invalid recording timebase");
    return Number(match[1]) / Number(match[2]);
  };
  const tick = rational(video.time_base);
  const rate = rational(video.r_frame_rate);
  if (Math.abs(rate - source.fps.num / source.fps.den) > 1e-10)
    throw new Error("Declared source fps does not match measured nominal rate");
  if (rate > 120 || rate < 1) throw new Error("Recording nominal rate must be within 1–120fps");
  // The container check comes first: WebM stores no stream duration, and its Opus pre-skip start differs by FFmpeg
  // build (0 or -0.007s), so the remux hint is the one that fixes the source on every machine.
  const durationTicks = Number(video.duration_ts);
  if (!Number.isSafeInteger(durationTicks) || durationTicks <= 0)
    throw new Error(
      "Recording needs a measured terminal video timestamp; this container (WebM/Matroska and some streams) stores no video stream duration. Remux to MP4 first: ffmpeg -i IN -c:v libx264 -c:a aac OUT.mp4, then transcribe the MP4 (a transcript is bound to its file's SHA256)",
    );
  for (const stream of [video, audio])
    if (!Number.isFinite(Number(stream.start_time)) || Math.abs(Number(stream.start_time)) > 1 / 48000)
      throw new Error(
        `Recording audio/video must share a zero start (video starts at ${video.start_time}s, audio at ${audio.start_time}s); offsets remain unsupported. Re-encode from zero first: ffmpeg -i IN -vf setpts=PTS-STARTPTS -af asetpts=PTS-STARTPTS -c:v libx264 -c:a aac OUT.mp4`,
      );
  const durationSec = durationTicks * tick;
  if (durationSec > 1800 || !Number.isFinite(durationSec))
    throw new Error("Recording duration must be at most 30 minutes");
  const raw = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp,duration,pkt_duration",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8", maxBuffer: 48 * 1024 * 1024, timeout: 120000 },
    ),
  ).frames;
  if (!Array.isArray(raw) || !raw.length || raw.length > 216000)
    throw new Error("Recording requires 1–216000 decoded frames");
  const ticks = raw.map((frame: any) => Number(frame.best_effort_timestamp));
  for (let i = 0; i < ticks.length; i++)
    if (
      !Number.isSafeInteger(ticks[i]) ||
      ticks[i] < 0 ||
      (i === 0 && ticks[i] !== 0) ||
      (i > 0 && ticks[i] <= ticks[i - 1])
    )
      throw new Error("Recording requires strictly increasing finite decoded timestamps from zero");
  const tailTicks = Number(raw.at(-1).duration ?? raw.at(-1).pkt_duration);
  if (!Number.isSafeInteger(tailTicks) || tailTicks <= 0 || Math.abs(ticks.at(-1)! + tailTicks - durationTicks) > 1)
    throw new Error("Ambiguous final frame duration or terminal timestamp");
  const audioDuration = Number(audio.duration);
  if (!Number.isFinite(audioDuration))
    throw new Error(
      "Recording audio stream has no measured duration; remux to MP4 first: ffmpeg -i IN -c:v libx264 -c:a aac OUT.mp4",
    );
  if (audioDuration < durationSec - 1 / 30 - 1e-6)
    throw new Error(
      `Authentic audio ends ${(durationSec - audioDuration).toFixed(3)}s before the video and does not cover the full recording`,
    );
  if (audioDuration > durationSec + 1 / 30 + 1e-6)
    throw new Error(
      `Authentic audio runs ${(audioDuration - durationSec).toFixed(3)}s past the end of the video (more than one frame). Trim it to the picture first: ffmpeg -i IN -t ${durationSec} -c:v copy -c:a aac OUT.mp4, then transcribe the trimmed file`,
    );
  const sampleRate = Number(audio.sample_rate);
  const audioTick = rational(audio.time_base);
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000)
    throw new Error("Recording audio sample rate must be within 8–192kHz");
  const audioFrames = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp,nb_samples",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120000 },
    ),
  ).frames;
  if (!Array.isArray(audioFrames) || !audioFrames.length || audioFrames.length > 400000)
    throw new Error("Recording audio requires a bounded decoded sample clock");
  let sampleCursor = 0;
  for (const frame of audioFrames) {
    const pts = Number(frame.best_effort_timestamp),
      count = Number(frame.nb_samples);
    if (
      !Number.isSafeInteger(pts) ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      Math.abs(pts * audioTick - sampleCursor / sampleRate) > 1 / sampleRate + 1e-8
    )
      throw new Error("Authentic audio has discontinuous decoded timestamps; explicit offset/gap repair required");
    sampleCursor += count;
  }
  // Samples past the stream's declared (trimmed) duration are encoder padding, not authentic audio: FFmpeg 8 decodes
  // the last AAC frame in full (1024 samples) where later builds apply the end trim.
  const decodedAudioSec = Math.min(sampleCursor / sampleRate, audioDuration);
  if (
    Math.abs(durationSec - decodedAudioSec) > 1 / 30 + 1e-6 ||
    Math.abs(Math.ceil(durationSec * 30 - 1e-9) / 30 - decodedAudioSec) > 2 / 30 + 1e-6
  )
    throw new Error("Decoded authentic audio does not cover full recording");
  const seconds = [...ticks.map((n: number) => n * tick), durationSec];
  const masterFrames = seconds.map((n) => Math.round(n * 30));
  if (!masterFrames.at(-1) || Math.ceil(durationSec * 30 - 1e-9) > 54000)
    throw new Error("Normalized recording must fit 1–54000 frames");
  return {
    frames: raw.length as number,
    width: video.width as number,
    height: video.height as number,
    durationSec,
    audioDurationSec: audioDuration,
    decodedAudioDurationSec: decodedAudioSec,
    authenticContentDurationSec: decodedAudioSec,
    clockToleranceSec: Math.max(Math.min(tick, 0.001), 1 / sampleRate),
    masterFrameCount: Math.ceil(durationSec * 30 - 1e-9),
    seconds,
    masterFrames,
    timingHash: createHash("sha256")
      .update(JSON.stringify({ timebase: video.time_base, ticks, durationTicks }))
      .digest("hex"),
    normalizerVersion,
    nominalRate: video.r_frame_rate as string,
    variableFrameRate: ticks.some((n: number, i: number) => i > 1 && n - ticks[i - 1] !== ticks[1] - ticks[0]),
  };
}
