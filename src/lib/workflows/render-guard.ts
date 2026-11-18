import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertRecordingEvidence } from "./recording-evidence";
import { assertPathWithin } from "../cli";

export const WorkflowRenderContractSchema = z
  .object({
    version: z.literal(1),
    workflow: z.enum(["product-ad", "education", "recording-edit", "shorts-series"]),
    projectId: z.string(),
    timelineRequired: z.literal(true),
  })
  .strict();
/** Derived workflows must never silently fall back to their non-authoritative legacy scenes. */
export function assertWorkflowRenderMode(projectDirectory: string, projectId: string, timeline?: boolean): void {
  const file = path.join(projectDirectory, "pipeline/workflow-render.json");
  const owned = ["product-ad-evidence", "education", "recording-edit", "shorts-series-binding"];
  const authored = owned.filter((stem) => existsSync(path.join(projectDirectory, "pipeline", `${stem}.json`)));
  if (!existsSync(file)) {
    if (authored.length)
      throw new Error("Workflow render contract missing; restore the authored project before rendering");
    return;
  }
  assertPathWithin(projectDirectory, file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid workflow render contract file");
  const contract = WorkflowRenderContractSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (contract.projectId !== projectId) throw new Error("Workflow render contract belongs to another project");
  const artifact = {
    "product-ad": "product-ad-evidence",
    education: "education",
    "recording-edit": "recording-edit",
    "shorts-series": "shorts-series-binding",
  }[contract.workflow];
  if (!existsSync(path.join(projectDirectory, "pipeline", `${artifact}.json`)))
    throw new Error("Authored workflow evidence is missing; restore it before rendering");
  if (contract.workflow === "recording-edit") assertRecordingEvidence(projectDirectory, projectId);
  if (timeline !== true)
    throw new Error(
      `Workflow ${contract.workflow} requires --timeline; legacy scene rendering would change audio, captions or source selections`,
    );
}
