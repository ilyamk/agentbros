import { z } from "zod";
export const RhythmOverridesSchema = z
  .object({
    beatsSec: z.array(z.number().finite().nonnegative()).max(10000),
    note: z.string().min(1),
    reviewedBy: z.string().min(1),
  })
  .strict();
