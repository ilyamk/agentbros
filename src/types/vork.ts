import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1);
const acknowledgedWarning = z.object({ code: text, reason: text }).strict();
export const VorkPinSchema = z.object({ file: text, sha256: hash }).strict();
export const VorkTaskSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    intent: text,
    notice: text,
    workflow: z.enum(["standalone", "blender-export", "geometry-to-blender", "footage-vfx"]),
    scene: text,
    inputs: z.array(text),
    duration: z.number().positive(),
    fps: z.number().positive(),
    seed: z.number().int().nonnegative(),
    camera: text,
    light: text,
    material: text,
    motion: text,
    effect: text,
    profile: z.enum(["std/previs", "std/draft", "std/final", "std/path"]),
    acceptance: z.array(text).min(1),
    renderBackend: z.enum(["vork", "blender-cycles"]).optional(),
    hybridJob: text.optional(),
    acknowledgedWarnings: z.array(acknowledgedWarning).optional(),
  })
  .strict();
export const NativeVorkReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    engine: z.literal("vork"),
    version: z.literal("0.5.1"),
    purpose: z.enum(["draft", "production"]),
    operation: z.enum(["render", "export"]),
    createdAt: z.string().datetime(),
    root: z.literal("."),
    tool: VorkPinSchema,
    runtime: z.array(VorkPinSchema).min(1),
    inputs: z.array(VorkPinSchema).min(1),
    outputs: z.array(VorkPinSchema).min(1),
    settings: z
      .object({
        profile: text,
        seed: z.number().int(),
        fps: z.number().positive(),
        resolution: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        frames: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
        samples: z.number().int().positive().optional(),
      })
      .strict(),
    warnings: z.array(z.object({ code: text, requested: z.unknown(), dropped: z.unknown() }).passthrough()),
    acknowledgedWarnings: z.array(acknowledgedWarning).optional(),
    elapsedMs: z.number().nonnegative(),
    metadata: text,
  })
  .strict();
export const HybridVorkReceiptSchema = NativeVorkReceiptSchema.extend({
  schemaVersion: z.literal(2),
  engine: z.literal("vork-blender"),
  renderBackend: z.literal("blender-cycles"),
  blenderVersion: text,
  geometryReceipt: VorkPinSchema,
  frameMapping: z.object({ sourceFirst: z.literal(0), blenderFirst: z.number().int() }).strict(),
}).strict();
export const VorkReceiptSchema = z.discriminatedUnion("schemaVersion", [
  NativeVorkReceiptSchema,
  HybridVorkReceiptSchema,
]);
export const VorkResultSchema = z
  .object({ receipt: VorkReceiptSchema, receiptHash: hash, sourceOutputHash: hash })
  .strict();
export type VorkTask = z.infer<typeof VorkTaskSchema>;
export type VorkReceipt = z.infer<typeof VorkReceiptSchema>;

const vector3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const colour3 = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);
export const VorkLightingSchema = z
  .object({
    world: z.object({ colour: colour3, strength: z.number().finite().nonnegative() }).strict(),
    areas: z
      .array(
        z
          .object({
            name: text,
            position: vector3,
            target: vector3,
            colour: colour3,
            energy: z.number().finite().positive(),
            size: z.number().finite().positive(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict()
  .refine(
    (value) => new Set(value.areas.map((area) => area.name)).size === value.areas.length,
    "Light names must be unique",
  );
export const defaultVfxLighting = {
  world: { colour: [0.6, 0.7, 0.85] as [number, number, number], strength: 0.3 },
  areas: [
    {
      name: "Plate key",
      position: [2, 3, -2] as [number, number, number],
      target: [0, 0.05, 0] as [number, number, number],
      colour: [1, 0.66, 0.35] as [number, number, number],
      energy: 80,
      size: 2,
    },
    {
      name: "Plate rim",
      position: [-2, 2, 1] as [number, number, number],
      target: [0, 0.05, 0] as [number, number, number],
      colour: [1, 1, 1] as [number, number, number],
      energy: 20,
      size: 2,
    },
  ],
};
export const VorkReceiverSchema = z
  .object({
    size: z
      .union([
        z.number().positive().max(100),
        z.tuple([z.number().positive().max(100), z.number().positive().max(100)]),
      ])
      .default(5),
    position: vector3.default([0, 0, 0]),
    roughness: z.number().min(0).max(1).default(0.3),
    colour: colour3.default([0.4, 0.4, 0.4]),
  })
  .strict();
export const VorkVfxSchema = z
  .object({
    schemaVersion: z.literal(1),
    plate: text,
    fps: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    duration: z.number().positive(),
    camera: text.optional(),
    calibration: z
      .object({
        focalPx: z.number().positive(),
        planeWidthM: z.number().positive(),
        planeHeightM: z.number().positive(),
        corners: z.array(z.tuple([z.number(), z.number()])).length(4),
        initialPose: z
          .object({
            translation: z.tuple([z.number(), z.number(), z.number()]),
            rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    matte: text.optional(),
    depth: text.optional(),
    proxy: text.optional(),
    renderBackend: z.enum(["vork", "blender-cycles"]).default("vork"),
    lighting: VorkLightingSchema.optional(),
    receiver: VorkReceiverSchema.optional(),
    shadowMode: z.enum(["shadow-catcher", "contact", "none"]).default("shadow-catcher"),
    inputs: z.array(text).optional(),
    placement: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).default([0, 0, 0]),
    scale: z.number().positive().max(100).default(0.12),
    seed: z.number().int().nonnegative().default(42),
  })
  .strict()
  .refine((v) => !!v.camera || !!v.calibration, "Supply a camera or explicit planar calibration");
