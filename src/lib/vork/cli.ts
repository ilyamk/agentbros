import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { CliErrorObject, parseArgs, runScript, requireProject } from "../cli";
import { importAsset } from "../assets/registry";
import { VorkTaskSchema } from "../../types/vork";
import { planHybridVfx } from "./hybrid";
import { buildRecipe, recipeById, recipeParams, VORK_RECIPES } from "./recipes";
import { checkScene, exportVork, readTask, renderVork, type RenderOptions } from "./render";
import { digest, hashFile, json, requireVork, runProcess, writeNew } from "./runtime";

export const VORK_FLAGS = [
  {
    name: "action",
    description: "scene: init|brief|check|export; recipe: list|describe|build|render|proof; render: render",
  },
  { name: "scene", description: "Local Vork scene JSON" },
  { name: "task", description: "Versioned shot task JSON" },
  { name: "output", description: "Fresh output directory; scene export: .glb file" },
  { name: "id", default: "product-stage", description: "Recipe identifier" },
  { name: "params", description: "Strict JSON recipe parameters" },
  {
    name: "profile",
    choices: ["std/previs", "std/draft", "std/final", "std/path"],
    description: "Explicit render profile; default task or std/final",
  },
  { name: "resolution", description: "WIDTHxHEIGHT; default scene resolution" },
  { name: "samples", type: "number", description: "Sample budget 1..4096" },
  { name: "seed", type: "number", description: "Explicit random seed" },
  { name: "fps", type: "number", description: "Output FPS; default scene FPS" },
  { name: "frames", description: "Inclusive zero-based FIRST-LAST" },
  { name: "format", choices: ["png", "exr"], default: "png", description: "Image sequence encoding" },
  { name: "channels", description: "Comma-separated native output channels" },
  { name: "node", description: "Explicit geometry subtree for GLB export, e.g. hero" },
  { name: "allow-loss", description: "Comma-separated intentionally acknowledged native export loss codes" },
  { name: "encode", choices: ["h264", "prores4444"], description: "Encode PNG sequence; ProRes preserves alpha" },
  {
    name: "purpose",
    choices: ["draft", "production"],
    default: "draft",
    description: "Drafts remain preview-only at delivery",
  },
  { name: "timeout-sec", type: "number", default: 3600, description: "Total child deadline, maximum 7200 seconds" },
  { name: "executable", description: "Complete pinned external runtime executable" },
  { name: "project", description: "Existing project for verified output import" },
  { name: "import", type: "boolean", description: "Register encoded output or single image in the project" },
  { name: "dry-run", type: "boolean", description: "Validate and plan without rendering or writing" },
] as const;
function parsePair(value: string | undefined, separator: RegExp): [number, number] | undefined {
  if (!value) return undefined;
  const values = value.split(separator).map(Number);
  if (values.length !== 2 || values.some((n) => !Number.isFinite(n)))
    throw new Error(`Expected a numeric pair, got ${value}`);
  return values as [number, number];
}
export function shotPrompt(file: string) {
  const { task } = readTask(file);
  return [
    `Build Vork shot ${task.id}: ${task.intent}`,
    `The viewer must notice: ${task.notice}`,
    `Renderer: ${task.renderBackend ?? "vork"}${task.hybridJob ? `; use vork:vfx --action render --request ${task.hybridJob}` : ""}.`,
    `Workflow: ${task.workflow}. Timing: ${task.duration}s, ${task.fps} fps, seed ${task.seed}.`,
    `Camera: ${task.camera}\nLight: ${task.light}\nMaterial: ${task.material}\nMotion: ${task.motion}\nEffect: ${task.effect}`,
    `Scene: ${task.scene}; pinned inputs: ${task.inputs.join(", ") || "procedural author-owned geometry"}.`,
    task.renderBackend === "blender-cycles"
      ? "Validate the hybrid job, then inspect a Cycles preview and a contiguous motion strip before a full render with explicit samples."
      : `Use the pinned runtime, read only relevant help topics, check the scene, inspect previews and a contiguous motion strip before final ${task.profile}.`,
    `Acceptance: ${task.acceptance.join("; ")}. Preserve receipts and every warning. Do not imply any unsupported effect or human approval.`,
  ].join("\n\n");
}
export function runVorkCli(kind: "scene" | "render" | "recipe") {
  void runScript(async () => {
    const args = parseArgs(VORK_FLAGS),
      action = args.action ?? (kind === "recipe" ? "list" : kind === "scene" ? "check" : "render");
    if (kind === "recipe" || action === "init") recipeParams.parse(args.params ? JSON.parse(args.params) : {});
    if (args.import) {
      if (!args.project) throw new Error("--import requires --project");
      requireProject(args.project);
      if (args.encode === "prores4444") throw new Error("ProRes is a finishing hand-off; import H.264 or a single PNG");
      if (action !== "export" && !args.encode && !args.frames?.match(/^(\d+)-\1$/))
        throw new Error("Import needs an encoded video or explicit single-frame range");
    }
    const need = (value: string | undefined, flag: string) => {
      if (!value) throw new CliErrorObject({ code: "INVALID_INPUT", message: `${flag} is required` });
      return value;
    };
    if (kind === "recipe" && action === "list")
      return {
        outputs: [],
        metadata: { recipes: VORK_RECIPES.map((r) => ({ ...r, status: "experimental-until-proof" })) },
      };
    if (kind === "recipe" && action === "describe")
      return {
        outputs: [],
        metadata: {
          recipe: recipeById(args.id!),
          params: {
            seed: 42,
            duration: 3,
            fps: 30,
            count: 10000,
            simulationQuality: "preview",
            colour: [0.08, 0.32, 0.38],
          },
        },
      };
    if (kind === "scene" && action === "brief")
      return { outputs: [], metadata: { prompt: shotPrompt(need(args.task, "--task")) } };
    if ((kind === "scene" && action === "init") || (kind === "recipe" && action === "build")) {
      if (args["dry-run"])
        return { outputs: [], metadata: { recipe: recipeById(args.id!), output: need(args.output, "--output") } };
      const result = await buildRecipe(
        args.id!,
        need(args.output, "--output"),
        args.params ? JSON.parse(args.params) : {},
        args.executable,
      );
      return { outputs: [result.scene, result.taskFile], metadata: result };
    }
    const task = args.task ? readTask(args.task) : undefined;
    const scene = args.scene ?? task?.scene;
    if (kind === "scene" && action === "check") {
      if (task?.task.renderBackend === "blender-cycles") {
        const jobFile = path.resolve(path.dirname(args.task!), need(task.task.hybridJob, "task.hybridJob"));
        const planned = planHybridVfx(jobFile);
        return {
          outputs: [],
          metadata: {
            state: "job-validated-render-pending",
            renderBackend: "blender-cycles",
            jobFile,
            inputCount: planned.pins.length,
            note: "Static job, camera, source clock and inputs validated; inspect an actual Cycles preview before qualification",
          },
        };
      }
      if (args["dry-run"])
        return {
          outputs: [],
          metadata: {
            state: "planned",
            argv: [
              "check",
              need(scene, "--scene or --task"),
              "--profile",
              args.profile ?? task?.task.profile ?? "std/final",
            ],
          },
        };
      const result = await checkScene(
        need(scene, "--scene or --task"),
        args.executable,
        args.profile ?? task?.task.profile,
      );
      return { outputs: [], metadata: { state: "checked", ...result } };
    }
    if (kind === "scene" && action === "export") {
      const result = await exportVork(need(scene, "--scene"), need(args.output, "--output"), {
        executable: args.executable,
        node: args.node,
        allowLosses: args["allow-loss"]?.split(","),
        dryRun: args["dry-run"],
        purpose: args.purpose as "draft" | "production",
      });
      let imported;
      if (args.import && result.receipt)
        imported = importAsset({
          projectId: args.project!,
          sourceFile: result.output,
          nonMedia: true,
          provenance: { origin: "manual", tool: "vork:geometry" },
          vorkResult: {
            receipt: result.receipt,
            receiptHash: digest(JSON.stringify(result.receipt)),
            sourceOutputHash: hashFile(result.output),
          },
        });
      return {
        outputs: args["dry-run"]
          ? []
          : [result.output, result.report, ...(result.receiptFile ? [result.receiptFile] : [])],
        metadata: { output: result.output, report: result.report, receiptFile: result.receiptFile, imported },
      };
    }
    if (action !== "render" && action !== "proof")
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown ${kind} action: ${action}` });
    const output = path.resolve(need(args.output, "--output"));
    if (kind === "recipe" && action === "proof") {
      if (args["dry-run"])
        return { outputs: [], metadata: { recipe: recipeById(args.id!), output, action: "proof", state: "planned" } };
      const { evaluateVork } = await import("./evaluation");
      const proof = await evaluateVork(output, [args.id!], {
        resolution: parsePair(args.resolution, /x/i),
        samples: args.samples,
        executable: args.executable,
      });
      return { outputs: [proof.file], metadata: proof.report };
    }
    let source = scene,
      taskFile = args.task;
    if (kind === "recipe") {
      if (args["dry-run"]) return { outputs: [], metadata: { recipe: recipeById(args.id!), output } };
      const built = await buildRecipe(
        args.id!,
        path.join(output, "source"),
        args.params ? JSON.parse(args.params) : {},
        args.executable,
      );
      source = built.scene;
      taskFile = built.taskFile;
    }
    const options: RenderOptions = {
      scene: need(source, "--scene"),
      output: kind === "recipe" ? path.join(output, "render") : output,
      task: taskFile,
      profile: args.profile ?? (taskFile ? VorkTaskSchema.parse(json(taskFile)).profile : undefined),
      resolution: parsePair(args.resolution, /x/i),
      samples: args.samples,
      seed: args.seed ?? (taskFile ? VorkTaskSchema.parse(json(taskFile)).seed : undefined),
      fps: args.fps,
      frames: parsePair(args.frames, /-/),
      format: args.format as "png" | "exr",
      channels: args.channels?.split(","),
      encode: args.encode as RenderOptions["encode"],
      purpose: args.purpose as RenderOptions["purpose"],
      timeoutSec: args["timeout-sec"],
      executable: args.executable,
      dryRun: args["dry-run"],
    };
    const result = await renderVork(options);
    if (!("receipt" in result)) return { outputs: [], metadata: result };
    let imported;
    if (args.import) {
      const projectId = need(args.project, "--project");
      if (args.encode === "prores4444")
        throw new Error(
          "ProRes is a finishing hand-off; import an opaque H.264 or single RGBA PNG, or retain the sequence for the plate",
        );
      const sourceFile =
        result.video ??
        (result.settings.frames[0] === result.settings.frames[1]
          ? path.join(result.output, "frames", `${String(result.settings.frames[0]).padStart(6, "0")}.png`)
          : undefined);
      if (!sourceFile) throw new Error("Import needs an encoded video or a single PNG frame");
      imported = importAsset({
        projectId,
        sourceFile,
        provenance: {
          origin: "manual",
          tool: "vork:0.5.1",
          prompt: taskFile ? shotPrompt(taskFile) : "Authored Vork scene",
        },
        vorkResult: {
          receipt: result.receipt,
          receiptHash: digest(JSON.stringify(result.receipt)),
          sourceOutputHash: hashFile(sourceFile),
        },
      });
    }
    return {
      outputs: [
        result.receiptFile,
        result.video ?? path.join(result.output, "frames"),
        ...(imported ? [`public/${imported.asset.files.original}`] : []),
      ],
      metadata: {
        state: result.state,
        output: result.output,
        video: result.video,
        settings: result.settings,
        receiptFile: result.receiptFile,
        warnings: result.receipt.warnings,
        elapsedMs: result.receipt.elapsedMs,
        imported,
      },
    };
  });
}
