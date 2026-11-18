import path from "node:path";
import { assertProjectId } from "../render-plan";
import { ProjectConfigSchema } from "../../types/video";
import type { TimelineIR, EditCommand } from "../../types/timeline";
import { ChapterInspectionInputs } from "../longform/inspection-inputs";
export function hasAuthoredCopy(command: EditCommand): boolean {
  return command.type === "authored-copy" || (command.type === "batch" && command.commands.some(hasAuthoredCopy));
}
/** Trusted project validator, not a request-selected waiver or semantic claim classifier. */
export function captureProjectCopyEdits(
  timeline: TimelineIR,
  command: EditCommand,
  projectId: string,
  rootDir = process.cwd(),
) {
  if (!hasAuthoredCopy(command)) return undefined;
  if (timeline.projectId !== projectId) throw Error("Copy edit belongs to another project");
  assertProjectId(projectId);
  const project = path.join(rootDir, "public/projects", projectId),
    inputs = new ChapterInspectionInputs();
  const raw = inputs.json(path.join(project, "project.json"), project, 8 * 1024 * 1024);
  if (
    raw.educational === true ||
    ["claims", "declaredClaims", "facts", "recipe"].some((key) => Object.hasOwn(raw, key))
  )
    throw Error("Authored copy refuses declared factual/educational/recipe projects");
  const config = ProjectConfigSchema.parse(raw);
  if (config.talkingHead?.enabled) throw Error("Authored copy refuses talking-head projects");
  for (const file of [
    "workflow-render.json",
    "workflow-request.json",
    "product-ad-evidence.json",
    "education.json",
    "recording-edit.json",
    "shorts-series-binding.json",
    "workflow-claims.json",
    "evidence/chart-quantity-bindings.json",
    "campaign-snapshot.json",
    "campaign-binding.json",
    "entity-bindings.json",
    "localization.json",
  ])
    inputs.absent(path.join(project, "pipeline", file), project);
  inputs.assertUnchanged();
  return inputs;
}
export function assertProjectCopyEdits(
  timeline: TimelineIR,
  command: EditCommand,
  projectId: string,
  rootDir = process.cwd(),
) {
  captureProjectCopyEdits(timeline, command, projectId, rootDir);
}
