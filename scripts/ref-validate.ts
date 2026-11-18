import { parseArgs, runScript } from "../src/lib/cli";
import { DEFAULT_LIBRARY_ROOT, referenceDirectory, validateReference } from "../src/lib/reference/library";

const SPECS = [
  { name: "id", required: true, description: "Reference id" },
  { name: "library-root", default: DEFAULT_LIBRARY_ROOT, description: "Library directory" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  const directory = referenceDirectory(args["library-root"]!, args.id!);
  const report = validateReference(directory);
  return { outputs: [], metadata: { directory, passed: report.invalid.length === 0, ...report } };
});
