import { CategoryReceiptSchema, CategoryQuerySchema, CategoryRuntimeSchema } from "../../types/category-search";
import { SourceIndexSchema, type SourceIndex } from "../../types/source-index";
import { boundedEvidenceJson, boundedEvidenceHash } from "./bounded-evidence";
import { sourceIndexCacheKey, verifyOcrEvidence } from "./ocr-evidence";
import { verifyVisualEvidence } from "./visual-evidence";
import { AssetRegistrySchema } from "../../types/assets";
import { stableHash } from "../longform/plans";
import { digest } from "../jobs/model-artifacts";
import type { z } from "zod";
export const CATEGORY_RECEIPT_LIMIT = 8 * 1024 * 1024;
export const categoryOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export function validateCategoryRuntime(raw: unknown) {
  const value = CategoryRuntimeSchema.parse(raw),
    ids = value.taxonomy.identifiers;
  if (ids.some((s, i) => i > 0 && categoryOrder(ids[i - 1]!, s) >= 0) || digest(ids.join("\n")) !== value.taxonomy.hash)
    throw Error("Category taxonomy must have unique sorted identifiers and exact hash");
  return value;
}
export function validateCategoryReceipt(raw: unknown) {
  const value = CategoryReceiptSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(value)) > CATEGORY_RECEIPT_LIMIT)
    throw Error("Category receipt exceeds8MiB; refusing truncation");
  const runtime = validateCategoryRuntime(value.identity.runtime),
    ids = new Set(runtime.taxonomy.identifiers);
  for (const frame of value.frames)
    if (
      frame.observations.some(
        (row, i) =>
          !ids.has(row.identifier) ||
          (i > 0 && categoryOrder(frame.observations[i - 1]!.identifier, row.identifier) >= 0),
      )
    )
      throw Error(
        "Category observations require supported unique sorted identifiers; complete returned rows must not be truncated",
      );
  return value;
}
export function categoryReceiptKey(identityHash: string, sourceHash: string, baseIndex: unknown, frames: unknown) {
  return stableHash({ version: 1, identityHash, sourceHash, baseIndex, frames });
}
export function categorySegments(
  base: SourceIndex,
  receipt: z.infer<typeof CategoryReceiptSchema>,
  receiptHash: string,
) {
  return receipt.frames.map((frame, i) => {
    const n = frame.sourceFrame.num,
      endSec = base.source.timestamps[n + 1];
    if (
      base.source.timestamps[n] !== frame.timeSec ||
      endSec === undefined ||
      !Number.isFinite(endSec) ||
      endSec <= frame.timeSec ||
      endSec > base.source.durationSec + 0.001
    )
      throw Error("Category frame requires exact nextPTS; terminal extent unverified");
    return {
      id: `category-frame-${i}`,
      startSec: frame.timeSec,
      endSec,
      text: "",
      tags: [],
      evidence: [
        {
          kind: "visual-category" as const,
          source: frame.path,
          hash: frame.hash,
          detail: `Sampled decoded frame ${n}; persistence unverified. Native category scores are not calibrated confidence or semantic truth. Raw receipt ${receiptHash}; taxonomy ${receipt.identity.runtime.taxonomy.hash}.`,
        },
      ],
    };
  });
}
/** Rebuild all candidate segments before consumers can use category rows. No engine execution. */
export function verifyCategoryEvidence(index: SourceIndex, publicFile: (ref: string) => string): SourceIndex {
  const pin = index.categoryAnalysis;
  if (!pin) return index;
  const raw = boundedEvidenceJson(publicFile(pin.receipt.path), CATEGORY_RECEIPT_LIMIT);
  if (raw.hash !== pin.receipt.hash) throw Error("Category receipt checksum changed");
  if (index.cacheKey !== sourceIndexCacheKey(index)) throw Error("Category derived cache identity mismatch");
  const receipt = validateCategoryReceipt(raw.value),
    baseRaw = boundedEvidenceJson(publicFile(receipt.baseIndex.path));
  if (baseRaw.hash !== receipt.baseIndex.hash) throw Error("Category base index checksum changed");
  const base = SourceIndexSchema.parse(baseRaw.value),
    frames = receipt.frames.map(({ width: _w, height: _h, observations: _o, ...frame }) => frame);
  if (
    base.categoryAnalysis ||
    base.source.kind !== "video" ||
    base.projectId !== index.projectId ||
    base.cacheKey !== sourceIndexCacheKey(base) ||
    base.cacheKey !== pin.baseCacheKey ||
    base.cacheKey !== receipt.baseIndex.cacheKey
  )
    throw Error("Category base identity mismatch");
  if (
    stableHash(receipt.identity) !== receipt.identityHash ||
    receipt.identityHash !== pin.identityHash ||
    receipt.key !== pin.cacheKey ||
    receipt.sourceHash !== index.sourceHash ||
    receipt.sourceHash !== base.sourceHash ||
    receipt.outputHash !== stableHash(receipt.frames) ||
    receipt.key !== categoryReceiptKey(receipt.identityHash, receipt.sourceHash, receipt.baseIndex, frames) ||
    JSON.stringify(frames) !== JSON.stringify(base.thumbnails)
  )
    throw Error("Category source/runtime/frame/score identity mismatch");
  if (boundedEvidenceHash(publicFile(base.source.path)) !== base.sourceHash)
    throw Error("Category source original changed");
  for (const frame of receipt.frames)
    if (boundedEvidenceHash(publicFile(frame.path), 16 * 1024 * 1024) !== frame.hash)
      throw Error("Category sampled frame changed");
  const comparable = ({ cacheKey: _k, createdAt: _c, categoryAnalysis: _p, segments: _s, ...rest }: SourceIndex) =>
    rest;
  if (
    JSON.stringify(comparable(base)) !== JSON.stringify(comparable(index)) ||
    JSON.stringify(index.segments) !== JSON.stringify([...base.segments, ...categorySegments(base, receipt, raw.hash)])
  )
    throw Error("Category candidates differ from immutable raw evidence");
  const prior = base.visualAnalysis
    ? verifyVisualEvidence(
        base,
        publicFile,
        AssetRegistrySchema.parse(
          boundedEvidenceJson(publicFile(`projects/${base.projectId}/pipeline/asset-registry.json`)).value,
        ),
        true,
      )
    : base;
  verifyOcrEvidence(prior, publicFile, true);
  return base;
}
/** Exact taxonomy ID only: omitted labels stay omitted, never fabricated zero scores. */
export function searchCategoryFrames(
  index: SourceIndex,
  publicFile: (ref: string) => string,
  rawQuery: unknown,
  limit = 100,
) {
  if (!index.categoryAnalysis || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw Error("Category search needs pinned analysis and limit1..100");
  verifyCategoryEvidence(index, publicFile);
  const receipt = validateCategoryReceipt(
      boundedEvidenceJson(publicFile(index.categoryAnalysis.receipt.path), CATEGORY_RECEIPT_LIMIT).value,
    ),
    query = CategoryQuerySchema.parse(rawQuery);
  if (
    query.taxonomyHash !== receipt.identity.runtime.taxonomy.hash ||
    !receipt.identity.runtime.taxonomy.identifiers.includes(query.identifier)
  )
    throw Error("Category query must use exact supported taxonomy identifier/hash");
  return receipt.frames
    .flatMap((frame, i) => {
      const row = frame.observations.find((v) => v.identifier === query.identifier);
      if (!row) return [];
      return [
        {
          cacheKey: index.cacheKey,
          assetId: index.assetId,
          sourceHash: index.sourceHash,
          segmentId: `category-frame-${i}`,
          startSec: frame.timeSec,
          endSec: index.source.timestamps[frame.sourceFrame.num + 1]!,
          score: row.score,
          method: "native-image-category" as const,
          query,
          queryHash: stableHash(query),
          frameHash: frame.hash,
          taxonomyHash: query.taxonomyHash,
          reviewRequired: true as const,
          automaticSelection: false as const,
          calibratedConfidence: false as const,
        },
      ];
    })
    .sort((a, b) => b.score - a.score || a.startSec - b.startSec || categoryOrder(a.segmentId, b.segmentId))
    .slice(0, limit);
}
