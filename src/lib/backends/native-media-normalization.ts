import { spawn } from "node:child_process";
import { existsSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const NativeDecodedClockSchema = z
  .object({
    timebase: z.object({ num: positiveInteger.max(1e9), den: positiveInteger.max(1e9) }).strict(),
    pts: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).min(1).max(3600),
    terminalTick: positiveInteger,
  })
  .strict();
export type NativeDecodedClock = z.infer<typeof NativeDecodedClockSchema>;
/** Original clock only. The ordinal proxy has deliberately unrelated presentation timestamps. */
export function validateNativeDecodedClock(input: NativeDecodedClock): NativeDecodedClock {
  const clock = NativeDecodedClockSchema.parse(input),
    num = BigInt(clock.timebase.num),
    den = BigInt(clock.timebase.den);
  if (
    clock.pts[0] !== 0 ||
    BigInt(clock.terminalTick) * num > 60n * den ||
    clock.pts.some((p, i) => i > 0 && p <= clock.pts[i - 1]!) ||
    clock.terminalTick <= clock.pts.at(-1)!
  )
    throw Error("Invalid zero-origin decoded video clock");
  const boundaries = [...clock.pts, clock.terminalTick].map((p) => {
    const product = BigInt(p) * num;
    if (product > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("Unsupported native video boundary precision");
    return Number(product) / clock.timebase.den;
  });
  if (boundaries.some((value, i) => !Number.isFinite(value) || (i > 0 && value <= boundaries[i - 1]!)))
    throw Error("Unsupported collapsed native video boundaries");
  return clock;
}
export function nativeDecodedFrameAt(input: NativeDecodedClock, timeSec: number): number {
  const clock = validateNativeDecodedClock(input);
  if (
    !Number.isFinite(timeSec) ||
    timeSec < 0 ||
    timeSec >= (clock.terminalTick * clock.timebase.num) / clock.timebase.den
  )
    throw Error("Native source time outside measured extent");
  let low = 0,
    high = clock.pts.length;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if ((clock.pts[mid]! * clock.timebase.num) / clock.timebase.den <= timeSec) low = mid;
    else high = mid;
  }
  return low;
}
export function nativeDecodedClockFromFrames(
  frames: ReadonlyArray<{ pts: number; duration: number }>,
  timebase: { num: number; den: number },
  terminalTick: number,
) {
  const clock = validateNativeDecodedClock({ timebase, pts: frames.map((f) => f.pts), terminalTick });
  for (let i = 0; i < frames.length; i++)
    if (
      !Number.isSafeInteger(frames[i]!.duration) ||
      frames[i]!.duration <= 0 ||
      BigInt(frames[i]!.pts) + BigInt(frames[i]!.duration) !== BigInt(frames[i + 1]?.pts ?? terminalTick)
    )
      throw Error("Decoded video frame extent is gapped/overlapping or terminal is ambiguous");
  return clock;
}
export function nativeAudioClock(
  frames: ReadonlyArray<{ pts: number; nbSamples: number }>,
  timebase: { num: number; den: number },
  sampleRate: number,
) {
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    !Number.isSafeInteger(timebase.num) ||
    !Number.isSafeInteger(timebase.den) ||
    timebase.num <= 0 ||
    timebase.den <= 0 ||
    !frames.length ||
    frames.length > 12000
  )
    throw Error("Invalid decoded audio clock bounds");
  let samples = 0;
  for (const frame of frames) {
    if (
      !Number.isSafeInteger(frame.pts) ||
      frame.pts < 0 ||
      !Number.isSafeInteger(frame.nbSamples) ||
      frame.nbSamples < 1 ||
      frame.nbSamples > 65536 ||
      BigInt(frame.pts) * BigInt(timebase.num) * BigInt(sampleRate) !== BigInt(samples) * BigInt(timebase.den)
    )
      throw Error("Audio decoded clock is offset/gapped/overlapping");
    samples += frame.nbSamples;
    if (samples / sampleRate > 60 + 65536 / sampleRate) throw Error("Decoded audio duration exceeds bound");
  }
  return { sampleRate, decodedSamples: samples, decodedDurationSec: samples / sampleRate };
}
/** Explicit physical stream extent may trim codec padding; cannot fabricate missing decoded samples. */
export function nativePlayableSamples(
  decoded: number,
  rate: number,
  durationTicks: number,
  timebase: { num: number; den: number },
) {
  if (
    ![decoded, rate, durationTicks, timebase.num, timebase.den].every(Number.isSafeInteger) ||
    decoded <= 0 ||
    rate < 8000 ||
    rate > 192000 ||
    durationTicks <= 0 ||
    timebase.num <= 0 ||
    timebase.den <= 0
  )
    throw Error("Invalid playable audio extent");
  const numerator = BigInt(durationTicks) * BigInt(timebase.num) * BigInt(rate),
    denominator = BigInt(timebase.den);
  if (numerator % denominator !== 0n || numerator / denominator > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error("Ambiguous fractional audio terminal extent");
  const playable = Number(numerator / denominator);
  if (playable > decoded || decoded - playable > 4096 || playable <= 0 || playable / rate > 60)
    throw Error("Ambiguous audio terminal extent or missing content");
  return { playableSamples: playable, discardedCodecPaddingSamples: decoded - playable };
}

export function nativeInstalledToolPath(name: "ffmpeg" | "ffprobe") {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const file = path.join(directory, name);
    if (existsSync(file) && statSync(file).isFile()) return realpathSync(file);
  }
  throw Error(`Installed ${name} required; no automatic download`);
}
/** Trusted fixed-tool CPU feasibility runner. No authored executable, shell, provider environment or network. */
export function runNativeNormalizationTool(
  name: "ffmpeg" | "ffprobe",
  argv: string[],
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    outputFile?: string;
    maxFileBytes?: number;
    signal?: AbortSignal;
    managedGroup?: boolean;
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 10000,
    limit = options.maxOutputBytes ?? 4 * 1024 * 1024;
  if (
    options.maxFileBytes !== undefined &&
    (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1 || options.maxFileBytes > 64 * 1024 * 1024)
  )
    throw Error("Invalid native proxy disk limit");
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 16 * 1024 * 1024 ||
    options.signal?.aborted
  )
    throw Error("Invalid native preparation bounds or cancelled");
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
    throw Error("OS deny-network native preparation unavailable");
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", "(version 1)(allow default)(deny network*)", nativeInstalledToolPath(name), ...argv],
      {
        shell: false,
        detached: !options.managedGroup,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      },
    );
    let output = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      failure: Error | undefined,
      closed = false;
    const kill = () => {
      if (closed || !child.pid) return;
      if (options.managedGroup) {
        child.kill("SIGKILL");
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const abort = (message: string) => {
      failure ??= Error(message);
      kill();
    };
    const cancelled = () => abort("Native preparation cancelled");
    process.once("SIGTERM", cancelled);
    process.once("disconnect", cancelled);
    options.signal?.addEventListener("abort", cancelled, { once: true });
    const timer = setTimeout(() => abort("Native preparation deadline exceeded"), timeoutMs);
    const fileWatch = setInterval(() => {
      try {
        if (
          options.outputFile &&
          existsSync(options.outputFile) &&
          statSync(options.outputFile).size > (options.maxFileBytes ?? 64 * 1024 * 1024)
        )
          abort("Native proxy disk bound exceeded");
      } catch (error) {
        abort(String(error));
      }
    }, 10);
    child.stdout.on("data", (bytes: Buffer) => {
      if (output.length + bytes.length > limit) abort("Native preparation stdout bound exceeded");
      else output = Buffer.concat([output, bytes]);
    });
    child.stderr.on("data", (bytes: Buffer) => {
      if (stderr.length + bytes.length > 65536) abort("Native preparation stderr bound exceeded");
      else stderr = Buffer.concat([stderr, bytes]);
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timer);
      clearInterval(fileWatch);
      options.signal?.removeEventListener("abort", cancelled);
      process.off("SIGTERM", cancelled);
      process.off("disconnect", cancelled);
      if (
        !failure &&
        options.outputFile &&
        existsSync(options.outputFile) &&
        statSync(options.outputFile).size > (options.maxFileBytes ?? 64 * 1024 * 1024)
      )
        failure = Error("Native proxy disk bound exceeded");
      if (failure) reject(failure);
      else if (code !== 0) reject(Error(`Native ${name} failed: ${stderr.toString().slice(-1000)}`));
      else resolve(output);
    });
  });
}
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeNormalizationReceiptSchema = z
  .object({
    version: z.literal(1),
    contract: z.literal("decoded-source-proxy-v1"),
    originalHash: sha256,
    ffmpegVersion: z.string().min(1).max(300),
    ffprobeVersion: z.string().min(1).max(300),
    video: z
      .object({
        clock: NativeDecodedClockSchema,
        clockHash: sha256,
        ordinalRate: positiveInteger.max(60),
        proxyHash: sha256,
        proxyBytes: positiveInteger.max(64 * 1024 * 1024),
        decodedFrames: positiveInteger.max(3600),
      })
      .strict()
      .optional(),
    audio: z
      .object({
        sampleRate: positiveInteger.max(192000),
        decodedSamples: positiveInteger,
        playableSamples: positiveInteger,
        discardedCodecPaddingSamples: z.number().int().nonnegative().max(4096),
        pcmHash: sha256,
        pcmBytes: positiveInteger.max(64 * 1024 * 1024),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((r, c) => {
    if (!r.video && !r.audio) c.addIssue({ code: "custom", message: "Normalization requires media evidence" });
    if (r.video) {
      try {
        validateNativeDecodedClock(r.video.clock);
      } catch {
        c.addIssue({ code: "custom", message: "Invalid original source clock" });
      }
      if (r.video.decodedFrames !== r.video.clock.pts.length)
        c.addIssue({ code: "custom", message: "Proxy frame count differs from source" });
    }
    if (
      r.audio &&
      (r.audio.playableSamples + r.audio.discardedCodecPaddingSamples !== r.audio.decodedSamples ||
        r.audio.playableSamples / r.audio.sampleRate > 60)
    )
      c.addIssue({ code: "custom", message: "Audio sample extent differs" });
  });
