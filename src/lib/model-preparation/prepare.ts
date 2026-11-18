import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, openSync, closeSync } from "node:fs";
import { CliErrorObject, ensureFfmpeg, ensureFfprobe } from "../cli";
import { hashFile, importAsset, readAssetRegistry } from "../assets/registry";
import { inspectAsset } from "../assets/inspect";
import { resolveImportedReferences } from "../assets/provider-references";
import { getEntityVersion, resolveEntityReferences } from "../entities/service";
import { buildFalOperation } from "../providers/fal-operations";
import { generationInputHash } from "../jobs/runner";
import { immutableWrite } from "../jobs/model-artifacts";
import { probeVideo } from "../vision/media";
import { verifyReviewClock } from "../vision/review-pack";
import { readRemoteMedia } from "../assets/remote-media";
import {
  ModelPreparationReceiptSchema,
  ModelPreparationSpecSchema,
  type ModelPreparationSpec,
} from "../../types/model-preparation";
import { genjutsuEndpoint } from "./profiles";
import { compilePack, packSpecFromPreparation, type MediaFacts } from "../references/compile";
import { profileForEndpoint } from "../references/profiles";
import type { ReferenceProfile } from "../../types/reference-profiles";
import {
  immutablePreparationJson,
  preparationDigest,
  preparationDirectory,
  projectMediaFile,
  readPreparation,
} from "./storage";

export function runPreparationFfmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-n", "-protocol_whitelist", "file,pipe", ...args], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Local preparation failed: ${result.error?.message ?? result.stderr.slice(-700)}`,
    });
}
/**
 * The legacy, hand-written Genjutsu prompt: kept verbatim as the parity oracle (RFC 0003 AC15). model:prepare builds
 * its prompt through the reference-pack compiler and asserts it equals this byte for byte.
 */
export function genjutsuPrompt(spec: ModelPreparationSpec): string {
  const source = spec.useMarkers ? "@Video1" : "the attached source video";
  const images = spec.references
    .map(
      (ref, index) =>
        `${spec.useMarkers ? `@Image${index + 1}` : `attached image ${index + 1}`} (${ref.entityId}, ${ref.role})`,
    )
    .join("; ");
  const instruction =
    spec.mode === "object-swap"
      ? `In ${source}, change only ${spec.target.description}. ${spec.target.change}`
      : spec.mode === "motion-transfer"
        ? `Use the movement, timing and camera of ${source} to rebuild the scene. ${spec.target.description}. ${spec.target.change}`
        : `Restyle ${source} using the selected style preset. ${spec.target.description}. ${spec.target.change}`;
  return [
    instruction,
    images ? `Reference bindings: ${images}.` : "",
    `Preserve: ${spec.target.preserve.join("; ")}.`,
    spec.target.otherSubjects.length
      ? `Do not alter these other subjects: ${spec.target.otherSubjects.join("; ")}.`
      : "",
    spec.additionalPrompt ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}
/**
 * Genjutsu as a profile path of the reference-pack flow (RFC 0003 D1, WP9): the request input is compiled from
 * packSpecFromPreparation with the endpoint's genjutsu-* profile. Slot measurement limits are left to the provider
 * guard that model:prepare already runs (buildFalOperation), so errors and their order are unchanged; the compiler
 * binds the fields and composes the prompt. The result must equal the legacy input byte for byte, or nothing is written.
 */
export function compileGenjutsuInput(
  spec: ModelPreparationSpec,
  source: MediaFacts & { assetId: string; sha256: string },
  references: { assetId: string; sha256: string; bytes: number; contentType: string; width: number; height: number }[],
  remoteMediaUrl?: string,
): Record<string, unknown> {
  const endpoint = genjutsuEndpoint(spec.mode),
    profile = profileForEndpoint(endpoint, "higgsfield");
  if (!profile)
    throw new CliErrorObject({ code: "VALIDATION", message: `No reference profile for ${endpoint} at higgsfield.` });
  const binding: ReferenceProfile = {
    ...profile,
    slots: profile.slots.map(({ durationSec: _d, maxBytes: _b, pixels: _p, formats: _f, fps: _r, ...slot }) => slot),
  };
  const { spec: packSpec, profile: effective } = packSpecFromPreparation(spec, binding, {
    sourceAssetId: source.assetId,
    referenceAssetIds: references.map((ref) => ref.assetId),
  });
  const { assetId, sha256, ...sourceFacts } = source;
  const compiled = compilePack({
    spec: packSpec,
    profile: effective,
    media: {
      [assetId]: sourceFacts,
      ...Object.fromEntries(
        references.map((ref) => [
          ref.assetId,
          { bytes: ref.bytes, contentType: ref.contentType, width: ref.width, height: ref.height },
        ]),
      ),
    },
  });
  const input = compiled.input;
  // A checked remote original is sent by its provider URL; reassigning keeps the field order.
  if (remoteMediaUrl !== undefined) input.video_url = remoteMediaUrl;
  const url = (sha: string) => `asset://sha256/${sha}`;
  const legacy = {
    video_url: remoteMediaUrl ?? url(sha256),
    image_urls: references.map((ref) => url(ref.sha256)),
    prompt: genjutsuPrompt(spec),
    resolution: spec.resolution,
    ...(spec.presetId ? { preset_id: spec.presetId } : {}),
  };
  if (JSON.stringify(input) !== JSON.stringify(legacy))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "The reference-pack compiler and the Genjutsu request disagree; nothing was submitted or approved.",
      details: { compiled: input, legacy },
    });
  return input;
}

const esc = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function prepareModel(projectId: string, input: unknown, rootDir = process.cwd()) {
  const spec = ModelPreparationSpecSchema.parse(input),
    directory = preparationDirectory(projectId, spec.id, rootDir);
  if (existsSync(path.join(directory, "receipt.json"))) {
    const current = readPreparation(projectId, spec.id, rootDir);
    if (preparationDigest(current.receipt.spec) !== preparationDigest(spec))
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: "Preparation is immutable; use a new id for changed inputs.",
      });
    return {
      ...current,
      request: JSON.parse(readFileSync(path.join(directory, "request.json"), "utf8")),
      reused: true,
    };
  }
  ensureFfmpeg();
  ensureFfprobe();
  const registry = readAssetRegistry(projectId, rootDir);
  const pin = (
    id: string,
    kind: "image" | "video",
  ): import("../../types/model-preparation").ModelPreparationReceipt["source"] => {
    const asset = registry.assets.find((row) => row.id === id);
    if (!asset || asset.kind !== kind)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Import a ${kind} original before preparation: ${id}`,
      });
    const file = projectMediaFile(projectId, asset.files.original, rootDir);
    if (hashFile(file) !== asset.hash || statSync(file).size !== asset.files.bytes)
      throw new CliErrorObject({ code: "VALIDATION", message: "Imported original changed." });
    const inspected = inspectAsset(file);
    if (inspected.kind !== kind)
      throw new CliErrorObject({ code: "VALIDATION", message: "Measured media kind differs from the asset record." });
    return {
      assetId: asset.id,
      sha256: asset.hash,
      original: asset.files.original,
      bytes: statSync(file).size,
      width: inspected.media.width!,
      height: inspected.media.height!,
      contentType: inspected.mime,
      ...(kind === "video" ? probeVideo(file) : { hasAudio: false }),
    };
  };
  const source = pin(spec.sourceAssetId, "video");
  const remote = spec.remoteSource ? readRemoteMedia(projectId, spec.remoteSource, rootDir) : undefined;
  const originalFile = projectMediaFile(projectId, source.original, rootDir);
  if (remote) {
    if (
      remote.asset.id !== source.assetId ||
      spec.segment.startSec !== 0 ||
      Math.abs(spec.segment.durationSec - source.durationSec!) > 0.001 ||
      spec.segment.crop ||
      (source.hasAudio && spec.audioPolicy !== "preserve-source")
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message:
          "Remote source must use the entire verified original without crop or audio changes. Omit remoteSource for local preparation.",
      });
    verifyReviewClock(originalFile, probeVideo(originalFile));
    const geometry = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,sample_aspect_ratio:stream_side_data=rotation",
        "-of",
        "json",
        originalFile,
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    if (geometry.status !== 0)
      throw new CliErrorObject({ code: "FFMPEG_FAILED", message: "Could not inspect remote source geometry." });
    const stream = JSON.parse(geometry.stdout).streams?.[0];
    if (
      !stream ||
      stream.width !== source.width ||
      stream.height !== source.height ||
      (stream.sample_aspect_ratio && !["1:1", "N/A"].includes(stream.sample_aspect_ratio)) ||
      stream.side_data_list?.some((row: { rotation?: number }) => row.rotation)
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Remote source needs square pixels and unrotated geometry. Omit remoteSource to conform it locally.",
      });
  }
  if (spec.segment.startSec + spec.segment.durationSec > source.durationSec! + 0.001)
    throw new CliErrorObject({ code: "VALIDATION", message: "Selected segment extends beyond the measured original." });
  const crop = spec.segment.crop;
  if (
    crop &&
    (crop.x + crop.width > source.width ||
      crop.y + crop.height > source.height ||
      [crop.x, crop.y, crop.width, crop.height].some((n) => n % 2))
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Crop must fit the displayed source and use even coordinates and dimensions.",
    });
  const references = spec.references.map((ref) => {
    const resolved = resolveEntityReferences(projectId, ref, rootDir);
    if (
      resolved.card.kind === "character" &&
      (!resolved.card.likenessConsent || resolved.card.likenessConsent.status === "unknown")
    )
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: `Record likeness consent or a not-applicable fictional identity for ${ref.entityId}.`,
      });
    const selected = resolved.references.find((row) => row.role === ref.role);
    if (!selected)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `No ${ref.role} reference in ${ref.entityId}@${ref.revision}.`,
      });
    const media = pin(selected.assetId, "image");
    const versionHash = getEntityVersion(projectId, ref.kind, ref.entityId, {
      revision: ref.revision,
      rootDir,
      requireApproved: true,
    }).version.contentHash;
    return { ...ref, versionHash, media };
  });
  if (new Set(references.map((ref) => ref.media.sha256)).size !== references.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Do not attach duplicate reference images under different markers.",
    });
  mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, ".preparing.lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    throw new CliErrorObject({
      code: "TIMEOUT",
      message: "Preparation is locked; inspect the existing operation before retrying.",
    });
  }
  const temporary = path.join(directory, `.${randomUUID()}.mp4`);
  try {
    immutablePreparationJson(path.join(directory, "spec.json"), spec);
    const sourceFile = projectMediaFile(projectId, source.original, rootDir);
    const filters = [
      `scale=${source.width}:${source.height}`,
      "setsar=1",
      ...(crop ? [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`] : []),
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      `fps=fps=${source.fps}:start_time=0`,
      "setpts=PTS-STARTPTS",
    ];
    if (!remote)
      runPreparationFfmpeg([
        "-ss",
        String(spec.segment.startSec),
        "-i",
        sourceFile,
        "-t",
        String(spec.segment.durationSec),
        "-map",
        "0:v:0",
        ...(spec.audioPolicy === "preserve-source" ? ["-map", "0:a:0?", "-c:a", "aac"] : ["-an"]),
        "-vf",
        filters.join(","),
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        temporary,
      ]);
    const preparedFile = remote ? originalFile : temporary;
    const prepared = remote
      ? remote.asset
      : importAsset({
          projectId,
          rootDir,
          sourceFile: temporary,
          provenance: { origin: "manual", tool: "model:prepare", referenceAssetIds: [source.assetId] },
        }).asset;
    const preparedSource = {
      assetId: prepared.id,
      sha256: prepared.hash,
      original: prepared.files.original,
      bytes: prepared.files.bytes,
      contentType: prepared.files.mime,
      ...probeVideo(preparedFile),
      durationSec: prepared.media.durationSec!,
    };
    if (Math.abs(preparedSource.durationSec - spec.segment.durationSec) > Math.max(0.1, 2 / preparedSource.fps))
      throw new CliErrorObject({ code: "VALIDATION", message: "Prepared duration differs from the selected segment." });
    const request = {
      provider: "higgsfield" as const,
      endpoint: genjutsuEndpoint(spec.mode),
      input: compileGenjutsuInput(
        spec,
        {
          assetId: prepared.id,
          sha256: prepared.hash,
          bytes: preparedSource.bytes,
          contentType: preparedSource.contentType,
          width: preparedSource.width,
          height: preparedSource.height,
          durationSec: preparedSource.durationSec,
          fps: preparedSource.fps,
        },
        references.map((ref) => ref.media),
        remote?.receipt.mediaUrl,
      ),
      ...(spec.remoteSource ? { context: { remoteMedia: [spec.remoteSource] } } : {}),
    };
    const resolved = resolveImportedReferences(request, projectId, rootDir, 256 * 1024 * 1024).request;
    const plan = buildFalOperation(resolved);
    const warnings = [
      ...plan.warnings,
      "Visual checks and rights are supplied review evidence, not automated creative or legal verification.",
    ];
    references.forEach((ref, index) => {
      if (Math.min(ref.media.width, ref.media.height) < 512)
        warnings.push(
          `@Image${index + 1} has a short edge below the 512-pixel house recommendation; inspect detail at shot scale.`,
        );
    });
    const reviewFiles: { path: string; sha256: string }[] = [];
    const thumbnails: { file: string; label: string }[] = [];
    for (const [index, seconds] of [
      0,
      preparedSource.durationSec / 2,
      Math.max(0, preparedSource.durationSec - 1 / preparedSource.fps),
    ].entries()) {
      const file = path.join(directory, `source-${index + 1}.png`);
      if (!existsSync(file))
        runPreparationFfmpeg([
          "-ss",
          String(seconds),
          "-i",
          preparedFile,
          "-frames:v",
          "1",
          "-vf",
          "scale=480:480:force_original_aspect_ratio=decrease",
          "-threads",
          "1",
          file,
        ]);
      thumbnails.push({ file, label: `@Video1 · ${seconds.toFixed(2)} s` });
    }
    for (const [index, ref] of references.entries()) {
      const file = path.join(directory, `image-${index + 1}.png`);
      if (!existsSync(file))
        runPreparationFfmpeg([
          "-i",
          projectMediaFile(projectId, ref.media.original, rootDir),
          "-frames:v",
          "1",
          "-vf",
          "scale=480:480:force_original_aspect_ratio=decrease",
          "-threads",
          "1",
          file,
        ]);
      thumbnails.push({ file, label: `@Image${index + 1} · ${ref.entityId}@${ref.revision} · ${ref.role}` });
    }
    thumbnails.forEach(({ file }) => reviewFiles.push({ path: path.basename(file), sha256: hashFile(file) }));
    const board = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'"><title>Genjutsu input review</title><style>body{font:18px system-ui;background:#16161a;color:white;padding:24px}main{display:flex;flex-wrap:wrap}figure{margin:12px}img{max-width:480px;height:300px;object-fit:contain}pre{white-space:pre-wrap}</style><h1>${esc(spec.id)} · ${spec.mode}</h1><main>${thumbnails.map((item) => `<figure><img src="${path.basename(item.file)}" alt="${esc(item.label)}"><figcaption>${esc(item.label)}</figcaption></figure>`).join("")}</main><pre>${esc(String(request.input.prompt))}</pre><p>Review motion throughout the original clip as well as these sampled frames. These images do not establish temporal consistency.</p></html>`;
    immutableWrite(path.join(directory, "board.html"), board);
    reviewFiles.push({ path: "board.html", sha256: hashFile(path.join(directory, "board.html")) });
    const inputAssets = new Map(readAssetRegistry(projectId, rootDir).assets.map((asset) => [asset.id, asset]));
    const seen = new Set<string>(),
      active = new Set<string>();
    const inputProvenance: { assetId: string; sha256: string; provenanceSha256: string }[] = [];
    const freezeProvenance = (id: string): void => {
      if (active.has(id))
        throw new CliErrorObject({ code: "VALIDATION", message: "Cyclic imported input provenance." });
      if (seen.has(id)) return;
      const asset = inputAssets.get(id);
      if (!asset) throw new CliErrorObject({ code: "VALIDATION", message: `Missing upstream input original: ${id}` });
      active.add(id);
      inputProvenance.push({ assetId: id, sha256: asset.hash, provenanceSha256: preparationDigest(asset.provenance) });
      for (const parent of asset.provenance.referenceAssetIds) freezeProvenance(parent);
      active.delete(id);
      seen.add(id);
    };
    [source.assetId, prepared.id, ...references.map((ref) => ref.media.assetId)].forEach(freezeProvenance);
    const receipt = ModelPreparationReceiptSchema.parse({
      schemaVersion: 1,
      projectId,
      id: spec.id,
      createdAt: new Date().toISOString(),
      spec,
      endpoint: request.endpoint,
      schemaSha256: plan.schemaSha256,
      requestSha256: preparationDigest({
        provider: request.provider,
        endpoint: request.endpoint,
        input: request.input,
      }),
      resolvedInputSha256: generationInputHash(plan.input),
      source,
      preparedSource,
      inputProvenance,
      references,
      reviewFiles,
      warnings,
    });
    const sha256 = preparationDigest(receipt);
    immutablePreparationJson(path.join(directory, "request.json"), {
      ...request,
      context: { ...request.context, modelPreparation: { id: spec.id, sha256 } },
    });
    immutablePreparationJson(path.join(directory, "visual-review-template.json"), {
      preparationSha256: sha256,
      reviewer: "FILL",
      evidence: "FILL after inspecting board and source clip",
      sourceMotionReadable: null,
      targetUnambiguous: null,
      references: references.map((ref) => ({
        sha256: ref.media.sha256,
        identityConsistent: null,
        detailReadable: null,
        angleSuitable: null,
        evidence: "FILL",
      })),
    });
    immutablePreparationJson(path.join(directory, "receipt.json"), receipt);
    return {
      receipt,
      sha256,
      request: { ...request, context: { ...request.context, modelPreparation: { id: spec.id, sha256 } } },
      reused: false,
    };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    closeSync(fd);
    unlinkSync(lock);
  }
}
