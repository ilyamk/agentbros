import { vizProjectAdvice } from "../src/lib/viz/integrity";
import { localSuggestions } from "../src/lib/local-capabilities/suggestions";
/** The next step of any project: detects its route (bespoke film, the user's own footage, campaign, a project.json's render-QA-delivery timeline, or the bound playbook's start command; a leftover legacy pipeline-state.json is ignored) and returns that route's next-step answer. Reads only, except the film and footage routes' step lease (docs/step-lease.md). */
import { existsSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import { openExistingFilm } from "../src/lib/film/cli";
import { nextAction } from "../src/lib/film/state";
import { footageNext } from "../src/lib/footage/next";
import { detectRoute, memoryFields, ROUTE_COMMANDS, ROUTE_OPTIONS, withPlaybook } from "../src/lib/pipeline/route";
import { campaignNext } from "../src/lib/campaigns/production/service";
import { timelineNext } from "../src/lib/pipeline/timeline-next";
import { guardCheck, raiseCommand, stopping } from "../src/lib/film/guard";
import { issueRouteLease } from "../src/lib/step-lease/issue";
import { consoleNextFields } from "../src/lib/console/next-block";

void runScript(async () => {
  const args = parseArgs([{ name: "project", required: true, description: "Project ID" }] as const);
  const projectId = args.project!;
  validateProjectId(projectId);
  const dir = path.join("public", "projects", projectId);
  if (!existsSync(dir))
    throw new CliErrorObject({
      code: "PROJECT_NOT_FOUND",
      message: `Project "${projectId}" not found. Start one: ${ROUTE_OPTIONS.join("; ")}.`,
    });
  const { route, detectedBy, playbook, start } = detectRoute(dir);
  const bound = withPlaybook(path.resolve(dir));
  const playbookFields = {
    playbook: bound.playbook,
    ...(bound.playbookHint ? { playbookHint: bound.playbookHint } : {}),
    ...(bound.playbookSuggest ? { playbookSuggest: bound.playbookSuggest } : {}),
    ...(bound.playbookWarning ? { playbookWarning: bound.playbookWarning } : {}),
  };
  if (!route && start && playbook) {
    const next = {
      action: "run",
      why: `The project is bound to the ${playbook.kind} playbook ${playbook.id} (${playbook.title}) and has not started its route yet. Fill the remaining <placeholders>, then run it.`,
      commands: [start],
      read: bound.read,
      ...memoryFields(path.resolve(dir), undefined, playbook.id),
    };
    return {
      metadata: {
        projectId,
        route: null,
        detectedBy,
        ...playbookFields,
        command: start,
        guide: bound.read[0],
        next,
        ...(await consoleNextFields({ rootDir: process.cwd(), project: projectId })),
      },
    };
  }
  if (!route)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Project "${projectId}" has ${detectedBy}, so its route is unknown. Start it on one: ${ROUTE_OPTIONS.join("; ")}.`,
    });
  const command = ROUTE_COMMANDS[route];
  // The global safeguard: a film's answer carries it (nextAction); a recording's spend and hours stop here.
  const crossed = route === "footage" ? stopping(guardCheck(path.resolve(dir)), undefined) : [];
  const next = crossed.length
    ? {
        action: "stop",
        step: "present-best",
        why: `A limit is reached: ${crossed.map((limit) => `${limit.name} ${limit.used}/${limit.max}`).join("; ")}. Show the user where the edit stands and ask whether to raise it; raising needs their own words.`,
        limits: crossed.map(({ name, used, max }) => ({ name, used, max })),
        raise: crossed.map((limit) => raiseCommand(projectId, limit)),
      }
    : route === "campaign"
      ? campaignNext(process.cwd(), projectId)
      : route === "film"
        ? nextAction(openExistingFilm(projectId))
        : route === "footage"
          ? footageNext(projectId, { save: false })
          : timelineNext(projectId);
  const lease = issueRouteLease(process.cwd(), route, projectId, next);
  const viz = vizProjectAdvice(process.cwd(), projectId);
  return {
    metadata: {
      projectId,
      route,
      detectedBy,
      ...(viz ? { visualisations: viz } : {}),
      ...playbookFields,
      command: `pnpm ${command.alias} --project ${projectId}`,
      guide: command.guide,
      next,
      ...lease,
      ...(await localSuggestions(projectId, next)),
      ...(await consoleNextFields({ rootDir: process.cwd(), project: projectId })),
    },
  };
});
