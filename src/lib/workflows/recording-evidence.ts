import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AssetRegistrySchema } from "../../types/assets";
import { RecordingEditRequestSchema, RecordingNormalizationSchema } from "../../types/workflow-recording-edit";
import { hashRecordingNormalizationMapping, hashRecordingTimingSummary } from "./recording-timing";
import { hashJoinPlan, type RecordingJoinPlan } from "./recording-joins";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().safe().nonnegative();
const finite = z.number().finite().nonnegative();
const Normalization = z
  .object({
    normalizerVersion: z.string().min(1),
    coordinateSystem: z.literal("decoded-original-frame-boundaries"),
    sourceBoundaries: z
      .array(z.object({ sourceFrame: integer, sourceSec: finite, masterFrame: integer }).strict())
      .min(2)
      .max(216001),
    masterToDecodedFrame: z.array(integer).min(1).max(54000),
    masterFrameCount: integer.positive().max(54000),
    droppedDecodedFrames: integer,
    repeatedMasterFrames: integer,
    mappingHash: sha,
    policy: RecordingNormalizationSchema,
    timingHash: sha,
    timingSummaryHash: sha,
    clockToleranceSec: finite.positive().max(0.001),
    originalDurationSec: finite.positive().max(1800),
    outputDurationSec: finite.positive().max(1800),
    boundaryMaxErrorSec: finite.max(1 / 60 + 1e-8),
    authenticAudioDurationSec: finite.positive(),
    decodedAudioDurationSec: finite.positive(),
    authenticContentDurationSec: finite.positive(),
    originalAudioVideoEndpointGapSec: z.number().finite(),
    masterCeilExtensionSec: finite.max(1 / 30 + 1e-8),
    tailAudioAdjustmentSec: z.number().finite(),
    terminalAdjustmentLimitSec: z.literal(2 / 30),
    originalImmutable: z.literal(true),
    speechSpeedChanged: z.literal(false),
  })
  .strict();
const canonical = (value: unknown): string =>
  JSON.stringify(value, function (_key, item) {
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item;
  });
function regular(project: string, file: string, maximum: number): void {
  if (lstatSync(project).isSymbolicLink()) throw new Error("Recording project symlinks are not permitted");
  const relative = path.relative(project, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Recording evidence path escapes project");
  let current = file;
  while (current !== project) {
    if (lstatSync(current).isSymbolicLink()) throw new Error("Recording evidence symlinks are not permitted");
    current = path.dirname(current);
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > maximum)
    throw new Error("Recording evidence file is not bounded regular data");
}
function json(project: string, file: string, maximum = 64 * 1024 * 1024): any {
  regular(project, file, maximum);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > maximum)
      throw new Error("Recording JSON must be bounded regular data");
    const value = JSON.parse(readFileSync(fd, "utf8"));
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("Recording JSON changed while reading");
    return value;
  } finally {
    closeSync(fd);
  }
}
function fileHash(project: string, file: string): string {
  regular(project, file, 32 * 1024 * 1024 * 1024);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW),
    hash = createHash("sha256");
  try {
    const before = fstatSync(fd),
      buffer = Buffer.alloc(1024 * 1024);
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("Recording immutable source changed while hashing");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
type RegistryAsset = (
  id: string,
  expectedHash: string,
  kind: "video" | "audio",
) => { record: z.infer<typeof AssetRegistrySchema>["assets"][number]; original: string };
function registryAssets(project: string, projectId: string) {
  const registryFile = path.join(project, "pipeline/asset-registry.json");
  const registry = AssetRegistrySchema.parse(json(project, registryFile, 8 * 1024 * 1024));
  const asset: RegistryAsset = (id, expectedHash, kind) => {
    const record = registry.assets.find((item) => item.id === id);
    if (
      !record ||
      record.kind !== kind ||
      record.hash !== expectedHash ||
      record.id !== `sha256:${expectedHash}` ||
      record.files.original !== `projects/${projectId}/assets/imported/${path.basename(record.files.original)}`
    )
      throw new Error("Recording original or derivative registry binding changed");
    const original = path.join(project, "assets/imported", path.basename(record.files.original));
    if (fileHash(project, original) !== expectedHash || lstatSync(original).size !== record.files.bytes)
      throw new Error("Recording original or derivative bytes changed");
    return { record, original };
  };
  return { registryFile, asset };
}
/** Version 3: the joined speech derivative and its join plan are bound to the reviewed identity. */
function assertJoinedSpeech(
  report: any,
  request: z.infer<typeof RecordingEditRequestSchema>,
  asset: RegistryAsset,
  masterKeepFrames: number,
): void {
  if (request.version !== 3) throw new Error("Joined speech evidence requires a version 3 request");
  const plan = report.joins?.plan as RecordingJoinPlan | undefined;
  if (
    !plan ||
    hashJoinPlan(plan) !== report.joins.joinPlanHash ||
    report.joins.joinPlanHash !== report.identity?.joinPlanHash ||
    canonical(plan.policy) !== canonical(request.joins) ||
    plan.joins.length !== request.keepSpans.length - 1
  )
    throw new Error("Recording join plan is not bound to reviewed identity");
  const audio = asset(report.audioAssetId, report.audioHash, "audio");
  const joined = asset(report.joins.joinedAudioAssetId, report.joins.joinedAudioHash, "audio");
  if (
    joined.record.provenance.tool !== "recording-join-crossfade" ||
    joined.record.provenance.model !== "none" ||
    canonical(joined.record.provenance.referenceAssetIds) !== canonical([audio.record.id])
  )
    throw new Error("Joined speech provenance changed");
  if (
    joined.record.media.sampleRate !== 48000 ||
    joined.record.media.channels !== 2 ||
    Math.abs(joined.record.media.durationSec! - masterKeepFrames / 30) > 1 / 48000 + 1e-6
  )
    throw new Error("Joined speech duration or format changed");
}
/** Read-only integrity check. Later timeline edits remain independent of the initial approved selection. */
export function assertRecordingEvidence(
  project: string,
  projectId: string,
  allowUnversioned = false,
): { originalFile: string; registryFile: string } | undefined {
  const file = path.join(project, "pipeline/recording-edit.json");
  if (!existsSync(file)) return;
  const report = json(project, file);
  if (
    allowUnversioned &&
    report.version === undefined &&
    report.request?.version === undefined &&
    report.normalization === undefined &&
    report.normalizedVideoAssetId === undefined
  )
    return;
  if (report.version === 1 && report.request?.version === 1) {
    const legacy = RecordingEditRequestSchema.parse(report.request);
    if (
      legacy.version !== 1 ||
      legacy.projectId !== projectId ||
      report.normalization !== undefined ||
      report.normalizedVideoAssetId !== undefined ||
      report.normalizedVideoHash !== undefined ||
      report.identity?.version !== 1 ||
      report.identity?.source?.normalization !== undefined ||
      report.identity?.source?.timingHash !== undefined ||
      report.identity?.source?.mappingHash !== undefined ||
      report.identity?.source?.timingSummaryHash !== undefined
    )
      throw new Error("Normalized recording evidence cannot be relabeled as legacy");
    if (
      !legacy.review ||
      digest(report.identity) !== report.editHash ||
      report.editHash !== legacy.review.approvedEditHash
    )
      throw new Error("Legacy recording review identity changed");
    return;
  }
  if (report.version === 3 && report.request?.version === 3 && report.request?.source?.normalization === undefined) {
    const request = RecordingEditRequestSchema.parse(report.request);
    if (
      request.version !== 3 ||
      "normalization" in request.source ||
      request.projectId !== projectId ||
      !request.review ||
      report.normalization !== undefined ||
      report.normalizedVideoAssetId !== undefined
    )
      throw new Error("Recording evidence requires reviewed matching project");
    const { review: _review, source, ...edit } = request;
    const frames = report.identity?.sourceFrameCount;
    if (!Number.isSafeInteger(frames) || frames < 1) throw new Error("Recording source frame count missing");
    const expectedIdentity = {
      ...edit,
      source: { sha256: source.sha256, version: source.version, fps: source.fps, rights: source.rights ?? {} },
      sourceFrameCount: frames,
      joinPlanHash: report.identity?.joinPlanHash,
    };
    if (
      canonical(expectedIdentity) !== canonical(report.identity) ||
      digest(report.identity) !== report.editHash ||
      report.editHash !== request.review.approvedEditHash ||
      canonical(report.reviewEvidence) !== canonical(request.review)
    )
      throw new Error("Recording source or review identity changed");
    const { registryFile, asset } = registryAssets(project, projectId);
    const original = asset(report.sourceAssetId, request.source.sha256, "video");
    const audio = asset(report.audioAssetId, report.audioHash, "audio");
    if (
      canonical(audio.record.provenance.referenceAssetIds) !== canonical([original.record.id]) ||
      audio.record.provenance.tool !== "ffmpeg-original-audio-extract" ||
      original.record.provenance.tool !== "supplied-recording"
    )
      throw new Error("Recording derivative provenance tool changed");
    assertJoinedSpeech(
      report,
      request,
      asset,
      request.keepSpans.reduce((n, k) => n + k.endFrame - k.startFrame, 0),
    );
    return { originalFile: original.original, registryFile };
  }
  if (
    !(report.version === 2 && report.request?.version === 2) &&
    !(report.version === 3 && report.request?.version === 3)
  )
    throw new Error("Invalid recording evidence version");
  const request = RecordingEditRequestSchema.parse(report.request);
  if (
    request.version !== report.version ||
    !("normalization" in request.source) ||
    request.projectId !== projectId ||
    !request.review
  )
    throw new Error("Recording evidence requires reviewed matching project");
  const normalization = Normalization.parse(report.normalization);
  const mappingHash = hashRecordingNormalizationMapping(normalization);
  if (
    mappingHash !== normalization.mappingHash ||
    mappingHash !== report.identity?.source?.mappingHash ||
    normalization.timingHash !== report.identity?.source?.timingHash
  )
    throw new Error("Recording normalization mapping is not bound to reviewed identity");
  const timingSummaryHash = hashRecordingTimingSummary(normalization);
  if (
    timingSummaryHash !== normalization.timingSummaryHash ||
    timingSummaryHash !== report.identity?.source?.timingSummaryHash
  )
    throw new Error("Recording timing summary is not bound to reviewed identity");
  const { review: _review, source, ...edit } = request;
  const sourceNormalization = "normalization" in source ? source.normalization : undefined;
  const expectedIdentity = {
    ...edit,
    source: {
      sha256: source.sha256,
      version: source.version,
      fps: source.fps,
      normalization: sourceNormalization,
      timingHash: normalization.timingHash,
      normalizerVersion: normalization.normalizerVersion,
      mappingHash,
      timingSummaryHash,
      rights: source.rights ?? {},
    },
    sourceFrameCount: normalization.sourceBoundaries.length - 1,
    ...(request.version === 3 ? { joinPlanHash: report.identity?.joinPlanHash } : {}),
  };
  if (
    canonical(expectedIdentity) !== canonical(report.identity) ||
    digest(report.identity) !== report.editHash ||
    report.editHash !== request.review.approvedEditHash ||
    canonical(report.reviewEvidence) !== canonical(request.review)
  )
    throw new Error("Recording source, policy or review identity changed");
  if (canonical(normalization.policy) !== canonical(sourceNormalization))
    throw new Error("Recording normalization policy changed");
  const boundaries = normalization.sourceBoundaries,
    count = boundaries.length - 1;
  for (let i = 0; i < boundaries.length; i++)
    if (
      boundaries[i].sourceFrame !== i ||
      boundaries[i].masterFrame !== Math.round(boundaries[i].sourceSec * 30) ||
      (i === 0 && boundaries[i].sourceSec !== 0) ||
      (i > 0 && boundaries[i].sourceSec <= boundaries[i - 1].sourceSec)
    )
      throw new Error("Recording boundary table is invalid");
  if (
    boundaries[count].sourceSec !== normalization.originalDurationSec ||
    normalization.masterFrameCount !== Math.ceil(normalization.originalDurationSec * 30 - 1e-9) ||
    normalization.masterToDecodedFrame.length !== normalization.masterFrameCount ||
    normalization.outputDurationSec !== normalization.masterFrameCount / 30
  )
    throw new Error("Recording terminal master duration changed");
  let decoded = 0;
  for (let frame = 0; frame < normalization.masterFrameCount; frame++) {
    while (decoded + 1 < count && boundaries[decoded + 1].masterFrame <= frame) decoded++;
    if (normalization.masterToDecodedFrame[frame] !== decoded)
      throw new Error("Recording decoded ownership map changed");
  }
  const unique = new Set(normalization.masterToDecodedFrame).size;
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-8;
  if (
    normalization.droppedDecodedFrames !== count - unique ||
    normalization.repeatedMasterFrames !== normalization.masterFrameCount - unique ||
    !close(
      normalization.authenticContentDurationSec,
      Math.min(normalization.authenticAudioDurationSec, normalization.decodedAudioDurationSec),
    ) ||
    !close(
      normalization.originalAudioVideoEndpointGapSec,
      normalization.originalDurationSec - normalization.decodedAudioDurationSec,
    ) ||
    !close(normalization.masterCeilExtensionSec, normalization.outputDurationSec - normalization.originalDurationSec) ||
    !close(
      normalization.tailAudioAdjustmentSec,
      normalization.outputDurationSec - normalization.decodedAudioDurationSec,
    ) ||
    Math.abs(normalization.originalAudioVideoEndpointGapSec) > 1 / 30 + 1e-6 ||
    Math.abs(normalization.tailAudioAdjustmentSec) > 2 / 30 + 1e-6
  )
    throw new Error("Recording timing provenance changed");
  const maxError = boundaries.reduce(
    (max, boundary) => Math.max(max, Math.abs(boundary.masterFrame / 30 - boundary.sourceSec)),
    0,
  );
  if (
    !close(maxError, normalization.boundaryMaxErrorSec) ||
    Math.abs(normalization.originalDurationSec - normalization.authenticAudioDurationSec) > 1 / 30 + 1e-6
  )
    throw new Error("Recording declared audio duration or boundary precision changed");
  for (const word of request.transcript.words)
    if (
      request.keepSpans.some((keep) => word.startFrame >= keep.startFrame && word.endFrame <= keep.endFrame) &&
      (!boundaries[word.endFrame] ||
        boundaries[word.endFrame].sourceSec >
          normalization.authenticContentDurationSec + normalization.clockToleranceSec + 1e-8)
    )
      throw new Error("Recording retained word exceeds authentic audio content");
  const { registryFile, asset } = registryAssets(project, projectId);
  const original = asset(report.sourceAssetId, request.source.sha256, "video");
  const picture = asset(report.normalizedVideoAssetId, report.normalizedVideoHash, "video");
  const audio = asset(report.audioAssetId, report.audioHash, "audio");
  for (const derivative of [picture, audio])
    if (canonical(derivative.record.provenance.referenceAssetIds) !== canonical([original.record.id]))
      throw new Error("Recording derivative has no immutable original provenance");
  if (
    original.record.provenance.origin !== "manual" ||
    original.record.provenance.tool !== "supplied-recording" ||
    [original, picture, audio].some((asset) => asset.record.provenance.model !== "none")
  )
    throw new Error("Recording source provenance changed");
  if (
    picture.record.provenance.tool !== "ffmpeg-reviewed-recording-normalization" ||
    audio.record.provenance.tool !== "ffmpeg-original-audio-extract"
  )
    throw new Error("Recording derivative provenance tool changed");
  if (
    picture.record.media.frameRate !== "30/1" ||
    audio.record.media.sampleRate !== 48000 ||
    audio.record.media.channels !== 2
  )
    throw new Error("Recording derivative media contract changed");
  for (const derivative of [picture, audio])
    if (Math.abs(derivative.record.media.durationSec! - normalization.outputDurationSec) > 1 / 48000 + 1e-6)
      throw new Error("Recording derivative duration changed");
  if (request.version === 3)
    assertJoinedSpeech(
      report,
      request,
      asset,
      request.keepSpans.reduce(
        (n, k) =>
          n +
          Math.ceil(boundaries[k.endFrame].sourceSec * 30 - 1e-9) -
          Math.floor(boundaries[k.startFrame].sourceSec * 30 + 1e-9),
        0,
      ),
    );
  return { originalFile: original.original, registryFile };
}
