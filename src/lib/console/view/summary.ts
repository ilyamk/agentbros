/**
 * A home page row (US1, RFC 0004 §5.1) from a project's view: route, current step, the active agent, waiting count,
 * control state (the status dot), spend and ceiling, the latest render and when anything last changed.
 */
import path from "node:path";
import { EVENTS_FILE, ProjectSummarySchema, type ProjectSummary, type ProjectView } from "../../../types/console";
import { statOf, toIso, type ProjectPaths } from "./files";

export function projectSummary(view: ProjectView, paths: ProjectPaths): ProjectSummary {
  const step = view.current ? view.steps.find((row) => row.id === view.current!.step) : undefined;
  const updated = Math.max(
    0,
    ...[
      paths.projectDir,
      path.join(paths.projectDir, "project.json"),
      path.join(paths.projectDir, "pipeline"),
      path.join(paths.projectDir, EVENTS_FILE),
      paths.outDir,
    ].map((file) => statOf(file)?.mtimeMs ?? 0),
  );
  const active = view.agents.active;
  const summary: ProjectSummary = {
    id: view.project.id,
    route: view.project.route,
    ...(view.project.title ? { title: view.project.title } : {}),
    ...(view.project.filmType ? { filmType: view.project.filmType } : {}),
    ...(view.project.playbook ? { playbook: view.project.playbook } : {}),
    ...(view.current ? { step: view.current.step } : {}),
    ...(step ? { stepTitle: step.title, stepStatus: step.status } : {}),
    ...(active
      ? { activeAgent: { name: active.name, ...(active.role ? { role: active.role } : {}), since: active.startedAt } }
      : {}),
    waiting: view.waiting.length,
    control: view.control.state,
    spentUsd: view.money.spentUsd,
    ...(view.money.ceilingUsd !== undefined ? { ceilingUsd: view.money.ceilingUsd } : {}),
    ...(view.media.latestRender ? { latestRender: view.media.latestRender } : {}),
    updatedAt: toIso(updated),
  };
  return ProjectSummarySchema.parse(summary);
}
