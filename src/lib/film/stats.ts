/** Linear interpolation between order statistics, so a short list still has a usable p10 and p90. */
export function percentile(values: number[], share: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * share;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

export const median = (values: number[]) => percentile(values, 0.5);

/** p90 / p10 of shot length. 1 is a metronome; references run from about 2 upwards. */
export const varietyRatio = (lengths: number[]) => {
  const low = percentile(lengths, 0.1);
  return low > 0 ? percentile(lengths, 0.9) / low : 0;
};

export const round = (value: number, digits = 3) => Number(value.toFixed(digits));

export type Range = { min?: number; max?: number };

export const inRange = (value: number, range: Range) =>
  (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);

export const describeRange = (range: Range, unit = "") => {
  if (range.min !== undefined && range.max !== undefined) return `${range.min} to ${range.max}${unit}`;
  if (range.min !== undefined) return `at least ${range.min}${unit}`;
  if (range.max !== undefined) return `at most ${range.max}${unit}`;
  return "no limit";
};

export const hasLimit = (range: Range) => range.min !== undefined || range.max !== undefined;
