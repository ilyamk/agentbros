import path from "node:path";
import type { z } from "zod";
import { DeliveryRequestSchema, type RenderIdentity } from "../../types/delivery";
import { assertPathWithin } from "../cli";
import { generationInputHash } from "../jobs/runner";
import { WorkflowRenderContractSchema } from "../workflows/render-guard";
import { readWorkflowEvidence, workflowEvidenceExists } from "../workflows/local-evidence";

type Request = z.output<typeof DeliveryRequestSchema>;
/** Declared use only: a pinned authored product-ad cannot be downgraded to ordinary commercial use. */
export function deliveryUseContext(root: string, request: Request, identities: RenderIdentity[]) {
  const project = path.resolve(root, "public/projects", request.projectId);
  assertPathWithin(path.resolve(root, "public/projects"), project);
  const file = path.join(project, "pipeline/workflow-render.json");
  const sourcePath = path.relative(root, file).split(path.sep).join("/");
  if (!identities.length || identities.some((identity) => identity.projectId !== request.projectId))
    throw new Error("Usage context needs current project render identities");
  const pins = identities.map((identity) => identity.sources.filter((source) => source.path === sourcePath));
  const present = workflowEvidenceExists(file);
  let derivation: {
    path: string;
    sha256: string;
    workflow: z.infer<typeof WorkflowRenderContractSchema>["workflow"];
  } | null = null;
  if (present || pins.some((pin) => pin.length)) {
    if (!present || pins.some((pin) => pin.length !== 1 || pin[0]!.role !== "creative"))
      throw new Error("Workflow use marker must be present and pinned once in every render identity");
    const evidence = readWorkflowEvidence(file, project, 4096);
    if (pins.some((pin) => pin[0]!.sha256 !== evidence.sha256))
      throw new Error("Workflow use marker changed since render identity capture");
    const marker = WorkflowRenderContractSchema.parse(JSON.parse(evidence.text));
    if (marker.projectId !== request.projectId) throw new Error("Workflow use marker belongs to another project");
    derivation = { path: sourcePath, sha256: evidence.sha256, workflow: marker.workflow };
  }
  const requestedUsage = { ...request.usage };
  const effectiveUsage = {
    ...requestedUsage,
    advertising: requestedUsage.advertising || derivation?.workflow === "product-ad",
  };
  const usage = {
    commercial: request.commercial,
    modified: true,
    placements: [...request.placements],
    ...effectiveUsage,
  };
  const declared = { version: 1, projectId: request.projectId, requestedUsage, effectiveUsage, usage, derivation };
  return {
    ...declared,
    contextSha256: generationInputHash(declared),
    provenance:
      "Declared requested use and exact pinned workflow correspondence; no legal permission or human approval inferred",
  };
}
export type DeliveryUseContext = ReturnType<typeof deliveryUseContext>;
