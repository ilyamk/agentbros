import { createHash } from "node:crypto";
import { validateVizRenderReceipt } from "./receipt";
import path from "node:path";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { ProjectConfigSchema } from "../../types/video";
import { VizFormatSchema, type VizBundle, type VizRenderVariants, type VizBinding } from "../../types/viz";
import { hashFile, readAssetRegistry } from "../assets/registry";
import { probeVideo } from "../vision/media";
import { TimelineEditStore } from "../timeline-ir/store";
import { compare, div, sub, fraction } from "../timeline-ir/rational";
import { localFile, assertVizDestination } from "./store";
const ReceiptSetSchema = z
  .object({
    version: z.literal(1),
    receipts: z
      .array(z.object({ format: VizFormatSchema, receipt: z.string() }).strict())
      .min(1)
      .max(3),
  })
  .strict();
export function mountVizClip(options: {
  project: string;
  bundle: VizBundle;
  receipt?: string;
  receipts?: string;
  track: string;
  clip: string;
  format: string;
  expectedRevision: number;
  apply: boolean;
}) {
  const root = process.cwd();
  const config = ProjectConfigSchema.parse(
    JSON.parse(readFileSync(localFile(root, path.join("public/projects", options.project, "project.json")), "utf8")),
  );
  if (!config.formats.includes(options.format as (typeof config.formats)[number]))
    throw new Error("Primary mount format must be a configured project format");
  if (Boolean(options.receipt) === Boolean(options.receipts))
    throw new Error("Choose receipt or a complete receipts manifest");
  const supplied = options.receipts
    ? ReceiptSetSchema.parse(JSON.parse(readFileSync(localFile(root, options.receipts), "utf8"))).receipts
    : [{ format: options.format, receipt: options.receipt! }];
  if (
    new Set(supplied.map((r) => r.format)).size !== supplied.length ||
    supplied.length !== config.formats.length ||
    config.formats.some((f) => !supplied.some((r) => r.format === f))
  )
    throw new Error("Provide exactly one complete render receipt for every configured format");
  const registry = readAssetRegistry(options.project);
  const variants: VizRenderVariants = {};
  const archives: Array<{ file: string; bytes: Buffer }> = [];
  for (const suppliedReceipt of supplied) {
    const file = localFile(root, suppliedReceipt.receipt);
    const bytes = readFileSync(file);
    const receipt = validateVizRenderReceipt(
      JSON.parse(bytes.toString("utf8")),
      options.bundle,
      path.resolve(
        "public/projects",
        options.project,
        "pipeline/viz",
        options.bundle.plans[0]!.spec.sceneId,
        "revisions",
        options.bundle.hash,
        "bundle.json",
      ),
    );
    const plan = options.bundle.plans.find((p) => p.format === receipt.format);
    if (
      !plan ||
      receipt.format !== suppliedReceipt.format ||
      receipt.revision !== options.bundle.hash ||
      receipt.frameCount !== plan.spec.durationFrames ||
      receipt.lastFrame !== plan.spec.durationFrames - 1
    )
      throw new Error("Receipt is not the complete prepared format");
    const output = localFile(root, receipt.output);
    if (hashFile(output) !== receipt.sha256) throw new Error("Rendered video was modified");
    const physical = probeVideo(output);
    if (
      physical.width !== plan.width ||
      physical.height !== plan.height ||
      physical.fps !== 30 ||
      physical.frameCount !== plan.spec.durationFrames
    )
      throw new Error("Physical render differs from its format plan");
    const asset = registry.assets.find((a) => a.id === receipt.assetId);
    if (!asset || asset.hash !== receipt.sha256)
      throw new Error("Receipt does not identify the registered video bytes");
    const receiptHash = createHash("sha256").update(bytes).digest("hex");
    const archived = path.join(
      "public/projects",
      options.project,
      "pipeline/viz",
      plan.spec.sceneId,
      "revisions",
      options.bundle.hash,
      "renders",
      `${receiptHash}.json`,
    );
    assertVizDestination(archived);
    const binding: VizBinding = {
      sceneId: plan.spec.sceneId,
      revision: options.bundle.hash,
      renderReceipt: { path: archived.slice("public/".length), sha256: receiptHash },
    };
    variants[receipt.format] = { assetId: asset.id, vizBinding: binding };
    archives.push({ file: archived, bytes });
  }
  const store = new TimelineEditStore(path.join("public/projects", options.project, "pipeline/timeline-edit.json"));
  const doc = store.read();
  const track = doc.timeline.tracks.find((t) => t.id === options.track && t.kind === "visual");
  const clip = track?.clips.find((c) => c.id === options.clip);
  if (!clip) throw new Error("Target visual clip not found");
  if (clip.captions.length || clip.rate.num !== clip.rate.den)
    throw new Error("Replacement requires an independent supporting clip without captions at unit rate");
  const frames = options.bundle.plans[0]!.spec.durationFrames;
  if (compare(div(sub(clip.source.end, clip.source.start), clip.source.timebase), fraction(frames, 30)) !== 0)
    throw new Error("Clip duration differs; no implicit stretch or ripple");
  const primary = variants[options.format as keyof VizRenderVariants]!;
  const command = {
    type: "replace",
    trackId: options.track,
    clipId: options.clip,
    assetId: primary.assetId,
    vizBinding: primary.vizBinding,
    vizRenderVariants: variants,
    source: { start: fraction(0), end: fraction(frames), timebase: fraction(30) },
  };
  store.dryRun(command, options.expectedRevision);
  if (options.apply) {
    for (const archive of archives) {
      mkdirSync(path.dirname(archive.file), { recursive: true });
      if (existsSync(archive.file)) {
        if (!readFileSync(archive.file).equals(archive.bytes)) throw new Error("Archived receipt is corrupt");
      } else writeFileSync(archive.file, archive.bytes, { flag: "wx" });
    }
  }
  const result = options.apply
    ? store.apply(command, options.expectedRevision)
    : store.dryRun(command, options.expectedRevision);
  return {
    outputs: options.apply ? [store.file, ...archives.map((a) => a.file)] : [],
    metadata: { applied: options.apply, revision: result.revision, formats: Object.keys(variants), command },
  };
}
