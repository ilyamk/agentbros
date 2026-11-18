import { captureLocalProvenance } from "../apple/provenance";
import { vizReceiptAncestryFiles, validateVizRenderReceipt } from "./receipt";
import path from "node:path";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import {
  VizRenderVariantsSchema,
  VizBindingSchema,
  VizBundleSchema,
  type VizBinding,
  type VizBundle,
} from "../../types/viz";
import { localFile } from "./store";
import { vizHash } from "./compile";
import { hashFile, readAssetRegistry } from "../assets/registry";

/** Collects only pinned active bindings; inactive preparation does not change render identity. */
export function collectActiveViz(
  root: string,
  project: string,
  consumed: unknown,
): Array<{
  bundle: VizBundle;
  file: string;
  sceneId: string;
  ownerSceneId?: string;
  receiptFile?: string;
  renderedAssetFile?: string;
  ancestryFiles?: string[];
}> {
  const bindings = new Map<string, VizBinding & { ownerSceneId?: string }>();
  const clipReceipts: Array<{ binding: VizBinding; assetId: string }> = [];
  const assetIds = new Set<string>();
  const consumedPlans = new Map<string, unknown[][]>();
  const walk = (value: unknown, ownerSceneId?: string): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, ownerSceneId));
      return;
    }
    const object = value as Record<string, unknown>;
    if (object.timeline) {
      walk(object.timeline);
      return;
    }
    if (object.template && typeof object.id === "string") {
      walk(object.template, ownerSceneId ?? object.id);
      return;
    }
    if (object.vizBinding && typeof object.id === "string" && object.startFrame !== undefined) ownerSceneId = object.id;
    if (typeof object.assetId === "string" && object.source) {
      const payload = object.payload as Record<string, unknown> | undefined;
      if (object.assetId.startsWith("scene:")) walk(payload?.scene, String(object.id));
      else if (payload?.vizRenderVariants) {
        for (const variant of Object.values(VizRenderVariantsSchema.parse(payload.vizRenderVariants))) {
          clipReceipts.push({ binding: variant.vizBinding, assetId: variant.assetId });
          walk({ vizBinding: variant.vizBinding }, String(object.id));
        }
      } else if (payload?.vizBinding) {
        const binding = VizBindingSchema.parse(payload.vizBinding);
        clipReceipts.push({ binding, assetId: object.assetId });
        walk({ vizBinding: binding }, String(object.id));
      } else assetIds.add(object.assetId);
      return;
    }
    if (Array.isArray(object.plans) && object.plans.some((p) => p && typeof p === "object" && "dataHash" in p)) {
      if (object.plateSrc !== undefined || object.plateFrames !== undefined)
        throw new Error("Internal plate sources cannot be supplied to native visualisation mounts");
      if (!object.vizBinding) throw new Error("Prepared visualisation requires a pinned binding");
      const b = VizBindingSchema.parse(object.vizBinding);
      const key = `${b.sceneId}:${b.revision}`;
      consumedPlans.set(key, [...(consumedPlans.get(key) ?? []), object.plans]);
    }
    if (object.vizBinding) {
      const b = VizBindingSchema.parse(object.vizBinding);
      bindings.set(`${b.sceneId}:${b.revision}:${ownerSceneId ?? ""}:${b.renderReceipt?.sha256 ?? ""}`, {
        ...b,
        ...(ownerSceneId ? { ownerSceneId } : {}),
      });
    }
    Object.values(object).forEach((item) => walk(item, ownerSceneId));
  };
  walk(consumed);
  if (assetIds.size && existsSync(path.join(root, "public/projects", project, "pipeline/asset-registry.json"))) {
    for (const asset of readAssetRegistry(project, root).assets)
      if (assetIds.has(asset.id) && asset.provenance.tool === "viz-render")
        throw new Error("Visualisation clip requires an explicit per-mount binding");
  }
  return [...bindings.values()].map((b) => {
    const file = localFile(
      root,
      path.join("public/projects", project, "pipeline/viz", b.sceneId, "revisions", b.revision, "bundle.json"),
      64 * 1024 * 1024,
    );
    const bundle = VizBundleSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (
      bundle.hash !== b.revision ||
      vizHash({
        version: 1,
        plans: bundle.plans,
        sourceHashes: bundle.sourceHashes,
        sourceCopies: bundle.sourceCopies,
      }) !== b.revision
    )
      throw new Error("Active visualisation revision was modified");
    let ancestryFiles: string[] = [];
    let receiptFile: string | undefined;
    let renderedAssetFile: string | undefined;
    if (b.renderReceipt) {
      receiptFile = localFile(root, path.join("public", b.renderReceipt.path));
      if (hashFile(receiptFile) !== b.renderReceipt.sha256) throw new Error("Mounted render receipt was modified");
      const receipt = validateVizRenderReceipt(JSON.parse(readFileSync(receiptFile, "utf8")), bundle, file);
      ancestryFiles = vizReceiptAncestryFiles(receipt, file);
      const plan = bundle.plans.find((p) => p.format === receipt.format);
      if (
        receipt.revision !== bundle.hash ||
        !plan ||
        receipt.frameCount !== plan.spec.durationFrames ||
        receipt.fps !== 30
      )
        throw new Error("Mounted render receipt differs from its scene");
      const clips = clipReceipts.filter((c) => c.binding.renderReceipt?.sha256 === b.renderReceipt!.sha256);
      for (const clip of clips) {
        const asset = readAssetRegistry(project, root).assets.find((a) => a.id === clip.assetId);
        if (receipt.assetId !== clip.assetId || !asset || asset.hash !== receipt.sha256)
          throw new Error("Mounted receipt differs from displayed asset");
        renderedAssetFile = localFile(root, path.join("public", asset.files.original), 1024 * 1024 * 1024);
        if (hashFile(renderedAssetFile) !== asset.hash) throw new Error("Mounted rendered asset was modified");
      }
    } else if (clipReceipts.some((c) => c.binding.sceneId === b.sceneId && c.binding.revision === b.revision))
      throw new Error("Rendered clip requires an exact receipt binding");
    const actual = consumedPlans.get(`${b.sceneId}:${b.revision}`);
    if (actual?.some((plans) => vizHash(plans) !== vizHash(bundle.plans)))
      throw new Error("Displayed visualisation differs from pinned revision");
    return {
      bundle,
      file,
      ...(ancestryFiles.length ? { ancestryFiles } : {}),
      ...(receiptFile ? { receiptFile } : {}),
      ...(renderedAssetFile ? { renderedAssetFile } : {}),
      sceneId: b.sceneId,
      ...(b.ownerSceneId ? { ownerSceneId: b.ownerSceneId } : {}),
    };
  });
}
export function captureVizDependencies(
  root: string,
  project: string,
  consumed: unknown,
  add: (file: string, role: "creative" | "code" | "asset") => void,
): void {
  for (const active of collectActiveViz(root, project, consumed)) {
    add(active.file, "creative");
    for (const file of active.ancestryFiles ?? []) add(file, "creative");
    if (active.receiptFile) add(active.receiptFile, "creative");
    if (active.renderedAssetFile) add(active.renderedAssetFile, "asset");
    for (const map of Object.values(active.bundle.plans[0]!.spec.textures?.maps ?? {})) {
      if (map) {
        const file = localFile(root, path.join("public", map.path));
        if (hashFile(file) !== map.sha256) throw new Error("Active texture was modified");
        add(file, "asset");
        captureLocalProvenance(file, realpathSync(root), add);
      }
    }
    for (const datum of active.bundle.plans[0]!.spec.data) {
      if (datum.evidence) add(localFile(root, path.join("public", datum.evidence.path)), "creative");
    }
    if (active.bundle.plans.some((p) => p.spec.recipe.endsWith("-3d")))
      add(path.join(root, "scripts/blender/viz_scene.py"), "code");
  }
}
