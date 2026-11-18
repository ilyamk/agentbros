import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { formatFinding, lintProject, lintProjectCode } from "../src/lib/verification/lint";
runScript(async () => {
  const args = parseArgs([
    { name: "root", description: "Trusted local repository root (default current directory)" },
    {
      name: "project",
      description:
        "Also lint the git-ignored src/projects/<id> with the render rules (determinism, media, staticFile; these fail) and slop signatures (emoji, purple-blue gradients: advisory warnings in metadata.slop)",
    },
  ] as const);
  const result = lintProject(args.root);
  const project = args.project ? lintProjectCode(args.root ?? process.cwd(), args.project) : undefined;
  const slop = project ? { filesScanned: project.filesScanned, warnings: project.warnings } : undefined;
  const findings = [...result.findings, ...(project?.findings ?? [])];
  const summary = {
    filesScanned: result.filesScanned + (project?.filesScanned ?? 0),
    findings,
    ...(slop ? { slop } : {}),
  };
  if (findings.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${findings.length} lint violation(s). ${findings.slice(0, 3).map(formatFinding).join(" ")}`,
      details: summary,
    });
  return { metadata: summary };
});
