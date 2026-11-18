/**
 * Pack result review helpers (RFC 0003 §10.3, §10.4): a one-line summary of a PackResultReview and its memory
 * observation. The failed-dimension invariant itself is enforced by PackResultReviewSchema.
 */
import { addMemory, markSeen } from "../memory";
import { CliErrorObject } from "../cli";
import type { MemoryEntry } from "../../types/memory";
import { PackResultReviewSchema, type PackResultReview, type ReferenceRole } from "../../types/references";

/** One identity-similarity reading (D10): optional evidence with its model and version, never a verdict. */
export type IdentitySimilarity = NonNullable<PackResultReview["identitySimilarity"]>[number];

/**
 * Future: a local face-embedding model that compares result frames with the identity attachments. No model is
 * integrated yet; `noIdentitySimilarity` returns no readings, and a review then omits `identitySimilarity`.
 */
export interface IdentitySimilarityProvider {
  readonly model: string;
  readonly version: string;
  measure(input: {
    resultFrames: string[];
    attachments: Array<{ sha256: string; file: string }>;
  }): Promise<IdentitySimilarity[]>;
}
export const noIdentitySimilarity: IdentitySimilarityProvider = {
  model: "none",
  version: "0",
  measure: async () => [],
};

export const REVIEW_DIMENSIONS = [
  "identity",
  "wardrobe",
  "preserved",
  "otherSubjects",
  "motion",
  "naturalness",
  "promptFit",
  "temporalConsistency",
  "audio",
] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

/** What the memory line says about the pack: its profile family and the roles of its attachments. */
export type PackReviewContext = {
  packId: string;
  profileFamily: string;
  attachmentRoles: ReferenceRole[];
  /** Project the pack belongs to; scopes the observation. */
  project?: string;
};

export type ResultReviewSummary = {
  verdict: PackResultReview["verdict"];
  /** Dimensions equal to "fail"; not-applicable and replace-in-edit are not failures. */
  failedDimensions: ReviewDimension[];
  memoryObservation: string;
};

const rolesText = (roles: ReferenceRole[]) => {
  const counts = new Map<string, number>();
  for (const role of roles) counts.set(role, (counts.get(role) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, n]) => (n > 1 ? `${role}x${n}` : role))
    .join(", ");
};

/**
 * Verdict, failed dimensions and a one-line memory observation (§10.4): profile family, attachment roles and count,
 * verdict and failing dimensions. Generic on purpose (no pack id), so a repeat is a near-duplicate memory counts.
 */
export function summariseResultReview(review: PackResultReview, pack?: PackReviewContext): ResultReviewSummary {
  const parsed = PackResultReviewSchema.parse(review);
  const failedDimensions = REVIEW_DIMENSIONS.filter((dimension) => parsed[dimension] === "fail");
  const subject = pack
    ? `${pack.profileFamily} pack, ${pack.attachmentRoles.length} attachment(s) (${rolesText(pack.attachmentRoles)})`
    : "Reference pack";
  const failing = failedDimensions.length ? `; failed ${failedDimensions.join(", ")}` : "";
  let line = `${subject}: result ${parsed.verdict}${failing}`;
  if (line.length > 160) line = `${line.slice(0, 159)}…`;
  return { verdict: parsed.verdict, failedDimensions, memoryObservation: line };
}

export type RecordReviewResult =
  { action: "dry-run"; entry: Parameters<typeof addMemory>[0] } | { action: "added" | "seen"; entry: MemoryEntry };

/**
 * Records the review as a memory observation (§10.4). A near-duplicate active observation counts a sighting
 * (memory hygiene: never a reworded copy). dryRun returns the entry it would add and writes nothing.
 */
export function recordReviewToMemory(options: {
  review: PackResultReview;
  packSummary: PackReviewContext;
  dryRun?: boolean;
  /** Who records it; the orchestrator is memory's only writer. */
  agent?: string;
  /** Memory root override (AGENTBROS_MEMORY_ROOT still wins). */
  root?: string;
}): RecordReviewResult {
  const { review, packSummary, dryRun = false, agent = "orchestrator", root } = options;
  const summary = summariseResultReview(review, packSummary);
  const evidence = `pipeline/reference-packs/${packSummary.packId}/results/${review.outputSha256}/review.json`;
  const entry = {
    type: "observation" as const,
    summary: summary.memoryObservation,
    scope: packSummary.project ? { project: packSummary.project } : {},
    source: { kind: "agent" as const, agent, evidence },
    body: [
      `Pack ${packSummary.packId} (${review.packSha256}), output ${review.outputSha256}.`,
      `Reviewer: ${review.reviewer}. Verdict: ${review.verdict}.`,
      `Failed: ${summary.failedDimensions.join(", ") || "none"}.`,
      `Evidence: ${review.evidence}`,
      "",
    ].join("\n"),
  };
  if (dryRun) return { action: "dry-run", entry };
  try {
    return { action: "added", entry: addMemory(entry, root) };
  } catch (error) {
    const existing = (error as CliErrorObject).details?.existing;
    if ((error as CliErrorObject).code === "FILE_EXISTS" && typeof existing === "string")
      return { action: "seen", entry: markSeen(existing, root, evidence) };
    throw error;
  }
}
