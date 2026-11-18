/**
 * Temporal stability for alpha mattes, pure maths over 8-bit grey frames (no I/O): motion from the source frames,
 * a motion-gated exponential moving average of the alpha, an optional guided-filter edge refine, and the flicker
 * measure that reports both. Frames are `Uint8Array` of width * height, row-major, 0..255.
 *
 * Why motion-gated: a plain EMA lowers flicker by dragging the matte behind a moving subject (ghosting). Here the
 * history weight falls to zero wherever the source picture itself changes, so moving edges take the raw matte and
 * only edges over a still picture are averaged.
 */

export type Frame = { width: number; height: number; data: Uint8Array };

/** Motion grid: the picture averaged over `cell` x `cell` blocks, so sensor grain cancels before frames are compared. */
export type Grid = { cols: number; rows: number; cell: number; data: Float32Array };

export const DEFAULT_TEMPORAL = {
  /** History weight on a still pixel, 0..1. 0 disables smoothing. */
  strength: 0.6,
  /** Block-mean luma change (0..1) at which the history weight reaches zero. About 10/255. */
  motionTau: 0.04,
  /** Below this block-mean luma change (0..1) a pixel counts as stable for the flicker measure. About 2/255. */
  stableThreshold: 2 / 255,
  /** Motion grid cell in pixels at 1080 short side; scaled with the frame. */
  cell: 8,
} as const;

export type TemporalOptions = { strength?: number; motionTau?: number; cell?: number };

/** Cell size for a frame: `cell` at a 1080 short side, at least 2. */
export function cellFor(width: number, height: number, cell: number = DEFAULT_TEMPORAL.cell): number {
  return Math.max(2, Math.round((cell * Math.min(width, height)) / 1080));
}

/** Block means of a grey frame, 0..1. */
export function blockMeans(frame: Frame, cell: number): Grid {
  const cols = Math.ceil(frame.width / cell);
  const rows = Math.ceil(frame.height / cell);
  const sums = new Float64Array(cols * rows);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < frame.height; y++) {
    const row = Math.floor(y / cell) * cols;
    const offset = y * frame.width;
    for (let x = 0; x < frame.width; x++) {
      const index = row + Math.floor(x / cell);
      sums[index]! += frame.data[offset + x]!;
      counts[index]! += 1;
    }
  }
  const data = new Float32Array(cols * rows);
  for (let i = 0; i < data.length; i++) data[i] = sums[i]! / counts[i]! / 255;
  return { cols, rows, cell, data };
}

/** Per-cell absolute change between two grids, max-pooled over the 3x3 neighbourhood so an edge's cell is never missed. */
export function motionGrid(previous: Grid, current: Grid): Grid {
  const { cols, rows, cell } = current;
  const raw = new Float32Array(cols * rows);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.abs(current.data[i]! - previous.data[i]!);
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let peak = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          peak = Math.max(peak, raw[rr * cols + cc]!);
        }
      }
      data[r * cols + c] = peak;
    }
  }
  return { cols, rows, cell, data };
}

/** History weight for a block-mean change `motion`: `strength` when still, falling linearly to 0 at `tau`. */
export function historyWeight(
  motion: number,
  strength: number = DEFAULT_TEMPORAL.strength,
  tau: number = DEFAULT_TEMPORAL.motionTau,
): number {
  if (strength <= 0) return 0;
  return strength * Math.min(1, Math.max(0, 1 - motion / tau));
}

/**
 * One EMA step: out = w * previousOut + (1 - w) * raw, with w from the source motion at each pixel's cell.
 * `previous` is the previous smoothed alpha (null on the first frame, which passes through unchanged).
 */
export function smoothStep(
  raw: Frame,
  previous: Uint8Array | null,
  motion: Grid | null,
  options: TemporalOptions = {},
): Uint8Array {
  if (!previous || !motion) return raw.data.slice();
  const strength = options.strength ?? DEFAULT_TEMPORAL.strength;
  const tau = options.motionTau ?? DEFAULT_TEMPORAL.motionTau;
  const out = new Uint8Array(raw.data.length);
  const { cols, cell } = motion;
  for (let y = 0; y < raw.height; y++) {
    const row = Math.floor(y / cell) * cols;
    for (let x = 0; x < raw.width; x++) {
      const i = y * raw.width + x;
      const w = historyWeight(motion.data[row + Math.floor(x / cell)]!, strength, tau);
      out[i] = Math.round(w * previous[i]! + (1 - w) * raw.data[i]!);
    }
  }
  return out;
}

/** Box mean with radius `r` (window 2r+1, clamped at the borders), separable running sums. */
export function boxMean(values: Float32Array, width: number, height: number, r: number): Float32Array {
  const tmp = new Float32Array(values.length);
  const out = new Float32Array(values.length);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    let sum = 0;
    let count = 0;
    for (let x = 0; x <= Math.min(r, width - 1); x++) {
      sum += values[base + x]!;
      count++;
    }
    for (let x = 0; x < width; x++) {
      tmp[base + x] = sum / count;
      const add = x + r + 1;
      const drop = x - r;
      if (add < width) {
        sum += values[base + add]!;
        count++;
      }
      if (drop >= 0) {
        sum -= values[base + drop]!;
        count--;
      }
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y <= Math.min(r, height - 1); y++) {
      sum += tmp[y * width + x]!;
      count++;
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / count;
      const add = y + r + 1;
      const drop = y - r;
      if (add < height) {
        sum += tmp[add * width + x]!;
        count++;
      }
      if (drop >= 0) {
        sum -= tmp[drop * width + x]!;
        count--;
      }
    }
  }
  return out;
}

/**
 * Guided-filter edge refine (He, Sun and Tang 2010): the alpha follows the source picture's own edges inside a band
 * around the matte's boundary; solid inside and empty outside stay as they are. `radius` scales with the frame
 * (4 px at a 1080 short side), `eps` is the regularisation in 0..1 units squared.
 */
export function guidedRefine(
  alpha: Frame,
  guide: Frame,
  radius = Math.max(2, Math.round((4 * Math.min(alpha.width, alpha.height)) / 1080)),
  eps = 1e-3,
): Uint8Array {
  const { width, height } = alpha;
  const n = width * height;
  const I = new Float32Array(n);
  const p = new Float32Array(n);
  const Ip = new Float32Array(n);
  const II = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = guide.data[i]! / 255;
    const a = alpha.data[i]! / 255;
    I[i] = g;
    p[i] = a;
    Ip[i] = g * a;
    II[i] = g * g;
  }
  const meanI = boxMean(I, width, height, radius);
  const meanP = boxMean(p, width, height, radius);
  const meanIp = boxMean(Ip, width, height, radius);
  const meanII = boxMean(II, width, height, radius);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = meanIp[i]! - meanI[i]! * meanP[i]!;
    const variance = meanII[i]! - meanI[i]! * meanI[i]!;
    a[i] = cov / (variance + eps);
    b[i] = meanP[i]! - a[i]! * meanI[i]!;
  }
  const meanA = boxMean(a, width, height, radius);
  const meanB = boxMean(b, width, height, radius);
  // The band: where the local mean of the alpha is neither solid nor empty.
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const local = meanP[i]!;
    if (local <= 0.01 || local >= 0.99) {
      out[i] = alpha.data[i]!;
      continue;
    }
    const q = meanA[i]! * I[i]! + meanB[i]!;
    out[i] = Math.round(Math.min(1, Math.max(0, q)) * 255);
  }
  return out;
}

export type FlickerTotals = {
  stablePixels: number;
  stableChange: number;
  edgePixels: number;
  edgeChange: number;
  movingPixels: number;
  movingDelta: number;
  pairs: number;
};

export const emptyFlicker = (): FlickerTotals => ({
  stablePixels: 0,
  stableChange: 0,
  edgePixels: 0,
  edgeChange: 0,
  movingPixels: 0,
  movingDelta: 0,
  pairs: 0,
});

/**
 * Accumulates the flicker of one frame pair: the mean alpha change |a_t - a_t-1| over pixels whose source picture is
 * stable (block-mean change below `stableThreshold`), over all stable pixels and over stable edge pixels (alpha
 * strictly between 5 and 250 in either frame). `reference`, when given, is the raw alpha of this frame: the mean
 * |a_t - raw_t| over moving pixels is the cost the smoothing pays where the subject moves (ghosting), reported beside it.
 */
export function accumulateFlicker(
  totals: FlickerTotals,
  previous: Uint8Array,
  current: Uint8Array,
  motion: Grid,
  width: number,
  height: number,
  reference?: Uint8Array,
  stableThreshold: number = DEFAULT_TEMPORAL.stableThreshold,
): FlickerTotals {
  const { cols, cell } = motion;
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / cell) * cols;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const still = motion.data[row + Math.floor(x / cell)]! < stableThreshold;
      if (still) {
        const change = Math.abs(current[i]! - previous[i]!);
        totals.stablePixels++;
        totals.stableChange += change;
        const a = previous[i]!;
        const b = current[i]!;
        if ((a > 5 && a < 250) || (b > 5 && b < 250)) {
          totals.edgePixels++;
          totals.edgeChange += change;
        }
      } else if (reference) {
        totals.movingPixels++;
        totals.movingDelta += Math.abs(current[i]! - reference[i]!);
      }
    }
  }
  totals.pairs++;
  return totals;
}

export type FlickerReport = {
  pairs: number;
  stableShare: number;
  stable: number;
  stableEdge: number;
  movingDelta: number | null;
};

/** Means in 0..255 alpha units. `stableShare` is the share of pixels that counted as stable. */
export function flickerReport(totals: FlickerTotals, pixelsPerFrame: number): FlickerReport {
  const mean = (sum: number, count: number) => (count ? Math.round((sum / count) * 1000) / 1000 : 0);
  return {
    pairs: totals.pairs,
    stableShare: totals.pairs ? Math.round((totals.stablePixels / (totals.pairs * pixelsPerFrame)) * 1000) / 1000 : 0,
    stable: mean(totals.stableChange, totals.stablePixels),
    stableEdge: mean(totals.edgeChange, totals.edgePixels),
    movingDelta: totals.movingPixels ? mean(totals.movingDelta, totals.movingPixels) : null,
  };
}

/** Share of pixels at or above half alpha. */
export function coverage(alpha: Uint8Array): number {
  let covered = 0;
  for (const value of alpha) if (value >= 128) covered++;
  return alpha.length ? covered / alpha.length : 0;
}
