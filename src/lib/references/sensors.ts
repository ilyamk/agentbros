/**
 * Mechanical reference sensors (RFC 0003 §10.3, D10): local ffmpeg/ffprobe measurements of a reference file, no ML.
 * A sensor is evidence, never a verdict: compile refuses on slot limits, sensors only report what they measured
 * with a severity a person or agent weighs. Pure metric functions are exported for packs and derive; the ffmpeg
 * layer below them decodes small grayscale frames and parses filter summaries.
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { inspectAsset } from "../assets/inspect";
import { probeVideo } from "../vision/media";
import type { Slot } from "../../types/reference-profiles";
import type { Modality, ReferenceRole } from "../../types/references";

/**
 * Heuristic thresholds. Each is a starting point calibrated on synthetic media, not a law: a reading above one is
 * reported as `warn` (or `fail` where named) for a reviewer to weigh against the board (D10). Change one only with a
 * test, through the creative-postmortem route when a problem repeats.
 */
export const SENSOR_THRESHOLDS = {
  /** Border band width as a fraction of the short edge (neutral-background heuristic). */
  borderBandFraction: 0.06,
  /** Std-dev of 8-bit luminance inside the border band; a plain studio backdrop stays well below. */
  borderStdDevWarn: 12,
  /** Grid used for the even-light heuristic (cells per side). */
  luminanceGrid: 4,
  /** Coefficient of variation (std/mean) of the grid cells' mean luminance; a strong gradient or hot spot is above. */
  luminanceSpreadWarn: 0.25,
  /** Long edge of the downscaled grayscale frames every picture metric reads. */
  analysisEdge: 128,
  /** Frames read for temporal metrics (flicker, camera motion), from the start of the clip. */
  temporalFrames: 90,
  /** Still frames sampled across a video for border and luminance (worst frame reported). */
  sampledFrames: 5,
  /** Mean |Δ mean luminance| between consecutive frames (8-bit levels): global brightness flicker of a control video. */
  flickerWarn: 3,
  /** Mean absolute per-pixel difference of consecutive frames inside the border band (8-bit levels): camera motion. */
  cameraMotionWarn: 4,
  /** ffmpeg scene score above which a frame starts a new shot. */
  sceneCutScore: 0.4,
  /** blackdetect: minimum black run (s) and pixel threshold. */
  blackMinSec: 0.1,
  blackPixelThreshold: 0.1,
  /** freezedetect: noise tolerance (dB) and minimum frozen run (s). */
  freezeNoiseDb: -60,
  freezeMinSec: 0.5,
  /** Black or frozen share of the clip that turns the warning into a fail (the clip shows nothing usable). */
  deadShareFail: 0.9,
  /** Peak at or above this (dBFS) reads as clipped or at full scale. */
  clipPeakDb: -0.1,
  /** RMS peak minus RMS trough (dB, 50 ms windows): below this, the quietest passages are not much quieter than speech. */
  snrWarnDb: 30,
  /** silencedetect noise level (dB) and minimum run (s). */
  silenceNoiseDb: -50,
  silenceMinSec: 0.3,
  /** Silent share of a voice sample above which it carries too little speech. */
  silenceRatioWarn: 0.5,
  /** Floor for -inf dB readings so receipts hold finite numbers. */
  dbFloor: -120,
  /** Default minimum yaw separation (degrees) for angle diversity, as the coverage policy's minDistinctYawDeg. */
  minDistinctYawDeg: 30,
} as const;

export type SensorSeverity = "ok" | "warn" | "fail";
export type SensorResult = {
  id: string;
  value: number | string | null;
  threshold?: number | string;
  severity: SensorSeverity;
  message: string;
};

export type SensorId =
  | "format"
  | "alpha"
  | "border"
  | "luminance"
  | "black-frozen"
  | "cuts"
  | "camera-motion"
  | "flicker"
  | "frame-count"
  | "duration"
  | "audio";

const IMAGE_ROLES = new Set<ReferenceRole>([
  "identity",
  "wardrobe",
  "expression",
  "prop",
  "product",
  "first-frame",
  "last-frame",
  "keyframe",
]);
const SCENE_ROLES = new Set<ReferenceRole>(["location", "lighting", "style"]);
const PERFORMANCE_ROLES = new Set<ReferenceRole>(["motion", "performance"]);
const CONTROL_ROLES = new Set<ReferenceRole>(["depth", "pose", "edge", "mask"]);

/**
 * Which sensors fit a reference role and modality. Subject roles get the neutral-background and even-light
 * heuristics; scene roles (location, lighting, style) only even light, since their border is the scene itself.
 */
export function sensorsForRole(role: ReferenceRole, modality: Modality): SensorId[] {
  const out: SensorId[] = ["format"];
  if (modality === "audio") {
    out.push("duration", "audio");
    return out;
  }
  if (modality === "image") out.push("alpha");
  if (IMAGE_ROLES.has(role)) out.push("border", "luminance");
  else if (SCENE_ROLES.has(role)) out.push("luminance");
  if (modality === "video") {
    if (PERFORMANCE_ROLES.has(role)) out.push("cuts", "camera-motion", "black-frozen", "duration");
    else if (role === "camera") out.push("cuts", "black-frozen", "duration");
    // A remix or restyle source may legitimately hold cuts.
    else if (role === "source-video") out.push("black-frozen", "duration");
    else if (CONTROL_ROLES.has(role)) out.push("flicker", "frame-count");
    else out.push("duration");
  }
  return out;
}

// --- Pure metrics ---

/** A grayscale frame, row-major, one byte per pixel. */
export type GrayFrame = { width: number; height: number; data: Uint8Array };

const mean = (values: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i]!;
  return values.length ? sum / values.length : 0;
};
const stdDev = (values: ArrayLike<number>) => {
  const m = mean(values);
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += (values[i]! - m) ** 2;
  return values.length ? Math.sqrt(sum / values.length) : 0;
};
const round = (value: number, digits = 3) => Number(value.toFixed(digits));

const bandWidth = (frame: GrayFrame) =>
  Math.max(1, Math.round(Math.min(frame.width, frame.height) * SENSOR_THRESHOLDS.borderBandFraction));
const inBand = (x: number, y: number, frame: GrayFrame, band: number) =>
  x < band || y < band || x >= frame.width - band || y >= frame.height - band;

/** Std-dev of luminance in the border band (8-bit levels). */
export function borderStdDev(frame: GrayFrame): number {
  const band = bandWidth(frame);
  const values: number[] = [];
  for (let y = 0; y < frame.height; y++)
    for (let x = 0; x < frame.width; x++) if (inBand(x, y, frame, band)) values.push(frame.data[y * frame.width + x]!);
  return stdDev(values);
}

/** Coefficient of variation of the mean luminance of a grid of cells (0 for flat light). */
export function luminanceSpread(frame: GrayFrame, grid: number = SENSOR_THRESHOLDS.luminanceGrid): number {
  const cells: number[] = [];
  for (let gy = 0; gy < grid; gy++)
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.floor((gx * frame.width) / grid),
        x1 = Math.floor(((gx + 1) * frame.width) / grid);
      const y0 = Math.floor((gy * frame.height) / grid),
        y1 = Math.floor(((gy + 1) * frame.height) / grid);
      let sum = 0,
        count = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          sum += frame.data[y * frame.width + x]!;
          count++;
        }
      if (count) cells.push(sum / count);
    }
  const m = mean(cells);
  return m > 0 ? stdDev(cells) / m : 0;
}

/** Mean |Δ mean luminance| between consecutive frames: global brightness flicker. */
export function temporalFlicker(frames: GrayFrame[]): number {
  if (frames.length < 2) return 0;
  const means = frames.map((frame) => mean(frame.data));
  let sum = 0;
  for (let i = 1; i < means.length; i++) sum += Math.abs(means[i]! - means[i - 1]!);
  return sum / (means.length - 1);
}

/**
 * Mean absolute per-pixel difference of consecutive frames inside the border band. The border is mostly background,
 * so a moving subject barely registers while a pan, tilt or handheld shake moves every border pixel.
 */
export function cameraMotion(frames: GrayFrame[]): number {
  if (frames.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!,
      b = frames[i]!;
    const band = bandWidth(b);
    let sum = 0,
      count = 0;
    for (let y = 0; y < b.height; y++)
      for (let x = 0; x < b.width; x++)
        if (inBand(x, y, b, band)) {
          const index = y * b.width + x;
          sum += Math.abs(b.data[index]! - a.data[index]!);
          count++;
        }
    total += count ? sum / count : 0;
  }
  return total / (frames.length - 1);
}

const yawDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

/** Angle diversity from declared yaws, with the coverage policy's greedy "picked ≥ n° apart" logic. */
export function yawDiversity(yaws: number[], minimumDeg: number = SENSOR_THRESHOLDS.minDistinctYawDeg): SensorResult {
  const picked: number[] = [];
  for (const yaw of [...yaws].sort((a, b) => a - b))
    if (picked.every((other) => yawDistance(yaw, other) >= minimumDeg)) picked.push(yaw);
  const close = yaws.some((yaw, i) => yaws.some((other, j) => i !== j && yawDistance(yaw, other) < minimumDeg));
  const base = { id: "angles.distinctYaws", value: picked.length, threshold: minimumDeg };
  if (picked.length < 2)
    return {
      ...base,
      severity: "warn",
      message: `Declared yaws give ${picked.length} distinct view(s) ${minimumDeg}° apart; at least two are needed.`,
    };
  if (close)
    return {
      ...base,
      severity: "warn",
      message: `${picked.length} distinct views, but some declared yaws are less than ${minimumDeg}° apart (near duplicates).`,
    };
  return { ...base, severity: "ok", message: `${picked.length} distinct views ${minimumDeg}° or more apart.` };
}

// --- ffmpeg layer ---

const TIMEOUT_MS = 300_000;
function ffmpeg(args: string[], maxBuffer = 64 * 1024 * 1024) {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", ...args], { timeout: TIMEOUT_MS, maxBuffer });
  if (result.error || result.status !== 0)
    throw new Error(`ffmpeg failed: ${result.error?.message ?? result.stderr?.toString().slice(-500)}`);
  return { stdout: result.stdout as Buffer, stderr: result.stderr?.toString() ?? "" };
}

function analysisSize(width: number, height: number): [number, number] {
  const scale = SENSOR_THRESHOLDS.analysisEdge / Math.max(width, height);
  const even = (value: number) => Math.max(2, Math.round((value * Math.min(1, scale)) / 2) * 2);
  return [even(width), even(height)];
}

/** Decodes frames as downscaled 8-bit grayscale; `filter` selects frames before scaling. */
function decodeGray(file: string, size: [number, number], options: { filter?: string; maxFrames: number }) {
  const [width, height] = size;
  const chain = [options.filter, `scale=${width}:${height}:flags=area`, "format=gray"].filter(Boolean).join(",");
  const { stdout } = ffmpeg([
    "-v",
    "error",
    "-i",
    file,
    "-map",
    "0:v:0",
    "-vf",
    chain,
    "-fps_mode",
    "passthrough",
    "-frames:v",
    String(options.maxFrames),
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "pipe:1",
  ]);
  const frameBytes = width * height;
  const frames: GrayFrame[] = [];
  for (let offset = 0; offset + frameBytes <= stdout.length; offset += frameBytes)
    frames.push({ width, height, data: new Uint8Array(stdout.subarray(offset, offset + frameBytes)) });
  return frames;
}

/** Runs an analysis filter and returns its info-level log. */
function filterLog(file: string, filter: string, stream: "v" | "a") {
  return ffmpeg(["-v", "info", "-i", file, "-map", `0:${stream}:0`, `-${stream}f`, filter, "-f", "null", "-"]).stderr;
}

const numbers = (log: string, key: string) =>
  [...log.matchAll(new RegExp(`${key}:\\s*(-?[0-9.]+)`, "g"))].map((match) => Number(match[1]));

function intervalsTotal(log: string, startKey: string, endKey: string, durationSec: number) {
  const starts = numbers(log, startKey),
    ends = numbers(log, endKey);
  let total = 0;
  starts.forEach((start, i) => (total += Math.max(0, (ends[i] ?? durationSec) - start)));
  return Math.min(total, durationSec);
}

type Media = {
  kind: "image" | "video" | "audio";
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  fps?: number;
  durationSec?: number;
  frameCount?: number;
  hasAlpha?: boolean;
  hasAudio: boolean;
};

function inspect(file: string): Media {
  const inspected = inspectAsset(file);
  const video = inspected.kind === "video" ? probeVideo(file) : undefined;
  const durationSec = video?.durationSec ?? inspected.media.durationSec;
  return {
    kind: inspected.kind,
    mime: inspected.mime,
    bytes: statSync(file).size,
    width: video?.width ?? inspected.media.width,
    height: video?.height ?? inspected.media.height,
    ...(video ? { fps: video.fps, frameCount: video.frameCount } : {}),
    ...(inspected.kind !== "image" && durationSec ? { durationSec } : {}),
    hasAlpha: inspected.media.hasAlpha === true,
    hasAudio: inspected.media.hasAudio,
  };
}

const ok = (id: string, value: SensorResult["value"], message: string, threshold?: number | string): SensorResult => ({
  id,
  value,
  ...(threshold !== undefined ? { threshold } : {}),
  severity: "ok",
  message,
});
const warn = (
  id: string,
  value: SensorResult["value"],
  message: string,
  threshold?: number | string,
): SensorResult => ({
  id,
  value,
  ...(threshold !== undefined ? { threshold } : {}),
  severity: "warn",
  message,
});
const fail = (
  id: string,
  value: SensorResult["value"],
  message: string,
  threshold?: number | string,
): SensorResult => ({
  id,
  value,
  ...(threshold !== undefined ? { threshold } : {}),
  severity: "fail",
  message,
});

/** Size and format against a slot (reported, not refused: compile refuses). Without a slot, the measured values. */
export function formatSensors(media: Media, slot?: Slot): SensorResult[] {
  const out: SensorResult[] = [];
  const { width, height } = media;
  if (width && height) {
    const short = Math.min(width, height),
      long = Math.max(width, height),
      aspect = width / height;
    const p = slot?.pixels;
    out.push(
      p?.minEdge !== undefined && short < p.minEdge
        ? fail("format.shortEdge", short, `Short edge ${short} px is below ${p.minEdge} px.`, p.minEdge)
        : ok("format.shortEdge", short, `Short edge ${short} px.`, p?.minEdge),
      p?.maxEdge !== undefined && long > p.maxEdge
        ? fail("format.longEdge", long, `Long edge ${long} px exceeds ${p.maxEdge} px.`, p.maxEdge)
        : ok("format.longEdge", long, `Long edge ${long} px.`, p?.maxEdge),
    );
    if (p?.aspect && (aspect < p.aspect[0] - 1e-9 || aspect > p.aspect[1] + 1e-9))
      out.push(
        fail(
          "format.aspect",
          round(aspect),
          `Aspect ${aspect.toFixed(3)} is outside ${p.aspect[0]}–${p.aspect[1]}.`,
          `${p.aspect[0]}-${p.aspect[1]}`,
        ),
      );
    else out.push(ok("format.aspect", round(aspect), `Aspect ${aspect.toFixed(3)}.`));
    if (p?.multipleOf !== undefined && (width % p.multipleOf || height % p.multipleOf))
      out.push(
        fail(
          "format.multipleOf",
          p.multipleOf,
          `${width}×${height} is not a multiple of ${p.multipleOf}.`,
          p.multipleOf,
        ),
      );
  }
  if (media.kind === "video" && media.fps !== undefined) {
    const range = slot?.fps;
    out.push(
      range && (media.fps < range[0] || media.fps > range[1])
        ? fail("format.fps", round(media.fps), `${round(media.fps)} fps is outside ${range[0]}–${range[1]} fps.`)
        : ok("format.fps", round(media.fps), `${round(media.fps)} fps.`),
    );
  }
  out.push(
    slot?.maxBytes !== undefined && media.bytes > slot.maxBytes
      ? fail("format.bytes", media.bytes, `${media.bytes} bytes exceed ${slot.maxBytes}.`, slot.maxBytes)
      : ok("format.bytes", media.bytes, `${media.bytes} bytes.`, slot?.maxBytes),
  );
  out.push(
    slot?.formats && !slot.formats.includes(media.mime)
      ? fail("format.mime", media.mime, `${media.mime} is not accepted (${slot.formats.join(", ")}).`)
      : ok("format.mime", media.mime, `${media.mime}.`),
  );
  return out;
}

/** Duration against a window (a slot's durationSec range when given). */
export function durationSensor(durationSec: number | undefined, slot?: Slot): SensorResult {
  if (durationSec === undefined) return warn("duration", null, "Duration could not be measured.");
  const d = slot?.durationSec;
  const value = round(durationSec);
  if (d && durationSec < d.min) return fail("duration", value, `Duration ${value} s is below ${d.min} s.`, d.min);
  if (d && durationSec > d.max) return fail("duration", value, `Duration ${value} s exceeds ${d.max} s.`, d.max);
  return ok("duration", value, d ? `Duration ${value} s within ${d.min}–${d.max} s.` : `Duration ${value} s.`);
}

/** Transparency versus the slot's stated alpha handling. */
export function alphaSensor(hasAlpha: boolean, slot?: Slot): SensorResult {
  const value = hasAlpha ? 1 : 0;
  if (!hasAlpha) return ok("alpha", value, "No alpha channel.");
  if (!slot) return ok("alpha", value, "Has an alpha channel.");
  if (slot.alpha === "supported") return ok("alpha", value, "Has alpha; the slot supports it.", slot.alpha);
  if (slot.alpha === "flatten")
    return warn("alpha", value, "Has alpha; the slot flattens it, so add a flatten derivative.", slot.alpha);
  return warn("alpha", value, "Has alpha; the slot does not state alpha handling.", slot.alpha);
}

function pictureFrames(file: string, media: Media): GrayFrame[] {
  if (!media.width || !media.height) return [];
  const size = analysisSize(media.width, media.height);
  if (media.kind === "image") return decodeGray(file, size, { maxFrames: 1 });
  const count = SENSOR_THRESHOLDS.sampledFrames;
  const total = media.frameCount ?? count;
  const step = Math.max(1, Math.floor(total / count));
  return decodeGray(file, size, { filter: `select='not(mod(n\\,${step}))'`, maxFrames: count });
}

function borderSensor(frames: GrayFrame[]): SensorResult {
  const worst = Math.max(...frames.map(borderStdDev));
  const value = round(worst, 2),
    limit = SENSOR_THRESHOLDS.borderStdDevWarn;
  return worst > limit
    ? warn(
        "border.stdDev",
        value,
        `Border luminance std-dev ${value} is above ${limit}: the background is busy or the subject touches the edge (neutral-background heuristic).`,
        limit,
      )
    : ok("border.stdDev", value, `Border luminance std-dev ${value}: a uniform background.`, limit);
}

function luminanceSensor(frames: GrayFrame[]): SensorResult {
  const worst = Math.max(...frames.map((frame) => luminanceSpread(frame)));
  const value = round(worst),
    limit = SENSOR_THRESHOLDS.luminanceSpreadWarn;
  return worst > limit
    ? warn(
        "luminance.spread",
        value,
        `Luminance spread ${value} across a ${SENSOR_THRESHOLDS.luminanceGrid}×${SENSOR_THRESHOLDS.luminanceGrid} grid is above ${limit}: uneven light or a hot spot (even-light heuristic).`,
        limit,
      )
    : ok("luminance.spread", value, `Luminance spread ${value}: even light.`, limit);
}

function temporalFrames(file: string, media: Media): GrayFrame[] {
  if (!media.width || !media.height) return [];
  return decodeGray(file, analysisSize(media.width, media.height), { maxFrames: SENSOR_THRESHOLDS.temporalFrames });
}

function cutsSensor(file: string, role: ReferenceRole, refuseCuts: boolean): SensorResult {
  const score = SENSOR_THRESHOLDS.sceneCutScore;
  const log = filterLog(file, `select='gt(scene\\,${score})',showinfo`, "v");
  const times = numbers(log, "pts_time");
  const count = times.length;
  if (!count) return ok("cuts.count", 0, "No scene cut inside the clip.", score);
  const at = times
    .slice(0, 5)
    .map((t) => `${round(t, 2)} s`)
    .join(", ");
  const message = `${count} scene cut(s) at ${at}: a ${role} reference should be one continuous shot.`;
  return refuseCuts
    ? fail("cuts.count", count, `${message} Refused for this profile.`, score)
    : warn("cuts.count", count, message, score);
}

function blackFrozenSensors(file: string, media: Media): SensorResult[] {
  const duration = media.durationSec ?? 0;
  const t = SENSOR_THRESHOLDS;
  const log = filterLog(
    file,
    `blackdetect=d=${t.blackMinSec}:pix_th=${t.blackPixelThreshold},freezedetect=n=${t.freezeNoiseDb}dB:d=${t.freezeMinSec}`,
    "v",
  );
  const black = duration ? numbers(log, "black_duration").reduce((a, b) => a + b, 0) : 0;
  const frozen = duration ? intervalsTotal(log, "freeze_start", "freeze_end", duration) : 0;
  const result = (id: string, seconds: number, what: string) => {
    const share = duration ? seconds / duration : 0;
    const value = round(share);
    if (share >= t.deadShareFail)
      return fail(
        id,
        value,
        `${what} for ${round(seconds, 2)} s, ${Math.round(share * 100)}% of the clip.`,
        t.deadShareFail,
      );
    if (seconds > 0)
      return warn(id, value, `${what} for ${round(seconds, 2)} s (${Math.round(share * 100)}% of the clip).`);
    return ok(id, 0, `No ${what.toLowerCase()} run.`);
  };
  return [result("black.share", black, "Black frames"), result("frozen.share", frozen, "Frozen frames")];
}

function cameraMotionSensor(frames: GrayFrame[]): SensorResult {
  const value = round(cameraMotion(frames), 2),
    limit = SENSOR_THRESHOLDS.cameraMotionWarn;
  return value > limit
    ? warn(
        "camera.motion",
        value,
        `Border motion ${value} is above ${limit}: the camera moves (pan, tilt or shake), which a motion-transfer model copies.`,
        limit,
      )
    : ok("camera.motion", value, `Border motion ${value}: a steady camera.`, limit);
}

function flickerSensor(frames: GrayFrame[]): SensorResult {
  const value = round(temporalFlicker(frames), 2),
    limit = SENSOR_THRESHOLDS.flickerWarn;
  return value > limit
    ? warn(
        "temporal.flicker",
        value,
        `Frame-to-frame luminance change ${value} is above ${limit}: the control video flickers.`,
        limit,
      )
    : ok("temporal.flicker", value, `Frame-to-frame luminance change ${value}: temporally stable.`, limit);
}

const finiteDb = (value: number | undefined) =>
  value === undefined || Number.isNaN(value) ? undefined : Math.max(SENSOR_THRESHOLDS.dbFloor, value);
function overall(log: string, key: string): number | undefined {
  const block = log.slice(log.lastIndexOf("Overall"));
  const match = block.match(new RegExp(`${key}:\\s*(-?inf|-?[0-9.]+)`));
  if (!match) return undefined;
  return match[1]!.endsWith("inf") ? (match[1]!.startsWith("-") ? -Infinity : Infinity) : Number(match[1]);
}

function audioSensors(file: string, durationSec: number | undefined, role: ReferenceRole): SensorResult[] {
  const t = SENSOR_THRESHOLDS;
  const log = filterLog(
    file,
    `astats=metadata=0:length=0.05,silencedetect=n=${t.silenceNoiseDb}dB:d=${t.silenceMinSec}`,
    "a",
  );
  const out: SensorResult[] = [];
  const peak = finiteDb(overall(log, "Peak level dB"));
  if (peak === undefined) out.push(warn("audio.peakDb", null, "astats printed no peak level."));
  else if (peak >= t.clipPeakDb)
    out.push(
      fail("audio.peakDb", round(peak, 2), `Peak ${round(peak, 2)} dBFS: clipped or at full scale.`, t.clipPeakDb),
    );
  else out.push(ok("audio.peakDb", round(peak, 2), `Peak ${round(peak, 2)} dBFS.`, t.clipPeakDb));
  if (role === "voice") {
    const rmsPeak = finiteDb(overall(log, "RMS peak dB"));
    const trough = finiteDb(overall(log, "RMS (?:trough|through) dB"));
    if (rmsPeak === undefined || trough === undefined)
      out.push(warn("audio.snrDb", null, "astats printed no RMS peak or trough."));
    else {
      const snr = round(rmsPeak - trough, 2);
      out.push(
        snr < t.snrWarnDb
          ? warn(
              "audio.snrDb",
              snr,
              `Quietest passages sit ${snr} dB under the loudest (noise floor ${round(trough, 1)} dBFS): background noise or no pauses (SNR estimate).`,
              t.snrWarnDb,
            )
          : ok("audio.snrDb", snr, `Estimated SNR ${snr} dB (noise floor ${round(trough, 1)} dBFS).`, t.snrWarnDb),
      );
    }
    if (durationSec) {
      const silent = intervalsTotal(log, "silence_start", "silence_end", durationSec);
      const ratio = round(silent / durationSec);
      out.push(
        ratio > t.silenceRatioWarn
          ? warn(
              "audio.silenceRatio",
              ratio,
              `${Math.round(ratio * 100)}% of the sample is silence.`,
              t.silenceRatioWarn,
            )
          : ok("audio.silenceRatio", ratio, `${Math.round(ratio * 100)}% silence.`, t.silenceRatioWarn),
      );
    }
  }
  return out;
}

export type ReferenceSensorInput = {
  file: string;
  role: ReferenceRole;
  modality: Modality;
  /** The profile slot the file is meant for: limits become sensor thresholds. */
  slot?: Slot;
  /** Scene cuts fail instead of warn (e.g. a Kling motion-control profile); the caller decides from the profile. */
  refuseCuts?: boolean;
  /** Declared yaws of the entity's angle views, for angle diversity. */
  yaws?: number[];
};

/**
 * Runs the sensors for a role and modality. Never throws for a sensor: one that cannot run (no ffmpeg, an
 * unreadable stream) returns a `warn` naming itself, so a derive or pack never fails because of evidence.
 */
export function runReferenceSensors(input: ReferenceSensorInput): SensorResult[] {
  const results: SensorResult[] = [];
  const guard = (id: string, run: () => SensorResult | SensorResult[]) => {
    try {
      const out = run();
      results.push(...(Array.isArray(out) ? out : [out]));
    } catch (error) {
      results.push(warn(id, null, `Sensor ${id} could not run: ${(error as Error).message.slice(0, 300)}`));
    }
  };
  let media: Media | undefined;
  guard("inspect", () => {
    media = inspect(input.file);
    return [];
  });
  if (input.yaws?.length) results.push(yawDiversity(input.yaws));
  if (!media) return results;
  const m = media;
  if (m.kind !== input.modality)
    results.push(warn("modality", m.kind, `The file is ${m.kind}, not the ${input.modality} the role expects.`));
  const sensors = sensorsForRole(input.role, m.kind);
  let pictures: GrayFrame[] | undefined;
  const picture = () => (pictures ??= pictureFrames(input.file, m));
  let sequence: GrayFrame[] | undefined;
  const temporal = () => (sequence ??= temporalFrames(input.file, m));
  for (const sensor of sensors)
    guard(sensor, () => {
      switch (sensor) {
        case "format":
          return formatSensors(m, input.slot);
        case "alpha":
          return alphaSensor(m.hasAlpha === true, input.slot);
        case "border":
          return picture().length ? borderSensor(picture()) : [];
        case "luminance":
          return picture().length ? luminanceSensor(picture()) : [];
        case "duration":
          return durationSensor(m.durationSec, input.slot);
        case "cuts":
          return cutsSensor(input.file, input.role, input.refuseCuts === true);
        case "black-frozen":
          return blackFrozenSensors(input.file, m);
        case "camera-motion":
          return cameraMotionSensor(temporal());
        case "flicker":
          return flickerSensor(temporal());
        case "frame-count": {
          const count = m.frameCount ?? 0;
          return count >= 2
            ? ok("frame.count", count, `${count} frames.`)
            : warn("frame.count", count, "A control video needs more than one frame.");
        }
        case "audio":
          return audioSensors(input.file, m.durationSec, input.role);
      }
    });
  return results;
}

/** Numeric sensor values as receipt measurements (`sensor.<id>`), finite only; warn and fail messages as warnings. */
export function sensorEvidence(results: SensorResult[]): { measurements: Record<string, number>; warnings: string[] } {
  const measurements: Record<string, number> = {};
  const warnings: string[] = [];
  for (const result of results) {
    if (typeof result.value === "number" && Number.isFinite(result.value))
      measurements[`sensor.${result.id}`] = result.value;
    if (result.severity !== "ok")
      warnings.push(`sensor ${result.id} (${result.severity}): ${result.message}`.slice(0, 4000));
  }
  return { measurements, warnings };
}
