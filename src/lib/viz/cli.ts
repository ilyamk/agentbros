import { prepareVizBlenderPlan, vizBlenderRanges, vizPreviewFrames } from "./blender-plan";
import { createVizRenderReceipt } from "./receipt";
import { mountVizFilm } from "./mount-film";
import { mountVizClip } from "./mount";
import { captureVizRenderInputs, assertVizRenderInputs } from "./render-inputs";
import { sub, div, compare, fraction } from "../timeline-ir/rational";
import path from "node:path";
import { readFileSync, mkdirSync, writeFileSync, existsSync, renameSync, rmSync, mkdtempSync } from "node:fs";
import { z } from "zod";
import { parseArgs, runScript, requireProject, CliErrorObject } from "../cli";
import { VIZ_RECIPES, VizRecipeSchema, VizSpecSchema } from "../../types/viz";
import { assertVizDestination, exampleViz, localFile, prepareViz, readViz } from "./store";
import { renderStills, renderClip } from "../vision/composition";
import { runBlender } from "../backends/blender-run";
import { ProjectConfigSchema } from "../../types/video";
import { vizHash } from "./compile";
import { hashFile, readAssetRegistry, importAsset } from "../assets/registry";
import { probeVideo } from "../vision/media";
import { TimelineEditStore } from "../timeline-ir/store";

export function runViz(action: "list" | "prepare" | "inspect" | "preview" | "render" | "mount" | "check"): void {
  runScript(async () => {
    const args = parseArgs([
      { name: "project", description: "Existing project ID" },
      { name: "scene", description: "Scene ID" },
      { name: "request", description: "Strict scene request JSON" },
      { name: "recipe", description: "Recipe ID" },
      { name: "revision", description: "Pinned scene revision hash" },
      { name: "expected-revision", description: "Expected current scene hash" },
      {
        name: "format",
        choices: ["vertical", "square", "landscape"] as const,
        default: "landscape",
        description: "Prepared output format",
      },
      { name: "backend", choices: ["svg", "three", "blender"] as const, description: "Explicit rendering backend" },
      { name: "dry-run", type: "boolean", description: "Validate without writing" },
      { name: "apply", type: "boolean", description: "Apply the proposed mounting transaction" },
      { name: "timeline-revision", type: "number", description: "Expected edit journal revision" },
      { name: "overlay", description: "Explicit overlay ID" },
      { name: "start-frame", type: "number", default: 0, description: "Exact output start frame" },
      { name: "shot", description: "Bespoke visualisation-only film shot" },
      { name: "plan-hash", description: "Expected motion plan SHA256" },
      { name: "build-hash", description: "Expected existing generated build SHA256" },
      { name: "track", description: "Explicit target visual track" },
      { name: "clip", description: "Explicit target clip" },
      { name: "receipt", description: "Completed render receipt for a single-format project" },
      { name: "receipts", description: "JSON manifest with one completed receipt per configured format" },
      { name: "target-scene", description: "Existing template scene slot" },
      { name: "config-hash", description: "Expected project configuration SHA256" },
      { name: "scope-root", description: "Trusted launcher input path boundary" },
    ]);
    try {
      if (args.apply && args["dry-run"]) throw new Error("--apply and --dry-run cannot be combined");
      if (args["dry-run"] && ["preview", "render"].includes(action))
        throw new Error("Use viz:prepare --dry-run for no-write validation");
      if (action === "list") {
        const recipe = args.recipe ? VizRecipeSchema.parse(args.recipe) : undefined;
        return {
          outputs: [],
          metadata: {
            recipes: (recipe ? [recipe] : VIZ_RECIPES).map((id) => ({
              id,
              licenceStatus: /^(process|network)(-3d)?$/.test(id)
                ? "elkjs-0.12.1-epl-2.0-owner-reviewed"
                : "permissive-dependencies",
              backends: id.endsWith("-3d") ? ["three", "blender"] : ["svg"],
              formats: ["vertical", "square", "landscape"],
            })),
            schema: z.toJSONSchema(VizSpecSchema),
            ...(recipe ? { example: exampleViz(recipe) } : {}),
          },
        };
      }
      const project = String(args.project ?? "");
      requireProject(project);
      if (action === "prepare") {
        if (!args.request) throw new Error("--request is required");
        const file = localFile(String(args["scope-root"] ?? process.cwd()), String(args.request));
        const result = await prepareViz(project, JSON.parse(readFileSync(file, "utf8")), {
          dryRun: args["dry-run"] === true,
          expectedRevision: args["expected-revision"] ? String(args["expected-revision"]) : undefined,
          scopeRoot: args["scope-root"] ? String(args["scope-root"]) : undefined,
        });
        return {
          outputs: args["dry-run"] ? [] : [result.path],
          metadata: {
            hash: result.bundle.hash,
            scene: result.bundle.plans[0]!.spec.sceneId,
            dryRun: args["dry-run"] === true,
          },
        };
      }
      if (!args.scene) throw new Error("--scene is required");
      const { bundle, path: file } = readViz(
        project,
        String(args.scene),
        args.revision ? String(args.revision) : undefined,
      );
      if (action === "inspect" || action === "check")
        return {
          outputs: [],
          metadata: {
            hash: bundle.hash,
            plans: bundle.plans.map((p) => ({ format: p.format, primitives: p.primitives.length })),
            status: "unverified",
            factualTruth: "unverified",
            humanApproval: "not-inferred",
          },
        };
      const plan = bundle.plans.find((p) => p.format === args.format);
      if (!plan) throw new Error("Requested format was not prepared");
      if (action === "mount") {
        if (args.shot) {
          if (!args["plan-hash"]) throw new Error("Bespoke shot mounting requires plan-hash");
          return mountVizFilm({
            project,
            bundle,
            shot: String(args.shot),
            planHash: String(args["plan-hash"]),
            buildHash: args["build-hash"] ? String(args["build-hash"]) : undefined,
            format: plan.format,
            apply: args.apply === true,
          });
        }
        const binding = { sceneId: plan.spec.sceneId, revision: bundle.hash };
        if (args["target-scene"]) {
          const configFile = localFile(process.cwd(), path.join("public/projects", project, "project.json"));
          if (args["config-hash"] !== hashFile(configFile)) throw new Error("Configuration hash conflict");
          const config = ProjectConfigSchema.parse(JSON.parse(readFileSync(configFile, "utf8")));
          if (config.formats.some((format) => !bundle.plans.some((p) => p.format === format)))
            throw new Error("Prepare every configured project format before mounting");
          const target = config.scenes.find((s) => s.id === String(args["target-scene"]));
          if (!target) throw new Error("Target scene not found");
          if (target.durationInFrames !== plan.spec.durationFrames)
            throw new Error("Target scene must explicitly match prepared duration");
          target.template = {
            id: "scene.visualisation",
            version: 1,
            props: { plans: bundle.plans, vizBinding: binding, ground: "opaque" },
          };
          const candidate = ProjectConfigSchema.parse(config);
          if (args.apply) {
            assertVizDestination(configFile);
            if (hashFile(configFile) !== args["config-hash"]) throw new Error("Configuration changed");
            const temporary = `${configFile}.${process.pid}.tmp`;
            writeFileSync(temporary, JSON.stringify(candidate, null, 2));
            renameSync(temporary, configFile);
          }
          return {
            outputs: args.apply ? [configFile] : [],
            metadata: { applied: args.apply === true, hash: bundle.hash, scene: target.id },
          };
        }
        if (args.clip) {
          if (!args.track || args["timeline-revision"] === undefined)
            throw new Error("Clip mounting requires track and timeline-revision");
          return mountVizClip({
            project,
            bundle,
            receipt: args.receipt ? String(args.receipt) : undefined,
            receipts: args.receipts ? String(args.receipts) : undefined,
            track: String(args.track),
            clip: String(args.clip),
            format: String(args.format),
            expectedRevision: Number(args["timeline-revision"]),
            apply: args.apply === true,
          });
        }

        if (!args.overlay || args["timeline-revision"] === undefined)
          throw new Error("--overlay and --timeline-revision are required");
        if (plan.spec.recipe.endsWith("-3d")) throw new Error("3D scene requires rendered clip mounting");
        const projectConfig = ProjectConfigSchema.parse(
          JSON.parse(
            readFileSync(localFile(process.cwd(), path.join("public/projects", project, "project.json")), "utf8"),
          ),
        );
        if (projectConfig.formats.some((format) => !bundle.plans.some((p) => p.format === format)))
          throw new Error("Prepare every configured format before mounting an overlay");
        const start = Number(args["start-frame"]);
        if (!Number.isSafeInteger(start) || start < 0) throw new Error("start-frame must be nonnegative integer");
        const store = new TimelineEditStore(path.join("public/projects", project, "pipeline/timeline-edit.json"));
        const doc = store.read();
        const ticks = doc.timeline.timebase.num / doc.timeline.timebase.den / 30;
        const rational = (frames: number) => {
          const num = frames * doc.timeline.timebase.num;
          const den = 30 * doc.timeline.timebase.den;
          if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) throw new Error("Timeline clock overflows");
          return { num, den };
        };
        void ticks;
        const props = {
          plans: bundle.plans,
          ground: "transparent",
          vizBinding: { sceneId: plan.spec.sceneId, revision: bundle.hash },
        };
        const existing = doc.timeline.overlays?.find((o) => o.id === String(args.overlay));
        const command = existing
          ? {
              type: "update-overlay",
              overlayId: String(args.overlay),
              props,
              start: rational(start),
              end: rational(start + plan.spec.durationFrames),
            }
          : {
              type: "add-overlay",
              overlay: {
                id: String(args.overlay),
                block: "viz-scene",
                props,
                start: rational(start),
                end: rational(start + plan.spec.durationFrames),
                layer: "below-captions",
              },
            };
        const result = args.apply
          ? store.apply(command, Number(args["timeline-revision"]))
          : store.dryRun(command, Number(args["timeline-revision"]));
        return {
          outputs: args.apply ? [store.file] : [],
          metadata: { hash: bundle.hash, revision: result.revision, applied: args.apply === true, command },
        };
      }

      const renderInputs = captureVizRenderInputs(process.cwd(), file, plan);
      const backend = String(args.backend ?? (plan.spec.recipe.endsWith("-3d") ? "three" : "svg"));
      const dir = path.join(
        "out",
        project,
        "viz",
        String(args.scene),
        bundle.hash,
        plan.format,
        backend,
        vizHash(renderInputs).slice(0, 16),
      );
      assertVizDestination(dir);
      mkdirSync(dir, { recursive: true });
      const publication = path.join(dir, "completed");
      const output = path.join(publication, "scene.mp4");
      if (action === "render" && existsSync(publication))
        throw new Error("Render already exists; inspect it instead of overwriting");
      if (plan.spec.recipe.endsWith("-3d") ? !["three", "blender"].includes(backend) : backend !== "svg")
        throw new Error("Unsupported recipe/backend combination");
      let plateSrc: string | undefined;
      let plateFrames: Record<string, string> | undefined;
      if (backend === "blender") {
        const prepared = path.join(dir, "blender-plan.json");
        writeFileSync(
          prepared,
          JSON.stringify(prepareVizBlenderPlan(plan, (p) => localFile(process.cwd(), path.join("public", p)))),
        );
        const ranges = vizBlenderRanges(plan.spec.durationFrames, action === "preview");
        plateFrames = {};
        for (const frames of ranges) {
          const rendered = await runBlender({
            script: path.resolve(import.meta.dirname, "../../../scripts/blender/viz_scene.py"),
            output: path.join(dir, action === "preview" ? `blender-still-${frames[0]}` : "blender"),
            frames,
            samples: 32,
            resolution: [plan.width, plan.height],
            engine: "cycles",
            filmTransparent: true,
            format: "png",
            device: "auto",
            factoryStartup: true,
            noRender: false,
            overwrite: false,
            resume: true,
            scriptArgs: [path.resolve(prepared)],
            timeoutSec: 3600,
          });
          Object.assign(
            plateFrames,
            Object.fromEntries(
              rendered.frames.map((frame) => {
                const imported = importAsset({
                  projectId: project,
                  sourceFile: frame.path,
                  provenance: { origin: "manual", tool: "viz-plate", originalFilename: path.basename(frame.path) },
                });
                return [String(frame.frame - 1), imported.asset.files.original];
              }),
            ),
          );
        }
      }
      const props = path.join(dir, "props.json");
      writeFileSync(
        props,
        JSON.stringify({
          plans: [plan],
          ground: "opaque",
          ...(plateSrc ? { plateSrc } : {}),
          ...(plateFrames ? { plateFrames } : {}),
        }),
      );
      const source = {
        entry: path.resolve(import.meta.dirname, "../../motion/viz/index.tsx"),
        composition: "VizScene",
        publicDir: path.resolve("public"),
        gl: "angle",
        propsFile: props,
      };
      if (action === "preview") {
        const frames = vizPreviewFrames(plan.spec.durationFrames);
        const result = await renderStills(source, frames, dir);
        assertVizRenderInputs(renderInputs);
        return { outputs: result.stills.map((s) => s.path), metadata: { hash: bundle.hash, ...result } };
      }

      const staging = mkdtempSync(path.join(dir, "publish-"));
      const temporaryOutput = path.join(staging, "scene.mp4");
      const controller = new AbortController();
      const abort = () => controller.abort(new Error("Visualisation render cancelled"));
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      try {
        const result = await renderClip(source, {
          output: temporaryOutput,
          codec: "h264",
          muted: true,
          signal: controller.signal,
        });
        assertVizRenderInputs(renderInputs);
        readViz(project, String(args.scene), bundle.hash);
        const imported = importAsset({
          projectId: project,
          sourceFile: temporaryOutput,
          provenance: {
            origin: "manual",
            tool: "viz-render",
            model: `viz:${plan.spec.sceneId}:${bundle.hash}`,
            originalFilename: "scene.mp4",
          },
        });
        const receipt = path.join(publication, "receipt.json");
        writeFileSync(
          path.join(staging, "receipt.json"),
          JSON.stringify(
            createVizRenderReceipt(
              {
                revision: bundle.hash,
                source: file,
                renderInputs,
                backend: backend as "svg" | "three" | "blender",
                format: plan.format,
                output: path.resolve(output),
                sha256: hashFile(temporaryOutput),
                assetId: imported.asset.id,
                ...result,
              },
              plan,
            ),
          ),
          { flag: "wx" },
        );
        controller.signal.throwIfAborted();
        assertVizRenderInputs(renderInputs);
        // Renaming a populated directory publishes video and receipt together and refuses a concurrent winner.
        renameSync(staging, publication);
        return { outputs: [output, receipt], metadata: result };
      } finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
        rmSync(staging, { recursive: true, force: true });
      }
    } catch (error) {
      if (error instanceof CliErrorObject) throw error;
      throw new CliErrorObject({ code: "VALIDATION", message: error instanceof Error ? error.message : String(error) });
    }
  });
}
