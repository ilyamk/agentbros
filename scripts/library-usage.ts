/** Which library blocks each film used, in local memory (memory/usage/<project>.json), so plan:check can stop the next film repeating the last one's heroes. */
import { existsSync } from "node:fs";
import { CliErrorObject, emitProgress, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { projectPipeline, readJsonFile } from "../src/lib/film/inputs";
import { listUsage, recordUsage } from "../src/lib/library/usage";
import { MotionPlanSchema } from "../src/types/creative";
import { CuePlacementsSchema } from "../src/types/tournament";

const SPECS = [
  {
    name: "record",
    type: "boolean",
    description:
      "Record the project's blocks from pipeline/cue-placements.json and motion-plan.json; film:done --step build does this itself",
  },
  { name: "list", type: "boolean", description: "List every recorded film, newest first" },
  { name: "project", description: "Project ID (with --record)" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (Boolean(args.record) === Boolean(args.list))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --record --project <id>, or --list." });
  if (args.list) {
    const { records, warnings } = listUsage();
    for (const warning of warnings) emitProgress(warning);
    for (const record of records)
      emitProgress(
        `${record.date} ${record.projectId}: ${
          record.blocks
            .filter((block) => block.weight === "hero")
            .map((block) => block.id)
            .join(", ") || "no hero block"
        }`,
      );
    return { metadata: { films: records.length, records, warnings } };
  }
  if (!args.project) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--record needs --project." });
  requireProject(args.project);
  const plan = readJsonFile(projectPipeline(args.project, "motion-plan.json"), MotionPlanSchema, "Motion plan");
  const placementsPath = projectPipeline(args.project, "cue-placements.json");
  const placements = existsSync(placementsPath)
    ? readJsonFile(placementsPath, CuePlacementsSchema, "Cue placements")
    : undefined;
  const { file, usage } = recordUsage(args.project, plan, placements);
  return { outputs: [file], metadata: { ...usage } };
});
