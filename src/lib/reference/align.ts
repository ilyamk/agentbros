import { decodeFrames, type VideoInfo } from "../vision/media";

// Time alignment and per-shot colour, after ReelMimic's perception/distance.py (dtw, look_pair, palette_component) and
// perception/look.py (MIT, © 2026 ReelMimic contributors).

export const FEATURE_HZ = 4;
const GRID_COLUMNS = 8;
const GRID_ROWS = 4;
const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 36;
/** Motion counts as much as about ten grid cells changing completely, so DTW follows both picture and pace. */
const ENERGY_WEIGHT = 10;
export const HISTOGRAM_BINS = 32;
/**
 * a and b bins are 8 wide and centred on zero, [-4, 4) being the middle bin, so a neutral grey or black reads a = b = 0.
 * The old [-128, 128] range put 0 on a bin edge: neutrals read a ≈ +4 and, from a hair below zero, b ≈ -4. sRGB stays
 * within a -87…99 and b -108…95, inside both ranges.
 */
export const LAB_RANGES: readonly [number, number][] = [
  [0, 100],
  [-132, 124],
  [-132, 124],
];

const round = (value: number, digits = 3) => Number(value.toFixed(digits));

export function rgbToLab(red: number, green: number, blue: number): [number, number, number] {
  const linear = [red, green, blue].map((value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const [r, g, b] = linear;
  const f = (value: number) => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** Three marginal histograms (L, a, b) of HISTOGRAM_BINS bins each, as counts. */
export type LabHistogram = [number[], number[], number[]];

export const emptyHistogram = (): LabHistogram => [
  new Array<number>(HISTOGRAM_BINS).fill(0),
  new Array<number>(HISTOGRAM_BINS).fill(0),
  new Array<number>(HISTOGRAM_BINS).fill(0),
];

export function addHistograms(target: LabHistogram, source: LabHistogram): LabHistogram {
  target.forEach((channel, index) => channel.forEach((_, bin) => (channel[bin]! += source[index]![bin]!)));
  return target;
}

const normalised = (channel: number[]) => {
  const total = channel.reduce((sum, value) => sum + value, 0);
  return total > 0 ? channel.map((value) => value / total) : channel.map(() => 0);
};

/** Earth mover's distance per channel, in that channel's units: unlike bin-by-bin distances it knows a slightly warmer orange is close to orange. */
export function wasserstein(a: LabHistogram, b: LabHistogram): [number, number, number] {
  return [0, 1, 2].map((channel) => {
    const [low, high] = LAB_RANGES[channel]!;
    const first = normalised(a[channel]!);
    const second = normalised(b[channel]!);
    let cumulative = 0;
    let total = 0;
    for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
      cumulative += first[bin]! - second[bin]!;
      total += Math.abs(cumulative);
    }
    return (total * (high - low)) / HISTOGRAM_BINS;
  }) as [number, number, number];
}

/** Mean of each channel from its histogram's bin centres. */
export function histogramMeans(histogram: LabHistogram): [number, number, number] {
  return histogram.map((channel, index) => {
    const [low, high] = LAB_RANGES[index]!;
    return normalised(channel).reduce(
      (sum, share, bin) => sum + share * (low + ((bin + 0.5) * (high - low)) / HISTOGRAM_BINS),
      0,
    );
  }) as [number, number, number];
}

export type FilmSample = { timeSec: number; grid: number[]; energy: number; histogram: LabHistogram };

/** Pictures of a film on a fixed clock: an 8x4 Lab grid, motion since the previous sample, and a Lab histogram. */
export function sampleFilm(media: string, info: VideoInfo, hz = FEATURE_HZ): FilmSample[] {
  const step = Math.max(1, Math.round(info.fps / hz));
  const samples: FilmSample[] = [];
  const batch = 400;
  let previous: Buffer | Uint8Array | undefined;
  for (let startFrame = 0; startFrame < info.frameCount; startFrame += batch * step) {
    const frames = decodeFrames(media, info, {
      startFrame,
      count: batch,
      step,
      width: SAMPLE_WIDTH,
      height: SAMPLE_HEIGHT,
    });
    frames.forEach((frame, index) => {
      const grid = new Array<number>(GRID_COLUMNS * GRID_ROWS * 3).fill(0);
      const histogram = emptyHistogram();
      let difference = 0;
      for (let y = 0; y < SAMPLE_HEIGHT; y++)
        for (let x = 0; x < SAMPLE_WIDTH; x++) {
          const offset = (y * SAMPLE_WIDTH + x) * 3;
          const lab = rgbToLab(frame.data[offset]!, frame.data[offset + 1]!, frame.data[offset + 2]!);
          const cell =
            (Math.floor((y * GRID_ROWS) / SAMPLE_HEIGHT) * GRID_COLUMNS +
              Math.floor((x * GRID_COLUMNS) / SAMPLE_WIDTH)) *
            3;
          lab.forEach((value, channel) => {
            grid[cell + channel]! += value;
            const [low, high] = LAB_RANGES[channel]!;
            histogram[channel]![
              Math.min(HISTOGRAM_BINS - 1, Math.max(0, Math.floor(((value - low) / (high - low)) * HISTOGRAM_BINS)))
            ]!++;
          });
          if (previous)
            for (let channel = 0; channel < 3; channel++)
              difference += Math.abs(frame.data[offset + channel]! - previous[offset + channel]!);
        }
      const perCell = (SAMPLE_WIDTH * SAMPLE_HEIGHT) / (GRID_COLUMNS * GRID_ROWS);
      const scales = [100, 128, 128];
      samples.push({
        timeSec: round((startFrame + index * step) / info.fps),
        grid: grid.map((value, position) => round(value / perCell / scales[position % 3]!, 4)),
        energy: previous ? round(difference / (SAMPLE_WIDTH * SAMPLE_HEIGHT * 3 * 255), 5) : 0,
        histogram,
      });
      previous = frame.data;
    });
    if (frames.length < batch) break;
  }
  return samples;
}

const percentile = (values: number[], share: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * (sorted.length - 1)))]!;
};

/** Feature rows for DTW: the Lab grid and motion, each film's motion scaled by its own 95th percentile. */
export function featureRows(samples: FilmSample[]): number[][] {
  const scale = Math.max(
    percentile(
      samples.map((sample) => sample.energy),
      0.95,
    ),
    1e-4,
  );
  return samples.map((sample) => [...sample.grid, (ENERGY_WEIGHT * Math.min(sample.energy, 2 * scale)) / scale]);
}

const cityblock = (a: number[], b: number[]) => {
  let total = 0;
  for (let index = 0; index < a.length; index++) total += Math.abs(a[index]! - b[index]!);
  return total;
};

/** Dynamic time warping with a Sakoe–Chiba band (a share of the longer series) around the scaled diagonal. Cost is the mean along the path. */
export function dtw(a: number[][], b: number[][], band = 0.25): { cost: number; path: [number, number][] } {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return { cost: Infinity, path: [] };
  const reach = Math.max(2, Math.floor(band * Math.max(n, m)));
  const total = new Float64Array(n * m).fill(Infinity);
  const local = new Float64Array(n * m).fill(Infinity);
  for (let i = 0; i < n; i++) {
    const centre = (i * (m - 1)) / Math.max(1, n - 1);
    const low = Math.max(0, Math.floor(centre - reach));
    const high = Math.min(m - 1, Math.ceil(centre + reach));
    for (let j = low; j <= high; j++) {
      const cost = cityblock(a[i]!, b[j]!);
      local[i * m + j] = cost;
      const before =
        i === 0 && j === 0
          ? 0
          : Math.min(
              i > 0 ? total[(i - 1) * m + j]! : Infinity,
              j > 0 ? total[i * m + j - 1]! : Infinity,
              i > 0 && j > 0 ? total[(i - 1) * m + j - 1]! : Infinity,
            );
      total[i * m + j] = cost + before;
    }
  }
  if (!Number.isFinite(total[n * m - 1]!)) return { cost: Infinity, path: [] };
  const path: [number, number][] = [[n - 1, m - 1]];
  let i = n - 1;
  let j = m - 1;
  while (i > 0 || j > 0) {
    const options: [number, number][] = [
      [i - 1, j - 1],
      [i - 1, j],
      [i, j - 1],
    ];
    [i, j] = options
      .filter(([row, column]) => row >= 0 && column >= 0)
      .reduce((best, option) => (total[option[0] * m + option[1]]! < total[best[0] * m + best[1]]! ? option : best));
    path.push([i, j]);
  }
  path.reverse();
  return { cost: path.reduce((sum, [row, column]) => sum + local[row * m + column]!, 0) / path.length, path };
}

export type TimeWarp = {
  toRender: (referenceSec: number) => number;
  toReference: (renderSec: number) => number;
  pairs: [number, number][];
};

function interpolator(xs: number[], ys: number[]): (value: number) => number {
  return (value) => {
    if (value <= xs[0]!) return ys[0]! + (value - xs[0]!);
    if (value >= xs.at(-1)!) return ys.at(-1)! + (value - xs.at(-1)!);
    let low = 0;
    let high = xs.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (xs[middle]! <= value) low = middle;
      else high = middle;
    }
    const span = xs[high]! - xs[low]!;
    return span > 0 ? ys[low]! + ((value - xs[low]!) / span) * (ys[high]! - ys[low]!) : ys[low]!;
  };
}

/** A monotone map between the two clocks from a DTW path: each reference sample goes to the mean of its partners. */
export function warpFromPath(path: [number, number][], referenceTimes: number[], renderTimes: number[]): TimeWarp {
  const grouped = (side: 0 | 1) => {
    const groups = new Map<number, number[]>();
    for (const pair of path) groups.set(pair[side], [...(groups.get(pair[side]) ?? []), pair[1 - side]!]);
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  };
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const forward = grouped(0).map(
    ([index, partners]) =>
      [referenceTimes[index]!, mean(partners.map((partner) => renderTimes[partner]!))] as [number, number],
  );
  const backward = grouped(1).map(
    ([index, partners]) =>
      [renderTimes[index]!, mean(partners.map((partner) => referenceTimes[partner]!))] as [number, number],
  );
  return {
    toRender: interpolator(
      forward.map((row) => row[0]),
      forward.map((row) => row[1]),
    ),
    toReference: interpolator(
      backward.map((row) => row[0]),
      backward.map((row) => row[1]),
    ),
    pairs: path.map(([row, column]) => [referenceTimes[row]!, renderTimes[column]!]),
  };
}

export type Span = { id: string; startSec: number; endSec: number };

/** Each render shot's reference partner: the reference shot that overlaps most with the render shot's span mapped back through the warp. */
export function pairShots(renderShots: Span[], referenceShots: Span[], warp: TimeWarp) {
  return renderShots.map((shot) => {
    const start = warp.toReference(shot.startSec);
    const end = Math.max(start + 1e-3, warp.toReference(shot.endSec));
    let best: { shot: Span; overlap: number } | undefined;
    for (const candidate of referenceShots) {
      const overlap = Math.min(end, candidate.endSec) - Math.max(start, candidate.startSec);
      if (overlap > 0 && (!best || overlap > best.overlap)) best = { shot: candidate, overlap };
    }
    return {
      render: shot,
      reference: best?.shot,
      referenceSpan: [round(start), round(end)] as [number, number],
      overlapShare: best ? round(best.overlap / (end - start)) : 0,
    };
  });
}

/** Sums sample histograms inside a span, leaving out its first and last 0.1 s, where a transition or a cut frame sits. */
export function spanHistogram(samples: FilmSample[], span: { startSec: number; endSec: number }): LabHistogram {
  const inside = samples.filter(
    (sample) => sample.timeSec >= span.startSec + 0.1 && sample.timeSec < span.endSec - 0.1,
  );
  const chosen = inside.length
    ? inside
    : samples.filter((sample) => sample.timeSec >= span.startSec && sample.timeSec < span.endSec);
  const nearest = chosen.length
    ? chosen
    : [
        samples.reduce((best, sample) =>
          Math.abs(sample.timeSec - (span.startSec + span.endSec) / 2) <
          Math.abs(best.timeSec - (span.startSec + span.endSec) / 2)
            ? sample
            : best,
        ),
      ];
  return nearest.reduce((sum, sample) => addHistograms(sum, sample.histogram), emptyHistogram());
}

export function spanEnergy(samples: FilmSample[], span: { startSec: number; endSec: number }): number {
  const inside = samples.filter(
    (sample) => sample.timeSec > span.startSec + 0.1 && sample.timeSec < span.endSec - 0.05,
  );
  return inside.length ? inside.reduce((sum, sample) => sum + sample.energy, 0) / inside.length : 0;
}
