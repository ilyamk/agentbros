import { assertVizMotionPlan } from "../src/lib/viz/integrity";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, emitProgress, emitResult, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { writeJsonAtomic } from "../src/lib/film/evidence";
import { projectPipeline, readJsonFile } from "../src/lib/film/inputs";
import { checkPlan, type PlanContext } from "../src/lib/film/plan-check";
import { isBespokeProject } from "../src/lib/film/state";
import { listUsage, recentOtherFilms, usageBlocks } from "../src/lib/library/usage";
import { MotionPlanSchema, type MotionPlan } from "../src/types/creative";
import { CuePlacementsSchema } from "../src/types/tournament";
import { AudioMapSchema, CueSheetSchema, FilmTargetsSchema } from "../src/types/film";

const SPECS = [
  {
    name: "project",
    description:
      "Project ID: reads pipeline/motion-plan.json, cue-sheet.json, film-targets.json and cue-placements.json, and writes pipeline/plan-check.json. Adds cross-film-repetition (memory/usage) and, in a bespoke film, signature-element",
  },
  { name: "plan", description: "MotionPlan JSON" },
  {
    name: "targets",
    description: "FilmTargets JSON from film:targets. Required: pace is judged against a reference or stated by hand",
  },
  { name: "cue-sheet", description: "CueSheet JSON" },
  {
    name: "audio-map",
    description:
      "Audio map JSON for the advisory structure leg (cuts on phrases, surges, downbeats; ending on the stop). Defaults to the project's pipeline/audio-map.json",
  },
  { name: "output", description: "Output JSON path" },
] as const;

/** The film's blocks and the last other films' usage (memory/usage), and whether the brief is bespoke. */
function projectContext(project: string, plan: MotionPlan): PlanContext {
  const placementsPath = projectPipeline(project, "cue-placements.json");
  const placements = existsSync(placementsPath)
    ? readJsonFile(placementsPath, CuePlacementsSchema, "Cue placements")
    : undefined;
  const { records, warnings } = listUsage();
  for (const warning of warnings) emitProgress(`library usage: ${warning}`);
  // A replica copies its reference, so it has no signature of its own to name.
  const brief = existsSync(projectPipeline(project, "brief.json"))
    ? (JSON.parse(readFileSync(projectPipeline(project, "brief.json"), "utf8")) as { filmType?: unknown })
    : {};
  return {
    blocks: usageBlocks(plan, placements),
    recent: recentOtherFilms(records, project, undefined, (id) => existsSync(path.join("public/projects", id))),
    bespoke: isBespokeProject(path.join("public/projects", project)) && brief.filmType !== "replica",
  };
}

void runScript(async () => {
  const startedAt = Date.now();
  const args = parseArgs(SPECS);
  if (args.project) requireProject(args.project);
  const inProject = (file: string) => (args.project ? projectPipeline(args.project, file) : undefined);
  const planPath = args.plan ?? inProject("motion-plan.json");
  const targetsPath = args.targets ?? inProject("film-targets.json");
  if (!planPath) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --plan or --project." });
  if (!targetsPath || !existsSync(targetsPath))
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: `No film targets${targetsPath ? ` at ${targetsPath}` : ""}. Run film:targets from the chosen reference, or film:targets --manual with --reason. A pace cannot be checked without them.`,
    });
  const defaultCues = inProject("cue-sheet.json");
  const cuePath = args["cue-sheet"] ?? (defaultCues && existsSync(defaultCues) ? defaultCues : undefined);
  const defaultMap = inProject("audio-map.json");
  const mapPath = args["audio-map"] ?? (defaultMap && existsSync(defaultMap) ? defaultMap : undefined);
  const plan = readJsonFile(planPath, MotionPlanSchema, "Motion plan");
  const context = args.project ? projectContext(args.project, plan) : {};
  if (args.project) assertVizMotionPlan(process.cwd(), args.project, plan);
  const result = checkPlan(
    plan,
    readJsonFile(targetsPath, FilmTargetsSchema, "Targets"),
    cuePath ? readJsonFile(cuePath, CueSheetSchema, "Cue sheet") : undefined,
    mapPath ? readJsonFile(mapPath, AudioMapSchema, "Audio map") : undefined,
    context,
  );
  for (const finding of result.findings)
    emitProgress(`${finding.status.padEnd(4)} ${finding.score.toFixed(1)} ${finding.dimension}: ${finding.message}`);
  for (const finding of result.advisory ?? [])
    emitProgress(`${finding.status.padEnd(4)} advisory ${finding.dimension}: ${finding.message}`);
  const output = args.output ?? inProject("plan-check.json");
  const outputs = output ? [writeJsonAtomic(output, result)] : [];
  if (result.verdict === "pass") return { outputs, metadata: { ...result } };
  const failing = result.findings.filter((finding) => finding.status === "fail");
  return emitResult({
    ok: false,
    error: "VALIDATION",
    message: `plan:check blocks this plan: risk ${result.riskScore} of 5, failing ${failing.map((finding) => finding.dimension).join(", ") || "on overall risk"}. Read metadata.findings[].fix and change the plan before building.`,
    outputs,
    metadata: { ...result },
    elapsedMs: Date.now() - startedAt,
  });
});
