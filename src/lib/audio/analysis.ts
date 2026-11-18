import { execFileSync, spawnSync } from "node:child_process";
import {
  assertRegularLocalInput,
  LOCAL_MEDIA_PROTOCOLS,
  MEDIA_PROBE_TIMEOUT_MS,
  LOCAL_AUDIO_TIMEOUT_MS,
  audioChildTimeout,
} from "./local-input";
export type SilenceInterval = { startSec: number; endSec: number };
export type AudioAnalysis = {
  durationSec: number;
  present: boolean;
  integratedLufs: number | null;
  truePeakDb: number | null;
  loudnessRangeLu: number | null;
  thresholdLufs: number | null;
  silence: SilenceInterval[];
};
export function mediaProbe(file: string, { timeoutMs = MEDIA_PROBE_TIMEOUT_MS } = {}) {
  file = assertRegularLocalInput(file);
  audioChildTimeout(timeoutMs);
  return JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        LOCAL_MEDIA_PROTOCOLS,
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs, killSignal: "SIGKILL" },
    ),
  ) as {
    streams: {
      codec_type: string;
      duration?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      nb_frames?: string;
    }[];
    format: { duration: string };
  };
}
export function analyzeAudio(
  file: string,
  { silenceDb = -40, minimumSilenceSec = 0.3, timeoutMs = LOCAL_AUDIO_TIMEOUT_MS } = {},
): AudioAnalysis {
  if (!Number.isFinite(silenceDb) || silenceDb >= 0 || !Number.isFinite(minimumSilenceSec) || minimumSilenceSec <= 0)
    throw new Error("Invalid silence detection thresholds");
  file = assertRegularLocalInput(file);
  audioChildTimeout(timeoutMs);
  const probe = mediaProbe(file),
    durationSec = Number(probe.format.duration);
  if (!(durationSec > 0)) throw new Error("Media duration must be positive");
  const present = probe.streams.some((stream) => stream.codec_type === "audio");
  const base = {
    durationSec,
    present,
    integratedLufs: null,
    truePeakDb: null,
    loudnessRangeLu: null,
    thresholdLufs: null,
    silence: [],
  } as AudioAnalysis;
  if (!present) return base;
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-protocol_whitelist",
      LOCAL_MEDIA_PROTOCOLS,
      "-i",
      file,
      "-vn",
      "-af",
      `silencedetect=noise=${silenceDb}dB:d=${minimumSilenceSec},loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, killSignal: "SIGKILL" },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Audio analysis failed: ${result.error?.message ?? result.stderr.slice(-2000)}`);
  const block = result.stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];
  if (!block) throw new Error("FFmpeg did not return loudness measurements");
  const measured = JSON.parse(block) as Record<string, string>;
  const finite = (key: string) => (Number.isFinite(Number(measured[key])) ? Number(measured[key]) : null);
  let open: number | undefined;
  const silence: SilenceInterval[] = [];
  for (const match of result.stderr.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
    const at = Number(match[2]);
    if (match[1] === "start") open = at;
    else if (open !== undefined) {
      silence.push({ startSec: open, endSec: Math.min(durationSec, at) });
      open = undefined;
    }
  }
  if (open !== undefined) silence.push({ startSec: open, endSec: durationSec });
  return {
    ...base,
    integratedLufs: finite("input_i"),
    truePeakDb: finite("input_tp"),
    loudnessRangeLu: finite("input_lra"),
    thresholdLufs: finite("input_thresh"),
    silence,
  };
}
