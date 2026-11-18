import { execFileSync } from "node:child_process";
import type { HtmlWorkerRequest } from "./html-types";
import type { NativeMediaSource } from "./hyperframes-player-media";
/** Short immutable local originals only; all demuxer protocols are bounded to files. */
export function probeNativeMedia(assets: HtmlWorkerRequest["assetMap"]): Record<string, NativeMediaSource> {
  const result: Record<string, NativeMediaSource> = {};
  for (const [name, asset] of Object.entries(assets).filter(([, a]) => /^(video|audio)\//.test(a.mime))) {
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", asset.path],
        { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
      ),
    ) as {
      streams: {
        codec_type: string;
        codec_name?: string;
        sample_rate?: string;
        channels?: number;
        duration?: string;
        avg_frame_rate?: string;
        width?: number;
        height?: number;
      }[];
      format: { duration: string };
    };
    const kind = asset.mime.startsWith("video/") ? "video" : "audio",
      streams = probe.streams.filter((s) => s.codec_type === kind),
      stream = streams[0],
      durationSec = Number(stream?.duration ?? probe.format.duration);
    if (
      streams.length !== 1 ||
      probe.streams.some((s) => s.codec_type !== kind) ||
      !Number.isFinite(durationSec) ||
      durationSec <= 0 ||
      durationSec > 60
    )
      throw Error("Native media requires one short isolated video or audio stream");
    if (
      kind === "audio" &&
      (!stream.codec_name?.startsWith("pcm_") ||
        Number(stream.sample_rate) !== 48000 ||
        ![1, 2].includes(stream.channels ?? 0))
    )
      throw Error("Native audio requires isolated 48k mono/stereo PCM source");
    const packets = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-select_streams",
          kind === "video" ? "v:0" : "a:0",
          "-show_packets",
          "-show_entries",
          "packet=pts_time,duration_time",
          "-of",
          "json",
          asset.path,
        ],
        { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
      ),
    ) as { packets: { pts_time: string; duration_time: string }[] };
    const clock = packets.packets
      .map((p) => ({ start: Number(p.pts_time), length: Number(p.duration_time) }))
      .sort((a, b) => a.start - b.start);
    if (!clock.length || clock.length > 3601) throw Error("Native media source clock bound");
    let end = 0;
    for (const p of clock) {
      if (
        !Number.isFinite(p.start) ||
        !Number.isFinite(p.length) ||
        p.length <= 0 ||
        Math.abs(p.start - end) > 2 / 48000
      )
        throw Error("Native media requires zero-origin continuous source clock");
      end = p.start + p.length;
    }
    if (Math.abs(end - durationSec) > 2 / 48000) throw Error("Native media clock/duration mismatch");
    let sourceFps: number | undefined;
    if (kind === "video") {
      const [n, d] = (stream.avg_frame_rate ?? "0/0").split("/").map(Number);
      sourceFps = n / d;
      if (
        !Number.isFinite(sourceFps) ||
        sourceFps < 1 ||
        sourceFps > 60 ||
        !stream.width ||
        !stream.height ||
        stream.width > 1920 ||
        stream.height > 1920 ||
        clock.some(
          (p, i) => Math.abs(p.start - i / sourceFps!) > 2 / 48000 || Math.abs(p.length - 1 / sourceFps!) > 2 / 48000,
        )
      )
        throw Error("Native video requires bounded CFR source metadata");
    }
    result[name] = { kind, durationSec, sha256: asset.sha256, ...(sourceFps ? { sourceFps } : {}) };
  }
  return result;
}
