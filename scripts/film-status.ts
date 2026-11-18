/** Derives the state of every step of the bespoke chain from files, validation and hashes. Reads only. */
import { parseArgs, runScript } from "../src/lib/cli";
import { openExistingFilm } from "../src/lib/film/cli";
import { dispatchTotals } from "../src/lib/film/brief";
import { deriveChain, isPromo } from "../src/lib/film/state";
import { rescoreLines } from "../src/lib/film/studio";
import { stepGuardReport } from "../src/lib/step-lease/lease";

void runScript(async () => {
  const args = parseArgs([{ name: "project", required: true, description: "Project ID" }] as const);
  const project = openExistingFilm(args.project!);
  const { steps, current, tokens } = deriveChain(project);
  // Commands run outside their step without a step:unlock (docs/step-lease.md).
  const outOfStep = stepGuardReport(project.projectDir);
  return {
    metadata: {
      projectId: project.id,
      profile: isPromo(project, tokens) ? "promo" : "full",
      currentStep: current?.id ?? null,
      why: current?.reasons.join(" ") ?? "Every step is closed.",
      stale: steps.filter((step) => step.status === "stale").map((step) => ({ step: step.id, because: step.reasons })),
      proxied: steps.filter((step) => step.proxied).map((step) => step.id),
      acceptedByUser: steps.find((step) => step.id === "human")?.status === "done",
      rescoredAfterVerdict: [
        ...rescoreLines(project.projectDir, "ideas"),
        ...rescoreLines(project.projectDir, "scripts"),
      ],
      advisories: steps
        .filter((step) => step.advisories?.length)
        .map((step) => ({ step: step.id, advisories: step.advisories })),
      steps: steps.map((step) => ({
        id: step.id,
        status: step.status,
        reasons: step.reasons,
        ...(step.proxied ? { proxied: true } : {}),
        ...(step.advisories?.length ? { advisories: step.advisories } : {}),
      })),
      briefs: dispatchTotals(project),
      ...(outOfStep ? { stepGuard: outOfStep } : {}),
    },
  };
});
