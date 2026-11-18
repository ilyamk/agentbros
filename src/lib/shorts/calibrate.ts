import {
  ShortsCalibrationSchema,
  ShortsRatingsSchema,
  type ShortsCalibration,
  type ShortsProposals,
} from "../../types/shorts";

export const APPROVED_AT_LEAST = 4;
export const TARGET_PRECISION = 0.7;

/** Lowest score threshold at which at least `targetPrecision` of the rated clips scoring at or above it were approved (rating >= 4). */
export function calibrateThreshold(
  proposals: ShortsProposals,
  rawRatings: unknown,
  options: {
    minClips: number;
    minAbove: number;
    targetPrecision?: number;
    ratingsSha256: string;
    proposalsSha256: string;
    now?: Date;
  },
): ShortsCalibration {
  const { ratings } = ShortsRatingsSchema.parse(rawRatings);
  const scores = new Map([...proposals.proposals, ...proposals.others].map((p) => [p.id, p.score]));
  const seen = new Set<string>();
  const rated = ratings.map((r) => {
    if (seen.has(r.id)) throw new Error(`Duplicate rating for ${r.id}`);
    seen.add(r.id);
    const score = scores.get(r.id);
    if (score === undefined) throw new Error(`Rated clip ${r.id} has no score in these proposals`);
    return { score, approved: r.rating >= APPROVED_AT_LEAST };
  });
  if (rated.length < options.minClips)
    throw new Error(`Calibration needs at least ${options.minClips} rated clips; got ${rated.length}`);
  const target = options.targetPrecision ?? TARGET_PRECISION;
  const thresholds = [...new Set(rated.map((r) => r.score))].sort((a, b) => a - b);
  for (const threshold of thresholds) {
    const above = rated.filter((r) => r.score >= threshold);
    if (above.length < options.minAbove) break;
    const approved = above.filter((r) => r.approved).length;
    const precision = approved / above.length;
    if (precision >= target)
      return ShortsCalibrationSchema.parse({
        version: 1,
        threshold,
        weights: proposals.weights,
        weightsHash: proposals.weightsHash,
        approvedAtLeast: APPROVED_AT_LEAST,
        targetPrecision: target,
        precision: Math.round(precision * 1000) / 1000,
        clipsAbove: above.length,
        approvedAbove: approved,
        rated: rated.length,
        ratingsSha256: options.ratingsSha256,
        proposalsSha256: options.proposalsSha256,
        calibratedAt: (options.now ?? new Date()).toISOString(),
      });
  }
  throw new Error(
    `No threshold keeps at least ${options.minAbove} clips with ${Math.round(target * 100)}% approved; rate more clips or revise the weights`,
  );
}
