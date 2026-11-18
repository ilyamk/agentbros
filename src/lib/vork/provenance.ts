import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { AssetRegistrySchema, type AssetRecord } from "../../types/assets";
import { assertPathWithin } from "../cli";
import { assertVorkResult, verifyPins } from "./render";
import { digest, hashFile, json } from "./runtime";
import { VorkReceiptSchema } from "../../types/vork";

function directReceipt(source: string, root: string) {
  for (const file of [
    source + ".vork-receipt.json",
    ...[path.dirname(source), path.dirname(path.dirname(source))].map((directory) =>
      path.join(directory, "vork-receipt.json"),
    ),
  ]) {
    if (!existsSync(file)) continue;
    const receipt = VorkReceiptSchema.parse(json(file));
    const pin = receipt.outputs.find((pin) => path.resolve(root, pin.file) === path.resolve(source));
    if (!pin) continue;
    if (pin.sha256 !== hashFile(source)) throw new Error("Vork receipt output binding mismatch");
    return { file, receipt };
  }
  return undefined;
}
/** Expand explicitly declared native frame patterns as immutable individual files. */
export function vorkAssetReferences(value: unknown, root: string): string[] {
  const files = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === "string" && /\.(png|exr|mp4|mov|glb)$/i.test(item)) {
      const candidate = path.isAbsolute(item)
        ? item
        : path.resolve(root, item.startsWith("public/") || item.startsWith("out/") ? item : "public/" + item);
      const token = path.basename(candidate).match(/#+|%0?\d*d/);
      const candidates =
        token && existsSync(path.dirname(candidate))
          ? readdirSync(path.dirname(candidate))
              .filter((name) => {
                const escaped = path
                  .basename(candidate)
                  .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                  .replace(/#+|%0?\d*d/, "\\d+");
                return new RegExp(`^${escaped}$`).test(name);
              })
              .map((name) => path.join(path.dirname(candidate), name))
          : [candidate];
      const bound = candidates.filter(
        (file) => existsSync(file) && statSync(file).isFile() && directReceipt(file, root),
      );
      if (token && bound.length && bound.length !== candidates.length)
        throw new Error("Every frame matching a Vork sequence pattern must be bound to its receipt");
      bound.forEach((file) => files.add(file));
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value);
  return [...files].sort();
}

function registryFor(file: string) {
  const marker = file.lastIndexOf(path.join("assets", "imported") + path.sep);
  return marker < 0 ? undefined : path.join(file.slice(0, marker), "pipeline", "asset-registry.json");
}
export function readVorkImportProvenance(source: string, hash: string, root: string): AssetRecord["vorkResult"] {
  const registryFile = registryFor(source);
  if (registryFile && existsSync(registryFile)) {
    const registry = AssetRegistrySchema.parse(json(registryFile));
    const asset = registry.assets.find(
      (row) => path.resolve(root, "public", row.files.original) === path.resolve(source),
    );
    if (asset?.vorkResult) {
      verify(asset, root, false);
      if (asset.hash !== hash) throw new Error("Imported Vork output changed");
      return asset.vorkResult;
    }
  }
  const direct = directReceipt(source, root);
  if (direct)
    return { receipt: direct.receipt, receiptHash: digest(JSON.stringify(direct.receipt)), sourceOutputHash: hash };
  return undefined;
}
function verify(asset: AssetRecord, root: string, production: boolean) {
  const result = asset.vorkResult;
  if (!result) return;
  if (digest(JSON.stringify(result.receipt)) !== result.receiptHash || result.sourceOutputHash !== asset.hash)
    throw new Error("Vork provenance receipt changed");
  assertVorkResult(result.receipt, asset.hash, root, production);
  if (hashFile(path.join(root, "public", asset.files.original)) !== asset.hash)
    throw new Error("Imported Vork output changed");
}
export function captureVorkProvenance(
  file: string,
  root: string,
  add: (file: string, role: "creative" | "asset") => void,
) {
  const direct = directReceipt(file, root);
  if (direct) {
    assertVorkResult(direct.receipt, hashFile(file), root);
    verifyPins(direct.receipt.outputs, root);
    add(direct.file, "creative");
    for (const pin of direct.receipt.inputs) {
      const source = path.resolve(root, pin.file);
      assertPathWithin(root, source);
      add(source, "creative");
    }
  }
  const registryFile = registryFor(file);
  if (!registryFile || !existsSync(registryFile)) return;
  assertPathWithin(root, registryFile);
  const registry = AssetRegistrySchema.parse(JSON.parse(readFileSync(registryFile, "utf8")));
  const asset = registry.assets.find((row) => path.resolve(root, "public", row.files.original) === path.resolve(file));
  if (!asset?.vorkResult) return;
  verify(asset, root, false);
  add(registryFile, "creative");
  for (const pin of asset.vorkResult.receipt.inputs) {
    const source = path.resolve(root, pin.file);
    assertPathWithin(root, source);
    add(source, "creative");
  }
}
export function assertImportedVorkAssets(files: readonly string[], registryFile: string, root: string) {
  for (const file of files) {
    const direct = directReceipt(file, root);
    if (direct) {
      assertVorkResult(direct.receipt, hashFile(file), root, true);
      verifyPins(direct.receipt.outputs, root);
    }
  }
  const registries = new Set([registryFile, ...files.map(registryFor).filter((file): file is string => !!file)]);
  for (const file of registries) {
    if (!existsSync(file)) continue;
    assertPathWithin(root, file);
    const registry = AssetRegistrySchema.parse(JSON.parse(readFileSync(file, "utf8")));
    for (const asset of registry.assets)
      if (files.some((source) => path.resolve(source) === path.resolve(root, "public", asset.files.original)))
        verify(asset, root, true);
  }
}
