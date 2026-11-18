import { AssetRegistrySchema } from "../../types/assets";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { LocalResultReceiptSchema } from "../../types/local-capabilities";
import { boundedFile, fileHash, digest } from "./runtime";
export function receiptForLocalAsset(file: string) {
  const match = file.replaceAll("\\", "/").match(/^(.*\.json)\.assets\//u);
  if (!match) return undefined;
  const rest = file
    .replaceAll("\\", "/")
    .slice((match[1]! + ".assets/").length)
    .split("/");
  const generation = rest.length > 1 ? path.join(match[1]! + ".assets", rest[0]!, "receipt.json") : undefined;
  return generation && existsSync(generation) ? generation : match[1]! + ".receipt.json";
}
export function captureLocalProvenance(
  file: string,
  root: string,
  add: (file: string, role: "creative" | "asset") => void,
) {
  const receiptFile = receiptForLocalAsset(file);
  if (!receiptFile) {
    const marker = file.lastIndexOf(path.join("assets", "imported") + path.sep);
    if (marker >= 0) {
      const registry = path.join(file.slice(0, marker), "pipeline/asset-registry.json");
      if (existsSync(registry)) {
        const contents = AssetRegistrySchema.parse(JSON.parse(boundedFile(registry).toString()));
        if (
          contents.assets.some(
            (asset) => asset.localResult && path.resolve(root, "public", asset.files.original) === path.resolve(file),
          )
        )
          add(registry, "creative");
      }
    }
    return;
  }
  if (!existsSync(receiptFile)) throw new Error("Local generated asset is missing its provenance receipt");
  const receipt = LocalResultReceiptSchema.parse(JSON.parse(boundedFile(receiptFile).toString()));
  const pin = receipt.outputs.find((row) => path.resolve(row.file) === path.resolve(file));
  if (!pin || fileHash(file) !== pin.sha256) throw new Error("Local generated asset provenance mismatch");
  for (const original of receipt.inputs) {
    const relative = path.relative(root, path.resolve(original.file));
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
      throw new Error("Import native source inputs into the workspace before production rendering");
    if (fileHash(original.file, 32 * 1024 ** 3) !== original.sha256) throw new Error("Local generated source changed");
    add(original.file, "creative");
  }
  add(receiptFile, "creative");
}
export function localAssetReferences(value: unknown, root: string): string[] {
  const files: string[] = [];
  const visit = (item: unknown) => {
    if (typeof item === "string" && (item.includes(".json.assets/") || item.includes("/assets/imported/")))
      files.push(
        path.isAbsolute(item) ? item : path.resolve(root, item.startsWith("public/") ? item : "public/" + item),
      );
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value);
  return [...new Set(files)];
}

export function readLocalImportProvenance(source: string, hash: string) {
  const file = receiptForLocalAsset(source);
  if (!file) {
    const marker = source.lastIndexOf(path.join("assets", "imported") + path.sep);
    if (marker < 0) return undefined;
    const registryFile = path.join(source.slice(0, marker), "pipeline/asset-registry.json");
    if (!existsSync(registryFile)) return undefined;
    const registry = AssetRegistrySchema.parse(JSON.parse(boundedFile(registryFile).toString()));
    return registry.assets.find((asset) => asset.hash === hash)?.localResult;
  }
  const bytes = boundedFile(file),
    receipt = LocalResultReceiptSchema.parse(JSON.parse(bytes.toString()));
  if (!receipt.outputs.some((row) => path.resolve(row.file) === path.resolve(source) && row.sha256 === hash))
    throw new Error("Native import is not bound to its original receipt");
  return { receipt, receiptHash: fileHash(file), sourceOutputHash: hash };
}
export function assertImportedLocalAssets(files: readonly string[], registryFile: string, root: string) {
  root = realpathSync(root);
  const consumed = files.map((file) => (existsSync(file) ? realpathSync(file) : path.resolve(file)));
  const registries = new Set([registryFile]);
  for (const file of files) {
    const marker = file.lastIndexOf(path.join("assets", "imported") + path.sep);
    if (marker >= 0) registries.add(path.join(file.slice(0, marker), "pipeline/asset-registry.json"));
  }
  for (const registry of registries) {
    if (!existsSync(registry)) continue;
    const raw = AssetRegistrySchema.parse(JSON.parse(boundedFile(registry).toString()));
    for (const asset of raw.assets) {
      if (!asset.localResult || !consumed.some((file) => file === path.resolve(root, "public", asset.files.original)))
        continue;
      const receipt = LocalResultReceiptSchema.parse(asset.localResult.receipt);
      if (digest(JSON.stringify(receipt) + "\n") !== asset.localResult.receiptHash)
        throw new Error("Imported native receipt changed");
      if (receipt.purpose === "draft") throw new Error("Imported native draft is preview-only");
      if (
        asset.localResult.sourceOutputHash !== asset.hash ||
        !receipt.outputs.some((row) => row.sha256 === asset.hash) ||
        fileHash(path.resolve(root, "public", asset.files.original)) !== asset.hash
      )
        throw new Error("Imported local asset provenance mismatch");
    }
  }
}
