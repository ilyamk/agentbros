import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { draftContributionPr } from "../src/lib/contrib/pr";

void runOffline(async () => {
  const args = parseArgs([
    { name: "base", description: "Diff base; tries upstream/main, origin/main, remote HEAD refs, then main" },
    { name: "category", description: "Category; must agree with the change entry" },
    { name: "size", description: "S, M or L; defaults to the diff's line count" },
    { name: "issue", type: "number", description: "Issue number (required for M or L)" },
    { name: "autonomy", description: "autonomous, assisted (default) or human" },
    { name: "harness", description: "claude-code, codex or other; defaults to the change entry" },
    { name: "model", required: true, description: "Model used, declared by the contributor" },
    { name: "owner", required: true, description: "Accountable GitHub handle" },
    { name: "what", description: "What changed; defaults to the change-entry body" },
    { name: "why", description: "Concrete problem and reason for the change" },
    { name: "risks", description: "Remaining risks and limitations" },
    { name: "out", description: "Also write the PR body to this file; never sends to GitHub" },
  ] as const);
  const body = draftContributionPr({ root: process.cwd(), ...args, model: args.model!, owner: args.owner! });
  if (args.out) {
    mkdirSync(path.dirname(args.out), { recursive: true });
    writeFileSync(args.out, body);
  }
  return { outputs: args.out ? [args.out] : [], metadata: { body } };
});
