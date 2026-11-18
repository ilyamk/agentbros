import { z } from "zod";
const node = z
  .object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
    parent: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
      .optional(),
    startFrame: z.number().int().min(0).max(36000),
    durationFrames: z.number().int().min(1).max(36000),
    rate: z.number().min(0.125).max(8).default(1),
    selector: z
      .string()
      .regex(/^#[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
      .optional(),
    audioAsset: z.string().min(1).optional(),
    sourceStartSec: z.number().min(0).max(3600).default(0),
    volume: z.number().min(0).max(1).default(1),
  })
  .strict();
export const HtmlTimingSchema = z.object({ version: z.literal(1), nodes: z.array(node).min(1).max(64) }).strict();
export type HtmlTiming = z.infer<typeof HtmlTimingSchema>;
export function flattenHtmlTiming(timing: HtmlTiming, fps: number) {
  const map = new Map(timing.nodes.map((n) => [n.id, n]));
  if (map.size !== timing.nodes.length) throw new Error("Duplicate timing IDs");
  const selectors = timing.nodes.flatMap((n) => (n.selector ? [n.selector] : []));
  if (new Set(selectors).size !== selectors.length) throw new Error("Duplicate timing selectors");
  function resolve(id: string, stack: string[] = []): { startSec: number; endSec: number; rate: number } {
    const n = map.get(id);
    if (!n || stack.includes(id) || stack.length >= 8) throw new Error("Missing/cyclic/deep timing parent");
    const p = n.parent ? resolve(n.parent, [...stack, id]) : { startSec: 0, endSec: Infinity, rate: 1 };
    const startSec = p.startSec + n.startFrame / fps / p.rate;
    const endSec = startSec + n.durationFrames / fps / p.rate;
    const rate = p.rate * n.rate;
    if (endSec > p.endSec + 1e-9 || rate < 0.125 || rate > 8) throw new Error("Timing outside parent/rate bounds");
    return { startSec, endSec, rate };
  }
  return timing.nodes.map((n) => ({ ...n, ...resolve(n.id) }));
}
