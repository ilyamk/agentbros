import { z } from "zod";
import { EntityRefSchema } from "../../types/entities";
import { ProjectConfigSchema, type ProjectConfig } from "../../types/video";
import { CliErrorObject } from "../cli";
import { resolveEntityReferences } from "./service";
import { readAssetRegistry } from "../assets/registry";
export const EntityShotBindingSchema = z
  .object({
    sceneId: z.string(),
    entity: EntityRefSchema,
    referenceRole: z.string().min(1),
    target: z.enum(["imageUrl", "leftPanel.imageUrl"]),
  })
  .strict();
export type EntityShotBinding = z.infer<typeof EntityShotBindingSchema>;

/** Materialize pinned references into canonical scene media; source config remains unchanged. */
export function compileEntityBindings(
  projectId: string,
  source: ProjectConfig,
  bindings: EntityShotBinding[],
  rootDir = process.cwd(),
): ProjectConfig {
  const project = ProjectConfigSchema.parse(structuredClone(source)),
    used = new Set<string>();
  const assets = readAssetRegistry(projectId, rootDir).assets;
  for (const input of bindings) {
    const binding = EntityShotBindingSchema.parse(input),
      key = `${binding.sceneId}/${binding.target}`;
    if (used.has(key))
      throw new CliErrorObject({ code: "VALIDATION", message: `Multiple entity bindings target ${key}.` });
    used.add(key);
    const scene = project.scenes.find((s) => s.id === binding.sceneId);
    if (!scene)
      throw new CliErrorObject({ code: "VALIDATION", message: `Entity binding scene missing: ${binding.sceneId}` });
    const resolved = resolveEntityReferences(projectId, binding.entity, rootDir);
    const reference = resolved.references.find((r) => r.role === binding.referenceRole);
    if (!reference)
      throw new CliErrorObject({
        code: "FILE_NOT_FOUND",
        message: `Entity reference role missing: ${binding.referenceRole}`,
      });
    const asset = assets.find((a) => a.id === reference.assetId)!;
    if (binding.target === "leftPanel.imageUrl") {
      if (!scene.leftPanel || !("imageUrl" in scene.leftPanel) || asset.kind !== "image")
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Image panel binding requires an image panel and image asset.",
        });
      scene.leftPanel.imageUrl = reference.original;
    } else {
      const expected = scene.visualType === "video" ? "video" : "image";
      if (asset.kind !== expected || !["video", "photo", "showcase"].includes(scene.visualType))
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Scene binding requires a compatible photo/showcase/video scene.",
        });
      scene.imageUrl = reference.original;
    }
  }
  return ProjectConfigSchema.parse(project);
}
