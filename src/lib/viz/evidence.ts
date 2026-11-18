import path from "node:path";
import { VizQuantitySourceSchema } from "../../types/viz";
import { vizHash } from "./compile";
import { workflowClaims } from "../workflows/claims";
import { readWorkflowEvidence } from "../workflows/local-evidence";
import { collectActiveViz } from "./usage";

export function inspectVizEvidence(root: string, project: string, consumed: unknown) {
  const active = collectActiveViz(root, project, consumed);
  const findings: Array<{
    code: "CHART_SOURCE_MISMATCH" | "CHART_SOURCE_REVIEW_REQUIRED";
    severity: "error" | "info";
    path: (string | number)[];
    message: string;
  }> = [];
  for (const item of active) {
    const spec = item.bundle.plans[0]!.spec;
    for (const datum of spec.data) {
      if (!item.ownerSceneId || !datum.quantity || !datum.evidence) {
        findings.push({
          code: "CHART_SOURCE_REVIEW_REQUIRED",
          severity: "info",
          path: ["viz", item.sceneId, datum.id],
          message: "Data source correspondence is unverified",
        });
        continue;
      }
      try {
        const ref = datum.evidence;
        const claim = workflowClaims(root, project).find(
          (c) => c.id === ref.claimId && c.sceneId === item.ownerSceneId,
        );
        if (!claim) {
          findings.push({
            code: "CHART_SOURCE_REVIEW_REQUIRED",
            severity: "info",
            path: ["viz", item.sceneId, datum.id],
            message: "The current mounted owner has no matching claim; derived/inherited claims need review",
          });
          continue;
        }
        if (!claim.evidence.some((e) => e.path === ref.path && e.sha256 === ref.sha256 && e.excerpt === ref.excerpt))
          throw new Error("Source must belong to exact owning workflow claim");
        const source = readWorkflowEvidence(
          path.resolve(root, "public", ref.path),
          path.join(root, "public/projects", project),
          8 * 1024 * 1024,
        );
        if (source.sha256 !== ref.sha256 || !source.text.includes(ref.excerpt))
          throw new Error("Source hash or excerpt mismatch");
        const record = VizQuantitySourceSchema.parse(JSON.parse(source.text)).records.find(
          (r) => r.id === ref.recordId,
        );
        if (!record || record.value !== datum.value || vizHash(record.quantity) !== vizHash(datum.quantity))
          throw new Error("Source record differs from displayed quantity/value");
      } catch (error) {
        findings.push({
          code: "CHART_SOURCE_MISMATCH",
          severity: "error",
          path: ["viz", item.sceneId, datum.id],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { active, findings };
}
