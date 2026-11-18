import { z } from "zod";
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(value + "T00:00:00Z");
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
  }, "Canonical calendar date required");
const period = z
  .object({ start: date, end: date })
  .strict()
  .refine((p) => p.start <= p.end, "Period start must precede end");
const common = { unit: z.literal("%"), subjectId: id, basisId: id, methodId: id, period };
/** Authored measurement identity, never inferred from prose or a percent sign. */
export const ChartQuantitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("return-percent-v1"), ...common }).strict(),
  z
    .object({ kind: z.literal("population-outperformed-percent-v1"), ...common, cohortId: id, comparatorId: id })
    .strict(),
]);
export type ChartQuantity = z.infer<typeof ChartQuantitySchema>;
export const ChartPointValueBindingSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("point-value-label-v1"),
    expectedQuantity: ChartQuantitySchema,
    formatter: z.enum(["percent-v1", "signed-percent-v1"]),
  })
  .strict();
const citation = z
  .object({ path: z.string().min(1).max(1024), sha256: hash, excerpt: z.string().min(1).max(65536) })
  .strict();
/** Lives in the already snapshot-captured evidence tree; refers to existing workflow claims. */
export const ChartQuantityBindingsSchema = z
  .object({
    version: z.literal(1),
    projectId: id,
    bindings: z
      .array(
        z
          .object({
            sceneId: id,
            chartHash: hash,
            seriesIndex: z.number().int().nonnegative(),
            dataIndex: z.number().int().nonnegative(),
            claimId: z.string().min(1).max(256),
            quantity: ChartQuantitySchema,
            value: z.number().finite(),
            source: citation.extend({ recordId: id }).strict(),
          })
          .strict(),
      )
      .min(1)
      .max(4096),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    const seen = new Set<string>();
    artifact.bindings.forEach((b, index) => {
      const key = JSON.stringify([b.sceneId, b.seriesIndex, b.dataIndex, b.claimId]);
      if (seen.has(key))
        ctx.addIssue({ code: "custom", path: ["bindings", index], message: "Duplicate chart/claim target binding" });
      seen.add(key);
    });
  });
/** Synthetic or supplied normalized local records; byte identity is not a truth verdict. */
export const ChartQuantitySourceSchema = z
  .object({
    version: z.literal(1),
    records: z
      .array(z.object({ id, quantity: ChartQuantitySchema, value: z.number().finite() }).strict())
      .min(1)
      .max(4096),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (new Set(source.records.map((r) => r.id)).size !== source.records.length)
      ctx.addIssue({ code: "custom", path: ["records"], message: "Duplicate normalized source record ID" });
  });
