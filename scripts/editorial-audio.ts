import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs, runScript, CliErrorObject, ensureFfmpeg, ensureFfprobe, requireProject } from "../src/lib/cli";
import { analyzeRhythm } from "../src/lib/audio/rhythm";
import { synthesizeSfx, attachSfxCues } from "../src/lib/audio/procedural";
import { forecastToFinish } from "../src/lib/editorial/finish-plan";
import { OperationStore } from "../src/lib/jobs/store";
import { applyEdit } from "../src/lib/timeline-ir/commands";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
runScript(async () => {
  const args = parseArgs([
    {
      name: "action",
      required: true,
      choices: ["rhythm", "sfx", "cues", "forecast"],
      description: "Offline sound/editorial operation",
    },
    { name: "input", description: "Audio or spec/task JSON path" },
    { name: "output", description: "New WAV or JSON evidence path" },
    { name: "overrides", description: "Reviewed beat marks JSON" },
    { name: "project", description: "Required for cues/forecast" },
    {
      name: "dry-run",
      type: "boolean",
      description: "Validate plan without writing",
    },
  ] as const);
  if (!args.input)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--input required",
    });
  const inputJson = () => JSON.parse(readFileSync(args.input!, "utf8"));
  if (args.action === "sfx") {
    const spec = inputJson();
    if (args["dry-run"]) {
      const { ProceduralSfxSchema } = await import("../src/lib/audio/procedural");
      return {
        outputs: [],
        metadata: { dryRun: true, spec: ProceduralSfxSchema.parse(spec) },
      };
    }
    if (!args.output)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--output WAV required",
      });
    ensureFfmpeg();
    ensureFfprobe();
    return {
      outputs: [args.output],
      metadata: synthesizeSfx(args.output, spec),
    };
  }
  let metadata: Record<string, unknown>;
  if (args.action === "rhythm") {
    ensureFfmpeg();
    ensureFfprobe();
    metadata = analyzeRhythm(args.input, args.overrides ? JSON.parse(readFileSync(args.overrides, "utf8")) : undefined);
  } else {
    if (!args.project)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--project required",
      });
    requireProject(args.project);
    metadata =
      args.action === "forecast"
        ? forecastToFinish(new OperationStore(args.project).snapshot(), inputJson())
        : (() => {
            const doc = new TimelineEditStore(
                path.resolve("public/projects", args.project!, "pipeline/timeline-edit.json"),
              ).read(),
              timeline = attachSfxCues(doc.timeline, inputJson());
            const command = {
              type: "batch",
              commands: timeline.tracks
                .slice(doc.timeline.tracks.length)
                .map((track) => ({ type: "add-track", track })),
            };
            applyEdit(doc.timeline, command);
            return {
              revision: doc.revision,
              command,
              timeline,
              apply:
                "Import each sound asset, review command, then timeline:edit --command-file PLAN --revision REVISION; original journal remains untouched.",
            };
          })();
  }
  if (args.output && !args["dry-run"]) {
    if (existsSync(args.output))
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: "Evidence output exists; use a new path",
      });
    mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    writeFileSync(args.output, JSON.stringify(args.action === "cues" ? metadata.command : metadata, null, 2) + "\n");
  }
  return {
    outputs: args.output && !args["dry-run"] ? [args.output] : [],
    metadata,
  };
});
