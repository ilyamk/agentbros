import type { TimelineIR } from "../../types/timeline";
import { VizRenderVariantsSchema, type VizFormat } from "../../types/viz";
/** Resolve a fully declared format without changing the authored journal or its hashes. */
export function selectVizVariants(timeline: TimelineIR, format: VizFormat): TimelineIR {
  const hasVariants = timeline.tracks.some((t) => t.clips.some((c) => c.payload?.vizRenderVariants));
  if (!hasVariants) return timeline;
  const selected = structuredClone(timeline);
  for (const track of selected.tracks)
    for (const clip of track.clips) {
      if (!clip.payload?.vizRenderVariants) continue;
      const variants = VizRenderVariantsSchema.parse(clip.payload.vizRenderVariants);
      const variant = variants[format];
      if (!variant) throw new Error(`Visualisation ${clip.id} has no rendered ${format} variant`);
      clip.assetId = variant.assetId;
      clip.payload.vizBinding = variant.vizBinding;
      delete clip.payload.vizRenderVariants;
    }
  return selected;
}
