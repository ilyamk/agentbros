import { z } from "zod";

export const LeakPatternSchema = z.union([
  z.object({ name: z.string().min(1), regex: z.string(), flags: z.string().optional() }).strict(),
  z.object({ name: z.string().min(1), sha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)) }).strict(),
]);

export const LocalLeakPatternsSchema = z.object({ leakPatterns: z.array(LeakPatternSchema) }).strict();
export type LeakPattern = z.infer<typeof LeakPatternSchema>;
