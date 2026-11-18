import { localSuggestions } from "../src/lib/local-capabilities/suggestions";
/** Says what the orchestrator does now: dispatch an agent, run a script, ask the user, or stop. Writes only the step lease (pipeline/session/lease.json, docs/step-lease.md). */
import { parseArgs, runScript } from "../src/lib/cli";
import { openExistingFilm } from "../src/lib/film/cli";
import { nextAction } from "../src/lib/film/state";
import { issueFilmLease } from "../src/lib/step-lease/issue";
import { consoleNextFields } from "../src/lib/console/next-block";

void runScript(async () => {
  const args = parseArgs([{ name: "project", required: true, description: "Project ID" }] as const);
  const project = openExistingFilm(args.project!);
  const next = nextAction(project);
  const lease = issueFilmLease(project, next, "film:next");
  return {
    metadata: {
      projectId: args.project,
      ...next,
      ...lease,
      ...(await localSuggestions(args.project!, next)),
      ...(await consoleNextFields({ rootDir: process.cwd(), project: args.project! })),
    },
  };
});
