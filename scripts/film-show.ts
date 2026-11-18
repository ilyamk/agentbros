/**
 * A compact, read-only digest of a bespoke film step's inputs and outputs (or of one artefact): shape, counts, schema
 * validity and chosen fields, so agents need no script of their own to look inside pipeline JSON. Writes nothing.
 */
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { openExistingFilm, refusals } from "../src/lib/film/cli";
import { showArtefact, showStep } from "../src/lib/film/show";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    { name: "step", description: "Step id, as in film:status: its inputs and outputs, one digest each" },
    {
      name: "artefact",
      description:
        "One file or folder inside the project or out/<id>/, relative to the repository root: a deeper digest",
    },
    {
      name: "fields",
      description: "Comma-separated dot paths to show in full (bounded), e.g. ideas.title,scores.0.axes",
    },
    { name: "depth", description: "Digest depth, 0 to 4 (default 1 for a step, 2 for an artefact)" },
  ] as const);
  if (!args.step && !args.artefact)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --step <step>, --artefact <path>, or both." });
  const depth = args.depth === undefined ? undefined : Number(args.depth);
  if (depth !== undefined && !(Number.isInteger(depth) && depth >= 0 && depth <= 4))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--depth must be a whole number from 0 to 4." });
  const fields = args.fields
    ?.split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const options = { ...(fields?.length ? { fields } : {}), ...(depth !== undefined ? { depth } : {}) };
  const project = openExistingFilm(args.project!);
  const shown = refusals(() =>
    args.artefact ? showArtefact(project, args.artefact, options) : showStep(project, args.step!, options),
  );
  return { metadata: { ...shown, ...(args.artefact && args.step ? { step: args.step } : {}) } };
});
