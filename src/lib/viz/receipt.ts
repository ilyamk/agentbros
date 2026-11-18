import { localFile } from "./store";
import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { VizBundleSchema, VizFormatSchema, type VizBundle, type VizPlan } from "../../types/viz";
import { hashFile } from "../assets/registry";
import { vizHash } from "./compile";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const VizRenderReceiptSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("rendered-viz-v1"),
    revision: hash,
    format: VizFormatSchema,
    backend: z.enum(["svg", "three", "blender"]),
    output: z.string().min(1),
    sha256: hash,
    assetId: z.string().min(1),
    source: z.string().min(1),
    renderInputs: z.record(z.string().min(1), hash),
    inputIdentity: z.object({ bundleHash: hash, planHash: hash, renderInputsHash: hash }).strict(),
    id: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.literal(30),
    durationInFrames: z.number().int().positive(),
    firstFrame: z.literal(0),
    lastFrame: z.number().int().nonnegative(),
    frameCount: z.number().int().positive(),
  })
  .strict();
export const VizDerivedReceiptSchema = VizRenderReceiptSchema.extend({
  kind: z.literal("derived-viz-binding-v1"),
  origin: z.object({ sourceBundleSha256: hash, sourceReceiptSha256: hash }).strict(),
});
export const VizAnyReceiptSchema = z.discriminatedUnion("kind", [VizRenderReceiptSchema, VizDerivedReceiptSchema]);
export function vizPixelsIdentity(plan: VizPlan): string {
  const copy = structuredClone(plan);
  copy.dataHash = "";
  for (const datum of copy.spec.data) delete datum.evidence;
  for (const map of Object.values(copy.spec.textures?.maps ?? {})) if (map) map.path = "content-addressed";
  return vizHash(copy);
}
export type VizRenderReceipt = z.infer<typeof VizRenderReceiptSchema>;
export function createVizRenderReceipt(
  input: Omit<VizRenderReceipt, "version" | "kind" | "inputIdentity" | "fps" | "firstFrame"> & {
    fps: number;
    firstFrame: number;
  },
  plan: VizPlan,
): VizRenderReceipt {
  return VizRenderReceiptSchema.parse({
    ...input,
    version: 1,
    kind: "rendered-viz-v1",
    inputIdentity: {
      bundleHash: hashFile(input.source),
      planHash: vizHash(plan),
      renderInputsHash: vizHash(input.renderInputs),
    },
  });
}
/** Structural input binding, not a cryptographic attestation or a judgement of factual truth. */
export function validateVizRenderReceipt(
  raw: unknown,
  bundle: VizBundle,
  bundleFile: string,
  depth = 0,
): z.infer<typeof VizAnyReceiptSchema> {
  if (depth > 16) throw new Error("Visualisation ancestry exceeds 16 generations");
  const receipt = VizAnyReceiptSchema.parse(raw);
  const plan = bundle.plans.find((p) => p.format === receipt.format);
  const bundleHash = hashFile(bundleFile);
  if (
    receipt.revision !== bundle.hash ||
    !plan ||
    receipt.inputIdentity.bundleHash !== bundleHash ||
    receipt.inputIdentity.planHash !== vizHash(plan) ||
    receipt.inputIdentity.renderInputsHash !== vizHash(receipt.renderInputs) ||
    !Object.values(receipt.renderInputs).includes(bundleHash)
  )
    throw new Error("Render receipt input identity differs from the pinned scene");
  if (
    receipt.frameCount !== plan.spec.durationFrames ||
    receipt.durationInFrames !== plan.spec.durationFrames ||
    receipt.lastFrame !== plan.spec.durationFrames - 1 ||
    receipt.width !== plan.width ||
    receipt.height !== plan.height
  )
    throw new Error("Render receipt does not cover the complete prepared format");
  if (receipt.kind === "derived-viz-binding-v1") {
    const prefix = bundleFile.lastIndexOf(`${path.sep}pipeline${path.sep}viz${path.sep}`);
    if (prefix < 0) throw new Error("Derived bundle has no project ancestry scope");
    const projectDirectory = bundleFile.slice(0, prefix);
    const directory = path.join(projectDirectory, "pipeline/viz/ancestry");
    const sourceBundleFile = localFile(
        projectDirectory,
        path.join(directory, `${receipt.origin.sourceBundleSha256}.json`),
        64 * 1024 * 1024,
      ),
      sourceReceiptFile = localFile(
        projectDirectory,
        path.join(directory, `${receipt.origin.sourceReceiptSha256}.json`),
      );
    if (
      hashFile(sourceBundleFile) !== receipt.origin.sourceBundleSha256 ||
      hashFile(sourceReceiptFile) !== receipt.origin.sourceReceiptSha256
    )
      throw new Error("Derived render ancestry was modified");
    const originalBundle = VizBundleSchema.parse(JSON.parse(readFileSync(sourceBundleFile, "utf8")));
    const original = validateVizRenderReceipt(
      JSON.parse(readFileSync(sourceReceiptFile, "utf8")),
      originalBundle,
      sourceBundleFile,
      depth + 1,
    );
    const originalPlan = originalBundle.plans.find((p) => p.format === receipt.format);
    if (
      !originalPlan ||
      original.sha256 !== receipt.sha256 ||
      original.assetId !== receipt.assetId ||
      vizPixelsIdentity(originalPlan) !== vizPixelsIdentity(plan) ||
      receipt.renderInputs["source-bundle"] !== receipt.origin.sourceBundleSha256 ||
      receipt.renderInputs["source-receipt"] !== receipt.origin.sourceReceiptSha256
    )
      throw new Error("Derived render changes the original visual content");
  }
  return receipt;
}

export function vizReceiptAncestryFiles(raw: unknown, bundleFile: string, depth = 0): string[] {
  if (depth > 16) throw new Error("Visualisation ancestry exceeds 16 generations");
  const receipt = VizAnyReceiptSchema.parse(raw);
  if (receipt.kind !== "derived-viz-binding-v1") return [];
  const prefix = bundleFile.lastIndexOf(`${path.sep}pipeline${path.sep}viz${path.sep}`);
  if (prefix < 0) throw new Error("Missing ancestry scope");
  const projectDirectory = bundleFile.slice(0, prefix);
  const directory = path.join(projectDirectory, "pipeline/viz/ancestry");
  const sourceBundle = localFile(
      projectDirectory,
      path.join(directory, `${receipt.origin.sourceBundleSha256}.json`),
      64 * 1024 * 1024,
    ),
    sourceReceipt = localFile(projectDirectory, path.join(directory, `${receipt.origin.sourceReceiptSha256}.json`));
  return [
    sourceBundle,
    sourceReceipt,
    ...vizReceiptAncestryFiles(JSON.parse(readFileSync(sourceReceipt, "utf8")), sourceBundle, depth + 1),
  ];
}
