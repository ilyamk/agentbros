import type { ShotColour } from "../../types/reference";
import { histogramMeans, HISTOGRAM_BINS, LAB_RANGES, spanHistogram, type FilmSample, type LabHistogram } from "./align";

const round = (value: number, digits = 1) => Number(value.toFixed(digits));

function percentiles(channel: number[], index: number): [number, number, number] {
  const [low, high] = LAB_RANGES[index]!;
  const total = channel.reduce((sum, value) => sum + value, 0) || 1;
  return [0.1, 0.5, 0.9].map((share) => {
    let cumulative = 0;
    for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
      cumulative += channel[bin]! / total;
      if (cumulative >= share) return round(low + ((bin + 0.5) * (high - low)) / HISTOGRAM_BINS);
    }
    return round(high);
  }) as [number, number, number];
}

function colourOf(histogram: LabHistogram, samples: number): ShotColour {
  const [L, a, b] = histogramMeans(histogram);
  return {
    L: round(L),
    a: round(a),
    b: round(b),
    percentiles: { L: percentiles(histogram[0], 0), a: percentiles(histogram[1], 1), b: percentiles(histogram[2], 2) },
    samples,
  };
}

/** Same samples and edge trim as ref:compare's reference side, so a spec target copied from here is what compare reads. */
export function shotColour(samples: FilmSample[], span: { startSec: number; endSec: number }): ShotColour {
  const histogram = spanHistogram(samples, span);
  const pixels = histogram[0].reduce((sum, value) => sum + value, 0);
  const perSample = samples[0] ? samples[0].histogram[0].reduce((sum, value) => sum + value, 0) : 1;
  return colourOf(histogram, Math.round(pixels / Math.max(1, perSample)));
}

/** Sample-weighted mean of several shots' colour: the measured target of a merged shot. Percentiles are not combined. */
export function mergedLab(colours: ShotColour[]): { L: number; a: number; b: number } | undefined {
  const total = colours.reduce((sum, colour) => sum + colour.samples, 0);
  if (!total) return undefined;
  const mean = (key: "L" | "a" | "b") =>
    round(colours.reduce((sum, colour) => sum + colour[key] * colour.samples, 0) / total);
  return { L: mean("L"), a: mean("a"), b: mean("b") };
}
