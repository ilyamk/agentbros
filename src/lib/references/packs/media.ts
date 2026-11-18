/** Attachment resolution for packs: registry asset → verified bytes → measured pin and compiler facts. */
import { statSync } from "node:fs";
import { CliErrorObject } from "../../cli";
import { hashFile } from "../../assets/registry";
import { inspectAsset } from "../../assets/inspect";
import { projectMediaFile } from "../../model-preparation/storage";
import { probeVideo } from "../../vision/media";
import type { AssetRecord } from "../../../types/assets";
import type { DerivativeMediaPin, Modality } from "../../../types/references";
import type { MediaFacts } from "../compile";

export type ResolvedAttachmentMedia = {
  asset: AssetRecord;
  file: string;
  pin: DerivativeMediaPin;
  facts: MediaFacts;
};

/** The asset's original, re-hashed against the registry; VALIDATION when the bytes changed. */
export function verifiedOriginal(projectId: string, asset: AssetRecord, rootDir = process.cwd()): string {
  const file = projectMediaFile(projectId, asset.files.original, rootDir);
  if (statSync(file).size !== asset.files.bytes || hashFile(file) !== asset.hash)
    throw new CliErrorObject({ code: "VALIDATION", message: `Imported original ${asset.id} changed on disk.` });
  return file;
}

/** Measures one registered asset for a slot of `modality`. */
export function resolveAttachmentMedia(
  projectId: string,
  assetId: string,
  modality: Modality,
  registry: AssetRecord[],
  rootDir = process.cwd(),
): ResolvedAttachmentMedia {
  const asset = registry.find((row) => row.id === assetId);
  if (!asset)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Asset ${assetId} is not in the project registry; import it with pnpm asset:import (or derive it with refs:derive) first.`,
    });
  if (asset.kind !== modality)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Asset ${assetId} is ${asset.kind}; the slot carries ${modality}.`,
    });
  const file = verifiedOriginal(projectId, asset, rootDir);
  const inspected = inspectAsset(file);
  if (inspected.kind !== asset.kind)
    throw new CliErrorObject({ code: "VALIDATION", message: `Measured kind of ${assetId} differs from its record.` });
  const video = inspected.kind === "video" ? probeVideo(file) : undefined;
  const width = video?.width ?? inspected.media.width,
    height = video?.height ?? inspected.media.height;
  const durationSec = inspected.kind === "image" ? undefined : (video?.durationSec ?? inspected.media.durationSec);
  const pin: DerivativeMediaPin = {
    assetId: asset.id,
    sha256: asset.hash,
    original: asset.files.original,
    bytes: asset.files.bytes,
    ...(width && height ? { width, height } : {}),
    contentType: inspected.mime,
    ...(durationSec ? { durationSec } : {}),
    ...(video ? { fps: video.fps, frameCount: video.frameCount } : {}),
    hasAudio: inspected.media.hasAudio,
  };
  const facts: MediaFacts = {
    bytes: asset.files.bytes,
    sha256: asset.hash,
    contentType: inspected.mime,
    ...(width && height ? { width, height } : {}),
    ...(durationSec ? { durationSec } : {}),
    ...(video ? { fps: video.fps } : {}),
    ...(inspected.media.hasAlpha === true ? { hasAlpha: true } : {}),
  };
  return { asset, file, pin, facts };
}

/** Every ancestor of an asset through provenance.referenceAssetIds (itself first); cycles are refused. */
export function assetAncestry(assetId: string, registry: AssetRecord[]): AssetRecord[] {
  const byId = new Map(registry.map((asset) => [asset.id, asset]));
  const out: AssetRecord[] = [],
    seen = new Set<string>(),
    active = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) throw new CliErrorObject({ code: "VALIDATION", message: "Cyclic asset provenance." });
    if (seen.has(id)) return;
    const asset = byId.get(id);
    seen.add(id);
    if (!asset) return; // An unregistered ancestor is reported by the rights rule as non-generated.
    active.add(id);
    out.push(asset);
    for (const parent of asset.provenance.referenceAssetIds) visit(parent);
    active.delete(id);
  };
  visit(assetId);
  return out;
}
