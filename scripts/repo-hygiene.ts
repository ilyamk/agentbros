import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPathWithin, CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { gitText, repositoryText } from "../src/lib/context/repository";
import { auditRepositoryHygiene } from "../src/lib/workspace/hygiene";
import { applyCleanup, cleanupResult, planWorkspaceClean } from "../src/lib/workspace/cleanup";

void runScript(async () => {
  const args = parseArgs([
    {
      name: "check",
      type: "boolean",
      description: "Fail on machine paths or maintenance artefacts in the Git working tree",
    },
    {
      name: "write",
      type: "boolean",
      description: "Write a redacted inventory under ignored out/qa/repository-hygiene/",
    },
    {
      name: "clean",
      type: "boolean",
      description: "Plan cleanup of ignored QA outputs using workspace:clean safeguards",
    },
    {
      name: "yes",
      type: "boolean",
      description: "Apply the --clean plan; source files are never automatically removed",
    },
  ] as const);
  if ((args.yes && !args.clean) || (args.clean && (args.check || args.write)))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Use --clean [--yes], or audit with --check/--write." });
  const root = process.cwd();
  if (path.resolve(gitText(root, ["rev-parse", "--show-toplevel"]).trim()) !== root)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Run repo:hygiene from the repository root." });
  if (args.clean) {
    const plan = planWorkspaceClean({ scopes: ["qa"] });
    if (args.yes) applyCleanup(plan);
    return cleanupResult(plan, !args.yes);
  }
  const repo = repositoryText(root);
  repo.files = gitText(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  const report = auditRepositoryHygiene(repo);
  const outputs: string[] = [];
  if (args.write) {
    const file = path.join(root, "out/qa/repository-hygiene/report.json");
    assertPathWithin(root, file);
    mkdirSync(path.dirname(file), { recursive: true });
    assertPathWithin(root, file);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    outputs.push(path.relative(root, file));
  }
  if (args.check && report.findings.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Repository hygiene found ${report.findings.length} issue(s).`,
      details: { outputs, ...report },
    });
  return { outputs, metadata: report };
});
