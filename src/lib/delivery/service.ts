import { assertImportedLocalAssets } from "../apple/provenance";
import { assertImportedVorkAssets } from "../vork/provenance";
import { assertNoDraftLocalAssets } from "../apple/tasks";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import {
  DeliveryRequestSchema,
  DeliverySnapshotSchema,
  DeliveryManifestSchema,
  RenderReceiptSchema,
  type DeliveryRequest,
  type DeliverySnapshot,
} from "../../types/delivery";
import { reviewQaEvidence } from "./evidence";
import { deliveryUseContext, type DeliveryUseContext } from "./use-context";
import {
  captureSubtitleSelection,
  assertSubtitleSelection,
  publishSubtitleFiles,
  verifyPublishedSubtitleFiles,
} from "./subtitle-tracks";
import { captureRenderIdentity } from "./identity";
import { capturePlatformAudioSelection, assertPlatformAudioSelection, bindPlatformAudioMovies } from "./platform-audio";
import {
  deliveryStateForPlatformAudio,
  platformAudioMessage,
  finalizePlatformAudioEligibility,
} from "./platform-audio-plan";
import { PlatformAudioHandoffSchema } from "../../types/platform-audio";
import { generationInputHash } from "../jobs/runner";
import { immutableWrite, digest } from "../jobs/model-artifacts";
import { hashFile } from "../assets/registry";
import { assertPathWithin } from "../cli";
import { inspectEditorialProject } from "../editorial/qa";
import { mediaProbe, analyzeAudio } from "../audio/analysis";
import { FORMAT_CONFIGS } from "../../types/video";
import { replicaPublicationBlock } from "./replica-rights";
import {
  bespokeOutput,
  bespokeRequestProblems,
  captureBespokeIdentity,
  isBespokeDelivery,
  bespokeLocalAssets,
} from "./bespoke";
import { CliErrorObject } from "../cli";
import { reviewGates, reviewRights, reviewClaims, reviewBespokeClaims, type Finding } from "./reviews";
import { OperationStore } from "../jobs/store";
import { planProjectRender } from "../render-plan";
import { ProjectVideoSchema, type ProjectVideoProps } from "../project-props";
import { captionCues, subtitleText } from "../captions/delivery";
import { adaptLegacyProject } from "../timeline-ir/legacy";
import { fraction } from "../timeline-ir/rational";
const stable = (value: unknown) => generationInputHash(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
/** Match the existing renderer identity JSON boundary without coercing unsupported values. */
export function serializedNativeProps(props: ProjectVideoProps): ProjectVideoProps {
  const active = new Set<object>();
  const visit = (value: unknown, parts: string[]): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw Error("Nonfinite native render props");
      return;
    }
    if (typeof value !== "object" || active.has(value)) throw Error("Invalid native render props");
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw Error("Invalid native render props prototype");
    if (Object.getOwnPropertySymbols(value).length) throw Error("Invalid native render props symbols");
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw Error("Invalid native render props array prototype");
      if (
        Object.keys(descriptors).some(
          (key) => key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length),
        )
      )
        throw Error("Invalid native render props array property");
      for (let i = 0; i < value.length; i++) {
        const item = descriptors[String(i)];
        if (!item || !("value" in item)) throw Error("Invalid native render props array");
        visit(item.value, [...parts, String(i)]);
      }
    } else
      for (const [key, item] of Object.entries(descriptors)) {
        if (!("value" in item)) throw Error("Invalid native render props accessor");
        if (item.value === undefined) {
          const field =
            parts.length === 0 ? ProjectVideoSchema.shape[key as keyof typeof ProjectVideoSchema.shape] : undefined;
          if (
            field?.isOptional() ||
            (parts.length === 2 && parts[0] === "timelineAssets" && ["durationSec", "hasAudio"].includes(key))
          )
            continue;
          throw Error("Unexpected undefined native render props");
        }
        visit(item.value, [...parts, key]);
      }
    active.delete(value);
  };
  visit(props, []);
  return JSON.parse(JSON.stringify(props)) as ProjectVideoProps;
}
function nativeRenderJobs(
  root: string,
  request: z.output<typeof DeliveryRequestSchema>,
  identities: z.infer<typeof DeliverySnapshotSchema>["identities"],
) {
  return identities.map((identity) => ({
    identity,
    props: serializedNativeProps(
      planProjectRender(request.projectId, identity.format, root, {
        timeline: request.timeline,
        audioMaster: request.audioMaster,
        captions: identity.captions,
      }).jobs[0]!.props,
    ),
  }));
}
/** A bespoke film's request problems, as one refusal. */
function refuseBespoke(root: string, request: z.output<typeof DeliveryRequestSchema>) {
  const problems = bespokeRequestProblems(root, request);
  if (problems.length)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `${request.projectId} is a bespoke film (film chain, film:render): ${problems.join("; ")}. See docs/delivery.md, "Bespoke films".`,
    });
}
export function captureDeliverySnapshot(input: DeliveryRequest, options: { rootDir?: string } = {}) {
  const request = DeliveryRequestSchema.parse(input),
    root = path.resolve(options.rootDir ?? process.cwd());
  const bespoke = isBespokeDelivery(root, request.projectId);
  if (bespoke) refuseBespoke(root, request);
  const identities = bespoke
    ? [
        captureBespokeIdentity(request.projectId, request.formats[0]!, {
          rootDir: root,
          audioMaster: request.audioMaster,
        }),
      ]
    : request.formats.flatMap((format) =>
        request.variants.map((variant) =>
          captureRenderIdentity(request.projectId, format, {
            rootDir: root,
            timeline: request.timeline,
            audioMaster: request.audioMaster,
            fontContext: request.fontContext,
            captions: variant === "clean" ? "off" : "on",
          }),
        ),
      );
  const subtitlePlan = captureSubtitleSelection(root, request, identities);
  const nativePlan = request.platformAudioPlacement
    ? capturePlatformAudioSelection(root, request, nativeRenderJobs(root, request, identities))
    : undefined;
  const basis = {
    version: 1,
    projectId: request.projectId,
    identities,
    ...(subtitlePlan ? { subtitleSelection: subtitlePlan.selection } : {}),
    ...(nativePlan ? { platformAudioSelection: nativePlan.selection } : {}),
  };
  const id = stable(basis);
  const file = path.join(root, "public/projects", request.projectId, "pipeline/delivery/snapshots", `${id}.json`);
  assertPathWithin(path.join(root, "public/projects", request.projectId), file);
  const snapshot = existsSync(file)
    ? DeliverySnapshotSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    : DeliverySnapshotSchema.parse({
        version: 1,
        projectId: request.projectId,
        id,
        createdAt: new Date().toISOString(),
        identities,
        ...(subtitlePlan ? { subtitleSelection: subtitlePlan.selection } : {}),
        ...(nativePlan ? { platformAudioSelection: nativePlan.selection } : {}),
      });
  if (
    snapshot.id !== id ||
    stable({
      version: 1,
      projectId: request.projectId,
      identities: snapshot.identities,
      ...(snapshot.subtitleSelection ? { subtitleSelection: snapshot.subtitleSelection } : {}),
      ...(snapshot.platformAudioSelection ? { platformAudioSelection: snapshot.platformAudioSelection } : {}),
    }) !== id
  )
    throw new Error("Delivery snapshot checksum conflict");
  immutableWrite(file, JSON.stringify(snapshot, null, 2));
  return { snapshot, file };
}
function legacySubtitles(root: string, projectId: string) {
  const project = path.join(root, "public/projects", projectId),
    raw = JSON.parse(readFileSync(path.join(project, "project.json"), "utf8")) as Record<string, unknown>;
  const ir = adaptLegacyProject(raw, projectId);
  for (const track of ir.tracks.filter(
    (t) =>
      t.kind ===
      (ir.tracks.some((track) => track.kind === "voiceover" && track.clips.length) ? "voiceover" : "presenter"),
  ))
    for (const clip of track.clips) {
      const edited = path.join(project, "voiceover", `${clip.id}.words.edited.json`),
        original = path.join(project, "voiceover", `${clip.id}.words.json`);
      const file = existsSync(edited) ? edited : original;
      assertPathWithin(project, file);
      if (!existsSync(file)) throw new Error(`Subtitle alignment missing for ${clip.id}`);
      const aligned = JSON.parse(readFileSync(file, "utf8")) as {
        words?: { text: string; start: number; end: number }[];
      };
      // Alignment files are scene-local seconds even for continuous presenter source.
      const sourceStart = clip.source.start.num / clip.source.start.den;
      clip.captions = (aligned.words ?? []).map((word, index) => ({
        id: `${clip.id}:${index}`,
        text: word.text,
        start: fraction(Math.round((sourceStart + word.start * 30) * 1000000), 1000000),
        end: fraction(Math.round((sourceStart + word.end * 30) * 1000000), 1000000),
      }));
    }
  return ir;
}
/** Trusted native recovery prerequisite: observe exact existing cache before any media QA. */
export function assertReadonlyNativeFontIdentities(
  root: string,
  input: DeliveryRequest,
  snapshotInput: DeliverySnapshot,
) {
  const request = DeliveryRequestSchema.parse(input),
    snapshot = DeliverySnapshotSchema.parse(snapshotInput);
  if (!request.platformAudioPlacement) throw Error("Read-only font identity mode is restricted to native recovery");
  if (!request.fontContext) return;
  const expected = request.formats.flatMap((format) =>
    request.variants.map((variant) => `${format}:${variant === "clean" ? "off" : "on"}`),
  );
  if (
    snapshot.projectId !== request.projectId ||
    snapshot.identities.length !== expected.length ||
    new Set(snapshot.identities.map((i) => `${i.format}:${i.captions}`)).size !== expected.length ||
    snapshot.identities.some((i) => !expected.includes(`${i.format}:${i.captions}`))
  )
    throw Error("Readonly font recovery output identity mismatch");
  for (const identity of snapshot.identities) {
    const current = captureRenderIdentity(request.projectId, identity.format, {
      rootDir: root,
      timeline: request.timeline,
      audioMaster: request.audioMaster,
      fontContext: request.fontContext,
      captions: identity.captions,
      fontContextMode: "existing",
    });
    if (current.sourceSnapshotHash !== identity.sourceSnapshotHash || current.propsHash !== identity.propsHash)
      throw Error("Readonly font recovery source changed since captured snapshot");
  }
}
/** Normal checks persist QA findings; trusted native recovery is read-only. Production gates remain unchanged. */
export function checkDelivery(
  input: DeliveryRequest,
  snapshotInput: unknown,
  options: { rootDir?: string; persistReport?: false } = {},
) {
  const request = DeliveryRequestSchema.parse(input),
    snapshot = DeliverySnapshotSchema.parse(snapshotInput),
    root = path.resolve(options.rootDir ?? process.cwd()),
    project = path.join(root, "public/projects", request.projectId);
  assertPathWithin(path.join(root, "public/projects"), project);
  if (options.persistReport === false && !request.platformAudioPlacement)
    throw Error("Read-only report mode is restricted to native recovery");
  if (options.persistReport === false) assertReadonlyNativeFontIdentities(root, request, snapshot);
  const findings: Finding[] = [],
    outputs: z.infer<typeof DeliveryManifestSchema>["outputs"] = [];
  const error = (code: string, message: string, file?: string) =>
    findings.push({ code, severity: "error", message, ...(file ? { path: file } : {}) });
  // A film-chain project has no project.json: its identity, output and approvals follow the bespoke route.
  const bespoke = isBespokeDelivery(root, request.projectId);
  const consumed = bespoke
    ? bespokeLocalAssets(root, request.projectId)
    : snapshot.identities.flatMap((i) =>
        i.sources.filter((source) => source.role === "asset").map((source) => path.resolve(root, source.path)),
      );
  try {
    assertImportedLocalAssets(consumed, path.join(project, "pipeline/asset-registry.json"), root);
    assertImportedVorkAssets(consumed, path.join(project, "pipeline/asset-registry.json"), root);
  } catch (problem) {
    error("LOCAL_IMPORTED_DRAFT", String(problem));
  }
  try {
    assertNoDraftLocalAssets(consumed);
  } catch (problem) {
    error("LOCAL_DRAFT_ASSET", String(problem));
  }
  if (bespoke)
    for (const problem of bespokeRequestProblems(root, request))
      error("BESPOKE_REQUEST_INVALID", `Bespoke film: ${problem}`);
  if (
    snapshot.projectId !== request.projectId ||
    snapshot.id !==
      stable({
        version: 1,
        projectId: snapshot.projectId,
        identities: snapshot.identities,
        ...(snapshot.subtitleSelection ? { subtitleSelection: snapshot.subtitleSelection } : {}),
        ...(snapshot.platformAudioSelection ? { platformAudioSelection: snapshot.platformAudioSelection } : {}),
      })
  )
    error("SNAPSHOT_INVALID", "Source snapshot belongs to another project or changed");
  const expected = request.formats.flatMap((format) =>
    request.variants.map((variant) => `${format}:${variant === "clean" ? "off" : "on"}`),
  );
  if (
    snapshot.identities.length !== expected.length ||
    new Set(snapshot.identities.map((i) => `${i.format}:${i.captions}`)).size !== expected.length ||
    snapshot.identities.some((i) => !expected.includes(`${i.format}:${i.captions}`))
  )
    error(
      "DELIVERY_OUTPUT_CONTRACT",
      "Snapshot must contain exactly each requested format and clean/captioned variant",
    );
  let subtitlePlan: ReturnType<typeof captureSubtitleSelection>;
  try {
    subtitlePlan = captureSubtitleSelection(root, request, snapshot.identities);
    assertSubtitleSelection(snapshot.subtitleSelection, subtitlePlan);
  } catch (problem) {
    error("SUBTITLE_SELECTION_INVALID", String(problem));
  }
  let nativePlan: ReturnType<typeof capturePlatformAudioSelection>;
  let nativeHandoff: z.infer<typeof PlatformAudioHandoffSchema> | undefined;
  const nativeMovies: Parameters<typeof bindPlatformAudioMovies>[3] = [];
  if (request.platformAudioPlacement) {
    try {
      nativePlan = capturePlatformAudioSelection(root, request, nativeRenderJobs(root, request, snapshot.identities));
      assertPlatformAudioSelection(snapshot.platformAudioSelection, nativePlan);
      nativeHandoff = nativePlan?.result;
      for (const finding of nativeHandoff?.findings ?? []) error(finding.code, finding.message);
    } catch (problem) {
      error("NATIVE_SELECTION_INVALID", String(problem));
      nativeHandoff = PlatformAudioHandoffSchema.parse({
        version: 1,
        status: "pending-manual",
        localStatus: "blocked",
        findings: [{ code: "NATIVE_SELECTION_INVALID", message: platformAudioMessage(problem) }],
        movieBindings: [],
        provenance:
          "Locally checked correspondence; reviews are declarations; external placement, account availability and legal permission remain unverified",
      });
    }
  } else if (snapshot.platformAudioSelection)
    error("NATIVE_SELECTION_INVALID", "Native selection cannot be removed from a captured snapshot");
  const qaEvidence: Record<string, unknown>[] = [];
  let resourceUse: DeliveryUseContext | undefined;
  let costs: Record<string, unknown> | null = null,
    rights: Record<string, unknown>[] = [];
  try {
    reviewGates(root, request, snapshot, findings, { bespoke });
  } catch (problem) {
    error("CREATIVE_APPROVAL_INVALID", String(problem));
  }
  try {
    if (bespoke) reviewBespokeClaims(request, snapshot, findings);
    else reviewClaims(root, request, snapshot, findings);
  } catch (problem) {
    error("CLAIMS_REVIEW_INVALID", String(problem));
  }
  try {
    resourceUse = deliveryUseContext(root, request, snapshot.identities);
    rights = reviewRights(root, request, snapshot.identities, findings, resourceUse.contextSha256);
  } catch (problem) {
    error("RIGHTS_RECORD_INVALID", String(problem));
  }
  const studyOnly = replicaPublicationBlock(project);
  if (studyOnly) error("REPLICA_STUDY_ONLY", studyOnly);
  try {
    const store = new OperationStore(request.projectId, { directory: path.join(project, "pipeline") });
    assertPathWithin(project, store.file);
    if (existsSync(store.file)) {
      costs = store.summary();
      if (costs.overBudget)
        error("BUDGET_EXCEEDED", "Settled actuals plus retained commitments exceed the project cap");
      for (const job of Object.values(store.snapshot().jobs)) {
        if (job.state !== "published" && !(job.state === "cancelled" && job.release))
          error("GENERATION_UNRESOLVED", `${job.operationId} is ${job.state}; resolve provider/billing before release`);
        if (job.state === "published" && job.paidAttempts > 0 && !job.receipt)
          findings.push({
            code: "BILLING_UNRECONCILED",
            severity: "warning",
            message: `${job.operationId}: actual invoice missing; reservation remains ${job.reservedMicros / 1e6} USD. This is not zero/free billing`,
          });
      }
    }
  } catch (problem) {
    error("BUDGET_STATE_INVALID", String(problem));
  }
  for (const identity of snapshot.identities) {
    const variant = identity.captions === "off" ? "clean" : "captioned";
    const output = bespoke
      ? bespokeOutput(root, request.projectId)
      : path.join(root, "out", request.projectId, `${identity.format}${variant === "clean" ? "-clean" : ""}.mp4`);
    try {
      const current = bespoke
        ? captureBespokeIdentity(request.projectId, identity.format, {
            rootDir: root,
            audioMaster: request.audioMaster,
          })
        : captureRenderIdentity(request.projectId, identity.format, {
            rootDir: root,
            timeline: request.timeline,
            audioMaster: request.audioMaster,
            fontContext: request.fontContext,
            captions: identity.captions,
            ...(options.persistReport === false ? { fontContextMode: "existing" as const } : {}),
          });
      if (current.sourceSnapshotHash !== identity.sourceSnapshotHash || current.propsHash !== identity.propsHash)
        error(
          "SOURCE_CHANGED",
          "Project/story/edit/caption alignment/media/code changed since render snapshot",
          output,
        );
      assertPathWithin(path.join(root, "out", request.projectId), output);
      if (!existsSync(output)) {
        error(
          "RENDER_MISSING",
          bespoke
            ? `Missing the film: render it with film:render --project ${request.projectId}, which writes ${path.relative(root, output)} and its receipt`
            : `Missing required ${identity.format}/${variant}`,
          output,
        );
        continue;
      }
      const outputSha256 = hashFile(output),
        receiptFile = `${output}.receipt.json`;
      let receipt = request.renderBindings.find(
        (r) => r.outputSha256 === outputSha256 && r.format === identity.format && r.captions === identity.captions,
      );
      if (existsSync(receiptFile)) {
        assertPathWithin(path.join(root, "out", request.projectId), receiptFile);
        receipt = RenderReceiptSchema.parse(JSON.parse(readFileSync(receiptFile, "utf8")));
      }
      if (
        !receipt ||
        receipt.sourceSnapshotHash !== identity.sourceSnapshotHash ||
        receipt.propsHash !== identity.propsHash ||
        receipt.outputSha256 !== outputSha256 ||
        receipt.format !== identity.format ||
        receipt.captions !== identity.captions ||
        stable({ sources: receipt.sources }) !== stable({ sources: identity.sources })
      )
        error(
          "RENDER_BINDING_MISSING",
          "Output needs a matching renderer receipt or explicit current-hash human render-binding evidence",
          output,
        );
      else if (receipt.partial)
        error(
          "PARTIAL_RENDER",
          `Output is an excerpt (frames ${receipt.partial.startFrame}-${receipt.partial.endFrame} of ${receipt.partial.totalFrames}), never a final deliverable`,
          output,
        );
      else if (receipt.evidence === "human-declared")
        findings.push({
          code: "HUMAN_DECLARED_RENDER_BINDING",
          severity: "warning",
          message: "Output-to-source binding is supplied reviewer evidence, not an independently observed render",
          path: output,
        });
      if (request.platformAudioPlacement)
        nativeMovies.push({ path: path.relative(root, output), sha256: outputSha256, identity, receipt });
      if (bespoke)
        qaEvidence.push(
          ...reviewQaEvidence(root, request.projectId, identity, outputSha256, identity.propsHash, findings),
        );
      else {
        const currentProps = planProjectRender(request.projectId, identity.format, root, {
          timeline: request.timeline,
          audioMaster: request.audioMaster,
          captions: identity.captions,
        }).jobs[0]!.props;
        qaEvidence.push(
          ...reviewQaEvidence(
            root,
            request.projectId,
            identity,
            outputSha256,
            createHash("sha256").update(JSON.stringify(currentProps)).digest("hex"),
            findings,
          ),
        );
        const editorial = inspectEditorialProject(request.projectId, {
          rootDir: root,
          format: identity.format,
          editedTimeline: request.timeline,
        });
        findings.push(...editorial.findings);
      }
      const probe = mediaProbe(output),
        video = probe.streams.find((stream) => stream.codec_type === "video"),
        format = FORMAT_CONFIGS[identity.format];
      const [num, den] = String(video?.avg_frame_rate ?? "0/1")
          .split("/")
          .map(Number),
        fps = num! / den!;
      if (!video || video.width !== format.width || video.height !== format.height)
        error("RESOLUTION_MISMATCH", `Expected ${format.width}x${format.height}`, output);
      if (!Number.isFinite(fps) || Math.abs(fps - 30) > 1e-6)
        error("FPS_MISMATCH", "Delivery requires actual 30fps", output);
      const duration = Number(probe.format.duration);
      if (!Number.isFinite(duration) || Math.abs(duration - identity.durationInFrames / 30) > 1 / 30 + 0.02)
        error("RENDER_DURATION_MISMATCH", "Output does not match exact compiled story duration", output);
      const decode = spawnSync(
        "ffmpeg",
        ["-v", "error", "-xerror", "-i", output, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"],
        { encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
      );
      if (decode.status !== 0 || decode.error)
        error("OUTPUT_DECODE_FAILED", "Full encoded video/audio decode failed", output);
      const audio = analyzeAudio(output);
      if (request.loudness.audioRequired && (!audio.present || audio.integratedLufs === null))
        error("RENDER_AUDIO_MISSING", "Required measured sound is absent/silent", output);
      if (
        audio.integratedLufs !== null &&
        Math.abs(audio.integratedLufs - request.loudness.targetLufs) > request.loudness.toleranceLu
      )
        error(
          "LOUDNESS_OUTSIDE_TARGET",
          `Measured ${audio.integratedLufs} LUFS vs requested ${request.loudness.targetLufs} ±${request.loudness.toleranceLu}`,
          output,
        );
      if (audio.truePeakDb !== null && audio.truePeakDb > request.loudness.maxTruePeakDb)
        error(
          "TRUE_PEAK_OVERLOAD",
          `Measured ${audio.truePeakDb} dBTP exceeds ${request.loudness.maxTruePeakDb}`,
          output,
        );
      outputs.push({
        path: path.relative(root, output),
        sha256: outputSha256,
        format: identity.format,
        variant,
        sourceSnapshotHash: identity.sourceSnapshotHash,
        propsHash: identity.propsHash,
        durationSec: Number.isFinite(duration) ? duration : 0,
        fps: Number.isFinite(fps) ? fps : 0,
        width: video?.width ?? 0,
        height: video?.height ?? 0,
        integratedLufs: audio.integratedLufs,
        truePeakDb: audio.truePeakDb,
      });
    } catch (problem) {
      error("OUTPUT_CHECK_FAILED", problem instanceof Error ? problem.message : String(problem), output);
    }
  }
  const visual = request.visualReview;
  if (
    !visual ||
    visual.sourceSnapshotHash !== snapshot.id ||
    !outputs.length ||
    outputs.some((output) => !visual.outputHashes.includes(output.sha256))
  )
    error(
      "VISUAL_REVIEW_REQUIRED",
      "Current format/captioned/clean outputs need named visual/semantic review evidence bound to this snapshot and every output hash",
    );
  let subtitleFiles: {
    name: string;
    content: string;
    output?: NonNullable<typeof subtitlePlan>["selection"]["outputs"][number];
  }[] = subtitlePlan?.files ?? [];
  if (request.subtitles.length && !bespoke)
    try {
      const job = planProjectRender(request.projectId, request.formats[0], root, {
        timeline: request.timeline,
        audioMaster: request.audioMaster,
      }).jobs[0]!;
      const cues = captionCues(job.props.timeline ?? legacySubtitles(root, request.projectId));
      if (!cues.length) throw new Error("Requested subtitles have no aligned words");
      subtitleFiles = request.subtitles.map((format) => ({
        name: `captions.${format}`,
        content: subtitleText(cues, format),
      }));
    } catch (problem) {
      error("SUBTITLE_EXPORT_FAILED", String(problem));
    }
  // Detect mutations during probe/review itself, not only before checks.
  for (const identity of snapshot.identities)
    for (const source of identity.sources)
      try {
        const file = path.join(root, source.path);
        assertPathWithin(root, file);
        if (hashFile(file) !== source.sha256) error("SOURCE_CHANGED_DURING_QA", `Source changed: ${source.path}`);
      } catch (problem) {
        error("SOURCE_CHANGED_DURING_QA", String(problem));
      }
  try {
    if (
      resourceUse &&
      deliveryUseContext(root, request, snapshot.identities).contextSha256 !== resourceUse.contextSha256
    )
      error("RIGHTS_USE_CHANGED", "Declared workflow use changed during delivery QA");
  } catch (problem) {
    error("RIGHTS_USE_CHANGED", String(problem));
  }
  try {
    assertSubtitleSelection(snapshot.subtitleSelection, captureSubtitleSelection(root, request, snapshot.identities));
  } catch (problem) {
    error("SUBTITLE_SELECTION_CHANGED", String(problem));
  }
  if (nativePlan) {
    try {
      const current = capturePlatformAudioSelection(
        root,
        request,
        nativeRenderJobs(root, request, snapshot.identities),
      );
      assertPlatformAudioSelection(nativePlan.selection, current);
      nativeHandoff = bindPlatformAudioMovies(root, request, nativePlan, nativeMovies);
      for (const finding of nativeHandoff.findings) error(finding.code, finding.message);
    } catch (problem) {
      error("NATIVE_BINDING_INVALID", String(problem));
      nativeHandoff = {
        ...nativePlan.result,
        localStatus: "blocked",
        findings: [
          ...nativePlan.result.findings.slice(0, 127),
          { code: "NATIVE_BINDING_INVALID", message: platformAudioMessage(problem) },
        ],
      };
    }
  }
  if (request.platformAudioPlacement)
    findings.push({
      code: "NATIVE_PLATFORM_PLACEMENT_PENDING",
      severity: "warning",
      message:
        "Native audio placement, account access and legal availability remain pending manual; no production release is published",
    });
  const blocked = findings.some((item) => item.severity === "error");
  if (nativeHandoff) nativeHandoff = finalizePlatformAudioEligibility(nativeHandoff, blocked);
  const manifest = DeliveryManifestSchema.parse({
    version: 1,
    projectId: request.projectId,
    snapshotId: snapshot.id,
    createdAt: new Date().toISOString(),
    state: deliveryStateForPlatformAudio(request, blocked),
    request,
    sourceIdentities: snapshot.identities,
    findings,
    outputs,
    ...(subtitlePlan ? { subtitleOutputs: subtitlePlan.selection.outputs } : {}),
    ...(nativeHandoff ? { platformAudioPlacement: nativeHandoff } : {}),
    rights,
    costs,
    reviewEvidence: {
      qaEvidence,
      ...(subtitlePlan
        ? {
            subtitleSelection: subtitlePlan.selection,
            subtitleProvenance:
              "Supplied track/language declarations; translation, alignment accuracy and human acceptance are not inferred",
          }
        : {}),
      resourceUse: resourceUse ?? { requestedUsage: request.usage, status: "invalid-unverified" },
      provenance: "Supplied human approvals/reviews are declarations; media/budget/hashes are locally measured",
      ...(request.manualApproval ? { manual: request.manualApproval } : {}),
      ...(request.visualReview ? { visual: request.visualReview } : {}),
      ...(request.claimsReview ? { claims: request.claimsReview } : {}),
    },
    apiCalls: 0,
  });
  const report = path.join(project, "pipeline/delivery/reports", `${snapshot.id}-${randomUUID()}.json`);
  assertPathWithin(project, report);
  if (options.persistReport !== false) immutableWrite(report, JSON.stringify(manifest, null, 2));
  const resultFiles = options.persistReport === false ? [] : [report];
  try {
    if (manifest.state === "production-ready") {
      const releaseId = digest(JSON.stringify(manifest)),
        directory = path.join(root, "out", request.projectId, "releases", releaseId);
      assertPathWithin(path.join(root, "out", request.projectId), directory);
      for (const output of outputs) {
        const source = path.join(root, output.path);
        if (hashFile(source) !== output.sha256) throw new Error("Output changed during release copy");
        const target = path.join(directory, `${output.format}-${output.variant}.mp4`);
        immutableWrite(target, readFileSync(source));
        if (hashFile(target) !== output.sha256) throw new Error("Release output checksum mismatch");
        resultFiles.push(target);
      }
      resultFiles.push(...publishSubtitleFiles(directory, subtitleFiles));
      const credits = path.join(directory, "credits.md");
      immutableWrite(
        credits,
        [
          "# Credits",
          "",
          ...rights.map((record) => String(record.attribution ?? "")).filter(Boolean),
          "",
          "Rights evidence is documented in release.json; supplied human reviews are declared evidence.",
        ].join("\n"),
      );
      resultFiles.push(credits);
      const release = path.join(directory, "release.json");
      const releaseContent = JSON.stringify(manifest, null, 2);
      const sums = path.join(directory, "checksums.json");
      immutableWrite(
        sums,
        JSON.stringify(
          resultFiles
            .filter((file) => file.startsWith(directory))
            .map((file) => ({ file: path.basename(file), sha256: hashFile(file) }))
            .concat([{ file: "release.json", sha256: digest(releaseContent) }]),
          null,
          2,
        ),
      );
      resultFiles.push(sums);
      // Commit marker is last: partial packets never contain a production-ready release manifest.
      assertSubtitleSelection(snapshot.subtitleSelection, captureSubtitleSelection(root, request, snapshot.identities));
      verifyPublishedSubtitleFiles(directory, subtitleFiles);
      immutableWrite(release, releaseContent);
      resultFiles.push(release);
    }
  } catch (problem) {
    manifest.findings.push({
      code: "PACKAGE_PUBLICATION_FAILED",
      severity: "error",
      message: problem instanceof Error ? problem.message : String(problem),
    });
    manifest.state = "blocked";
    const failureReport = path.join(project, "pipeline/delivery/reports", `${snapshot.id}-${randomUUID()}.json`);
    assertPathWithin(project, failureReport);
    if (options.persistReport !== false) immutableWrite(failureReport, JSON.stringify(manifest, null, 2));
    return {
      ok: false,
      productionReady: false,
      outputs: [failureReport],
      report: failureReport,
      manifest,
      blockers: manifest.findings.filter((item) => item.severity === "error"),
    };
  }
  return {
    ok: !blocked || request.mode === "draft",
    productionReady: manifest.state === "production-ready",
    outputs: resultFiles,
    report,
    manifest,
    blockers: findings.filter((item) => item.severity === "error"),
  };
}
