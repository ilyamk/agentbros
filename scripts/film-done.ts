/** Records a finished step: checks its outputs and done rule, then hashes its inputs and outputs. --skip records why a skippable step is skipped. */
import { emitProgress, parseArgs, runScript } from "../src/lib/cli";
import { openExistingFilm, refusals } from "../src/lib/film/cli";
import { existsSync } from "node:fs";
import path from "node:path";
import { RENDER, stepById } from "../src/lib/film/chain";
import { snapshotFilmVersion } from "../src/lib/film/versions";
import { sealStep, skipStep, stepState, type FilmProject } from "../src/lib/film/state";
import { noteRound } from "../src/lib/memory/capture";
import { noteUsage } from "../src/lib/library/usage";
import { guardSeal } from "../src/lib/film/guard-cli";
import { clearLease } from "../src/lib/step-lease/lease";

const latestRound = (project: FilmProject, step: string) => {
  try {
    return stepState(project, step).critic?.latestPath;
  } catch {
    return undefined;
  }
};

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    { name: "step", required: true, description: "Step id, as in film:status" },
    {
      name: "unchanged-because",
      description: "Why the result is rightly identical after an input changed; recorded in the spine",
    },
    { name: "skip", description: "Skip a skippable step (discovery) and record this reason" },
  ] as const);
  const project = openExistingFilm(args.project!);
  if (args.skip !== undefined) {
    const skip = refusals(() => skipStep(project, args.step!, args.skip!));
    const leaseCleared = clearLease(project.projectDir, args.step!);
    return { metadata: { projectId: project.id, step: args.step, skipped: skip, leaseCleared } };
  }
  const reason = args["unchanged-because"];
  const guard = guardSeal(project, args.step!);
  const receipt = refusals(() => sealStep(project, args.step!, reason ? { unchangedBecause: reason } : {}));
  guard.commit();
  // The step is over: its lease goes; `pnpm next` issues the next step's.
  const leaseCleared = clearLease(project.projectDir, args.step!);
  const memoryWarning = stepById(args.step!)?.critic
    ? noteRound(project.id, args.step!, latestRound(project, args.step!), project.rootDir)
    : undefined;
  if (memoryWarning) emitProgress(memoryWarning);
  // The built film's blocks go to memory/usage, so plan:check can keep the next film off the same heroes.
  const usageWarning = args.step === "build" ? noteUsage(project.projectDir, project.id, project.rootDir) : undefined;
  if (usageWarning) emitProgress(usageWarning);
  // A step sealed on the film (measure, critic, human…) tags the kept version of that exact render.
  const step = stepById(args.step!);
  const film = path.join(project.rootDir, RENDER.replace("{id}", project.id));
  let versionWarning: string | undefined;
  if (step && [...step.inputs, ...step.outputs].some((item) => item.path === RENDER) && existsSync(film)) {
    try {
      snapshotFilmVersion(project, film, { step: args.step! });
    } catch (error) {
      versionWarning = `The film was not kept under out/${project.id}/versions/: ${error instanceof Error ? error.message : String(error)}`;
      emitProgress(versionWarning);
    }
  }
  return {
    metadata: {
      projectId: project.id,
      receipt,
      leaseCleared,
      ...(memoryWarning ? { memoryWarning } : {}),
      ...(usageWarning ? { usageWarning } : {}),
      ...(versionWarning ? { versionWarning } : {}),
    },
  };
});
