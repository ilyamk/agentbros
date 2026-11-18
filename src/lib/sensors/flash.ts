import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject } from "../cli";
import type { Occurrence } from "./findings";

// Photosensitivity sensor: general and red flashes per WCAG 2.3.1 "Three Flashes or Below Threshold".
//
// Sources (opened 2026-11-13):
// - W3C, Understanding SC 2.3.1, https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html
//   General flash: "a pair of opposing changes in relative luminance of 10% or more of the maximum relative luminance
//   (1.0) where the relative luminance of the darker image is below 0.80"; "a pair of opposing changes" is "an increase
//   followed by a decrease, or a decrease followed by an increase". Red flash: "any pair of opposing transitions involving
//   a saturated red", where one state has R/(R + G + B) >= 0.8 and the states differ by more than 0.2 in the CIE 1976 UCS
//   (u'v') chromaticity diagram. Content passes with no more than three flashes in any one-second period. Area: "no more
//   than a total of .006 steradians within any 10 degree visual field on the screen (25% of any 10 degree visual field)";
//   the page turns that into "a flashing area of 87,296 CSS pixels" (341 x 256) on a 1024 x 768 screen, 11.1% of it.
// - W3C, Understanding SC 2.3.1 for WCAG 2.0, https://www.w3.org/WAI/WCAG20/Understanding/three-flashes-or-below-threshold
//   The earlier working definition of a red transition: R/(R + G + B) >= 0.8 for either state "and the change in the value
//   of (R-G-B)x320 is > 20 (negative values of (R-G-B)x320 are set to zero)". Kept here as a magnitude floor beside the
//   u'v' distance, which alone has none: a near-black red-graded area jittering by one code value would otherwise swing
//   between neutral and saturated red every frame.
// - ITU-R BT.1702-3 (11/2023), Guideline 1, https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.1702-3-202311-I!!PDF-E.pdf
//   A flash is a pair of opposing luminance changes (20 cd/m2 or more with the darker image below 160 cd/m2); "a transition
//   to or from a saturated red is also potentially harmful"; a sequence fails when "the combined area of flashes occurring
//   concurrently occupies more than 25% of the displayed screen area" and "there are more than three flashes (i.e. six
//   changes in luminance ...) within any one-second period". Ofcom's Broadcasting Code rule 2.12 and its guidance note on
//   flashing images apply the same limits to UK television (their pages refused automated access, so the numbers here are
//   taken from the two sources above).
//
// Choices made here: relative luminance and the red ratio use linearised sRGB (the WCAG relative luminance definition),
// averaged over a grid of cells so area can be judged. The area limit is WCAG's 11.1% of the frame, stricter than ITU's
// 25%. Flashing cells are summed over the whole frame rather than within any one 10-degree field: on a phone the frame is
// roughly that field, and on a larger screen the sum is conservative. A window fails when more than six transitions
// (three flashes) fall inside it, so 3 Hz full-frame flashing passes and 4 Hz fails.
//
// Not reused: tension.ts, measureMotion and motion:check's meanLuma average gamma-encoded values (or ffmpeg `gray`),
// so 0 to 60 of 255 reads as a 0.24 swing there but is 0.045 in relative luminance; and they sample at 10 Hz or every
// fifth frame, which aliases a strobe. This sensor decodes every frame.

export const FLASH_GRID = 32;
export const FLASH_LUMINANCE_STEP = 0.1;
export const FLASH_DARKER_BELOW = 0.8;
export const RED_RATIO = 0.8;
export const RED_CHROMA_STEP = 0.2;
/** WCAG 2.0's working definition: the change in max(0, R - G - B) x 320 must exceed 20. */
export const RED_MAGNITUDE_STEP = 20;
/** 341 x 256 of 1024 x 768 (W3C Understanding 2.3.1), as a share of the frame. */
export const FLASH_AREA_LIMIT = (341 * 256) / (1024 * 768);
/** Three flashes are six transitions; more than this in one second fails. */
export const MAX_TRANSITIONS_PER_SECOND = 6;
const DECODE_SIZE = FLASH_GRID * 2;
/** Below this summed linear RGB a cell has no meaningful chromaticity and is read as neutral. */
const NEUTRAL_BELOW = 0.003;
const D65 = { u: 0.1978, v: 0.4683 };

export const LINEAR = Float32Array.from({ length: 256 }, (_, value) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
});

export const relativeLuminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Linear r, g, b averaged per cell of a FLASH_GRID x FLASH_GRID grid, from an rgb24 frame of any size. */
export function cellsFromRgb(raw: Buffer | Uint8Array, width: number, height: number, grid = FLASH_GRID): Float32Array {
  const sums = new Float64Array(grid * grid * 3);
  const counts = new Uint32Array(grid * grid);
  const columns = Uint16Array.from({ length: width }, (_, x) => Math.min(grid - 1, Math.floor((x * grid) / width)));
  for (let y = 0; y < height; y++) {
    const row = Math.min(grid - 1, Math.floor((y * grid) / height)) * grid;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const cell = row + columns[x]!;
      sums[cell * 3] += LINEAR[raw[offset]!]!;
      sums[cell * 3 + 1] += LINEAR[raw[offset + 1]!]!;
      sums[cell * 3 + 2] += LINEAR[raw[offset + 2]!]!;
      counts[cell]!++;
    }
  }
  return Float32Array.from(sums, (sum, index) => sum / Math.max(1, counts[Math.floor(index / 3)]!));
}

/** CIE 1976 u'v' of linear sRGB, and whether it is a saturated red. */
export function chromaticity(r: number, g: number, b: number): { u: number; v: number; red: boolean; redness: number } {
  const redness = Math.max(0, r - g - b) * 320;
  if (r + g + b < NEUTRAL_BELOW) return { ...D65, red: false, redness };
  const x = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const denominator = x + 15 * y + 3 * z;
  return { u: (4 * x) / denominator, v: (9 * y) / denominator, red: r / (r + g + b) >= RED_RATIO, redness };
}

const FlashRangeSchema = z.object({
  kind: z.enum(["general", "red"]),
  startFrame: z.number(),
  endFrame: z.number(),
  startSec: z.number(),
  endSec: z.number(),
  /** Most flashes (transition pairs) one cell made in a one-second window of this range. */
  flashes: z.number(),
  /** Largest share of the frame flashing more than three times in one window of this range. */
  area: z.number(),
});
export type FlashRange = z.infer<typeof FlashRangeSchema>;

export const FlashReportSchema = z.object({
  fps: z.number(),
  frames: z.number(),
  grid: z.number(),
  areaLimit: z.number(),
  /** Largest share of the frame over the flash count in any one-second window, per kind. */
  worstArea: z.object({ general: z.number(), red: z.number() }),
  ranges: z.array(FlashRangeSchema),
});
export type FlashReport = z.infer<typeof FlashReportSchema>;

type LumaState = { direction: -1 | 0 | 1; peak: number; min: number; max: number };
type RedState = { u: number; v: number; red: boolean; redness: number };

/** Feed frames in order with `push`, then `report`. Keeps only per-cell state and transition frame numbers. */
export class FlashTracker {
  private frame = 0;
  private luma: LumaState[] = [];
  private chroma: RedState[] = [];
  readonly general: number[][] = [];
  readonly red: number[][] = [];

  constructor(private readonly cells = FLASH_GRID * FLASH_GRID) {
    for (let cell = 0; cell < cells; cell++) {
      this.general.push([]);
      this.red.push([]);
    }
  }

  push(linear: Float32Array): void {
    if (linear.length !== this.cells * 3) throw new Error(`Expected ${this.cells * 3} values, got ${linear.length}.`);
    for (let cell = 0; cell < this.cells; cell++) {
      const [r, g, b] = [linear[cell * 3]!, linear[cell * 3 + 1]!, linear[cell * 3 + 2]!];
      const luminance = relativeLuminance(r, g, b);
      const colour = chromaticity(r, g, b);
      if (this.frame === 0) {
        this.luma.push({ direction: 0, peak: luminance, min: luminance, max: luminance });
        this.chroma.push(colour);
        continue;
      }
      if (stepLuma(this.luma[cell]!, luminance)) this.general[cell]!.push(this.frame);
      const anchor = this.chroma[cell]!;
      if (anchor.red || colour.red) {
        if (
          Math.hypot(colour.u - anchor.u, colour.v - anchor.v) > RED_CHROMA_STEP &&
          Math.abs(colour.redness - anchor.redness) > RED_MAGNITUDE_STEP
        ) {
          this.red[cell]!.push(this.frame);
          this.chroma[cell] = colour;
        }
      } else this.chroma[cell] = colour;
    }
    this.frame++;
  }

  report(fps: number, areaLimit = FLASH_AREA_LIMIT): FlashReport {
    const general = windows(this.general, this.frame, fps, areaLimit, "general");
    const red = windows(this.red, this.frame, fps, areaLimit, "red");
    return {
      fps,
      frames: this.frame,
      grid: Math.round(Math.sqrt(this.cells)),
      areaLimit: round(areaLimit),
      worstArea: { general: general.worst, red: red.worst },
      ranges: [...general.ranges, ...red.ranges].sort((a, b) => a.startFrame - b.startFrame),
    };
  }
}

/** A transition is a move of FLASH_LUMINANCE_STEP or more away from the last extreme, with the darker side below FLASH_DARKER_BELOW. */
function stepLuma(state: LumaState, value: number): boolean {
  if (state.direction === 0) {
    if (value - state.min >= FLASH_LUMINANCE_STEP && state.min < FLASH_DARKER_BELOW) return turn(state, 1, value);
    if (state.max - value >= FLASH_LUMINANCE_STEP && value < FLASH_DARKER_BELOW) return turn(state, -1, value);
    state.min = Math.min(state.min, value);
    state.max = Math.max(state.max, value);
    return false;
  }
  if (state.direction === 1) {
    if (value > state.peak) state.peak = value;
    else if (state.peak - value >= FLASH_LUMINANCE_STEP && value < FLASH_DARKER_BELOW) return turn(state, -1, value);
    return false;
  }
  if (value < state.peak) state.peak = value;
  else if (value - state.peak >= FLASH_LUMINANCE_STEP && state.peak < FLASH_DARKER_BELOW) return turn(state, 1, value);
  return false;
}

function turn(state: LumaState, direction: 1 | -1, value: number): true {
  state.direction = direction;
  state.peak = value;
  return true;
}

const round = (value: number, digits = 3) => Number(value.toFixed(digits));

/** Slides a one-second window over the transitions: a window fails when cells covering more than the area limit each make more than six. */
function windows(transitions: number[][], frames: number, fps: number, areaLimit: number, kind: FlashRange["kind"]) {
  const span = Math.max(1, Math.round(fps));
  const from = new Uint32Array(transitions.length);
  const to = new Uint32Array(transitions.length);
  const ranges: FlashRange[] = [];
  let worst = 0;
  let open: FlashRange | undefined;
  for (let start = 0; start < Math.max(1, frames - span + 1); start++) {
    let flashing = 0;
    let most = 0;
    transitions.forEach((list, cell) => {
      while (from[cell]! < list.length && list[from[cell]!]! < start) from[cell]!++;
      while (to[cell]! < list.length && list[to[cell]!]! < start + span) to[cell]!++;
      const count = to[cell]! - from[cell]!;
      if (count > MAX_TRANSITIONS_PER_SECOND) {
        flashing++;
        most = Math.max(most, count);
      }
    });
    const area = flashing / transitions.length;
    worst = Math.max(worst, area);
    if (area <= areaLimit) {
      open = undefined;
      continue;
    }
    const endFrame = Math.min(frames - 1, start + span - 1);
    if (open && start <= open.endFrame + 1) {
      open.endFrame = endFrame;
      open.endSec = round((endFrame + 1) / fps, 2);
      open.flashes = Math.max(open.flashes, Math.floor(most / 2));
      open.area = Math.max(open.area, round(area));
    } else {
      open = {
        kind,
        startFrame: start,
        endFrame,
        startSec: round(start / fps, 2),
        endSec: round((endFrame + 1) / fps, 2),
        flashes: Math.floor(most / 2),
        area: round(area),
      };
      ranges.push(open);
    }
  }
  return { ranges, worst: round(worst) };
}

/**
 * Decodes every frame of a file at a small size and measures its flashes. The decode is forced to a constant `fps`, the
 * rate the windows are counted at, so a variable-rate phone recording is measured on its real clock; frames go through
 * a temporary file read in chunks, so memory stays flat on a long file.
 */
export function measureFlashesInFile(video: string, fps: number): FlashReport {
  const dir = mkdtempSync(path.join(tmpdir(), "avc-flash-"));
  const raw = path.join(dir, "frames.rgb");
  try {
    const result = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-i",
        video,
        "-an",
        "-sn",
        "-map",
        "0:v:0",
        "-vf",
        `fps=${fps},scale=${DECODE_SIZE}:${DECODE_SIZE}:flags=area,format=rgb24`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        raw,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.error || result.status !== 0)
      throw new CliErrorObject({
        code: "FFMPEG_FAILED",
        message: `Could not decode frames of ${video}: ${result.error?.message ?? result.stderr?.toString().slice(-300)}`,
      });
    const size = DECODE_SIZE * DECODE_SIZE * 3;
    const chunk = Buffer.alloc(size * 512);
    const tracker = new FlashTracker();
    const fd = openSync(raw, "r");
    try {
      let carry = 0;
      for (;;) {
        const read = readSync(fd, chunk, carry, chunk.length - carry, null);
        const filled = carry + read;
        let offset = 0;
        for (; offset + size <= filled; offset += size)
          tracker.push(cellsFromRgb(chunk.subarray(offset, offset + size), DECODE_SIZE, DECODE_SIZE));
        carry = filled - offset;
        if (carry) chunk.copy(chunk, 0, offset, filled);
        if (read === 0) break;
      }
    } finally {
      closeSync(fd);
    }
    return tracker.report(fps);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const describe = (range: FlashRange) =>
  `${range.kind === "red" ? "saturated-red" : "general"} flashes at ${range.startSec}-${range.endSec} s (frames ${range.startFrame}-${range.endFrame}): up to ${range.flashes} a second over ${Math.round(range.area * 100)}% of the frame`;

export const FLASH_FIX = `WCAG 2.3.1 allows at most three flashes in any one second over more than ${Math.round(FLASH_AREA_LIMIT * 1000) / 10}% of the frame. Space the hits at least 1/3 s apart, shrink the flashing area, keep the swing under 10% relative luminance, or swap a saturated-red flood for another colour.`;

export function flashLines(report: FlashReport): string[] {
  return report.ranges.map(describe);
}

/** motion:check findings; `firstFrame` is the composition frame the report's frame 0 stands for. */
export function flashOccurrences(report: FlashReport, firstFrame = 0): Occurrence[] {
  const shift = firstFrame / report.fps;
  return report.ranges.map((item) => {
    const range = {
      ...item,
      startFrame: firstFrame + item.startFrame,
      endFrame: firstFrame + item.endFrame,
      startSec: round(item.startSec + shift, 2),
      endSec: round(item.endSec + shift, 2),
    };
    return {
      code: "FLASH_RISK" as const,
      frame: range.startFrame,
      key: `${range.kind}:${range.startFrame}-${range.endFrame}`,
      message: `Photosensitivity risk: ${describe(range)}.`,
      fix: `${FLASH_FIX} If the strobe is deliberate and warned, add {"code":"FLASH_RISK","frames":"${range.startFrame}-${range.endFrame}","reason":"..."} to --allow.`,
    };
  });
}
