import path from "node:path";
import { writeFileSync } from "node:fs";
import { parseArgs, runScript, requireProject, assertPathWithin, CliErrorObject } from "../src/lib/cli";
import { sourceWordProposal } from "../src/lib/ingest/word-proposal";
runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project slug" },
    { name: "index", required: true, description: "Immutable source index JSON" },
    { name: "output", required: true, description: "New project-local proposal JSON" },
    { name: "frames", type: "boolean", description: "Use verified source CFR frame clock; refuse collapsed words" },
  ] as const);
  requireProject(args.project!);
  const output = path.resolve(args.output!);
  assertPathWithin(path.resolve("public/projects", args.project!), output);
  try {
    const proposal = sourceWordProposal(args.project!, args.index!, args.frames);
    writeFileSync(output, JSON.stringify(proposal, null, 2) + "\n", { flag: "wx" });
    return {
      outputs: [output],
      metadata: {
        method: proposal.method,
        clock: proposal.clock,
        words: proposal.words.length,
        estimated: true,
        reviewRequired: true,
        approved: false,
      },
    };
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({ code: "VALIDATION", message: error instanceof Error ? error.message : String(error) });
  }
});
