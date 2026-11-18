import { seeded, fail } from "./io";

export interface Preference {
  a: string;
  b: string;
  winner: "a" | "b" | "tie";
  block?: string;
}
/** MM with half a win per tie and a small symmetric prior for finite separation. */
export function fit(
  preferences: Preference[],
  ids = [...new Set(preferences.flatMap((pair) => [pair.a, pair.b]))].sort(),
): Record<string, number> {
  if (ids.length < 2 || !preferences.length) fail("Ratings need at least two candidates and one comparison");
  const index = new Map(ids.map((id, i) => [id, i]));
  const wins = ids.map(() => 0),
    games = ids.map(() => ids.map(() => 0));
  for (const pair of preferences) {
    const a = index.get(pair.a),
      b = index.get(pair.b);
    if (a === undefined || b === undefined || a === b || !["a", "b", "tie"].includes(pair.winner))
      fail("Invalid preference");
    games[a]![b]!++;
    games[b]![a]!++;
    wins[a]! += pair.winner === "a" ? 1 : pair.winner === "tie" ? 0.5 : 0;
    wins[b]! += pair.winner === "b" ? 1 : pair.winner === "tie" ? 0.5 : 0;
  }
  const connected = new Set([0]);
  for (let pass = 0; pass < ids.length; pass++)
    for (const a of [...connected])
      games[a]!.forEach((count, b) => {
        if (count) connected.add(b);
      });
  if (connected.size !== ids.length) fail("Comparison graph is disconnected; cross-component ratings are undefined");
  for (let a = 0; a < ids.length; a++)
    for (let b = a + 1; b < ids.length; b++) {
      games[a]![b]! += 0.02;
      games[b]![a]! += 0.02;
      wins[a]! += 0.01;
      wins[b]! += 0.01;
    }
  let strengths = ids.map(() => 1);
  for (let iteration = 0; iteration < 10_000; iteration++) {
    const next = strengths.map(
      (_, a) =>
        wins[a]! /
        games[a]!.reduce((sum, count, b) => sum + (a === b ? 0 : count / (strengths[a]! + strengths[b]!)), 0),
    );
    const centre = Math.exp(next.reduce((sum, value) => sum + Math.log(value), 0) / next.length);
    for (let i = 0; i < next.length; i++) next[i]! /= centre;
    const change = Math.max(...next.map((value, i) => Math.abs(Math.log(value / strengths[i]!))));
    strengths = next;
    if (change < 1e-9) break;
  }
  return Object.fromEntries(ids.map((id, i) => [id, Math.log(strengths[i]!)]));
}
const interval = (values: number[]): [number, number] => {
  values.sort((a, b) => a - b);
  return [values[Math.floor((values.length - 1) * 0.025)]!, values[Math.ceil((values.length - 1) * 0.975)]!];
};
export function ratePreferences(
  preferences: Preference[],
  options: { seed: number; bootstrapSamples: number; noiseFloor: number },
) {
  if (
    !Number.isInteger(options.bootstrapSamples) ||
    options.bootstrapSamples < 1 ||
    !Number.isFinite(options.noiseFloor) ||
    options.noiseFloor < 0
  )
    fail("Set a measured non-negative noise floor and positive bootstrap count");
  const ratings = fit(preferences),
    ids = Object.keys(ratings),
    rng = seeded(options.seed);
  // Resample paired order/judge observations together when a block is supplied.
  const blocks = new Map<string, Preference[]>();
  preferences.forEach((pair, i) => {
    const key = pair.block ?? String(i);
    blocks.set(key, [...(blocks.get(key) ?? []), pair]);
  });
  const groups = [...blocks.values()],
    samples: Record<string, number>[] = [];
  for (let iteration = 0; iteration < options.bootstrapSamples; iteration++) {
    const sample = groups.flatMap(() => groups[Math.floor(rng() * groups.length)]!);
    try {
      samples.push(fit(sample, ids));
    } catch {
      /* A disconnected replicate has no rating. */
    }
  }
  if (samples.length < Math.ceil(options.bootstrapSamples * 0.8))
    fail("Too few connected bootstrap samples; collect more comparisons");
  return {
    ratings: ids
      .map((id) => ({ id, rating: ratings[id]!, interval95: interval(samples.map((sample) => sample[id]!)) }))
      .sort((a, b) => b.rating - a.rating),
    deltas: ids.flatMap((a, i) =>
      ids.slice(i + 1).map((b) => {
        const delta = ratings[a]! - ratings[b]!,
          interval95 = interval(samples.map((sample) => sample[a]! - sample[b]!));
        return {
          a,
          b,
          delta,
          interval95,
          interpretation: (Math.abs(delta) <= options.noiseFloor || (interval95[0] <= 0 && interval95[1] >= 0)
            ? "no detectable change"
            : "detectable change") as "no detectable change" | "detectable change",
        };
      }),
    ),
  };
}
