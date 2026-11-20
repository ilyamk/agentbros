import { z } from "zod";

export const unitTrayContentSchema = z.object({
  headline: z.string().trim().min(1).max(72),
  unitLabel: z.string().trim().min(1).max(48),
  from: z.number().int().min(0).max(64),
  to: z.number().int().min(0).max(64),
  firstFrame: z.number().int().min(0),
  stepFrames: z.number().int().min(2),
  shape: z.enum(["disc", "tile"]),
});

export const unitTraySchema = unitTrayContentSchema.extend({
  ground: z.string(),
  text: z.string(),
  accent: z.string(),
});

export type UnitTrayProps = z.infer<typeof unitTraySchema>;

export const unitTrayDefaults = {
  headline: "Items restored",
  unitLabel: "One tile per repaired item",
  from: 6,
  to: 12,
  firstFrame: 22,
  stepFrames: 8,
  shape: "tile",
  ground: "#F2ECE2",
  text: "#241D18",
  accent: "#96482F",
} satisfies UnitTrayProps;

export function unitTrayCount(
  frame: number,
  { from, to, firstFrame, stepFrames }: z.infer<typeof unitTrayContentSchema>,
) {
  const steps = frame < firstFrame ? 0 : 1 + Math.floor((frame - firstFrame) / stepFrames);
  return from + Math.sign(to - from) * Math.min(Math.abs(to - from), steps);
}

export function unitTrayEndFrame({ from, to, firstFrame, stepFrames }: z.infer<typeof unitTrayContentSchema>) {
  return from === to ? 0 : firstFrame + (Math.abs(to - from) - 1) * stepFrames + (to > from ? stepFrames - 1 : 0);
}

export function unitTrayCues({ from, to, firstFrame, stepFrames }: z.infer<typeof unitTrayContentSchema>) {
  const count = Math.abs(to - from);
  return Array.from({ length: count }, (_, index) => ({
    frame: firstFrame + index * stepFrames,
    kind: "reveal" as const,
    sfx: "none" as const,
    weight: index === count - 1 ? ("hero" as const) : ("support" as const),
    label: `count ${from + Math.sign(to - from) * (index + 1)}`,
  }));
}
