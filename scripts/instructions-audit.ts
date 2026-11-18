import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "../src/lib/cli";
import { repositoryText } from "../src/lib/context/repository";
import { auditPlan, runAudit } from "../src/lib/triage/audit";
import { runTriageScript } from "../src/lib/triage/cli";
import { ledgerPath } from "../src/lib/triage/ledger";
import { loadConfig } from "../src/lib/triage/vendors";

void runTriageScript(async () => {
  const args = parseArgs([
    {
      name: "dry-run",
      type: "boolean",
      description: "List instruction sections and tasks; no calls, ledger or report writes",
    },
  ] as const);
  const config = loadConfig();
  if (!config.enabled) return { metadata: { skipped: "triage disabled" } };
  const plan = auditPlan(repositoryText(process.cwd()));
  if (args["dry-run"])
    return {
      metadata: {
        dryRun: true,
        sectionCount: plan.sections.length,
        callCount: plan.sections.length * 2,
        judges: config.judges,
        monthlyCapUsd: config.monthlyCapUsd,
        sections: plan.sections.map(({ text: _text, ...section }) => section),
        limitations: plan.limitations,
      },
    };
  const { report, markdown } = await runAudit(plan, {
    config,
    ledger: ledgerPath(),
    runId: process.env.TRIAGE_RUN_ID ?? randomUUID(),
  });
  mkdirSync("out/context", { recursive: true });
  writeFileSync("out/context/audit.json", `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync("out/context/audit.md", markdown);
  return {
    outputs: ["out/context/audit.json", "out/context/audit.md"],
    metadata: {
      sectionCount: plan.sections.length,
      findings: report.findings.length,
      labels: report.labels,
      costUsd: report.costUsd,
    },
  };
});
