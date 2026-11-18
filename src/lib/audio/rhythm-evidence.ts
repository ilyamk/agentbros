import path from "node:path";
import { fileURLToPath } from "node:url";
import { AssetRegistrySchema, type AssetRecord } from "../../types/assets";
import {
  RhythmEvidenceSchema,
  RhythmEvidencePayloadSchema,
  ReviewedRhythmMarksSchema,
  RhythmMarksSchema,
  RhythmMarksPayloadSchema,
  RhythmRuntimeSchema,
  type RhythmEvidence,
  type RhythmMarks,
} from "../../types/rhythm-evidence";
import { RhythmReadContext, RhythmReadBudget, rhythmDigest } from "./rhythm-files";
import { validateRhythmClock } from "./rhythm-clock";
import { analyzeRhythmPcm } from "./rhythm-kernel";
import { mapReviewedRhythmMarks } from "./rhythm-marks";
import { createRhythmMetadataService, type RhythmMetadataIdentity } from "./rhythm-artifact-metadata";
import { parseTimelineEditDocument } from "../timeline-ir/store";
/** Trusted host installation config only. Neither requests nor evidence may select paths or execute tools. */
export type TrustedRhythmRuntime = {
  artifactMetadata?: RhythmMetadataIdentity;
  ffmpeg: { file: string; version: string };
  ffprobe: { file: string; version: string };
};
const MiB = 1024 * 1024;
const projectFile = (projectId: string, relative: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(projectId)) throw Error("Invalid rhythm project");
  return `public/projects/${projectId}/${relative}`;
};
export function selectedRhythmAsset(registry: unknown, projectId: string, assetId: string): AssetRecord {
  const parsed = AssetRegistrySchema.parse(registry);
  for (const asset of parsed.assets)
    if (!asset.files.original.startsWith(`projects/${projectId}/assets/imported/`))
      throw Error("Rhythm registry original outside project");
  const asset = parsed.assets.find((a) => a.id === assetId);
  if (
    !asset ||
    asset.kind !== "audio" ||
    !/^projects\/[A-Za-z0-9_-]+\/assets\/imported\/[a-f0-9]{64}\.(wav|flac)$/.test(asset.files.original) ||
    !["pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_f64le", "flac"].includes(asset.media.codec)
  )
    throw Error("Rhythm evidence requires registered WAV/FLAC audio");
  return asset;
}
export function rhythmEvidencePayload(value: unknown) {
  const parsed = RhythmEvidenceSchema.parse(value);
  const { sha256, ...payload } = parsed;
  if (rhythmDigest(payload) !== sha256) throw Error("Rhythm evidence payload digest changed");
  return { parsed, payload };
}
export function rhythmArtifactKey(
  evidence: Pick<
    RhythmEvidence,
    "request" | "original" | "selectedAssetDigest" | "parameters" | "runtime" | "implementations" | "clock"
  >,
) {
  return rhythmDigest({
    request: evidence.request,
    original: evidence.original,
    selectedAssetDigest: evidence.selectedAssetDigest,
    parameters: evidence.parameters,
    runtime: evidence.runtime,
    implementations: evidence.implementations,
    clock: evidence.clock,
  });
}
/** Read source implementation bytes only. This does not execute a decoder/tool or authenticate its prior invocation. */
function implementationContext(budget = new RhythmReadBudget()) {
  const context = new RhythmReadContext(fileURLToPath(new URL("../../../", import.meta.url)), budget);
  const pin = (relative: string) => context.read(relative, MiB).pin.sha256;
  const kernel = rhythmDigest([pin("src/lib/audio/rhythm-kernel.ts"), pin("src/lib/audio/rhythm-overrides.ts")]),
    clock = pin("src/lib/audio/rhythm-clock.ts"),
    evidence = rhythmDigest([
      pin("src/lib/audio/rhythm-evidence.ts"),
      pin("src/lib/audio/rhythm-files.ts"),
      pin("src/lib/audio/rhythm-process.ts"),
      pin("src/lib/audio/rhythm-preparation.ts"),
      pin("src/lib/audio/rhythm-publisher.ts"),
      pin("src/lib/audio/rhythm-workspace.ts"),
      pin("src/lib/audio/rhythm-artifact-stage.ts"),
      pin("src/lib/audio/rhythm-artifact-metadata.ts"),
      pin("src/lib/audio/rhythm-artifact-metadata.py"),
      pin("src/lib/audio/rhythm-faults.ts"),
      pin("src/types/rhythm-evidence.ts"),
      pin("src/types/assets.ts"),
    ]),
    mapper = rhythmDigest([
      pin("src/lib/audio/rhythm-clock.ts"),
      pin("src/lib/audio/rhythm-marks.ts"),
      pin("src/lib/timeline-ir/compiler.ts"),
      pin("src/lib/timeline-ir/rational.ts"),
      pin("src/lib/timeline-ir/store.ts"),
      pin("src/types/timeline.ts"),
      pin("src/types/rhythm-evidence.ts"),
    ]);
  return { identity: { kernel, clock, evidence, mapper }, context };
}
export function currentRhythmImplementations(budget = new RhythmReadBudget()) {
  const result = implementationContext(budget);
  result.context.assertUnchanged();
  return result.identity;
}
function trustedRuntime(runtime: TrustedRhythmRuntime, budget: RhythmReadBudget, metadataRequired = false) {
  const contexts: RhythmReadContext[] = [];
  const result = {} as { ffmpeg: { version: string; sha256: string }; ffprobe: { version: string; sha256: string } };
  for (const name of ["ffmpeg", "ffprobe"] as const) {
    const tool = runtime[name];
    if (!tool || !path.isAbsolute(tool.file)) throw Error("Rhythm trusted installed tool unavailable");
    const context = new RhythmReadContext(path.dirname(tool.file), budget);
    const pin = context.read(path.basename(tool.file), 128 * MiB).pin;
    contexts.push(context);
    result[name] = { version: tool.version, sha256: pin.sha256 };
  }
  const metadata = metadataRequired && !runtime.artifactMetadata ? createRhythmMetadataService(budget) : undefined;
  return {
    identity: RhythmRuntimeSchema.parse({
      ...result,
      ...(metadataRequired ? { artifactMetadata: runtime.artifactMetadata ?? metadata!.identity } : {}),
    }),
    contexts,
    metadata,
  };
}
function evidenceWithContext(
  context: RhythmReadContext,
  projectId: string,
  file: string,
  expectedSha: string,
  runtime: TrustedRhythmRuntime,
) {
  if (!/^pipeline\/rhythm\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.evidence\.json$/.test(file))
    throw Error("Rhythm evidence path outside fixed project namespace");
  const raw = context.json(projectFile(projectId, file), 2 * MiB);
  if (raw.pin.sha256 !== expectedSha) throw Error("Rhythm external evidence pin changed");
  const { parsed: evidence } = rhythmEvidencePayload(raw.value);
  if (evidence.request.projectId !== projectId) throw Error("Rhythm evidence project changed");
  const tools = trustedRuntime(runtime, context.budget, Boolean(evidence.runtime.artifactMetadata)),
    implementation = implementationContext(context.budget);
  if (
    rhythmDigest(evidence.runtime) !== rhythmDigest(tools.identity) ||
    rhythmDigest(evidence.implementations) !== rhythmDigest(implementation.identity)
  )
    throw Error("Rhythm trusted runtime/source implementation stale");
  const privateRoot = `.cache/rhythm-evidence/${projectId}/${rhythmArtifactKey(evidence)}/`,
    clockPath = privateRoot + "clock.json",
    pcmPath = privateRoot + "pcm.f32";
  if (evidence.artifacts.clock.path !== clockPath || evidence.artifacts.pcm.path !== pcmPath)
    throw Error("Rhythm private artifact identity changed");
  const clockRaw = context.check(evidence.artifacts.clock, 4 * MiB),
    clock = validateRhythmClock(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clockRaw.bytes)));
  if (rhythmDigest(clock) !== rhythmDigest(evidence.clock)) throw Error("Rhythm decoded clock summary changed");
  if (
    evidence.initialPins.length !== 2 ||
    evidence.initialPins[0].path !== privateRoot + "initial-config.json" ||
    evidence.initialPins[1].path !== privateRoot + "initial-registry.json"
  )
    throw Error("Rhythm initial provenance snapshot paths changed");
  const initialConfig = context.check(evidence.initialPins[0], 8 * MiB);
  const archivedConfig = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(initialConfig.bytes));
  if (!archivedConfig || typeof archivedConfig !== "object" || Array.isArray(archivedConfig))
    throw Error("Rhythm initial config snapshot must be an object");
  const initialRegistry = context.check(evidence.initialPins[1], 4 * MiB),
    archived = selectedRhythmAsset(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(initialRegistry.bytes)),
      projectId,
      evidence.request.assetId,
    );
  if (rhythmDigest(archived) !== evidence.selectedAssetDigest) throw Error("Rhythm archived selected asset changed");
  const current = context.json(projectFile(projectId, "pipeline/asset-registry.json"), 4 * MiB),
    asset = selectedRhythmAsset(current.value, projectId, evidence.request.assetId);
  if (
    rhythmDigest(asset) !== evidence.selectedAssetDigest ||
    asset.hash !== evidence.request.assetSha256 ||
    evidence.original.path !== `public/${asset.files.original}` ||
    evidence.original.sha256 !== asset.hash ||
    evidence.original.bytes !== asset.files.bytes ||
    asset.media.sampleRate !== clock.sampleRate ||
    asset.media.channels !== clock.channels ||
    asset.media.codec !== clock.codec
  )
    throw Error("Rhythm selected original/registry binding changed");
  context.check(evidence.original, 64 * MiB);
  if (Boolean(evidence.artifacts.originalSnapshot) !== Boolean(evidence.artifacts.commit))
    throw Error("Rhythm preparation snapshot/commit pair incomplete");
  if (evidence.artifacts.originalSnapshot && evidence.artifacts.commit) {
    const snapshot = evidence.artifacts.originalSnapshot,
      commit = evidence.artifacts.commit;
    if (
      snapshot.path !== privateRoot + "original." + asset.files.original.split(".").at(-1) ||
      snapshot.sha256 !== evidence.original.sha256 ||
      snapshot.bytes !== evidence.original.bytes ||
      commit.path !== privateRoot + "commit.json"
    )
      throw Error("Rhythm preparation snapshot/commit binding");
    context.check(snapshot, 64 * MiB);
    const receipt = context.json(commit.path, 65536);
    if (
      receipt.pin.sha256 !== commit.sha256 ||
      receipt.pin.bytes !== commit.bytes ||
      rhythmDigest(receipt.value) !==
        rhythmDigest({
          version: 1,
          key: rhythmArtifactKey(evidence),
          originalSha256: snapshot.sha256,
          clockSha256: evidence.artifacts.clock.sha256,
          pcmSha256: evidence.artifacts.pcm.sha256,
        })
    )
      throw Error("Rhythm preparation commit altered");
  }
  const pcm = context.check(evidence.artifacts.pcm, 19200000);
  if (pcm.bytes.length !== clock.analysisSamples * 4) throw Error("Rhythm PCM extent differs from exact clock");
  const reconstructed = analyzeRhythmPcm(pcm.bytes, clock.analysisSamples / 16000, asset.hash),
    onsets = reconstructed.onsetSamples.map((sample, index) => ({ id: `onset-${index}`, sample }));
  if (
    rhythmDigest(RhythmEvidencePayloadSchema.shape.analysis.parse(reconstructed.report)) !==
      rhythmDigest(evidence.analysis) ||
    rhythmDigest(onsets) !== rhythmDigest(evidence.onsets)
  )
    throw Error("Rhythm detector evidence differs from pinned PCM");
  return { evidence, tools, implementation };
}
export function readRhythmEvidence(
  root: string,
  projectId: string,
  file: string,
  expectedSha: string,
  runtime: TrustedRhythmRuntime,
  budget = new RhythmReadBudget(),
) {
  const context = new RhythmReadContext(root, budget),
    result = evidenceWithContext(context, projectId, file, expectedSha, runtime);
  context.assertUnchanged();
  result.implementation.context.assertUnchanged();
  for (const tool of result.tools.contexts) tool.assertUnchanged();
  result.tools.metadata?.assertUnchanged();
  return result.evidence;
}
/** Stage B read-only driver. No writer, CLI registration, media decoder or public executor. */
export function prepareRhythmMarks(
  root: string,
  projectId: string,
  input: unknown,
  runtime: TrustedRhythmRuntime,
  budget = new RhythmReadBudget(),
): RhythmMarks {
  const request = ReviewedRhythmMarksSchema.parse(input);
  if (request.projectId !== projectId) throw Error("Rhythm marks launcher project differs");
  const context = new RhythmReadContext(root, budget);
  const config = context.json(projectFile(projectId, "project.json"), 8 * MiB);
  if (!config.value || typeof config.value !== "object" || Array.isArray(config.value))
    throw Error("Rhythm project config must be an object");
  const automation = context.optional(projectFile(projectId, "pipeline/audio-mix.json"), 4 * MiB);
  if (automation) JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(automation.bytes));
  const journal = context.json(projectFile(projectId, "pipeline/timeline-edit.json"), 8 * MiB),
    doc = parseTimelineEditDocument(journal.value);
  if (doc.revision !== request.expectedRevision || doc.timeline.projectId !== projectId)
    throw Error("Rhythm current timeline revision/project changed");
  const checked = evidenceWithContext(context, projectId, request.evidence.path, request.evidence.sha256, runtime),
    mapped = mapReviewedRhythmMarks(checked.evidence, request, doc.timeline);
  const payload = RhythmMarksPayloadSchema.parse({
    version: 1,
    contract: "mapped-rhythm-marks-v1",
    request,
    requestSha256: rhythmDigest(request),
    evidencePayloadSha256: checked.evidence.sha256,
    reviewSha256: rhythmDigest(request.review),
    currentPins: context.snapshotPins(),
    revision: doc.revision,
    assetSha256: checked.evidence.original.sha256,
    mapperSha256: checked.implementation.identity.mapper,
    ...mapped,
    readonly: true,
    timelineMutation: false,
    reviewRequired: true,
    calibratedBeatTruth: false,
  });
  context.assertUnchanged();
  checked.implementation.context.assertUnchanged();
  for (const tool of checked.tools.contexts) tool.assertUnchanged();
  checked.tools.metadata?.assertUnchanged();
  return RhythmMarksSchema.parse({ ...payload, sha256: rhythmDigest(payload) });
}
export function inspectRhythmMarks(
  root: string,
  projectId: string,
  file: string,
  expectedSha: string,
  runtime: TrustedRhythmRuntime,
) {
  if (!/^pipeline\/rhythm\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.marks\.json$/.test(file))
    throw Error("Rhythm marks path outside fixed namespace");
  const context = new RhythmReadContext(root),
    raw = context.json(projectFile(projectId, file), 2 * MiB);
  if (raw.pin.sha256 !== expectedSha) throw Error("Rhythm external mapped sidecar pin changed");
  const parsed = RhythmMarksSchema.parse(raw.value),
    { sha256, ...payload } = parsed;
  if (rhythmDigest(payload) !== sha256) throw Error("Rhythm mapped sidecar digest changed");
  const current = prepareRhythmMarks(root, projectId, parsed.request, runtime, context.budget);
  if (rhythmDigest(parsed) !== rhythmDigest(current)) throw Error("Rhythm mapped sidecar stale/reconstruction differs");
  context.assertUnchanged();
  return current;
}
