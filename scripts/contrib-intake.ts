import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CliErrorObject, parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { intake, IntakeContextSchema, type ChangedFile } from "../src/lib/contrib/intake";

void runOffline(async () => {
  const args = parseArgs([
    { name: "base", required: true, description: "Base Git revision" },
    { name: "head", required: true, description: "Head Git revision" },
    { name: "body", required: true, description: "PR body text file" },
    { name: "context", description: "JSON with cla, openPrCount (including this PR), labels and tier" },
  ] as const);
  const git = (argv: string[]) =>
    execFileSync("git", ["--no-pager", ...argv], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const base = git(["rev-parse", "--verify", "--end-of-options", `${args.base}^{commit}`]).trim();
  const head = git(["rev-parse", "--verify", "--end-of-options", `${args.head}^{commit}`]).trim();
  const diffArgs = ["--no-ext-diff", "--no-textconv", "--no-renames", "-z", base, head, "--"];
  const statuses = git(["diff", "--name-status", ...diffArgs]).split("\0");
  const statusByPath = new Map<string, string>();
  for (let i = 0; i + 1 < statuses.length; i += 2) statusByPath.set(statuses[i + 1]!, statuses[i]!);
  const changedFiles: ChangedFile[] = git(["diff", "--numstat", ...diffArgs])
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
      if (!match) throw new Error("Invalid Git numstat record");
      const [, additions, deletions, path] = match as unknown as [string, string, string, string];
      const status = statusByPath.get(path);
      if (!status) throw new Error(`Missing Git status for ${path}`);
      const file: ChangedFile = {
        path,
        additions: additions === "-" ? 0 : Number(additions),
        deletions: deletions === "-" ? 0 : Number(deletions),
        binary: additions === "-" || deletions === "-",
        status,
      };
      if (path === "package.json" || /^\.changes\/[^/]+\.md$/.test(path)) {
        if (status !== "D") file.content = git(["show", `${head}:${path}`]);
        if (path === "package.json" && status !== "A") file.previousContent = git(["show", `${base}:${path}`]);
      }
      return file;
    });
  const context = IntakeContextSchema.parse(args.context ? JSON.parse(readFileSync(args.context, "utf8")) : {});
  const result = intake({
    prBody: readFileSync(args.body!, "utf8"),
    changedFiles,
    authorTier: context.tier,
    cla: context.cla,
    openPrCount: context.openPrCount,
    labels: context.labels,
  });
  if (result.findings.some(({ severity }) => severity === "block"))
    throw new CliErrorObject({ code: "VALIDATION", message: "Contribution intake blocked", details: result });
  return { metadata: result };
});
