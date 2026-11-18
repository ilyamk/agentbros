/** Exports an applied or verified improvement proposal as local patch files plus a generalised PR.md, leak-scanned. Never pushes. */
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { runGit, upstreamProposal } from "../src/lib/memory/upstream";

const SPECS = [
  { name: "id", required: true, description: "The proposal's id (applied or verified)" },
  {
    name: "out",
    description:
      "Output folder (default memory/upstream/<id>); a git-ignored folder in the workspace or the temporary folder",
  },
  { name: "dry-run", type: "boolean", description: "Build and scan without writing; lists any leak hits" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  const top = runGit(["rev-parse", "--show-toplevel"], process.cwd());
  if (top.status !== 0) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Run inside the repository" });
  const repo = top.stdout.trim();
  const result = upstreamProposal({ repo, id: args.id!, out: args.out, dryRun: Boolean(args["dry-run"]) });
  const metadata = {
    id: args.id,
    dryRun: Boolean(args["dry-run"]),
    outDir: result.outDir,
    commits: result.commits,
    files: result.files.map((file) => file.name),
    hits: result.hits,
    pushed: false,
  };
  if (result.hits.length > 0 && !args["dry-run"]) {
    throw new CliErrorObject({
      code: "LEAK",
      message: `Leak scan found ${result.hits.length} hits; nothing was written`,
      details: metadata,
    });
  }
  return { outputs: result.written ? result.files.map((file) => path.join(result.outDir, file.name)) : [], metadata };
});
