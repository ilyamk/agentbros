import path from "node:path";
import { boundedFile } from "../apple/runtime";
import { WorkflowScenarioSchema, WorkflowSuiteSchema } from "../../types/workflow-evaluation";
import { contained, digest, fail } from "./io";

export const WORKFLOW_SUITE = "bench/workflows/v2/suite.json";
export function workflowScenarios(root: string, suiteFile = WORKFLOW_SUITE) {
  const suite = WorkflowSuiteSchema.parse(JSON.parse(boundedFile(contained(root, suiteFile), 1024 * 1024).toString()));
  return suite.scenarios.map((entry) => {
    const bytes = boundedFile(contained(root, entry.path), 1024 * 1024);
    if (digest(bytes) !== entry.sha256) fail(`Workflow scenario hash mismatch: ${entry.id}`);
    const scenario = WorkflowScenarioSchema.parse(JSON.parse(bytes.toString()));
    if (scenario.id !== entry.id) fail("Workflow scenario identity mismatch");
    for (const pin of [...scenario.material, ...(scenario.quality ? [scenario.quality] : [])]) {
      const data = boundedFile(contained(root, pin.path), scenario.limits.fileBytes);
      if (data.length !== pin.bytes || digest(data) !== pin.sha256)
        fail(`Workflow material hash mismatch: ${pin.path}`);
    }
    return {
      scenario,
      bytes,
      profile: suite.profile,
      noSpend: suite.noSpend ?? false,
      suiteVersion: suite.version,
      file: entry.path,
      sha256: entry.sha256,
      suiteFile: path.relative(root, path.resolve(root, suiteFile)),
    };
  });
}
