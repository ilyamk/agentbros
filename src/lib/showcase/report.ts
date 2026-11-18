import path from "node:path";
import { requireProject } from "../cli";
import { readLedger, totalUsd } from "../cli/cost-log";
import { readMetrics, projectPlaybook } from "../memory/capture";
import { assertPublic, optionalJson, stripExportPaths } from "./data";
import { ShowcaseHarnessSchema } from "../../types/showcase";

export function projectFacts(project: string) {
  requireProject(project);
  const metrics = readMetrics(project),
    entries = readLedger(project);
  const rounds = new Map<string, number>();
  for (const row of metrics)
    if (row.event === "round")
      rounds.set(row.step ?? "unspecified", Math.max(rounds.get(row.step ?? "unspecified") ?? 0, row.value ?? 0));
  const providers = [...new Set(entries.map((row) => row.service))].sort();
  const count = (event: string) => metrics.filter((row) => row.event === event).length;
  const brief = optionalJson(path.join("public/projects", project, "pipeline/brief.json")) as
    Record<string, unknown> | undefined;
  const harness = ShowcaseHarnessSchema.safeParse(brief?.harness);
  const times = metrics.map((row) => Date.parse(row.at)).sort((a, b) => a - b);
  const wallTimeMin = times.length > 1 ? (times.at(-1)! - times[0]!) / 60000 : null;
  return {
    wallTimeMin,
    rounds: [...rounds.values()].reduce((sum, value) => sum + value, 0),
    approvals: count("approved"),
    rejections: count("rejected"),
    sensorFailures: count("sensor-fail"),
    userInterventions: count("approved") + count("rejected"),
    spend: {
      totalUsd: totalUsd(entries),
      byProvider: providers.map((provider) => ({
        provider,
        totalUsd: totalUsd(entries.filter((row) => row.service === provider)),
      })),
      subscriptionNote: "Harness subscription costs are declared separately; they are not inferred from the ledger.",
    },
    delivered: count("delivered") > 0,
    playbook: projectPlaybook(project) ?? null,
    harness: harness.success ? harness.data : null,
  };
}
export function fieldReport(project: string) {
  const facts = projectFacts(project);
  const report = stripExportPaths({
    rounds: facts.rounds,
    approvals: facts.approvals,
    rejections: facts.rejections,
    sensorFailures: facts.sensorFailures,
    spend: facts.spend,
    delivered: facts.delivered,
    playbook: facts.playbook,
    harness: facts.harness,
  });
  assertPublic(report, process.cwd());
  const markdown = `# Anonymous field report\n\nRounds: ${report.rounds}\nApprovals: ${report.approvals}\nRejections: ${report.rejections}\nSensor failures: ${report.sensorFailures}\nSpend (USD): ${report.spend.totalUsd ?? "unknown"}\nDelivered: ${report.delivered ? "yes" : "no"}\nPlaybook: ${report.playbook ?? "unknown"}\nHarness: ${report.harness ?? "unknown"}\n\n${report.spend.subscriptionNote}\n`;
  return { report, markdown };
}
