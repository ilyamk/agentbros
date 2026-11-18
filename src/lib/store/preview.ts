/**
 * Store preview specs and the pure checks behind `store:conform`.
 * Apple: App preview specifications (App Store Connect Help). Google Play: Add preview assets (Play Console Help).
 */

export const STORES = ["apple", "google"] as const;
export type Store = (typeof STORES)[number];
export const APPLE_CLASSES = ["iphone", "iphone-55", "ipad", "mac", "tv"] as const;
export type AppleClass = (typeof APPLE_CLASSES)[number];

type Size = { width: number; height: number };
const both = (width: number, height: number): Size[] => [
  { width, height },
  { width: height, height: width },
];

export type StoreSpec = {
  label: string;
  sizes: Size[];
  /** Duration band of the picture, in seconds; `hard` makes it an error rather than a warning. */
  durationSec: { min?: number; max: number; hard: boolean };
  maxFps: number;
  fpsHard: boolean;
  /** Apple refuses a preview without one stereo AAC track; Play takes a YouTube video, where audio rules are advice. */
  audioHard: boolean;
  maxBytes?: number;
  /** Apple's target video bitrate band; only reported. */
  videoKbps?: { min: number; max: number };
};

const APPLE = {
  durationSec: { min: 15, max: 30, hard: true },
  maxFps: 30,
  fpsHard: true,
  audioHard: true,
  maxBytes: 500 * 1024 * 1024,
  videoKbps: { min: 10_000, max: 12_000 },
};

export const APPLE_SPECS: Record<AppleClass, StoreSpec> = {
  iphone: { ...APPLE, label: 'App Store iPhone 6.9", 6.5", 6.1"', sizes: both(886, 1920) },
  "iphone-55": { ...APPLE, label: 'App Store iPhone 5.5"', sizes: both(1080, 1920) },
  ipad: { ...APPLE, label: "App Store iPad", sizes: both(1200, 1600) },
  mac: { ...APPLE, label: "Mac App Store", sizes: [{ width: 1920, height: 1080 }] },
  tv: { ...APPLE, label: "App Store Apple TV", sizes: [{ width: 1920, height: 1080 }] },
};

/** Play takes a YouTube link: no side bars, so a 9:16 or 16:9 master; only the first 30 s autoplay. */
export const GOOGLE_SPEC: StoreSpec = {
  label: "Google Play (YouTube upload)",
  sizes: both(1080, 1920),
  durationSec: { max: 30, hard: false },
  maxFps: 30,
  fpsHard: false,
  audioHard: false,
};

export const AUDIO_TARGET = { codec: "aac", kbps: 256, sampleRate: 48_000, channels: 2 } as const;
export const VIDEO_TARGET = {
  profile: "high",
  level: "4.0",
  maxLevel: 40,
  pixFmt: "yuv420p",
  kbps: 11_000,
  maxKbps: 12_000,
  bufKbps: 24_000,
  fps: 30,
} as const;

export function specFor(store: Store, cls?: string): StoreSpec {
  if (store === "google") {
    if (cls) throw new Error("--class applies only to --store apple; Google Play takes one YouTube video.");
    return GOOGLE_SPEC;
  }
  if (!cls) throw new Error(`--store apple needs --class: ${APPLE_CLASSES.join(", ")}.`);
  if (!(APPLE_CLASSES as readonly string[]).includes(cls))
    throw new Error(`Unknown --class ${cls}; use ${APPLE_CLASSES.join(", ")}.`);
  return APPLE_SPECS[cls as AppleClass];
}

export type VideoFacts = {
  codec: string;
  profile?: string;
  level?: number;
  width: number;
  height: number;
  fps: number;
  pixFmt?: string;
  sar?: string;
  kbps?: number;
  durationSec: number;
};
export type AudioFacts = { codec: string; channels: number; sampleRate: number; kbps?: number };
export type MediaFacts = {
  video: VideoFacts;
  audio?: AudioFacts;
  audioStreams: number;
  formatDurationSec: number;
  sizeBytes?: number;
};

const num = (value: unknown): number | undefined => {
  const n = Number(value);
  return value === undefined || value === null || value === "" || !Number.isFinite(n) ? undefined : n;
};
const rate = (value: unknown): number => {
  const [a, b = 1] = String(value ?? "")
    .split("/")
    .map(Number);
  return b ? a! / b : Number.NaN;
};

/** Reads `ffprobe -show_streams -show_format -of json` output. */
export function factsFromProbe(raw: unknown): MediaFacts {
  const probe = raw as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const streams = probe.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("No video stream.");
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  const audio = audios[0];
  const formatDurationSec = num(probe.format?.duration) ?? Number.NaN;
  const avg = rate(video.avg_frame_rate);
  return {
    video: {
      codec: String(video.codec_name ?? ""),
      profile: video.profile === undefined ? undefined : String(video.profile),
      level: num(video.level),
      width: Number(video.width),
      height: Number(video.height),
      fps: Number.isFinite(avg) && avg > 0 ? avg : rate(video.r_frame_rate),
      pixFmt: video.pix_fmt === undefined ? undefined : String(video.pix_fmt),
      sar: video.sample_aspect_ratio === undefined ? undefined : String(video.sample_aspect_ratio),
      kbps: num(video.bit_rate) === undefined ? undefined : num(video.bit_rate)! / 1000,
      durationSec: num(video.duration) ?? formatDurationSec,
    },
    audio: audio && {
      codec: String(audio.codec_name ?? ""),
      channels: Number(audio.channels),
      sampleRate: Number(audio.sample_rate),
      kbps: num(audio.bit_rate) === undefined ? undefined : num(audio.bit_rate)! / 1000,
    },
    audioStreams: audios.length,
    formatDurationSec,
    sizeBytes: num(probe.format?.size),
  };
}

export type Finding = { code: string; severity: "error" | "warning"; message: string; fix?: string };

const sizeText = (sizes: Size[]) => sizes.map(({ width, height }) => `${width}x${height}`).join(" or ");
const squarePixels = (sar?: string) => !sar || sar === "1:1" || sar === "0:1" || sar === "N/A";

/** Findings that no conform can fix: the picture's size and the film's length. */
export function inputBlockers(facts: MediaFacts, spec: StoreSpec): Finding[] {
  const { video } = facts;
  const findings: Finding[] = [];
  if (!spec.sizes.some(({ width, height }) => width === video.width && height === video.height))
    findings.push({
      code: "SIZE",
      severity: "error",
      message: `${video.width}x${video.height} is not an accepted ${spec.label} size (${sizeText(spec.sizes)}); store:conform never rescales or letterboxes.`,
      fix: `Render a composition declared at ${sizeText(spec.sizes.slice(0, 1))} (width/height on the project's <Composition>), not a --draft, then conform that file.`,
    });
  if (!squarePixels(video.sar))
    findings.push({
      code: "PIXEL_ASPECT",
      severity: "error",
      message: `Non-square pixels (${video.sar}).`,
      fix: "Render with square pixels.",
    });
  findings.push(...durationFindings(video.durationSec, spec));
  return findings;
}

function durationFindings(durationSec: number, spec: StoreSpec): Finding[] {
  const { min, max, hard } = spec.durationSec;
  const severity = hard ? "error" : "warning";
  if (!Number.isFinite(durationSec))
    return [{ code: "DURATION", severity: "error", message: "Cannot read the picture's duration." }];
  if (min !== undefined && durationSec < min - 1e-3)
    return [
      {
        code: "DURATION",
        severity,
        message: `${durationSec.toFixed(2)} s is shorter than ${min} s.`,
        fix: "Lengthen the film in its composition.",
      },
    ];
  if (durationSec > max + 1e-3)
    return [
      {
        code: "DURATION",
        severity,
        message: hard
          ? `${durationSec.toFixed(2)} s is longer than ${max} s.`
          : `${durationSec.toFixed(2)} s: only the first ${max} s autoplay.`,
        fix: hard ? "Shorten the film in its composition." : undefined,
      },
    ];
  return [];
}

/** Why the picture must be re-encoded; empty means it is stream-copied untouched. */
export function videoReencodeReasons(video: VideoFacts, spec: StoreSpec): string[] {
  const reasons: string[] = [];
  if (video.codec !== "h264") reasons.push(`codec ${video.codec || "unknown"} is not H.264`);
  if (video.profile?.toLowerCase() !== VIDEO_TARGET.profile)
    reasons.push(`profile ${video.profile ?? "unknown"} is not High`);
  if (video.level === undefined || video.level > VIDEO_TARGET.maxLevel)
    reasons.push(`level ${video.level ?? "unknown"} is above 4.0`);
  if (video.pixFmt !== VIDEO_TARGET.pixFmt) reasons.push(`pixel format ${video.pixFmt ?? "unknown"} is not yuv420p`);
  if (spec.fpsHard && video.fps > spec.maxFps + 0.01)
    reasons.push(`${video.fps.toFixed(2)} fps is above ${spec.maxFps}`);
  return reasons;
}

/** ffmpeg arguments for the conform. Picture: copied, or re-encoded at the same size to H.264 High 4.0. Audio: AAC 256k stereo 48 kHz, silent when the input has none. */
export function conformArgs(
  input: string,
  output: string,
  facts: MediaFacts,
  spec: StoreSpec,
  forceVideo = false,
): { args: string[]; reencodeReasons: string[]; addedSilence: boolean } {
  const reencodeReasons = forceVideo ? ["--reencode-video"] : videoReencodeReasons(facts.video, spec);
  const duration = facts.video.durationSec.toFixed(6);
  const addedSilence = facts.audioStreams === 0;
  const args = ["-v", "error", "-nostdin", "-y", "-i", input];
  if (addedSilence) args.push("-f", "lavfi", "-t", duration, "-i", `anullsrc=r=${AUDIO_TARGET.sampleRate}:cl=stereo`);
  args.push("-map", "0:v:0", "-map", addedSilence ? "1:a:0" : "0:a:0");
  if (reencodeReasons.length === 0) args.push("-c:v", "copy");
  else {
    args.push(
      "-c:v",
      "libx264",
      "-profile:v",
      VIDEO_TARGET.profile,
      "-level:v",
      VIDEO_TARGET.level,
      "-pix_fmt",
      VIDEO_TARGET.pixFmt,
    );
    args.push(
      "-b:v",
      `${VIDEO_TARGET.kbps}k`,
      "-maxrate",
      `${VIDEO_TARGET.maxKbps}k`,
      "-bufsize",
      `${VIDEO_TARGET.bufKbps}k`,
    );
    if (spec.fpsHard && facts.video.fps > spec.maxFps + 0.01) args.push("-r", String(VIDEO_TARGET.fps));
  }
  args.push(
    "-c:a",
    "aac",
    "-b:a",
    `${AUDIO_TARGET.kbps}k`,
    "-ar",
    String(AUDIO_TARGET.sampleRate),
    "-ac",
    String(AUDIO_TARGET.channels),
  );
  args.push("-t", duration, "-movflags", "+faststart", "-map_metadata", "-1", output);
  return { args, reencodeReasons, addedSilence };
}

/** Every rule of the store spec checked against a probe of the finished file. */
export function verifyPreview(facts: MediaFacts, spec: StoreSpec): Finding[] {
  const { video, audio } = facts;
  const findings = inputBlockers(facts, spec);
  const fpsSeverity = spec.fpsHard ? "error" : "warning";
  if (video.fps > spec.maxFps + 0.01)
    findings.push({
      code: "FPS",
      severity: fpsSeverity,
      message: `${video.fps.toFixed(2)} fps is above ${spec.maxFps}.`,
    });
  if (video.codec !== "h264")
    findings.push({ code: "VIDEO_CODEC", severity: "error", message: `Video codec ${video.codec} is not H.264.` });
  else if (video.profile?.toLowerCase() !== "high" || (video.level ?? 99) > VIDEO_TARGET.maxLevel)
    findings.push({
      code: "VIDEO_PROFILE",
      severity: "warning",
      message: `H.264 ${video.profile ?? "?"} level ${video.level ?? "?"}; Apple names High Profile 4.0.`,
      fix: "Run again with --reencode-video.",
    });
  if (
    spec.videoKbps &&
    video.kbps !== undefined &&
    (video.kbps < spec.videoKbps.min || video.kbps > spec.videoKbps.max)
  )
    findings.push({
      code: "VIDEO_BITRATE",
      severity: "warning",
      message: `Video ${Math.round(video.kbps)} kbps; Apple's target is ${spec.videoKbps.min / 1000}-${spec.videoKbps.max / 1000} Mbps.`,
      fix: "Run again with --reencode-video for 11 Mbps.",
    });
  const audioSeverity = spec.audioHard ? "error" : "warning";
  if (!audio)
    findings.push({
      code: "AUDIO_MISSING",
      severity: audioSeverity,
      message: spec.audioHard
        ? "No audio track; App Store Connect refuses a preview without one."
        : "No audio track; a silent YouTube video is accepted, but a store video usually carries sound.",
    });
  else {
    if (facts.audioStreams > 1)
      findings.push({
        code: "AUDIO_STREAMS",
        severity: audioSeverity,
        message: `${facts.audioStreams} audio tracks; one stereo track is expected.`,
      });
    if (audio.codec !== AUDIO_TARGET.codec)
      findings.push({
        code: "AUDIO_CODEC",
        severity: audioSeverity,
        message: `Audio codec ${audio.codec} is not AAC.`,
      });
    if (audio.channels !== AUDIO_TARGET.channels)
      findings.push({
        code: "AUDIO_CHANNELS",
        severity: audioSeverity,
        message: `${audio.channels} audio channels; stereo is required.`,
      });
    if (audio.sampleRate !== 44_100 && audio.sampleRate !== 48_000)
      findings.push({
        code: "AUDIO_RATE",
        severity: audioSeverity,
        message: `${audio.sampleRate} Hz; 44.1 or 48 kHz is required.`,
      });
    if (audio.kbps !== undefined && Math.abs(audio.kbps - AUDIO_TARGET.kbps) > 32)
      findings.push({
        code: "AUDIO_BITRATE",
        severity: "warning",
        message: `Audio measures ${Math.round(audio.kbps)} kbps against 256 kbps requested (AAC spends fewer bits on silence).`,
      });
  }
  if (spec.maxBytes !== undefined && facts.sizeBytes !== undefined && facts.sizeBytes > spec.maxBytes)
    findings.push({
      code: "FILE_SIZE",
      severity: "error",
      message: `${(facts.sizeBytes / 1024 / 1024).toFixed(1)} MB is over ${spec.maxBytes / 1024 / 1024} MB.`,
    });
  return findings;
}

export const PROBE_ARGS = [
  "-v",
  "error",
  "-show_entries",
  "stream=codec_type,codec_name,profile,level,width,height,avg_frame_rate,r_frame_rate,pix_fmt,sample_aspect_ratio,channels,sample_rate,bit_rate,duration:format=duration,size",
  "-of",
  "json",
] as const;
