import { execFileSync } from "node:child_process";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { checkContribution } from "../src/lib/reference/contribute";
import { DEFAULT_LIBRARY_ROOT } from "../src/lib/reference/library";

const SPECS = [
  { name: "id", description: "Reference id to check before contributing it; comma-separated for several" },
  {
    name: "all",
    type: "boolean",
    description: "Every reference in the library; private ones are listed as localOnly and left out",
  },
  {
    name: "library-root",
    default: DEFAULT_LIBRARY_ROOT,
    description: "Library directory, relative to the repository root",
  },
  {
    name: "base",
    description: "Commit messages after this revision are checked for private ids; defaults to main when it exists",
  },
] as const;

const git = (args: string[]) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (!!args.id === !!args.all)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --id ID (or ID,ID) or --all." });
  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  if (!repoRoot)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Run ref:contribute inside the repository checkout." });
  const base =
    args.base ??
    (git(["rev-parse", "--verify", "--quiet", "main"]) && git(["rev-parse", "--abbrev-ref", "HEAD"]) !== "main"
      ? "main"
      : undefined);
  const report = checkContribution({
    repoRoot,
    libraryRoot: args["library-root"]!,
    ids: args.id
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    all: args.all === true,
    base,
  });
  const issues = [
    ...report.repository,
    ...report.checked.flatMap((row) => row.issues.map((issue) => ({ id: row.id, ...issue }))),
  ];
  const metadata = {
    passed: report.passed,
    checked: report.checked.map((row) => ({ id: row.id, issues: row.issues.length, filmTextLocal: row.filmTextLocal })),
    localOnly: report.localOnly,
    issues,
    warnings: report.warnings,
  };
  if (!report.passed)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Not ready to contribute: ${issues.length} problem${issues.length === 1 ? "" : "s"}. First: ${issues[0]!.message}`,
      details: metadata,
    });
  return { outputs: [], metadata };
});
