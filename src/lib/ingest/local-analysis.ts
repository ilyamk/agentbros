import type { RejectedObserverOptions } from "./rejected-observation";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hashFile } from "../assets/registry";
import { inspectAsset } from "../assets/inspect";
import { CliErrorObject } from "../cli";
import { ingestMedia } from "./index";
import { runLocalWorker, readBoundedLocalText, type LocalWorkerConfig } from "./local-worker";
import { EmbeddingPackSchema, EmbeddingQuerySchema, segmentEmbeddingHash } from "./embeddings";
import { SourceIndexSchema, type SourceIndex, type IngestOptions } from "../../types/source-index";
export async function ingestLocalMedia(request: {
  projectId: string;
  sourceFile: string;
  config: LocalWorkerConfig;
  options?: IngestOptions;
  rejectedObserver?: RejectedObserverOptions;
}) {
  const inspected = inspectAsset(request.sourceFile);
  if (inspected.kind === "image")
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "ASR requires recorded audio/video",
    });
  const result = await runLocalWorker(
    request.config,
    {
      operation: "asr",
      sourceFile: path.resolve(request.sourceFile),
      sourceHash: hashFile(request.sourceFile),
      durationSec: inspected.media.durationSec!,
    },
    request.projectId,
    request.rejectedObserver,
  );
  const identity = result.capability.identity;
  const transcriptFile = result.file.replace(/\.json$/, ".transcript.json");
  const bytes = JSON.stringify(result.output) + "\n";
  if (existsSync(transcriptFile)) {
    if (readBoundedLocalText(transcriptFile) !== bytes)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Local transcript evidence checksum changed",
      });
  } else
    writeFileSync(transcriptFile, bytes, {
      flag: "wx",
    });
  const analysis = ingestMedia({
    projectId: request.projectId,
    sourceFile: request.sourceFile,
    transcriptFile,
    options: request.options,
    localAnalysis: {
      engine: "whisper.cpp",
      identityHash: result.capability.identityHash,
      cacheKey: result.key,
      model: identity.model,
      revision: identity.revision,
      modelHash: identity.modelHash,
      reviewRequired: true,
      segmentation: "sentence-boundaries-v1",
      ...(request.config.wordTimingMethod ? { wordTimingMethod: request.config.wordTimingMethod } : {}),
    },
  });
  return {
    ...analysis,
    workerCacheHit: result.cacheHit,
    workerEvidence: result.file,
    ...("wordTimings" in result.output && result.output.wordTimings
      ? {
          wordAlignment: {
            method: result.output.wordTimings.method,
            status: result.output.wordTimings.status,
            estimated: true,
            reviewRequired: true,
            ...(result.output.wordTimings.reason ? { reason: result.output.wordTimings.reason } : {}),
          },
        }
      : {}),
    reviewRequired: true,
  };
}
export async function embedSourceIndexes(projectId: string, inputs: SourceIndex[], config: LocalWorkerConfig) {
  const indexes = inputs.map((index) => SourceIndexSchema.parse(index));
  if (indexes.some((index) => index.projectId !== projectId))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Embedding indexes belong to another project",
    });
  const rows = indexes.flatMap((index) =>
    index.segments
      .filter((segment) => segment.text.trim())
      .map((segment) => ({
        index,
        segment,
        pin: segmentEmbeddingHash(index, segment.id),
      })),
  );
  if (!rows.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "No textual source segments to embed",
    });
  const result = await runLocalWorker(
    config,
    {
      operation: "embed",
      texts: rows.map((row) => row.segment.text),
      sourcePins: rows.map((row) => row.pin),
    },
    projectId,
  );
  const vectors = z
    .object({
      vectors: z.array(z.array(z.number())),
    })
    .parse(result.output).vectors;
  const pack = EmbeddingPackSchema.parse({
    version: 1,
    space: {
      model: result.capability.identity.model,
      revision: result.capability.identityHash,
      dimensions: vectors[0]!.length,
      kind: "text",
    },
    generatedBy: `local ${result.capability.engine}`,
    evidence: result.file,
    items: rows.map((row, i) => ({
      cacheKey: row.index.cacheKey,
      sourceHash: row.index.sourceHash,
      segmentId: row.segment.id,
      segmentHash: row.pin,
      vector: vectors[i],
    })),
  });
  const file = result.file.replace(/\.json$/, ".pack.json"),
    bytes = JSON.stringify(pack) + "\n";
  if (existsSync(file)) {
    if (readBoundedLocalText(file) !== bytes)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Local embedding pack evidence checksum changed",
      });
  } else
    writeFileSync(file, bytes, {
      flag: "wx",
    });
  return {
    pack,
    file,
    cacheHit: result.cacheHit,
    workerIdentity: result.capability.identity,
    workerEvidence: result.file,
  };
}
export async function embedLocalQuery(projectId: string, text: string, config: LocalWorkerConfig, space: unknown) {
  const result = await runLocalWorker(
    config,
    {
      operation: "embed",
      texts: [text],
      sourcePins: [],
    },
    projectId,
  );
  const vectors = z
    .object({
      vectors: z.array(z.array(z.number())),
    })
    .parse(result.output).vectors;
  const query = EmbeddingQuerySchema.parse({
    space: {
      model: result.capability.identity.model,
      revision: result.capability.identityHash,
      dimensions: vectors[0]!.length,
      kind: "text",
    },
    text,
    vector: vectors[0],
  });
  if (JSON.stringify(query.space) !== JSON.stringify(EmbeddingQuerySchema.shape.space.parse(space)))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Query worker differs from corpus model/revision/dimensions",
    });
  return {
    query,
    cacheHit: result.cacheHit,
    workerEvidence: result.file,
  };
}
