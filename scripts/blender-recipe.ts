import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { parseResolution } from "../src/lib/backends/blender-run";
import { parseFrameRange } from "../src/lib/vision/composition";
import { findRecipe, listRecipes, proofRecipes, recipeRequest, renderRecipe } from "../src/lib/blender-arsenal/recipes";

const SPECS = [
  { name: "id", description: "Recipe id for describe, render, bake or a single proof" },
  { name: "all", type: "boolean", description: "Proof every recipe" },
  { name: "params", description: "Strict JSON object of recipe parameters" },
  { name: "output", description: "Output directory; proofs preserve existing evidence" },
  { name: "frames", description: "Inclusive range a-b, within 1-64; proof needs at least three frames" },
  { name: "samples", type: "number", default: 16, description: "Render samples" },
  { name: "resolution", default: "640x360", description: "Proof/render dimensions WxH" },
  {
    name: "engine",
    choices: ["cycles", "eevee"],
    default: "cycles",
    description: "Render engine; device selects CPU or GPU",
  },
  {
    name: "device",
    choices: ["auto", "cpu", "gpu"],
    default: "auto",
    description: "Cycles device; auto selects Metal/GPU when available; CPU checks require exact pixels",
  },
  { name: "bare", type: "boolean", description: "Omit the default floor and lighting; keep the proof camera" },
  { name: "extensions", description: "Approved installed extension ids for optional recipe engines" },
  { name: "executable", description: "Optional Blender executable" },
  { name: "timeout", type: "number", default: 3600, description: "Timeout per Blender invocation, seconds" },
  { name: "dry-run", type: "boolean", description: "Validate and return backend request without running Blender" },
] as const;

void runScript(async () => {
  const tokens = process.argv.slice(2);
  if (tokens[0] === "--") tokens.shift();
  const action = tokens[0] && !tokens[0].startsWith("-") ? tokens.shift()! : "list";
  const args = parseArgs(SPECS, tokens);
  if (!["list", "describe", "render", "bake", "proof"].includes(action))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Use list, describe --id, render --id, bake --id or proof --all",
    });
  const recipes = listRecipes();
  if (args.all && action !== "proof")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--all is only valid for proof" });
  if (action === "list") return { metadata: { recipes } };
  if (action !== "proof" && !args.id)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `${action} requires --id` });
  if (action === "proof" && !!args.id === !!args.all)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Proof requires exactly one of --all or --id" });
  const selected = args.id ? [findRecipe(args.id, recipes)] : recipes;
  if (action === "describe") return { metadata: { recipe: selected[0] } };
  if (action === "proof" && (args.params || args.bare))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Proof checks directed defaults; use render for custom params or --bare",
    });
  const output = args.output ?? (action === "proof" ? "out/qa/blender-recipes" : `out/qa/recipes/${args.id}/${action}`);
  const options = {
    output,
    params: args.params ? (JSON.parse(args.params) as unknown) : {},
    frames: args.frames ? parseFrameRange(args.frames) : undefined,
    extensions: args.extensions,
    samples: args.samples,
    resolution: parseResolution(args.resolution!),
    bare: Boolean(args.bare),
    bake: action === "bake",
    engine: args.engine as "cycles" | "eevee",
    device: args.device as "auto" | "cpu" | "gpu",
    executable: args.executable,
    timeoutSec: args.timeout,
  };
  if (action === "bake" && options.frames)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Bake caches the full recipe; --frames is only valid for render/proof",
    });
  if (action === "proof" && options.frames && options.frames[1] - options.frames[0] < 2)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Proof needs at least three consecutive frames" });
  if (args["dry-run"]) return { metadata: { action, requests: selected.map((meta) => recipeRequest(meta, options)) } };
  if (action === "proof") {
    const report = await proofRecipes(selected, options);
    const index = path.resolve(output, "index.json");
    if (!report.pass)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Recipe proofs failed: ${report.recipes
          .filter((r) => r.status === "failed")
          .map((r) => r.id)
          .join(", ")}. Evidence: ${index}`,
        details: { index, sheet: report.sheet },
      });
    return { outputs: [index, ...(report.sheet ? [report.sheet] : [])], metadata: { report } };
  }
  const result = await renderRecipe(selected[0]!, options);
  return {
    outputs: [
      result.manifest,
      ...(result.review ? [result.review.sheet, result.review.preview] : []),
      ...result.frames.map((f) => f.path),
    ],
    metadata: result,
  };
});
