import { spawnSync } from "node:child_process";

/** The encoder delay most AAC encoders (Apple, fdk) leave at the start: 2112 samples. */
export const AAC_PRIMING_SAMPLES = 2112;

export type DecoderDelay = {
  codec: string;
  sampleRate: number;
  /** The container trims its own priming with an edit list, so ffmpeg and players already hide it. */
  editList: boolean;
  /** Priming the stream declares (ffmpeg's `initial_padding`), already skipped by the decoder. */
  declaredDelaySamples: number;
  /** Priming that players present as sound, because nothing in the file says to skip it. 0 when none is presumed. */
  primingSec: number;
  /** Whether this map's timeline had that priming removed (`--aac-priming-correct`). */
  primingCorrected: boolean;
};

function probe(media: string, args: string[]): string {
  const result = spawnSync("ffprobe", args.concat(media), {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 || result.stderr ? `${result.stdout ?? ""}${result.stderr ?? ""}` : "";
}

/**
 * Reads whether the first audio stream presents encoder priming. An AAC stream with no edit list and no declared
 * padding plays its priming, about 44 ms at 48 kHz: the presented timeline is what viewers hear, so it is the default.
 */
export function detectDecoderDelay(media: string, correct = false): DecoderDelay {
  const info = probe(media, [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name,sample_rate,initial_padding",
    "-of",
    "json",
  ]);
  let stream: { codec_name?: string; sample_rate?: string; initial_padding?: number } = {};
  try {
    stream = (JSON.parse(info) as { streams?: (typeof stream)[] }).streams?.[0] ?? {};
  } catch {
    stream = {};
  }
  const codec = stream.codec_name ?? "unknown";
  const sampleRate = Number(stream.sample_rate ?? 0);
  const declared = Number(stream.initial_padding ?? 0);
  const editList = /type:'elst'/.test(probe(media, ["-v", "trace", "-read_intervals", "%+#1"]));
  const presumed = codec === "aac" && !editList && declared === 0 && sampleRate > 0;
  const primingSec = presumed ? Math.round((AAC_PRIMING_SAMPLES / sampleRate) * 1e6) / 1e6 : 0;
  return {
    codec,
    sampleRate,
    editList,
    declaredDelaySamples: declared,
    primingSec,
    primingCorrected: correct && primingSec > 0,
  };
}

/** ffmpeg filter prefix that drops the presented priming, or nothing when the timeline stays as presented. */
export function primingTrim(delay: DecoderDelay | undefined): string {
  return delay?.primingCorrected ? `atrim=start=${delay.primingSec},asetpts=PTS-STARTPTS,` : "";
}
