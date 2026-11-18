import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import {
  VizDerivedManifestSchema,
  VizBindingSchema,
  VizBundleSchema,
  type VizBinding,
  type VizBundle,
} from "../../types/viz";
import { collectActiveViz } from "./usage";
import { localFile } from "./store";
import { vizHash } from "./compile";
import { hashFile, readAssetRegistry } from "../assets/registry";
import { AssetRecordSchema, AssetRegistrySchema, type AssetRecord } from "../../types/assets";
import { readLocalImportProvenance } from "../apple/provenance";
import { digest } from "../apple/runtime";
import { inspectAsset } from "../assets/inspect";
import { assertPathWithin } from "../cli";
import { VizAnyReceiptSchema, validateVizRenderReceipt } from "./receipt";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export type DerivedVizFile = { relative: string; bytes: string | Buffer; sha256: string };
/** Read-only planning; all paths and revision hashes are settled before episode hashing. */
export function planDerivedViz(
  root: string,
  sourceProject: string,
  targetProject: string,
  consumed: unknown,
  formats: readonly string[],
) {
  const active = collectActiveViz(root, sourceProject, consumed);
  const files = new Map<string, DerivedVizFile>();
  const add = (relative: string, bytes: string | Buffer) => {
    assertPathWithin(
      path.resolve(root, "public/projects", targetProject),
      path.resolve(root, "public/projects", targetProject, relative),
    );
    const pin = sha(bytes);
    const previous = files.get(relative);
    if (
      !previous &&
      [...files.values()].reduce((sum, f) => sum + Buffer.byteLength(f.bytes), 0) + Buffer.byteLength(bytes) >
        128 * 1024 * 1024
    )
      throw new Error("Derived visualisation closure exceeds 128 MiB");
    if (previous && previous.sha256 !== pin) throw new Error("Derived visualisation destination collision");
    files.set(relative, { relative, bytes, sha256: pin });
    return pin;
  };
  const archive = (file: string) => {
    const bytes = readFileSync(file);
    const hash = sha(bytes);
    add(`pipeline/viz/ancestry/${hash}.json`, bytes);
    return hash;
  };
  const copyAncestry = (receipt: unknown, seen = new Set<string>(), depth = 0) => {
    if (depth > 16) throw new Error("Visualisation ancestry exceeds 16 generations");
    const parsed = VizAnyReceiptSchema.parse(receipt);
    if (parsed.kind !== "derived-viz-binding-v1") return;
    for (const hash of [parsed.origin.sourceBundleSha256, parsed.origin.sourceReceiptSha256]) {
      if (seen.has(hash)) continue;
      seen.add(hash);
      const file = localFile(
        root,
        path.join("public/projects", sourceProject, "pipeline/viz/ancestry", `${hash}.json`),
        64 * 1024 * 1024,
      );
      if (hashFile(file) !== hash) throw new Error("Source ancestry was modified");
      archive(file);
      if (hash === parsed.origin.sourceReceiptSha256)
        copyAncestry(JSON.parse(readFileSync(file, "utf8")), seen, depth + 1);
    }
  };
  const nativeAssets = new Map<string, AssetRecord>();
  const registryFile = path.join(root, "public/projects", sourceProject, "pipeline/asset-registry.json");
  const sourceAssets = existsSync(registryFile) ? readAssetRegistry(sourceProject, root).assets : [];
  const rewrites = new Map<string, { bundle: VizBundle; binding: VizBinding }>();
  for (const item of active) {
    if (formats.some((format) => !item.bundle.plans.some((p) => p.format === format)))
      throw new Error("Derived visualisation needs a separately prepared layout for every requested format");
    const derived = structuredClone(item.bundle);
    for (const plan of derived.plans) {
      for (const map of Object.values(plan.spec.textures?.maps ?? {})) {
        if (!map) continue;
        const file = localFile(root, path.join("public", map.path));
        if (hashFile(file) !== map.sha256) throw new Error("Source texture changed during derivation");
        const extension = path.extname(file).toLowerCase();
        const native = readLocalImportProvenance(file, map.sha256);
        const relative = `assets/${native ? "imported" : "viz-resources"}/${map.sha256}${extension}`;
        add(relative, readFileSync(file));
        map.path = `projects/${targetProject}/${relative}`;
        if (native) {
          if (
            digest(JSON.stringify(native.receipt) + "\n") !== native.receiptHash ||
            native.sourceOutputHash !== map.sha256 ||
            !native.receipt.outputs.some((output) => output.sha256 === map.sha256)
          )
            throw new Error("Native texture provenance mismatch");
          const original = sourceAssets.find((asset) => asset.hash === map.sha256);
          const inspected = inspectAsset(file);
          const asset = AssetRecordSchema.parse({
            ...original,
            schemaVersion: 1,
            id: `sha256:${map.sha256}`,
            hash: map.sha256,
            revision: 1,
            createdAt: original?.createdAt ?? native.receipt.createdAt,
            kind: inspected.kind,
            files: { original: map.path, bytes: Buffer.byteLength(readFileSync(file)), mime: inspected.mime },
            media: inspected.media,
            provenance: original?.provenance ?? { origin: "manual", tool: "derived-native-texture" },
            rights: original?.rights ?? {},
            entityLinks: original?.entityLinks ?? [],
            status: "candidate",
            localResult: native,
          });
          const prior = nativeAssets.get(asset.id);
          if (prior && vizHash(prior.localResult) !== vizHash(asset.localResult))
            throw new Error("Conflicting native texture provenance");
          nativeAssets.set(asset.id, asset);
        }
      }
      for (const datum of plan.spec.data) {
        if (!datum.evidence) continue;
        const evidence = datum.evidence;
        const original = localFile(root, path.join("public", evidence.path));
        if (hashFile(original) !== evidence.sha256) throw new Error("Source evidence changed during derivation");
        const relative = `pipeline/evidence/${evidence.sha256}.txt`;
        add(relative, readFileSync(original));
        evidence.path = `projects/${targetProject}/${relative}`;
        if (item.ownerSceneId) evidence.claimId = `${evidence.claimId}:${item.ownerSceneId}`;
      }
      plan.dataHash = vizHash(plan.spec.data);
    }
    derived.hash = vizHash({
      version: 1,
      plans: derived.plans,
      sourceHashes: derived.sourceHashes,
      sourceCopies: derived.sourceCopies,
    });
    const bundleRelative = `pipeline/viz/${item.sceneId}/revisions/${derived.hash}/bundle.json`;
    const bundleBytes = JSON.stringify(derived);
    const bundleHash = add(bundleRelative, bundleBytes);
    const binding: VizBinding = { sceneId: item.sceneId, revision: derived.hash };
    if (item.receiptFile) {
      const originalReceipt = VizAnyReceiptSchema.parse(JSON.parse(readFileSync(item.receiptFile, "utf8")));
      copyAncestry(originalReceipt);
      const sourceBundleSha256 = archive(item.file),
        sourceReceiptSha256 = archive(item.receiptFile);
      const plan = derived.plans.find((p) => p.format === originalReceipt.format)!;
      const renderInputs = {
        "derived-bundle": bundleHash,
        "source-bundle": sourceBundleSha256,
        "source-receipt": sourceReceiptSha256,
      };
      const receipt = {
        ...originalReceipt,
        kind: "derived-viz-binding-v1" as const,
        revision: derived.hash,
        source: path.resolve(root, "public/projects", targetProject, bundleRelative),
        output: path.resolve(
          root,
          "public/projects",
          targetProject,
          "assets/imported",
          path.basename(item.renderedAssetFile!),
        ),
        renderInputs,
        inputIdentity: { bundleHash, planHash: vizHash(plan), renderInputsHash: vizHash(renderInputs) },
        origin: { sourceBundleSha256, sourceReceiptSha256 },
      };
      const bytes = JSON.stringify(receipt),
        receiptHash = sha(bytes);
      const relative = `pipeline/viz/${item.sceneId}/revisions/${derived.hash}/renders/${receiptHash}.json`;
      add(relative, bytes);
      binding.renderReceipt = { path: `projects/${targetProject}/${relative}`, sha256: receiptHash };
    }
    rewrites.set(
      `${item.sceneId}:${item.bundle.hash}:${item.ownerSceneId ?? ""}:${item.receiptFile ? hashFile(item.receiptFile) : ""}`,
      { bundle: derived, binding },
    );
  }
  const timeline = structuredClone(consumed);
  const walk = (value: unknown, owner?: string): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((v) => walk(v, owner));
      return;
    }
    const object = value as Record<string, unknown>;
    if (object.template && typeof object.id === "string") owner = owner ?? object.id;
    if (typeof object.assetId === "string" && object.source) owner = String(object.id);
    if (object.vizBinding) {
      const b = VizBindingSchema.parse(object.vizBinding);
      const next = rewrites.get(`${b.sceneId}:${b.revision}:${owner ?? ""}:${b.renderReceipt?.sha256 ?? ""}`);
      if (!next) throw new Error("Derived visualisation has no planned dependency closure");
      object.vizBinding = next.binding;
      if (Array.isArray(object.plans)) object.plans = next.bundle.plans;
    }
    Object.entries(object).forEach(([key, v]) => {
      if (key !== "plans" && key !== "vizBinding") walk(v, owner);
    });
  };
  walk(timeline);
  const assets = [...nativeAssets.values()];
  if (assets.length)
    add(
      "pipeline/viz/native-assets.json",
      JSON.stringify(AssetRegistrySchema.parse({ schemaVersion: 1, revision: 1, assets })),
    );
  return { timeline, assets, files: [...files.values()] };
}
export function writeDerivedVizFiles(directory: string, files: readonly DerivedVizFile[]): string[] {
  const written = files.map((file) => {
    const target = path.resolve(directory, file.relative);
    assertPathWithin(directory, target);
    mkdirSync(path.dirname(target), { recursive: true });
    if (existsSync(target)) {
      if (hashFile(target) !== file.sha256) throw new Error("Existing derived dependency differs");
    } else writeFileSync(target, file.bytes, { flag: "wx" });
    return target;
  });
  const nativeFile = files.find((file) => file.relative === "pipeline/viz/native-assets.json");
  if (nativeFile) {
    const native = AssetRegistrySchema.parse(JSON.parse(nativeFile.bytes.toString()));
    const registryFile = path.join(directory, "pipeline/asset-registry.json");
    assertPathWithin(directory, registryFile);
    const existing = existsSync(registryFile)
      ? AssetRegistrySchema.parse(JSON.parse(readFileSync(registryFile, "utf8")))
      : { schemaVersion: 1 as const, revision: 0, assets: [] };
    const assets = new Map(existing.assets.map((asset) => [asset.id, asset]));
    for (const asset of native.assets) {
      if (!asset.files.original.startsWith(`projects/${path.basename(directory)}/assets/imported/`))
        throw new Error("Native texture registry belongs to another project");
      const previous = assets.get(asset.id);
      if (previous?.localResult && vizHash(previous.localResult) !== vizHash(asset.localResult))
        throw new Error("Conflicting native texture registry provenance");
      assets.set(asset.id, previous ? { ...previous, localResult: asset.localResult } : asset);
    }
    if (vizHash(existing.assets) !== vizHash([...assets.values()])) {
      const next = AssetRegistrySchema.parse({
        ...existing,
        revision: existing.revision + 1,
        assets: [...assets.values()],
      });
      mkdirSync(path.dirname(registryFile), { recursive: true });
      const temporary = `${registryFile}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(next, null, 2), { flag: "wx" });
      renameSync(temporary, registryFile);
    }
  }
  if (files.length) {
    const manifest = VizDerivedManifestSchema.parse({
      version: 1,
      projectId: path.basename(directory),
      files: files.map((f) => ({ relative: f.relative, sha256: f.sha256 })),
    });
    const file = path.join(directory, "pipeline/viz/derived-manifest.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const bytes = JSON.stringify(manifest);
    if (existsSync(file)) {
      if (readFileSync(file, "utf8") !== bytes) throw new Error("Derived manifest changed");
    } else writeFileSync(file, bytes, { flag: "wx" });
    written.push(file);
  }
  return written;
}
