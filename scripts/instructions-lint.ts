import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import {
  instructionBaseline,
  lintInstructions,
  newInstructionFindings,
  type InstructionBaseline,
} from "../src/lib/context/lint";
import { repositoryText } from "../src/lib/context/repository";

void runScript(async () => {
  const args = parseArgs([
    {
      name: "update-baseline",
      type: "boolean",
      description: "Replace contrib/instructions-baseline.json with today's findings; review the diff",
    },
  ] as const);
  const file = "contrib/instructions-baseline.json";
  const findings = lintInstructions(repositoryText(process.cwd()));
  if (args["update-baseline"]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(instructionBaseline(findings), null, 2)}\n`);
    return { outputs: [file], metadata: { findings: findings.length, baselineUpdated: true } };
  }
  const baseline: InstructionBaseline = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as InstructionBaseline)
    : { version: 1, fingerprints: [] };
  const fresh = newInstructionFindings(findings, baseline);
  if (fresh.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${fresh.length} new instruction finding(s).`,
      details: { findings: fresh, total: findings.length },
    });
  return { metadata: { findings: findings.length, newFindings: [], baseline: file } };
});
