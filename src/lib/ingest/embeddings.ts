import { z } from "zod";
import { stableHash } from "../longform/plans";
import { SourceIndexSchema, type SourceIndex } from "../../types/source-index";
export const EmbeddingSpaceSchema = z
  .object({
    model: z.string().min(1),
    revision: z.string().min(1),
    dimensions: z.number().int().min(1).max(16384),
    kind: z.enum(["text", "image", "multimodal"]),
  })
  .strict();
const VectorSchema = z.array(z.number().finite()).min(1).max(16384);
export const EmbeddingPackSchema = z
  .object({
    version: z.literal(1),
    space: EmbeddingSpaceSchema,
    generatedBy: z.string().min(1),
    evidence: z.string().min(1),
    items: z
      .array(
        z
          .object({
            cacheKey: z.string().regex(/^[a-f0-9]{64}$/),
            sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
            segmentId: z.string().min(1),
            segmentHash: z.string().regex(/^[a-f0-9]{64}$/),
            vector: VectorSchema,
          })
          .strict(),
      )
      .max(100000),
  })
  .strict();
export const EmbeddingQuerySchema = z
  .object({
    space: EmbeddingSpaceSchema,
    text: z.string().min(1),
    vector: VectorSchema,
  })
  .strict();
export function segmentEmbeddingHash(index: SourceIndex, segmentId: string) {
  const segment = index.segments.find((segment) => segment.id === segmentId);
  if (!segment) throw new Error("Embedding segment missing");
  return stableHash({
    sourceHash: index.sourceHash,
    cacheKey: index.cacheKey,
    segment,
  });
}
function unit(vector: number[], dimensions: number) {
  if (vector.length !== dimensions) throw new Error("Embedding dimension mismatch");
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Embedding must have finite nonzero norm");
  return vector.map((value) => value / norm);
}
/** Actual vector search over supplied, provenance-labelled embeddings; never labels lexical scores semantic. */
export function searchEmbeddings(indexInputs: SourceIndex[], packInput: unknown, queryInput: unknown, limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Embedding limit must be 1–100");
  const indexes = indexInputs.map((index) => SourceIndexSchema.parse(index)),
    pack = EmbeddingPackSchema.parse(packInput),
    query = EmbeddingQuerySchema.parse(queryInput);
  if (JSON.stringify(pack.space) !== JSON.stringify(query.space))
    throw new Error("Query and corpus require exactly the same embedding model/revision/kind/dimensions");
  const normalized = unit(query.vector, pack.space.dimensions),
    seen = new Set<string>();
  const hits = pack.items.map((item) => {
    const identity = `${item.cacheKey}:${item.segmentId}`;
    if (seen.has(identity)) throw new Error("Duplicate embedding item");
    seen.add(identity);
    const index = indexes.find((index) => index.cacheKey === item.cacheKey && index.sourceHash === item.sourceHash),
      segment = index?.segments.find((segment) => segment.id === item.segmentId);
    if (!index || !segment || segmentEmbeddingHash(index, segment.id) !== item.segmentHash)
      throw new Error("Embedding source/segment evidence stale or missing");
    const vector = unit(item.vector, pack.space.dimensions),
      cosine = Math.max(
        -1,
        Math.min(
          1,
          vector.reduce((sum, value, i) => sum + value * normalized[i], 0),
        ),
      );
    return {
      cacheKey: index.cacheKey,
      assetId: index.assetId,
      sourceHash: index.sourceHash,
      segmentId: segment.id,
      startSec: segment.startSec,
      endSec: segment.endSec,
      text: segment.text,
      cosine,
      method: "supplied-embedding-cosine" as const,
      evidence: segment.evidence,
      embeddingEvidence: {
        space: pack.space,
        generatedBy: pack.generatedBy,
        source: pack.evidence,
        segmentHash: item.segmentHash,
      },
      automaticSelection: false as const,
    };
  });
  return hits
    .sort(
      (a, b) =>
        b.cosine - a.cosine ||
        a.sourceHash.localeCompare(b.sourceHash) ||
        a.startSec - b.startSec ||
        a.segmentId.localeCompare(b.segmentId),
    )
    .slice(0, limit);
}
