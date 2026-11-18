import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { pipelineDir } from "../src/lib/pipeline/paths";
import { DEFAULT_LIBRARY_ROOT } from "../src/lib/reference/library";
import { checkReplicaSpec } from "../src/lib/reference/replica-check";

const SPECS = [
  { name: "project", description: "Project id: reads public/projects/<id>/pipeline/replica-spec.json" },
  { name: "spec", description: "Path to a replica spec, instead of the project's" },
  { name: "library-root", default: DEFAULT_LIBRARY_ROOT, description: "Library directory holding the reference" },
  {
    name: "write-shots",
    type: "boolean",
    description: "Write replica-shots.json beside the spec from its frames, for ref:compare --render-shots",
  },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (!args.project && !args.spec)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --project or --spec" });
  let specPath = args.spec;
  if (!specPath) {
    try {
      specPath = path.join(pipelineDir(args.project!), "replica-spec.json");
    } catch (error) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const result = checkReplicaSpec({
    specPath: path.resolve(specPath),
    libraryRoot: args["library-root"]!,
    writeShots: args["write-shots"],
  });
  return { outputs: result.outputs, metadata: { ...result.metadata, apiCalls: 0 } };
});
