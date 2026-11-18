import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { repositoryText } from "../src/lib/context/repository";
import { repositoryAddedLines, scanInstructionSecurity } from "../src/lib/context/security";

void runScript(async () => {
  const args = parseArgs([
    { name: "base", required: true, description: "Local trusted base git ref; its URL/package allowlist is used" },
    { name: "head", description: "Local head ref; omit to compare the tracked working tree with base" },
  ] as const);
  if (!args.base) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--base needs a local git ref." });
  const root = process.cwd();
  const trusted = repositoryText(root, args.base);
  const allowlist = JSON.parse(trusted.read("contrib/url-allowlist.json") ?? '{"domains":[],"npxPackages":[]}') as {
    domains: string[];
    npxPackages?: string[];
  };
  const lines = repositoryAddedLines(root, args.base, args.head);
  const findings = scanInstructionSecurity(lines, allowlist);
  if (findings.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${findings.length} instruction security finding(s).`,
      details: { findings },
    });
  return { metadata: { scannedLines: lines.length, findings: [] } };
});
