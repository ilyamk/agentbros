import { boundedEvidenceJson, boundedEvidenceHash } from "./bounded-evidence";
import { VisualReceiptSchema, VisualQueryPinSchema } from "../../types/visual-search";
import { SourceIndexSchema, type SourceIndex } from "../../types/source-index";
import type { z } from "zod";
import { readOcrJson, sourceIndexCacheKey, ocrRegularFile } from "./ocr-evidence";
import { stableHash } from "../longform/plans";
import { hashFile } from "../assets/registry";
import type { AssetRegistry } from "../../types/assets";
export function visualReceiptKey(
  identityHash: string,
  sourceHash: string,
  baseIndex: unknown,
  query: unknown,
  frames: unknown,
) {
  return stableHash({ version: 1, identityHash, sourceHash, baseIndex, query, frames });
}
export function visualSegments(base: SourceIndex, receipt: z.infer<typeof VisualReceiptSchema>, receiptHash: string) {
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
      throw new Error("Visual frame requires exact nextPTS; terminal extent unverified");
    return {
      id: `visual-frame-${i}`,
      startSec: frame.timeSec,
      endSec,
      text: "",
      tags: [],
      evidence: [
        {
          kind: "visual-frame" as const,
          source: frame.path,
          hash: frame.hash,
          detail: `Sampled decoded frame ${n}; persistence unverified. Native feature distance ${frame.distance}; not semantic confidence. Raw receipt ${receiptHash}; query ${receipt.query.hash}.`,
        },
      ],
    };
  });
}
/** Reconstruct the entire derived index from raw scores and pinned source/query originals. No engine execution. */
export function verifyVisualEvidence(
  index: SourceIndex,
  publicFile: (ref: string) => string,
  registry: AssetRegistry,
  bounded = false,
) {
  const read = (file: string, limit = 256 * 1024) =>
    bounded ? boundedEvidenceJson(file, limit) : readOcrJson(file, limit);
  const pin = index.visualAnalysis;
  if (!pin) return index;
  const raw = read(publicFile(pin.receipt.path));
  if (raw.hash !== pin.receipt.hash) throw new Error("Visual receipt checksum changed");
  const receipt = VisualReceiptSchema.parse(raw.value),
    baseRaw = read(publicFile(receipt.baseIndex.path), 16 * 1024 * 1024);
  if (baseRaw.hash !== receipt.baseIndex.hash) throw new Error("Visual base index checksum changed");
  const base = SourceIndexSchema.parse(baseRaw.value);
  if (
    base.visualAnalysis ||
    base.cacheKey !== sourceIndexCacheKey(base) ||
    base.cacheKey !== receipt.baseIndex.cacheKey ||
    base.cacheKey !== pin.baseCacheKey ||
    base.projectId !== index.projectId ||
    base.source.kind !== "video"
  )
    throw new Error("Visual base identity mismatch");
  const frames = receipt.frames.map(({ width: _w, height: _h, featureHash: _f, distance: _d, ...frame }) => frame);
  if (
    stableHash(receipt.identity) !== receipt.identityHash ||
    receipt.identityHash !== pin.identityHash ||
    receipt.key !== pin.cacheKey ||
    receipt.sourceHash !== index.sourceHash ||
    receipt.sourceHash !== base.sourceHash ||
    receipt.outputHash !== stableHash({ queryFeatureHash: receipt.queryFeatureHash, frames: receipt.frames }) ||
    receipt.key !==
      visualReceiptKey(receipt.identityHash, receipt.sourceHash, receipt.baseIndex, receipt.query, frames) ||
    JSON.stringify(frames) !== JSON.stringify(base.thumbnails)
  )
    throw new Error("Visual runtime/frame/score identity mismatch");
  const asset = registry.assets.find((a) => a.id === receipt.query.assetId);
  if (
    !asset ||
    asset.kind !== "image" ||
    asset.hash !== receipt.query.hash ||
    asset.files.original !== receipt.query.path ||
    stableHash(asset) !== receipt.query.assetMetadataHash
  )
    throw new Error("Visual query must retain its registered immutable image identity");
  ocrRegularFile(publicFile(receipt.query.path), 16 * 1024 * 1024);
  if (
    (bounded
      ? boundedEvidenceHash(publicFile(receipt.query.path), 16 * 1024 * 1024)
      : hashFile(publicFile(receipt.query.path))) !== receipt.query.hash
  )
    throw new Error("Visual query original changed");
  const comparable = ({ cacheKey: _k, createdAt: _c, visualAnalysis: _v, segments: _s, ...rest }: SourceIndex) => rest;
  if (
    JSON.stringify(comparable(base)) !== JSON.stringify(comparable(index)) ||
    JSON.stringify(index.segments) !== JSON.stringify([...base.segments, ...visualSegments(base, receipt, raw.hash)])
  )
    throw new Error("Visual candidates differ from immutable raw evidence");
  return base;
}
export function searchVisualFrames(
  index: SourceIndex,
  publicFile: (ref: string) => string,
  registry: AssetRegistry,
  limit = 10,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !index.visualAnalysis)
    throw new Error("Visual retrieval requires pinned analysis and limit 1..100");
  verifyVisualEvidence(index, publicFile, registry);
  const receipt = VisualReceiptSchema.parse(readOcrJson(publicFile(index.visualAnalysis.receipt.path)).value);
  return receipt.frames
    .map((frame, i) => ({
      cacheKey: index.cacheKey,
      assetId: index.assetId,
      sourceHash: index.sourceHash,
      segmentId: `visual-frame-${i}`,
      startSec: frame.timeSec,
      endSec: index.source.timestamps[frame.sourceFrame.num + 1]!,
      distance: frame.distance,
      method: "native-image-feature-distance" as const,
      query: receipt.query,
      frameHash: frame.hash,
      featureHash: frame.featureHash,
      reviewRequired: true as const,
      automaticSelection: false as const,
    }))
    .sort((a, b) => a.distance - b.distance || a.startSec - b.startSec || a.segmentId.localeCompare(b.segmentId))
    .slice(0, limit);
}
export { VisualQueryPinSchema };
