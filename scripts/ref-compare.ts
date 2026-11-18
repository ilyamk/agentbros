import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, ensureFfprobe, parseArgs, runScript } from "../src/lib/cli";
import { pipelineDir } from "../src/lib/pipeline/paths";
import { compareReference } from "../src/lib/reference/compare";
import { DEFAULT_LIBRARY_ROOT } from "../src/lib/reference/library";
import { ShotsFileSchema } from "../src/lib/vision/sheets";
import { ReplicaSpecSchema } from "../src/types/reference-replica";

const SPECS = [
  { name: "id", required: true, description: "Reference id" },
  { name: "render", required: true, description: "The recreation to compare" },
  { name: "library-root", default: DEFAULT_LIBRARY_ROOT, description: "Library directory" },
  {
    name: "render-shots",
    description: "JSON {shots:[{id?,startSec,endSec}]}: the recreation's real shots, instead of detected cuts",
  },
  { name: "no-camera", type: "boolean", description: "Skip fitting the recreation's camera moves (needs uv)" },
  {
    name: "spec",
    description:
      "Replica spec (with --tolerance replica): shots in its swaps[].shots are exempt from the colour checks. Defaults to the --project's",
  },
  {
    name: "project",
    description: "Project id (with --tolerance replica): reads public/projects/<id>/pipeline/replica-spec.json",
  },
  {
    name: "tolerance",
    default: "style",
    description:
      "style (default: loose findings for a film in the style of the reference) or replica (corrected shots, strict findings, summary.withinTolerance)",
  },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  ensureFfprobe();
  if (args.tolerance !== "style" && args.tolerance !== "replica")
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--tolerance must be style or replica, not ${args.tolerance}`,
    });
  if ((args.spec || args.project) && args.tolerance !== "replica")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--spec and --project need --tolerance replica" });
  let swappedShots: string[] | undefined;
  if (args.spec || args.project) {
    let specPath = args.spec;
    try {
      specPath ??= path.join(pipelineDir(args.project!), "replica-spec.json");
    } catch (error) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!existsSync(specPath))
      throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `No replica spec at ${specPath}` });
    const spec = ReplicaSpecSchema.safeParse(JSON.parse(readFileSync(specPath, "utf8")));
    if (!spec.success)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `${specPath}: ${spec.error.issues[0]?.path.join(".")}: ${spec.error.issues[0]?.message}. Run ref:replica-check.`,
      });
    if (spec.data.reference !== args.id)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `${specPath} replicates ${spec.data.reference}, not ${args.id}`,
      });
    swappedShots = spec.data.swaps.flatMap((swap) => swap.shots ?? []);
  }
  let renderShots;
  if (args["render-shots"]) {
    const parsed = ShotsFileSchema.safeParse(JSON.parse(readFileSync(args["render-shots"], "utf8")));
    if (!parsed.success)
      throw new CliErrorObject({ code: "VALIDATION", message: `--render-shots: ${parsed.error.issues[0]?.message}` });
    renderShots = parsed.data.shots.map((shot, index) => ({
      id: shot.id ?? `s${index + 1}`,
      startSec: shot.startSec,
      endSec: shot.endSec,
    }));
  }
  const { outputs, result } = compareReference({
    libraryRoot: args["library-root"]!,
    id: args.id!,
    render: args.render!,
    renderShots,
    camera: !args["no-camera"],
    tolerance: args.tolerance,
    swappedShots,
  });
  return { outputs, metadata: { ...result, apiCalls: 0 } };
});
