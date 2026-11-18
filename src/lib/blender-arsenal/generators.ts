import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPathWithin } from "../cli";

const text = z.string().min(1);
export const GeneratorManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    generators: z.array(
      z
        .object({
          id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          kind: z.enum(["generator", "builtin", "manual"]),
          purpose: text,
          install: z
            .object({
              method: z.enum(["builtin", "external", "manual"]),
              source: text,
              version: text,
              commit: z
                .string()
                .regex(/^[a-f0-9]{40}$/)
                .nullable(),
              sha256: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .optional(),
              build: z
                .string()
                .regex(/^[a-f0-9]{12,40}$/)
                .optional(),
            })
            .strict(),
          licence: text,
          capabilities: z.array(text).min(1),
          headless: z.enum(["yes", "partial", "no"]),
          determinism: text,
          typicalCost: z
            .object({
              currency: z.literal("USD"),
              licence: z.literal(0),
              secondsPerFrame: z.number().nonnegative().nullable(),
            })
            .strict(),
          status: z.enum(["proposed", "approved", "rejected"]),
          verdict: z.enum(["adopt", "experimental", "deferred", "reject"]),
          reason: text,
          consent: z.object({ by: text, date: z.string().date(), note: text }).strict(),
          evaluation: z.string().regex(/^docs\/blender-arsenal\/[a-z0-9_-]+\.md$/),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (new Set(manifest.generators.map((g) => g.id)).size !== manifest.generators.length)
      ctx.addIssue({ code: "custom", message: "Duplicate generator ids" });
    for (const generator of manifest.generators)
      if (generator.install.method === "external" && !generator.install.commit)
        ctx.addIssue({ code: "custom", message: "External generators require an exact commit" });
  });

/** Optional for older checkouts and fixtures; presence is always validated, never executed. */
export function readGenerators(root = process.cwd()) {
  const file = path.join(root, "blender-arsenal/generators.json");
  if (!existsSync(file)) return [];
  assertPathWithin(root, file);
  return GeneratorManifestSchema.parse(JSON.parse(readFileSync(file, "utf8"))).generators;
}
