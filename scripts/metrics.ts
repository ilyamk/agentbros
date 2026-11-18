import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, runScript } from "../src/lib/cli";
import { collectMetrics, METRICS_PATH, metricDeltas, writeReadmeMetrics } from "../src/lib/metrics";
import { stableJson } from "../src/lib/api-surface/source";

const SPECS = [
  { name: "write", type: "boolean", description: "Write out/metrics/metrics.json" },
  { name: "diff", description: "Compare numeric inventory fields with an older metrics JSON file" },
  {
    name: "write-readme",
    type: "boolean",
    description: "Regenerate the README metrics markers with verified headline counts",
  },
  { name: "usage", description: "Optional offline library:usage JSON file; personal memory is not read implicitly" },
] as const;
void runScript(async () => {
  const args = parseArgs(SPECS);
  const root = process.cwd();
  const metrics = collectMetrics(root, args.usage ? [path.resolve(args.usage)] : []);
  const outputs: string[] = [];
  const deltas = args.diff ? metricDeltas(JSON.parse(readFileSync(args.diff, "utf8")), metrics) : undefined;
  if (args.write) {
    mkdirSync(path.dirname(METRICS_PATH), { recursive: true });
    writeFileSync(METRICS_PATH, stableJson(metrics));
    outputs.push(METRICS_PATH);
  }
  if (args["write-readme"]) {
    writeReadmeMetrics(root, metrics);
    outputs.push("README.md");
  }
  return { outputs, metadata: { metrics, ...(deltas ? { deltas } : {}) } };
});
