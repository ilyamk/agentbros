import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPathWithin, parseArgs, runScript } from "../src/lib/cli";
import { auditMarkdown, markdownAuditTsv, markdownFoldersTsv } from "../src/lib/context/markdown-audit";
import { gitText, repositoryText } from "../src/lib/context/repository";

void runScript(async () => {
  const args = parseArgs([
    {
      name: "write",
      type: "boolean",
      description: "Write report.json, files.tsv and directories.tsv under out/qa/docs-audit/",
    },
  ] as const);
  const root = process.cwd();
  const repo = repositoryText(root);
  repo.files = gitText(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  const report = auditMarkdown(repo);
  const outputs: string[] = [];
  if (args.write) {
    const directory = path.join(root, "out/qa/docs-audit");
    assertPathWithin(root, directory);
    assertPathWithin(path.join(root, "out"), directory);
    mkdirSync(directory, { recursive: true });
    for (const [name, contents] of [
      ["report.json", `${JSON.stringify(report, null, 2)}\n`],
      ["files.tsv", markdownAuditTsv(report)],
      ["directories.tsv", markdownFoldersTsv(report)],
    ]) {
      const file = path.join(directory, name!);
      assertPathWithin(directory, file);
      writeFileSync(file, contents!);
      outputs.push(path.relative(root, file));
    }
  }
  return {
    outputs,
    metadata: {
      ...report.summary,
      reviewOnlyDirectoryPaths: report.reviewOnlyDirectories,
      limitations: report.limitations,
    },
  };
});
