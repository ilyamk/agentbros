import { mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readNativeJson, nativeFilePin } from "./native-media-files";
import {
  nativeAudioClock,
  nativePlayableSamples,
  nativeDecodedClockFromFrames,
  runNativeNormalizationTool,
  nativeInstalledToolPath,
  validateNativeDecodedClock,
  NativeDecodedClockSchema,
} from "./native-media-normalization";
import type { HtmlWorkerRequest } from "./html-types";
import type { NativeMediaSource } from "./hyperframes-player-media";
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  pin = z
    .object({
      path: z.string().regex(/^native-preparation\/[0-7]\/(ordinal\.mkv|pcm\.wav)$/),
      sha256: hash,
      bytes: z
        .number()
        .int()
        .positive()
        .max(64 * 1024 * 1024),
    })
    .strict();
const toolIdentity = z
  .object({ version: z.string().min(1).max(300), path: z.string().min(1).max(1024), sha256: hash })
  .strict();
const tools = z.object({ ffmpeg: toolIdentity, ffprobe: toolIdentity }).strict();
export const NativePreparedSourceSchema = z
  .object({
    kind: z.enum(["video", "audio"]),
    sha256: hash,
    durationSec: z.number().finite().positive().max(60),
    normalization: z
      .object({
        contract: z.literal("decoded-source-proxy-v1"),
        original: z
          .object({
            path: z.string().regex(/^assets\/\d+\.(mp4|webm|wav|mp3|m4a)$/),
            sha256: hash,
            bytes: z
              .number()
              .int()
              .positive()
              .max(32 * 1024 * 1024),
          })
          .strict(),
        tools,
        video: z
          .object({
            clock: NativeDecodedClockSchema,
            clockHash: hash,
            proxy: pin,
            frameCount: z.number().int().positive().max(3600),
            ordinalRate: z.literal(30),
          })
          .strict()
          .optional(),
        audio: z
          .object({
            pcm: pin,
            sourceSampleRate: z.number().int().min(8000).max(192000),
            sourceSamples: z.number().int().positive(),
            decodedSamples: z.number().int().positive(),
            paddingSamples: z.number().int().nonnegative().max(4096),
            outputSamples: z
              .number()
              .int()
              .positive()
              .max(60 * 48000),
            sampleRate: z.literal(48000),
            channels: z.number().int().min(1).max(2),
            clockHash: hash,
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();
export type NativePreparedSource = z.infer<typeof NativePreparedSourceSchema>;
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const rational = (value: string) => {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) throw Error("Missing native source rational");
  const num = Number(match[1]),
    den = Number(match[2]);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0)
    throw Error("Invalid native rational");
  return { num, den };
};
export async function prepareNativeMedia(request: Pick<HtmlWorkerRequest, "directory" | "assetMap">) {
  const started = Date.now(),
    root = request.directory,
    entries = Object.entries(request.assetMap).filter(([, a]) => /^(audio|video)\//.test(a.mime));
  if (!entries.length || entries.length > 8) throw Error("Native normalized source count bound");
  let total = Object.values(request.assetMap).reduce(
    (sum, a) => sum + nativeFilePin(a.path, root, 32 * 1024 * 1024).bytes,
    0,
  );
  if (total > 64 * 1024 * 1024) throw Error("Native aggregate snapshot bound");
  const tool = async (name: "ffmpeg" | "ffprobe", args: string[], outputFile?: string) => {
    const remaining = 30000 - (Date.now() - started);
    if (remaining <= 0) throw Error("Native whole preparation deadline");
    return runNativeNormalizationTool(name, args, {
      timeoutMs: remaining,
      maxOutputBytes: 16 * 1024 * 1024,
      outputFile,
      maxFileBytes: 64 * 1024 * 1024 - total,
      managedGroup: Boolean(process.send),
    });
  };
  const toolVersions = {} as NativePreparedSource["normalization"]["tools"];
  for (const name of ["ffmpeg", "ffprobe"] as const) {
    const file = nativeInstalledToolPath(name);
    toolVersions[name] = {
      version: (await tool(name, ["-version"])).toString().split("\n")[0],
      path: file,
      sha256: nativeFilePin(file, path.dirname(file), 256 * 1024 * 1024).sha256,
    };
  }
  const result: Record<string, NativePreparedSource> = {};
  for (const [index, [name, asset]] of entries.entries()) {
    const original = nativeFilePin(asset.path, root, 32 * 1024 * 1024);
    if (original.sha256 !== asset.sha256) throw Error("Native original snapshot hash mismatch");
    const probe = JSON.parse(
        (
          await tool("ffprobe", [
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_streams",
            "-of",
            "json",
            asset.path,
          ])
        ).toString(),
      ),
      streams = probe.streams;
    if (
      !Array.isArray(streams) ||
      streams.some((s: any) => !["video", "audio"].includes(s.codec_type)) ||
      streams.filter((s: any) => s.codec_type === "video").length > 1 ||
      streams.filter((s: any) => s.codec_type === "audio").length > 1
    )
      throw Error("Native normalization requires isolated audio or one video/optional audio");
    const video = streams.find((s: any) => s.codec_type === "video"),
      audio = streams.find((s: any) => s.codec_type === "audio"),
      kind = asset.mime.startsWith("video/") ? "video" : "audio";
    if (kind === "video" ? !video : !audio || video) throw Error("Native original MIME/stream mismatch");
    const directory = path.join(root, "native-preparation", String(index));
    mkdirSync(directory, { recursive: true });
    const normalization: NativePreparedSource["normalization"] = {
      contract: "decoded-source-proxy-v1",
      original,
      tools: toolVersions,
    };
    let durationSec: number | undefined;
    const ff = (args: string[], output: string) =>
      tool(
        "ffmpeg",
        ["-v", "error", "-threads", "1", "-protocol_whitelist", "file,pipe", "-i", asset.path, ...args, "-n", output],
        output,
      );
    if (video) {
      if (
        !Number.isSafeInteger(video.width) ||
        !Number.isSafeInteger(video.height) ||
        video.width <= 0 ||
        video.height <= 0 ||
        video.width > 1920 ||
        video.height > 1920
      )
        throw Error("Native video dimension bound");
      const rate = rational(video.r_frame_rate);
      if (rate.num / rate.den < 1 || rate.num / rate.den > 60) throw Error("Native nominal video rate bound");
      const timebase = rational(video.time_base),
        frames = JSON.parse(
          (
            await tool("ffprobe", [
              "-v",
              "error",
              "-protocol_whitelist",
              "file,pipe",
              "-select_streams",
              "v:0",
              "-show_frames",
              "-show_entries",
              "frame=best_effort_timestamp,duration,pkt_duration",
              "-of",
              "json",
              asset.path,
            ])
          ).toString(),
        ).frames;
      const clock = nativeDecodedClockFromFrames(
        frames.map((f: any) => ({
          pts: Number(f.best_effort_timestamp),
          duration: Number(f.duration ?? f.pkt_duration),
        })),
        timebase,
        Number(video.duration_ts),
      );
      durationSec = (clock.terminalTick * timebase.num) / timebase.den;
      const proxy = path.join(directory, "ordinal.mkv");
      await ff(
        [
          "-map",
          "0:v:0",
          "-vf",
          "setpts=N/(30*TB)",
          "-fps_mode",
          "passthrough",
          "-an",
          "-c:v",
          "ffv1",
          "-fflags",
          "+bitexact",
          "-flags:v",
          "+bitexact",
        ],
        proxy,
      );
      const proxyPin = nativeFilePin(proxy, root, 64 * 1024 * 1024 - total);
      total += proxyPin.bytes;
      const counts = JSON.parse(
        (
          await tool("ffprobe", [
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_streams",
            "-of",
            "json",
            proxy,
          ])
        ).toString(),
      ).streams;
      if (counts.length !== 1 || Number(counts[0].nb_read_frames) !== clock.pts.length)
        throw Error("Native ordinal proxy dropped decoded frames");
      normalization.video = {
        clock,
        clockHash: sha(clock),
        proxy: proxyPin,
        frameCount: clock.pts.length,
        ordinalRate: 30,
      };
    }
    if (audio) {
      const rate = Number(audio.sample_rate),
        channels = Number(audio.channels);
      if (![1, 2].includes(channels) || ![44100, 48000].includes(rate))
        throw Error("Native audio supports44100/48000 mono/stereo");
      const timebase = rational(audio.time_base),
        frames = JSON.parse(
          (
            await tool("ffprobe", [
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
              asset.path,
            ])
          ).toString(),
        ).frames;
      const clock = nativeAudioClock(
          frames.map((f: any) => ({ pts: Number(f.best_effort_timestamp), nbSamples: Number(f.nb_samples) })),
          timebase,
          rate,
        ),
        playable = nativePlayableSamples(clock.decodedSamples, rate, Number(audio.duration_ts), timebase),
        audioDuration = playable.playableSamples / rate;
      if (durationSec !== undefined && Math.abs(audioDuration - durationSec) > 1 / 48000)
        throw Error("Embedded audio/video extents differ; no gap fill or silent endpoint repair");
      durationSec ??= audioDuration;
      const exactOutput = (playable.playableSamples * 48000) / rate;
      if (!Number.isSafeInteger(exactOutput)) throw Error("Native resampled physical extent is fractional");
      const pcm = path.join(directory, "pcm.wav");
      await ff(
        [
          "-map",
          "0:a:0",
          "-af",
          `atrim=end_sample=${playable.playableSamples},aresample=48000`,
          "-ac",
          String(channels),
          "-c:a",
          "pcm_f32le",
          "-ar",
          "48000",
        ],
        pcm,
      );
      const pcmPin = nativeFilePin(pcm, root, 64 * 1024 * 1024 - total);
      total += pcmPin.bytes;
      const pcmProbe = JSON.parse(
        (
          await tool("ffprobe", [
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_streams",
            "-of",
            "json",
            pcm,
          ])
        ).toString(),
      ).streams;
      if (
        pcmProbe.length !== 1 ||
        Number(pcmProbe[0].duration_ts) !== exactOutput ||
        pcmProbe[0].time_base !== "1/48000"
      )
        throw Error("Native PCM physical sample count differs");
      normalization.audio = {
        pcm: pcmPin,
        sourceSampleRate: rate,
        sourceSamples: playable.playableSamples,
        decodedSamples: clock.decodedSamples,
        paddingSamples: playable.discardedCodecPaddingSamples,
        outputSamples: exactOutput,
        sampleRate: 48000,
        channels,
        clockHash: sha(frames),
      };
    }
    if (durationSec === undefined || durationSec <= 0 || durationSec > 60)
      throw Error("Native source measured duration unavailable");
    result[name] = NativePreparedSourceSchema.parse({ kind, durationSec, sha256: asset.sha256, normalization });
    if (nativeFilePin(asset.path, root, 32 * 1024 * 1024).sha256 !== original.sha256)
      throw Error("Native original changed during preparation");
  }
  verifyNativePreparedMedia(result, root);
  const output = path.join(root, "native-preparation", "receipt.json"),
    bytes = JSON.stringify(result) + "\n";
  if (Buffer.byteLength(bytes) > 256 * 1024) throw Error("Native normalization receipt byte bound");
  writeFileSync(output + ".tmp", bytes, { flag: "wx" });
  renameSync(output + ".tmp", output);
  return result;
}
export function verifyNativePreparedMedia(input: unknown, root: string): Record<string, NativePreparedSource> {
  const result = z.record(z.string(), NativePreparedSourceSchema).parse(input);
  let total = 0;
  for (const source of Object.values(result)) {
    if (source.sha256 !== source.normalization.original.sha256) throw Error("Native source identity differs");
    for (const pin of [
      source.normalization.original,
      source.normalization.video?.proxy,
      source.normalization.audio?.pcm,
    ].filter((p) => p !== undefined)) {
      const actual = nativeFilePin(path.join(root, pin.path), root);
      if (actual.sha256 !== pin.sha256 || actual.bytes !== pin.bytes) throw Error("Native derived receipt changed");
      total += actual.bytes;
    }
    for (const name of ["ffmpeg", "ffprobe"] as const) {
      const identity = source.normalization.tools[name],
        installed = nativeInstalledToolPath(name);
      if (
        identity.path !== installed ||
        identity.sha256 !== nativeFilePin(installed, path.dirname(installed), 256 * 1024 * 1024).sha256
      )
        throw Error("Native normalization tool identity changed");
    }
    const video = source.normalization.video;
    if (video) validateNativeDecodedClock(video.clock);
    if (
      video &&
      (sha(video.clock) !== video.clockHash ||
        video.frameCount !== video.clock.pts.length ||
        source.durationSec !== (video.clock.terminalTick * video.clock.timebase.num) / video.clock.timebase.den)
    )
      throw Error("Native frame mapping receipt changed");
    const audio = source.normalization.audio;
    if (
      audio &&
      (audio.sourceSamples + audio.paddingSamples !== audio.decodedSamples ||
        audio.outputSamples / 48000 !== audio.sourceSamples / audio.sourceSampleRate ||
        Math.abs(source.durationSec - audio.outputSamples / 48000) > 1 / 48000)
    )
      throw Error("Native audio extent receipt changed");
  }
  if (total > 64 * 1024 * 1024) throw Error("Native aggregate derived assets exceed snapshot bound");
  return result;
}

export function verifyNativeNormalizationReceipt(sources: unknown, root: string, pin: unknown) {
  const receipt = z
      .object({
        path: z.literal("native-preparation/receipt.json"),
        sha256: hash,
        bytes: z
          .number()
          .int()
          .positive()
          .max(256 * 1024),
      })
      .strict()
      .parse(pin),
    file = path.join(root, receipt.path),
    actual = nativeFilePin(file, root, 256 * 1024);
  if (
    actual.sha256 !== receipt.sha256 ||
    actual.bytes !== receipt.bytes ||
    JSON.stringify(readNativeJson(file, root)) !== JSON.stringify(sources)
  )
    throw Error("Native raw normalization receipt changed");
  return verifyNativePreparedMedia(sources, root);
}
