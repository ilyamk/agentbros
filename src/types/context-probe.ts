import { z } from "zod";

export const ContextProbeHarnessSchema = z.enum(["claude-code", "codex"]);
export type ContextProbeHarness = z.infer<typeof ContextProbeHarnessSchema>;
export const CONTEXT_PROBE_LAYERS = ["root", "nested", "agent", "skillBody", "skillDescription"] as const;
const RunSchema = z
  .object({
    status: z.enum(["observed", "inconclusive", "failed", "n/a"]),
    known: z.array(z.enum(CONTEXT_PROBE_LAYERS)),
    tokens: z.array(z.string()),
    reason: z.string().optional(),
  })
  .strict();
export const ContextProbeRecordSchema = z
  .object({
    version: z.literal(1),
    date: z.iso.datetime(),
    harness: ContextProbeHarnessSchema,
    harnessVersion: z.string(),
    commit: z.string(),
    seed: z.string(),
    canaries: z
      .object({
        root: z.string(),
        nested: z.string(),
        agent: z.string(),
        skillBody: z.string(),
        skillDescription: z.string(),
      })
      .strict(),
    parent: RunSchema,
    subagent: RunSchema,
  })
  .strict();
export type ContextProbeRecord = z.infer<typeof ContextProbeRecordSchema>;
export type ContextProbeRun = ContextProbeRecord["parent"];
