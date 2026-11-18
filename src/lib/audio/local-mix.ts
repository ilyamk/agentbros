import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, linkSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LocalAudioMixSchema, isPlainRelativePath, type LocalAudioMix } from "../../types/audio-master";
import { assertPathWithin } from "../cli";
import { analyzeAudio, mediaProbe } from "./analysis";
import { assertRegularLocalInput, LOCAL_MEDIA_PROTOCOLS, LOCAL_AUDIO_TIMEOUT_MS } from "./local-input";

function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: LOCAL_AUDIO_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0)
    throw new Error(`FFmpeg mix failed: ${result.error?.message ?? result.stderr.slice(-2000)}`);
}
function tempo(rate: number) {
  const filters: string[] = [];
  while (rate > 2) {
    filters.push("atempo=2");
    rate /= 2;
  }
  while (rate < 0.5) {
    filters.push("atempo=0.5");
    rate /= 0.5;
  }
  filters.push(`atempo=${rate}`);
  return filters.join(",");
}
function volume(track: LocalAudioMix["tracks"][number]) {
  let expression = String(track.keyframes.at(-1)?.volume ?? track.volume);
  for (let i = track.keyframes.length - 1; i >= 0; i--) {
    const next = track.keyframes[i],
      previous = track.keyframes[i - 1] ?? { atSec: 0, volume: track.volume };
    if (next.atSec === previous.atSec) {
      expression = String(next.volume);
      continue;
    }
    const ramp = `${previous.volume}+(t-${previous.atSec})*${(next.volume - previous.volume) / (next.atSec - previous.atSec)}`;
    expression = `if(lt(t,${next.atSec}),${ramp},${expression})`;
  }
  return `volume='${expression}':eval=frame`;
}
/** Social delivery: −14 LUFS integrated, −1.5 dBTP (headroom for AAC, so the measure leg passes). Review masters keep the plan's −16 / −1.5. */
export const LOUDNESS_PRESETS = {
  review: { targetLufs: -16, truePeakDb: -1.5 },
  social: { targetLufs: -14, truePeakDb: -1.5 },
} as const;
export type LoudnessPreset = keyof typeof LOUDNESS_PRESETS;

/** sidechaincompress blends dry and compressed music; keeping `1 − mix` dry caps the dip at `duckDb`. */
export const duckMix = (duckDb: number) => Math.round((1 - 10 ** (duckDb / 20)) * 1000) / 1000;

/**
 * A plan read from a file names its own track sources, so they are untrusted:
 * each must be a plain relative path (no `..`, absolute path or protocol such as
 * `http:`, `concat:` or `subfile:`), resolved against `root` (the workspace, or the
 * MCP launcher's scope root) and contained in it. Returns the plan with resolved sources.
 */
export function scopeMixPlanSources(raw: unknown, root: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Mix plan must be a JSON object");
  const plan = raw as Record<string, unknown>;
  if (!Array.isArray(plan.tracks)) return plan;
  const tracks = plan.tracks.map((track: unknown, i: number) => {
    if (!track || typeof track !== "object" || Array.isArray(track)) return track;
    const source = (track as { source?: unknown }).source;
    if (typeof source !== "string") return track;
    // An absolute path (as `projectAudioMix` writes) is accepted only when it is plain and inside the root.
    const plain = path.posix.isAbsolute(source) ? isPlainRelativePath(source.slice(1)) : isPlainRelativePath(source);
    if (!plain)
      throw new Error(`Mix plan track ${i} source must be a plain workspace-relative path: ${JSON.stringify(source)}`);
    // Compare canonical forms (macOS /var vs /private/var), then let assertPathWithin check symlinks.
    const resolved = path.resolve(root, source);
    let ancestor = resolved;
    while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    const canonical = path.resolve(realpathSync(ancestor), path.relative(ancestor, resolved));
    assertPathWithin(realpathSync(root), canonical);
    return { ...track, source: canonical };
  });
  return { ...plan, tracks };
}

export function buildAudioMix(raw: unknown, { meter = false }: { meter?: boolean } = {}) {
  const plan = LocalAudioMixSchema.parse(raw),
    args: string[] = [],
    filters: string[] = [],
    roles: { speech: string[]; music: string[]; sfx: string[] } = {
      speech: [],
      music: [],
      sfx: [],
    };
  plan.tracks.forEach((track, i) => {
    const probe = mediaProbe(track.source);
    if (!probe.streams.some((s) => s.codec_type === "audio")) throw new Error(`Audio stream missing: ${track.source}`);
    const sourceDuration = Number(probe.format.duration);
    const end =
      track.sourceEndSec ??
      (track.loop ? track.sourceStartSec + (plan.durationSec - track.startSec) * track.rate : sourceDuration);
    if (!track.loop && (end > sourceDuration + 0.02 || track.sourceStartSec >= sourceDuration))
      throw new Error(`Source audio interval exceeds media: ${track.source}`);
    const played = (end - track.sourceStartSec) / track.rate;
    if (
      track.role === "speech" &&
      !track.allowSpeechTrim &&
      (track.sourceStartSec > 0 || end < sourceDuration - 0.02 || track.startSec + played > plan.durationSec + 0.02)
    )
      throw new Error(`Mix would cut speech: ${track.source}; use explicit authored trim or extend duration`);
    if (track.loop) args.push("-stream_loop", "-1");
    args.push("-protocol_whitelist", LOCAL_MEDIA_PROTOCOLS, "-i", assertRegularLocalInput(track.source));
    const label = `track${i}`;
    // adelay may emit NOPTS after a trimmed input. Rebuild its zero-origin
    // output clock from emitted samples before project-time gain and padding.
    // Keep the historical no-delay graph unchanged.
    const delayedClock = Math.round(track.startSec * 1000) > 0 ? ",asetpts=N/SR/TB" : "";
    filters.push(
      `[${i}:a]atrim=start=${track.sourceStartSec}:end=${end},asetpts=PTS-STARTPTS,${tempo(track.rate)},adelay=${Math.round(track.startSec * 1000)}:all=1${delayedClock},${volume(track)},apad,atrim=duration=${plan.durationSec},aresample=48000[${label}]`,
    );
    roles[track.role].push(`[${label}]`);
  });
  const buses: string[] = [];
  for (const [role, inputs] of Object.entries(roles))
    if (inputs.length) {
      filters.push(`${inputs.join("")}amix=inputs=${inputs.length}:normalize=0[${role}]`);
      buses.push(role);
    }
  const ducking = plan.duckMusic && roles.music.length > 0 && roles.speech.length > 0;
  if (ducking) {
    filters.push(`[speech]asplit=${meter ? 3 : 2}[speechmix][duckkey]${meter ? "[speechmeter]" : ""}`);
    if (meter) filters.push("[music]asplit=2[musicin][musicmeter]");
    filters.push(
      `[${meter ? "musicin" : "music"}][duckkey]sidechaincompress=threshold=0.005:ratio=20:attack=20:release=250:makeup=1:mix=${duckMix(plan.duckDb)}[${meter ? "musicducked" : "musicduck"}]`,
    );
    if (meter) filters.push("[musicducked]asplit=2[musicduck][duckmeter]");
    buses.splice(buses.indexOf("speech"), 1, "speechmix");
    buses.splice(buses.indexOf("music"), 1, "musicduck");
  }
  filters.push(
    `${buses.map((b) => `[${b}]`).join("")}amix=inputs=${buses.length}:normalize=0,atrim=duration=${plan.durationSec}[master]`,
  );
  if (meter && ducking)
    filters.push(
      "[speechmeter]aformat=channel_layouts=mono[m0];[musicmeter]aformat=channel_layouts=mono[m1];[duckmeter]aformat=channel_layouts=mono[m2];[m0][m1][m2]amerge=inputs=3[meter]",
    );
  return { plan, args, filter: filters.join(";"), metered: meter && ducking };
}

export type DuckMeasurement = {
  /** Music dip while speech plays: median over speech windows of ducked vs dry music, in dB. */
  medianDuckDb: number;
  deepestDuckDb: number;
  /** Music level under the voice, relative to the voice: median of music minus speech RMS, in dB. */
  bedUnderVoiceDb: number;
  speechWindows: number;
  capDb: number;
};

/**
 * Renders speech, dry music and ducked music side by side and compares them in 50 ms windows
 * where speech is above −45 dBFS. Returns undefined when nothing is ducked.
 */
export function measureDuck(raw: unknown): DuckMeasurement | undefined {
  const compiled = buildAudioMix(raw, { meter: true });
  if (!compiled.metered) return undefined;
  const rate = 8000;
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...compiled.args,
      "-filter_complex",
      `${compiled.filter};[master]anullsink`,
      "-map",
      "[meter]",
      "-ar",
      String(rate),
      "-f",
      "f32le",
      "pipe:1",
    ],
    { maxBuffer: 512 * 1024 * 1024, timeout: LOCAL_AUDIO_TIMEOUT_MS, killSignal: "SIGKILL" },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Duck measurement failed: ${result.error?.message ?? String(result.stderr).slice(-1000)}`);
  const samples = new Float32Array(
    result.stdout.buffer,
    result.stdout.byteOffset,
    Math.floor(result.stdout.byteLength / 4),
  );
  const window = rate / 20;
  const db = (value: number) => 10 * Math.log10(Math.max(value, 1e-12));
  const ducks: number[] = [];
  const beds: number[] = [];
  for (let start = 0; (start + window) * 3 <= samples.length; start += window) {
    let speech = 0,
      dry = 0,
      wet = 0;
    for (let i = start; i < start + window; i++) {
      speech += samples[i * 3]! ** 2;
      dry += samples[i * 3 + 1]! ** 2;
      wet += samples[i * 3 + 2]! ** 2;
    }
    if (db(speech / window) < -45 || db(dry / window) < -70) continue;
    ducks.push(db(wet / dry));
    beds.push(db(wet / speech));
  }
  if (!ducks.length) return undefined;
  const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]!;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    medianDuckDb: round(median(ducks)),
    deepestDuckDb: round(Math.min(...ducks)),
    bedUnderVoiceDb: round(median(beds)),
    speechWindows: ducks.length,
    capDb: compiled.plan.duckDb,
  };
}
export function mixLocalAudio(
  raw: unknown,
  output: string,
  { force = false, beforePublish }: { force?: boolean; beforePublish?: () => void } = {},
) {
  if (path.extname(output).toLowerCase() !== ".wav") throw new Error("Audio master output must be .wav");
  if (existsSync(output) && !force) throw new Error(`Output already exists: ${output}`);
  const compiled = buildAudioMix(raw),
    directory = path.dirname(path.resolve(output));
  mkdirSync(directory, { recursive: true });
  const premix = path.join(directory, `.${randomUUID()}.premix.wav`),
    temporary = path.join(directory, `.${randomUUID()}.master.wav`);
  try {
    ffmpeg([
      ...compiled.args,
      "-filter_complex",
      compiled.filter,
      "-map",
      "[master]",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      "pcm_f32le",
      premix,
    ]);
    const analysis = analyzeAudio(premix);
    if (
      analysis.integratedLufs === null ||
      analysis.truePeakDb === null ||
      analysis.loudnessRangeLu === null ||
      analysis.thresholdLufs === null
    )
      throw new Error("Cannot normalize a silent/unmeasurable mix");
    const loudnorm = `loudnorm=I=${compiled.plan.targetLufs}:TP=${compiled.plan.truePeakDb}:LRA=11:measured_I=${analysis.integratedLufs}:measured_TP=${analysis.truePeakDb}:measured_LRA=${analysis.loudnessRangeLu}:measured_thresh=${analysis.thresholdLufs}:linear=true`;
    ffmpeg([
      "-protocol_whitelist",
      LOCAL_MEDIA_PROTOCOLS,
      "-i",
      premix,
      "-af",
      loudnorm,
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      "pcm_s24le",
      temporary,
    ]);
    const measured = analyzeAudio(temporary);
    if (
      measured.integratedLufs === null ||
      measured.truePeakDb === null ||
      Math.abs(measured.integratedLufs - compiled.plan.targetLufs) > 1 ||
      measured.truePeakDb > compiled.plan.truePeakDb + 0.3
    )
      throw new Error("Normalized mix failed loudness/true-peak acceptance; output not published");
    // Measured before publishing, so a failed measurement never leaves a master without its report.
    let duck: DuckMeasurement | undefined;
    let duckWarning: string | undefined;
    try {
      duck = measureDuck(raw);
    } catch (error) {
      duckWarning = error instanceof Error ? error.message : String(error);
    }
    beforePublish?.();
    if (existsSync(output) && !force) throw new Error(`Output appeared during mix: ${output}`);
    if (force) renameSync(temporary, output);
    else linkSync(temporary, output); // Publish without replacing a concurrent writer.

    return { output, analysis: measured, plan: compiled.plan, duck, ...(duckWarning ? { duckWarning } : {}) };
  } finally {
    rmSync(premix, { force: true });
    rmSync(temporary, { force: true });
  }
}
