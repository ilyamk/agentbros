import { z } from "zod";
import { ChartQuantitySchema } from "./chart-quantity";

export const VIZ_RECIPES = [
  "line",
  "area",
  "bars",
  "ranked-bars",
  "stacked-bars",
  "donut",
  "scatter",
  "sankey",
  "tree",
  "process",
  "network",
  "bars-3d",
  "network-3d",
  "process-3d",
] as const;
export const VizRecipeSchema = z.enum(VIZ_RECIPES);
export const VizFormatSchema = z.enum(["vertical", "square", "landscape"]);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const VizPortSchema = z.object({ id, side: z.enum(["NORTH", "EAST", "SOUTH", "WEST"]) }).strict();
export const VizGroupSchema = z.object({ id, label: z.string().min(1).max(48), parent: id.optional() }).strict();
export const VizQuantitySchema = z.union([
  ChartQuantitySchema,
  z
    .object({
      kind: z.literal("metric-v1"),
      metricId: id,
      subjectId: id,
      unit: z.string().min(1).max(100),
      methodId: id,
      period: z
        .object({ start: z.string().date(), end: z.string().date() })
        .strict()
        .refine((p) => p.start <= p.end, "Period must increase")
        .optional(),
    })
    .strict(),
]);
export const VizQuantitySourceSchema = z
  .object({
    version: z.literal(1),
    records: z
      .array(z.object({ id, quantity: VizQuantitySchema, value: z.number().finite() }).strict())
      .min(1)
      .max(10000)
      .refine((records) => new Set(records.map((r) => r.id)).size === records.length, "Duplicate source record IDs"),
  })
  .strict();
export const VizDatumSchema = z
  .object({
    id,
    label: z.string().max(500),
    group: id.optional(),
    ports: z.array(VizPortSchema).max(8).optional(),
    colour: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    value: z.number().finite().nullable().optional(),
    x: z.number().finite().optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    series: id.optional(),
    parent: id.optional(),
    quantity: VizQuantitySchema.optional(),
    evidence: z
      .object({
        claimId: z.string(),
        path: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        excerpt: z.string().min(1),
        recordId: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const VizEdgeSchema = z
  .object({
    id,
    source: id,
    target: id,
    sourcePort: id.optional(),
    targetPort: id.optional(),
    value: z.number().finite().nonnegative().optional(),
  })
  .strict();
export const VizEventSchema = z
  .object({
    action: z.enum(["reveal", "draw", "highlight", "dim", "annotate", "travel", "hold"]),
    target: id.optional(),
    frame: z.number().int().nonnegative(),
    duration: z.number().int().positive(),
    text: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.action === "annotate" && (!event.text || !event.target))
      context.addIssue({ code: "custom", message: "Annotation requires target and text" });
    if (event.action === "travel" && !event.target)
      context.addIssue({ code: "custom", message: "Travel requires a path target" });
  });
export const VizTextureMapSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    colourSpace: z.enum(["srgb", "linear"]),
    repeat: z.tuple([z.number().positive().max(100), z.number().positive().max(100)]).default([1, 1]),
  })
  .strict();
export const VizTextureManifestSchema = z
  .object({
    version: z.literal(1),
    licence: z.string().min(1),
    maps: z
      .object({
        baseColor: VizTextureMapSchema.optional(),
        roughness: VizTextureMapSchema.optional(),
        metallic: VizTextureMapSchema.optional(),
        normal: VizTextureMapSchema.optional(),
        ao: VizTextureMapSchema.optional(),
      })
      .strict(),
  })
  .strict();
export const VizSpecSchema = z
  .object({
    version: z.literal(1),
    sceneId: id,
    recipe: VizRecipeSchema,
    title: z.string().max(500).default(""),
    groups: z.array(VizGroupSchema).max(20).optional(),
    data: z.array(VizDatumSchema).max(10000).default([]),
    edges: z.array(VizEdgeSchema).max(300).default([]),
    source: z
      .object({
        path: z.string().min(1),
        format: z.enum(["csv", "tsv", "json"]),
        columns: z
          .object({
            id: z.string(),
            label: z.string(),
            value: z.string().optional(),
            x: z.string().optional(),
            date: z.string().optional(),
            series: z.string().optional(),
            parent: z.string().optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
    formats: z.array(VizFormatSchema).min(1).max(3).default(["landscape"]),
    durationFrames: z.number().int().min(31).max(1800).default(150),
    fps: z.literal(30).default(30),
    seed: z.string().default("viz"),
    locale: z.string().default("en-GB"),
    unit: z.string().max(100).default(""),
    xScale: z.enum(["linear", "utc"]).default("linear"),
    dateFormat: z.literal("yyyy-mm-dd").default("yyyy-mm-dd"),
    scale: z.enum(["linear", "log"]).default("linear"),
    theme: z
      .object({
        background: z
          .string()
          .regex(/^(transparent|#[a-fA-F0-9]{6})$/)
          .default("#10121a"),
        ink: z
          .string()
          .regex(/^#[a-fA-F0-9]{6}$/)
          .default("#ffffff"),
        accent: z
          .string()
          .regex(/^#[a-fA-F0-9]{6}$/)
          .default("#71e8c3"),
        seriesColours: z
          .array(z.string().regex(/^#[a-fA-F0-9]{6}$/))
          .min(1)
          .max(12)
          .optional(),
      })
      .strict()
      .default({ background: "#10121a", ink: "#ffffff", accent: "#71e8c3" }),
    events: z.array(VizEventSchema).max(200).default([]),
    layout: z.enum(["layered", "force"]).default("layered"),
    textures: VizTextureManifestSchema.optional(),
    textureManifest: z
      .object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
    material: z.enum(["plastic", "metal", "glass", "paper"]).default("plastic"),
    camera: z
      .object({
        projection: z.literal("orthographic").default("orthographic"),
        move: z.enum(["static", "push", "truck"]).default("static"),
        startFrame: z.number().int().nonnegative().default(0),
        endFrame: z.number().int().positive().optional(),
        amount: z.number().min(0).max(0.2).default(0.08),
        azimuth: z.number().min(-45).max(45).default(20),
        elevation: z.number().min(0).max(35).default(15),
      })
      .strict()
      .default({ projection: "orthographic", move: "static", startFrame: 0, amount: 0.08, azimuth: 20, elevation: 15 }),
    light: z.enum(["soft-product", "low-key", "high-key"]).default("soft-product"),
  })
  .strict();
export type VizSpec = z.infer<typeof VizSpecSchema>;
export type VizDatum = z.infer<typeof VizDatumSchema>;
export type VizFormat = z.infer<typeof VizFormatSchema>;
export const VizPrimitiveSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["rect", "circle", "path", "text"]),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().optional(),
    height: z.number().finite().optional(),
    radius: z.number().finite().optional(),
    d: z.string().optional(),
    text: z.string().optional(),
    fill: z.string(),
    datumId: z.string().optional(),
    strokeWidth: z.number().nonnegative().optional(),
  })
  .strict();
export const VizPlanSchema = z
  .object({
    version: z.literal(1),
    format: VizFormatSchema,
    width: z.number().positive(),
    height: z.number().positive(),
    primitives: z
      .array(VizPrimitiveSchema)
      .refine(
        (primitives) => new Set(primitives.map((primitive) => primitive.id)).size === primitives.length,
        "Visualisation primitive IDs must be unique; rename conflicting IDs",
      ),
    dataHash: z.string(),
    spec: VizSpecSchema,
  })
  .strict();
export type VizPlan = z.infer<typeof VizPlanSchema>;
export const VizBundleSchema = z
  .object({
    version: z.literal(1),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    plans: z.array(VizPlanSchema).min(1),
    sourceHashes: z.record(z.string(), z.string()),
    sourceCopies: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type VizBundle = z.infer<typeof VizBundleSchema>;

export const VizBindingSchema = z
  .object({
    sceneId: id,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    renderReceipt: z
      .object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
  })
  .strict();

export type VizBinding = z.infer<typeof VizBindingSchema>;

export const VizRenderVariantsSchema = z.partialRecord(
  VizFormatSchema,
  z.object({ assetId: z.string().min(1), vizBinding: VizBindingSchema }).strict(),
);
export type VizRenderVariants = z.infer<typeof VizRenderVariantsSchema>;

export const VizFilmPropsSchema = z
  .object({
    format: VizFormatSchema,
    shots: z
      .array(
        z
          .object({
            id: z.string(),
            startFrame: z.number().int().nonnegative(),
            durationInFrames: z.number().int().positive(),
            plans: z.array(VizPlanSchema).min(1),
            vizBinding: VizBindingSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type VizFilmProps = z.infer<typeof VizFilmPropsSchema>;

export const VizDerivedManifestSchema = z
  .object({
    version: z.literal(1),
    projectId: id,
    files: z
      .array(
        z
          .object({
            relative: z
              .string()
              .min(1)
              .refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes("..")),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict();
