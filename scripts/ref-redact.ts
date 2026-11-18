import { existsSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { corpusCandidates } from "../src/lib/reference/corpus";
import { DEFAULT_LIBRARY_ROOT, referenceDirectory } from "../src/lib/reference/library";
import { redactReference } from "../src/lib/reference/redact";

const SPECS = [
  { name: "id", description: "Reference id" },
  {
    name: "all",
    type: "boolean",
    description:
      "Every reference in the library (sub-directories with a source.json, except inbox and names starting with _)",
  },
  { name: "library-root", default: DEFAULT_LIBRARY_ROOT, description: "Library directory" },
  {
    name: "no-history",
    type: "boolean",
    description: "Do not look in git history for words a structure-only checkout lacks",
  },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (!!args.id === !!args.all) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --id ID or --all." });
  const root = args["library-root"]!;
  const ids = args.all
    ? corpusCandidates(root).filter((id) => existsSync(path.join(root, id, "source.json")))
    : [args.id!];
  const results = ids.map((id) => {
    const directory = referenceDirectory(root, id);
    if (!existsSync(path.join(directory, "source.json")))
      throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `No reference at ${directory}. Run ref:add first.` });
    return redactReference(directory, id, { history: !args["no-history"] });
  });
  const tally = Object.fromEntries(
    ["redacted", "refreshed", "recovered", "kept", "missing"].map((action) => [
      action,
      results.filter((row) => row.action === action).length,
    ]),
  );
  return {
    outputs: results
      .filter((row) => row.action === "redacted" || row.action === "refreshed" || row.action === "recovered")
      .map((row) => path.join(root, row.referenceId, "speech-text.json")),
    metadata: { libraryRoot: root, tally, results },
  };
});
