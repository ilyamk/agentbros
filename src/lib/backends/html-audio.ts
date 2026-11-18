import { execFileSync } from "node:child_process";
import { statSync, renameSync } from "node:fs";
import path from "node:path";
import { digest } from "../jobs/model-artifacts";
import type { HtmlWorkerRequest } from "./html-types";
import type { flattenHtmlTiming } from "./html-timing";
import type { NativeMediaSource, NativeMediaDescriptor } from "./hyperframes-player-media";
type LocalAudioTrack = {
  id: string;
  audioAsset?: string;
  sourceStartSec: number;
  startSec: number;
  endSec: number;
  rate: number;
  volume: number;
};
/** Fixed FFmpeg graph over immutable snapshots; browser audio never runs. */
export function mixHtmlAudio(request: HtmlWorkerRequest, timing: ReturnType<typeof flattenHtmlTiming>, video: string) {
  return mixLocalAudio(request, timing, video);
}
export function mixNativeAudio(
  request: HtmlWorkerRequest,
  descriptors: NativeMediaDescriptor[],
  video: string,
  sources?: Record<string, NativeMediaSource>,
) {
  const normalized = Object.fromEntries(
    Object.entries(sources ?? {})
      .filter(([, s]) => s.normalization?.audio)
      .map(([name, s]) => [
        name,
        {
          ...request.assetMap[name],
          path: path.join(request.directory, s.normalization!.audio!.pcm.path),
          sha256: s.normalization!.audio!.pcm.sha256,
          mime: "audio/wav",
        },
      ]),
  );
  const mixRequest = { ...request, assetMap: { ...request.assetMap, ...normalized } };
  return mixLocalAudio(
    mixRequest,
    descriptors
      .filter((d) => d.kind === "audio" || Boolean(sources?.[d.asset]?.normalization?.audio))
      .map((d) => ({
        id: d.id,
        audioAsset: d.asset,
        sourceStartSec: d.sourceStartSec,
        startSec: d.startSec,
        endSec: d.endSec,
        rate: d.rate,
        volume: d.volume,
      })),
    video,
  );
}
function mixLocalAudio(request: HtmlWorkerRequest, timing: LocalAudioTrack[], video: string) {
  const sampleRate = 48000;
  const samples = Math.round((request.frames.length / request.fps) * sampleRate);
  const tracks = timing.filter((n) => n.audioAsset);
  const inputs: string[] = [],
    filters: string[] = [],
    evidence: unknown[] = [];
  for (const [index, node] of tracks.entries()) {
    const asset = request.assetMap[node.audioAsset!];
    if (!asset || !asset.mime.startsWith("audio/"))
      throw new Error("Audio track must reference allowlisted audio original");
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", asset.path],
        { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
      ),
    ) as { streams: { codec_type: string }[]; format: { duration: string } };
    const streams = probe.streams.filter((s) => s.codec_type === "audio");
    if (streams.length !== 1 || probe.streams.some((s) => s.codec_type === "video"))
      throw new Error("Audio original must contain exactly one audio stream");
    const clock = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-select_streams",
          "a:0",
          "-show_packets",
          "-show_entries",
          "packet=pts_time,duration_time",
          "-of",
          "json",
          asset.path,
        ],
        { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
      ),
    ) as { packets: { pts_time?: string; duration_time?: string }[] };
    let end = 0;
    if (!clock.packets.length) throw new Error("Missing audio clock evidence");
    for (const packet of clock.packets) {
      const start = Number(packet.pts_time),
        length = Number(packet.duration_time);
      if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0 || Math.abs(start - end) > 2 / 48000)
        throw new Error("Audio offset/gap/overlap unsupported; normalize and review original first");
      end = start + length;
    }
    const duration = Number(probe.format.duration);
    const sourceEnd = node.sourceStartSec + (node.endSec - node.startSec) * node.rate;
    if (!Number.isFinite(duration) || sourceEnd > duration + 0.001)
      throw new Error("Audio source trim outside original duration");
    const startSample = Math.round(node.startSec * sampleRate),
      length = Math.round((node.endSec - node.startSec) * sampleRate);
    if (startSample + length > samples) throw new Error("Audio timing exceeds encoded timeline");
    inputs.push("-protocol_whitelist", "file,pipe", "-i", asset.path);
    const rates: number[] = [];
    let rate = node.rate;
    while (rate > 2) {
      rates.push(2);
      rate /= 2;
    }
    while (rate < 0.5) {
      rates.push(0.5);
      rate /= 0.5;
    }
    rates.push(rate);
    filters.push(
      `[${index}:a]atrim=start=${node.sourceStartSec}:end=${sourceEnd},asetpts=PTS-STARTPTS,${rates.map((r) => `atempo=${r}`).join(",")},aresample=${sampleRate},aformat=sample_fmts=flt:channel_layouts=stereo,apad,atrim=end_sample=${length},volume=${node.volume},adelay=${startSample}S:all=1[a${index}]`,
    );
    evidence.push({
      id: node.id,
      asset: node.audioAsset,
      sha256: asset.sha256,
      sourceStartSec: node.sourceStartSec,
      sourceEndSec: sourceEnd,
      rate: node.rate,
      startSample,
      lengthSamples: length,
      volume: node.volume,
    });
  }
  filters.push(
    `${tracks.map((_, i) => `[a${i}]`).join("")}amix=inputs=${tracks.length}:normalize=0:dropout_transition=0,alimiter=limit=0.95:latency=1,apad,atrim=end_sample=${samples}[mixed]`,
  );
  const wav = path.join(request.directory, "mix.wav");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      ...inputs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[mixed]",
      "-c:a",
      "pcm_f32le",
      "-ar",
      String(sampleRate),
      "-y",
      wav,
    ],
    { timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  if (statSync(wav).size > 64 * 1024 * 1024) throw new Error("Mixed audio exceeds resource bounds");
  const decoded = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      wav,
      "-f",
      "f32le",
      "-ac",
      "2",
      "-ar",
      String(sampleRate),
      "pipe:1",
    ],
    { timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (decoded.length !== samples * 2 * 4) throw new Error("Mixed audio sample count mismatch");
  let peak = 0;
  for (let i = 0; i < decoded.length; i += 4) {
    const value = decoded.readFloatLE(i);
    if (!Number.isFinite(value)) throw new Error("Nonfinite mixed audio");
    peak = Math.max(peak, Math.abs(value));
  }
  const mux = path.join(request.directory, "mux.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      video,
      "-protocol_whitelist",
      "file,pipe",
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
      "192k",
      "-t",
      String(samples / sampleRate),
      "-movflags",
      "+faststart",
      "-y",
      mux,
    ],
    { timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  const aac = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      mux,
      "-map",
      "0:a:0",
      "-f",
      "f32le",
      "-ac",
      "2",
      "-ar",
      String(sampleRate),
      "pipe:1",
    ],
    { timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
  );
  const aacSamples = aac.length / 8;
  if (!Number.isInteger(aacSamples) || aacSamples < samples || aacSamples > samples + 2048)
    throw new Error("AAC decoded sample coverage mismatch");
  renameSync(mux, video);
  return {
    sampleRate,
    channels: 2,
    pcmSha256: digest(decoded),
    aacDecodedSamples: aacSamples,
    pcmSamples: samples,
    pcmPeak: peak,
    durationSec: samples / sampleRate,
    encoding: "AAC; codec padding is not PCM sample identity",
    tracks: evidence,
  };
}
