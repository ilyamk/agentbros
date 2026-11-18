import { boundedEvidenceJson } from "./bounded-evidence";
import { readFileSync, constants, openSync, closeSync, fstatSync, readSync, lstatSync, existsSync } from "node:fs";
import path from "node:path";
import { OcrReceiptSchema, OcrFramePinSchema } from "../../types/ocr";
import type { z } from "zod";
import { SourceIndexSchema, type SourceIndex } from "../../types/source-index";
import { digest } from "../jobs/model-artifacts";
import { stableHash } from "../longform/plans";
/** Optional pin preserves the exact historical key formula when absent. */
export function sourceIndexCacheKey(
  index: Pick<
    SourceIndex,
    "sourceHash" | "options" | "transcript" | "localAnalysis" | "ocrAnalysis" | "visualAnalysis" | "categoryAnalysis"
  >,
) {
  return digest(
    JSON.stringify({
      version: 1,
      sourceHash: index.sourceHash,
      options: index.options,
      transcriptHash: index.transcript?.hash,
      ...(index.localAnalysis ? { localAnalysis: index.localAnalysis } : {}),
      ...(index.ocrAnalysis ? { ocrAnalysis: index.ocrAnalysis } : {}),
      ...(index.visualAnalysis ? { visualAnalysis: index.visualAnalysis } : {}),
      ...(index.categoryAnalysis ? { categoryAnalysis: index.categoryAnalysis } : {}),
    }),
  );
}
/** Refuse aliases in every path component; never follow a user-supplied OCR receipt. */
export function ocrLocalPath(project: string, file: string) {
  const full = path.resolve(file);
  if (full !== project && !full.startsWith(project + path.sep)) throw new Error("OCR evidence outside project");
  let current = full;
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("OCR evidence symlink forbidden");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return full;
}
export function ocrRegularFile(file: string, maximum = 32 * 1024 ** 3) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
    throw new Error("OCR input requires a bounded regular file");
  return file;
}
export function readOcrJson(file: string, limit = 256 * 1024) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("OCR evidence must be a bounded regular file");
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size || bytes.length > limit || readSync(fd, Buffer.alloc(1), 0, 1, null))
      throw new Error("OCR evidence changed during read");
    return { value: JSON.parse(bytes.toString("utf8")), hash: digest(bytes) };
  } finally {
    closeSync(fd);
  }
}
export function ocrReceiptKey(identityHash: string, sourceHash: string, baseIndex: unknown, frames: unknown) {
  return stableHash({ version: 1, identityHash, sourceHash, baseIndex, frames });
}
export function ocrSegments(base: SourceIndex, receipt: z.infer<typeof OcrReceiptSchema>, receiptHash: string) {
  return receipt.frames.flatMap((frame, frameIndex) => {
    const n = frame.sourceFrame.num,
      startSec = base.source.timestamps[n];
    const endSec = base.source.timestamps[n + 1];
    if (
      startSec !== frame.timeSec ||
      endSec === undefined ||
      !Number.isFinite(endSec) ||
      endSec <= frame.timeSec ||
      endSec > base.source.durationSec + 0.001
    )
      throw new Error("OCR frame occurrence clock mismatch");
    return frame.observations.map((observation, i) => ({
      id: `ocr-frame-${frameIndex}-${i}`,
      startSec: frame.timeSec,
      endSec,
      text: observation.text,
      tags: [],
      evidence: [
        {
          kind: "ocr" as const,
          source: frame.path,
          hash: frame.hash,
          detail: `Sampled decoded frame ${n}; persistence and spoken alignment unverified. Raw OCR receipt ${receiptHash}; observation ${i}.`,
        },
      ],
    }));
  });
}
/** Shared by canonical index reader and B-roll's independent scoped reader. No engine execution. */
export function verifyOcrEvidence(index: SourceIndex, publicFile: (ref: string) => string, bounded = false) {
  const read = (file: string, limit = 256 * 1024) =>
    bounded ? boundedEvidenceJson(file, limit) : readOcrJson(file, limit);
  const pin = index.ocrAnalysis;
  if (!pin) return;
  const raw = read(publicFile(pin.receipt.path));
  if (raw.hash !== pin.receipt.hash) throw new Error("OCR receipt checksum changed");
  const receipt = OcrReceiptSchema.parse(raw.value);
  const baseRaw = read(publicFile(receipt.baseIndex.path), 16 * 1024 * 1024);
  if (baseRaw.hash !== receipt.baseIndex.hash) throw new Error("OCR base index checksum changed");
  const base = SourceIndexSchema.parse(baseRaw.value);
  if (
    base.ocrAnalysis ||
    base.cacheKey !== sourceIndexCacheKey(base) ||
    base.cacheKey !== receipt.baseIndex.cacheKey ||
    base.cacheKey !== pin.baseCacheKey ||
    base.projectId !== index.projectId ||
    base.source.kind !== "video"
  )
    throw new Error("OCR base index identity mismatch");
  const frames = receipt.frames.map(({ width: _width, height: _height, observations: _observations, ...frame }) =>
    OcrFramePinSchema.parse(frame),
  );
  if (
    stableHash(receipt.identity) !== receipt.identityHash ||
    receipt.identityHash !== pin.identityHash ||
    receipt.key !== pin.cacheKey ||
    receipt.sourceHash !== index.sourceHash ||
    receipt.sourceHash !== base.sourceHash ||
    receipt.identity.runtime.revision !== pin.revision ||
    receipt.outputHash !== stableHash(receipt.frames) ||
    receipt.key !== ocrReceiptKey(receipt.identityHash, receipt.sourceHash, receipt.baseIndex, frames) ||
    JSON.stringify(frames) !== JSON.stringify(base.thumbnails)
  )
    throw new Error("OCR engine/source/frame/receipt identity mismatch");
  const languages = receipt.identity.languages;
  if (
    new Set(languages).size !== languages.length ||
    languages.some((v) => !receipt.identity.runtime.supportedLanguages.includes(v))
  )
    throw new Error("OCR unsupported recognition language");
  const segments = ocrSegments(base, receipt, pin.receipt.hash);
  const comparable = ({
    cacheKey: _key,
    createdAt: _created,
    ocr: _ocr,
    ocrAnalysis: _analysis,
    segments: _segments,
    ...rest
  }: SourceIndex) => rest;
  if (
    JSON.stringify(comparable(base)) !== JSON.stringify(comparable(index)) ||
    JSON.stringify(index.segments) !== JSON.stringify([...base.segments, ...segments]) ||
    !index.ocr.available ||
    !index.ocr.executed
  )
    throw new Error("OCR source/segments differ from immutable raw evidence");
}
