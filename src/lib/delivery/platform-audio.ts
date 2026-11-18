import path from "node:path";
import { type z } from "zod";
import { DeliveryRequestSchema, RenderReceiptSchema, type RenderIdentity } from "../../types/delivery";
import {
  PlatformAudioSelectionSchema,
  PlatformAudioHandoffSchema,
  type PlatformAudioSelection,
} from "../../types/platform-audio";
import { AssetRegistrySchema } from "../../types/assets";
import { type ProjectVideoProps } from "../project-props";
import { compileTimelineIR } from "../timeline-ir/compiler";
import { renderBoundary } from "../timeline-ir/render";
import { parseTimelineEditDocument } from "../timeline-ir/store";
import { readWorkflowEvidence } from "../workflows/local-evidence";
import { assertProjectId } from "../render-plan";
import { deliveryUseContext } from "./use-context";
import {
  planPlatformAudioEligibility,
  platformAudioHash,
  platformAudioRequestHash,
  platformAudioMessage,
  aggregatePlatformAudioResults,
} from "./platform-audio-plan";
import { readPlatformAudioPin } from "./platform-audio-input";
type Request = z.output<typeof DeliveryRequestSchema>;
type Job = { props: ProjectVideoProps; identity: RenderIdentity };
const provenance =
  "Locally checked correspondence; reviews are declarations; external placement, account availability and legal permission remain unverified" as const;
/** Only current consumed inputs; no renderer/media worker/import/publish calls. */
export function capturePlatformAudioSelection(root: string, request: Request, jobs: Job[]) {
  if (!request.platformAudioPlacement) return undefined;
  assertProjectId(request.projectId);
  const project = path.resolve(root, "public/projects", request.projectId),
    identities = jobs.map((job) => job.identity);
  const observations = new Map<
    string,
    { path: string; sha256: string; role: "edit" | "config" | "asset" | "creative" | "caption" | "code" }
  >();
  const remember = (
    file: string,
    sha256: string,
    role: "edit" | "config" | "asset" | "creative" | "caption" | "code",
  ) => {
    const key = path.relative(root, file).split(path.sep).join("/");
    const prior = observations.get(key);
    if (prior && (prior.sha256 !== sha256 || prior.role !== role))
      throw Error("Native evidence changed between consumers");
    observations.set(key, { path: key, sha256, role });
  };
  const journalFile = path.join(project, "pipeline/timeline-edit.json"),
    journal = readWorkflowEvidence(journalFile, project, 8 * 1024 * 1024),
    document = parseTimelineEditDocument(JSON.parse(journal.text));
  remember(journalFile, journal.sha256, "edit");
  const registryFile = path.join(project, "pipeline/asset-registry.json"),
    registryRead = readWorkflowEvidence(registryFile, project, 4 * 1024 * 1024),
    registry = AssetRegistrySchema.parse(JSON.parse(registryRead.text));
  remember(registryFile, registryRead.sha256, "creative");
  const expected = request.formats.flatMap((format) =>
    request.variants.map((variant) => format + ":" + (variant === "clean" ? "off" : "on")),
  );
  if (
    jobs.length !== expected.length ||
    new Set(jobs.map((job) => job.identity.format + ":" + job.identity.captions)).size !== expected.length ||
    jobs.some((job) => !expected.includes(job.identity.format + ":" + job.identity.captions))
  )
    throw Error("Native jobs must cover exact requested outputs");
  if (!jobs.length || document.timeline.projectId !== request.projectId)
    throw Error("Native selection needs current project jobs");
  for (const job of jobs) {
    const compiled = compileTimelineIR(document.timeline);
    if (
      job.props.format !== job.identity.format ||
      (job.props.captionsEnabled === false ? "off" : "on") !== job.identity.captions ||
      renderBoundary(compiled.duration, compiled.timebase, 30) !== job.identity.durationInFrames
    )
      throw Error("Native props/captions/duration do not match render identity");
    if (new Set(job.identity.sources.map((source) => source.path)).size !== job.identity.sources.length)
      throw Error("Native identity source paths ambiguous");
    if (
      platformAudioHash(job.props) !== job.identity.propsHash ||
      platformAudioHash(job.props.timeline) !== platformAudioHash(document.timeline) ||
      job.identity.editRevision !== document.revision ||
      job.identity.sources.filter(
        (source) =>
          source.path === path.relative(root, journalFile).split(path.sep).join("/") &&
          source.sha256 === journal.sha256 &&
          source.role === "edit",
      ).length !== 1
    )
      throw Error("Native selection needs exact consumed journal/props/source identity");
  }
  const reconciled = new Map<string, { source: RenderIdentity["sources"][number]; owners: string[] }>();
  for (const identity of identities)
    for (const source of identity.sources) {
      const owner = identity.format + "/" + identity.captions;
      if (source.path.includes("\\") || source.path.split("/").some((part) => ["", ".", ".."].includes(part)))
        throw Error("Invalid native render source path");
      if (
        !source.path.startsWith("src/") &&
        !source.path.startsWith("public/projects/" + request.projectId + "/") &&
        !source.path.startsWith("public/fonts/") &&
        !source.path.startsWith(".cache/font-contexts/") &&
        !["package.json", "pnpm-lock.yaml", "remotion.config.ts"].includes(source.path)
      )
        throw Error("Unsupported native render source path");
      const prior = reconciled.get(source.path);
      if (prior && (prior.source.sha256 !== source.sha256 || prior.source.role !== source.role))
        throw Error(
          "Native render source pin conflict: " + prior.owners.join(",") + " versus " + owner + " " + source.path,
        );
      if (prior) prior.owners.push(owner);
      else reconciled.set(source.path, { source, owners: [owner] });
    }
  const use = deliveryUseContext(root, request, identities),
    plans = jobs.map((job) =>
      planPlatformAudioEligibility(request, request.platformAudioPlacement, job.props, identities, registry, use),
    ),
    plan = plans[0];
  const aggregate = aggregatePlatformAudioResults(
    plans.map((item, index) => ({
      format: identities[index].format,
      captions: identities[index].captions,
      result: item.result,
    })),
  );
  if (plans.some((item) => item.routingHash !== plan.routingHash))
    throw Error("Native audio routing differs across requested outputs");
  const evidence = [
    ...request.platformAudioPlacement.entries.flatMap((entry) => [
      ...Object.values(entry.evidence),
      entry.selectionReview.evidence,
      entry.marksReview.evidence,
    ]),
    ...request.platformAudioPlacement.sourceReviews.map((review) => review.evidence),
  ];
  let evidenceBytes = 0;
  for (const item of evidence) {
    const file = path.resolve(project, item.file),
      read = readWorkflowEvidence(file, project, 1024 * 1024);
    evidenceBytes += Buffer.byteLength(read.text);
    if (evidenceBytes > 8 * 1024 * 1024 || read.sha256 !== item.sha256)
      throw Error("Native evidence stale or aggregate bound exceeded");
    remember(file, read.sha256, "creative");
  }
  const audible = new Set<string>();
  let mediaBytes = 0;
  for (const routing of plan.routing as { source: string; assetSha256: string }[]) {
    if (audible.has(routing.source)) continue;
    audible.add(routing.source);
    const file = path.resolve(root, "public", routing.source),
      read = readPlatformAudioPin(file, project);
    mediaBytes += read.bytes;
    if (mediaBytes > 1024 * 1024 * 1024 || read.sha256 !== routing.assetSha256)
      throw Error("Native audible original stale or aggregate bound exceeded");
    if (
      identities.some(
        (identity) =>
          identity.sources.filter(
            (source) =>
              source.path === path.relative(root, file).split(path.sep).join("/") &&
              source.sha256 === read.sha256 &&
              source.role === "asset",
          ).length !== 1,
      )
    )
      throw Error("Audible original missing from render source pins");
    remember(file, read.sha256, "asset");
  }
  let totalSourceBytes = 0;
  for (const { source } of reconciled.values()) {
    const file = path.resolve(root, source.path);
    const read = readPlatformAudioPin(file, root);
    totalSourceBytes += read.bytes;
    if (totalSourceBytes > 1024 * 1024 * 1024 || read.sha256 !== source.sha256)
      throw Error("Native render source pin stale or aggregate bound exceeded");
    remember(file, read.sha256, source.role);
  }
  const selection = PlatformAudioSelectionSchema.parse({
    version: 1,
    projectId: request.projectId,
    requestHash: platformAudioRequestHash(request, request.platformAudioPlacement),
    usageContextSha256: use.contextSha256,
    journalRevision: document.revision,
    routingHash: plan.routingHash,
    sources: [...observations.values()].sort((a, b) => a.path.localeCompare(b.path)),
    entries: plan.entries.map((entry) => {
      const identity = identities.find(
        (identity) =>
          identity.format === entry.target.format &&
          identity.captions === (entry.target.variant === "clean" ? "off" : "on"),
      );
      if (!identity) throw Error("Native target identity missing");
      return { ...entry, sourceSnapshotHash: identity.sourceSnapshotHash, propsHash: identity.propsHash };
    }),
  });
  for (const source of selection.sources)
    if (readPlatformAudioPin(path.resolve(root, source.path), root).sha256 !== source.sha256)
      throw Error("Native input changed before return");
  return { selection, result: PlatformAudioHandoffSchema.parse({ ...aggregate, selection }) };
}
export function assertPlatformAudioSelection(
  expected: unknown,
  actual: ReturnType<typeof capturePlatformAudioSelection>,
) {
  if (expected === undefined && actual === undefined) return;
  if (
    !expected ||
    !actual ||
    platformAudioHash(PlatformAudioSelectionSchema.parse(expected)) !== platformAudioHash(actual.selection)
  )
    throw Error("Native selection changed since snapshot");
}
/** Exact current output/renderer receipt; no movie copy/decode or acoustic proof in this SOURCE stage. */
export function bindPlatformAudioMovies(
  root: string,
  request: Request,
  captured: NonNullable<ReturnType<typeof capturePlatformAudioSelection>>,
  outputs: { path: string; sha256: string; identity: RenderIdentity; receipt: unknown }[],
) {
  const plan = request.platformAudioPlacement;
  if (!plan) throw Error("Native placement required");
  const findings = [...captured.result.findings],
    bindings: z.infer<typeof PlatformAudioHandoffSchema>["movieBindings"] = [];
  if (platformAudioRequestHash(request, plan) !== captured.selection.requestHash)
    throw Error("Native request changed before movie binding");
  const project = path.resolve(root, "public/projects", request.projectId),
    moviePins: { file: string; scope: string; sha256: string }[] = [];
  for (const entry of captured.selection.entries) {
    try {
      const matches = outputs.filter(
        (output) =>
          output.identity.format === entry.target.format &&
          output.identity.captions === (entry.target.variant === "clean" ? "off" : "on"),
      );
      if (matches.length !== 1) throw Error("Native movie target ambiguous or missing");
      const output = matches[0];
      if (
        output.identity.projectId !== request.projectId ||
        output.identity.sourceSnapshotHash !== entry.sourceSnapshotHash ||
        output.identity.propsHash !== entry.propsHash
      )
        throw Error("Movie identity differs from prospective native selection");
      const receipt = RenderReceiptSchema.parse(output.receipt);
      const outputFile = path.resolve(root, output.path),
        actual = readPlatformAudioPin(outputFile, path.resolve(root, "out", request.projectId));
      if (
        actual.sha256 !== output.sha256 ||
        receipt.evidence !== "renderer" ||
        receipt.outputSha256 !== actual.sha256 ||
        receipt.propsHash !== output.identity.propsHash ||
        receipt.sourceSnapshotHash !== output.identity.sourceSnapshotHash ||
        receipt.format !== output.identity.format ||
        receipt.captions !== output.identity.captions ||
        platformAudioHash(receipt.sources) !== platformAudioHash(output.identity.sources)
      )
        throw Error("Native movie needs exact current renderer/source binding");
      const review = plan.outputReviews.find((review) => review.entryId === entry.id);
      if (
        !review ||
        review.outputSha256 !== actual.sha256 ||
        review.sourceSnapshotHash !== receipt.sourceSnapshotHash ||
        review.propsHash !== receipt.propsHash ||
        review.selectionHash !== entry.selectionHash
      )
        throw Error("Current native movie listening declaration required");
      const evidence = readWorkflowEvidence(path.resolve(project, review.evidence.file), project, 1024 * 1024);
      if (evidence.sha256 !== review.evidence.sha256) throw Error("Native output review evidence changed");
      moviePins.push(
        { file: outputFile, scope: path.resolve(root, "out", request.projectId), sha256: actual.sha256 },
        { file: path.resolve(project, review.evidence.file), scope: project, sha256: evidence.sha256 },
      );
      bindings.push({
        entryId: entry.id,
        outputSha256: actual.sha256,
        sourceSnapshotHash: receipt.sourceSnapshotHash,
        propsHash: receipt.propsHash,
        selectionHash: entry.selectionHash,
        reviewSha256: platformAudioHash(review),
      });
    } catch (error) {
      if (findings.length < 128)
        findings.push({
          code: "NATIVE_MOVIE_BINDING_INVALID",
          message: platformAudioMessage(error),
          entryId: entry.id,
        });
    }
  }
  for (const source of captured.selection.sources)
    if (readPlatformAudioPin(path.resolve(root, source.path), root).sha256 !== source.sha256)
      throw Error("Native input changed during movie binding");
  for (const pin of moviePins)
    if (readPlatformAudioPin(pin.file, pin.scope).sha256 !== pin.sha256)
      throw Error("Native movie/review evidence changed before return");
  return PlatformAudioHandoffSchema.parse({
    version: 1,
    status: "pending-manual",
    localStatus:
      captured.result.localStatus === "blocked" || findings.length
        ? "blocked"
        : bindings.length === captured.selection.entries.length
          ? "eligible-awaiting-delivery-gates"
          : "eligible-awaiting-movie",
    selection: captured.selection,
    findings,
    movieBindings: bindings,
    provenance,
  });
}
