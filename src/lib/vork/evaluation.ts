import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { buildImprovementPackets } from "../blender-arsenal/improvements";
import { determinism, recipeQuality } from "../blender-arsenal/recipe-quality";
import { readRecipeFrame } from "../blender-arsenal/recipes";
import { buildRecipe, VORK_RECIPES } from "./recipes";
import { renderVork } from "./render";
import { json, writeNew } from "./runtime";

export async function evaluateVork(
  output: string,
  ids: string[],
  options: { resolution?: [number, number]; samples?: number; executable?: string } = {},
) {
  output = path.resolve(output);
  if (existsSync(output)) throw new Error("Evaluation exists; retain it and choose a new run");
  mkdirSync(output, { recursive: true });
  const resolution = options.resolution ?? [320, 180],
    entries: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    try {
      const built = await buildRecipe(
        id,
        path.join(output, id, "source"),
        { count: 1000, duration: 0.2 },
        options.executable,
      );
      const settings = {
        scene: built.scene,
        task: built.taskFile,
        resolution,
        samples: options.samples ?? 4,
        profile: built.recipe.profile,
        executable: options.executable,
      };
      const range = await renderVork({ ...settings, output: path.join(output, id, "range"), frames: [0, 2] });
      const alone = await renderVork({ ...settings, output: path.join(output, id, "alone"), frames: [1, 1] });
      if (!("receipt" in range) || !("receipt" in alone)) throw new Error("A proof needs actual renders");
      const frame = (directory: string, index: number) =>
        readRecipeFrame(path.join(directory, "frames", `${String(index).padStart(6, "0")}.png`), resolution);
      const frames = [0, 1, 2].map((index) => frame(range.output, index));
      const repeatability = determinism(frames[1]!, frame(alone.output, 1), "METAL");
      const quality = recipeQuality(frames, undefined, {
        requireActivity: !["procedural-vessel", "fog-volume"].includes(id),
        requireCoverage: false,
      });
      entries.push({
        id,
        technicalPass: true,
        repeatability,
        diagnostics: quality,
        warnings: [...range.receipt.warnings, ...alone.receipt.warnings],
        status:
          repeatability.pass && quality.pass && !range.receipt.warnings.length
            ? "technical-pass-visual-review-pending"
            : "experimental",
        sequence: range.output,
        alone: alone.output,
        elapsedMs: range.receipt.elapsedMs + alone.receipt.elapsedMs,
        visualReview: "pending",
      });
    } catch (error) {
      entries.push({ id, technicalPass: false, status: "failed", error: String(error) });
    }
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    resolution,
    samples: options.samples ?? 4,
    mode: "proof",
    qualified: false,
    pass: entries.every((row) => row.status === "technical-pass-visual-review-pending"),
    recipes: entries,
    limitations: [
      "Three frames do not qualify full-clip temporal stability",
      "No cross-device determinism claim",
      "Independent visual and user acceptance remain separate",
    ],
  };
  const file = writeNew(path.join(output, "evaluation.json"), report);
  return { file, report };
}
export function evaluationReport(file: string) {
  return json(file);
}
export const evaluationIds = () => VORK_RECIPES.map((recipe) => recipe.id);
export const comparisonPackets = buildImprovementPackets;
