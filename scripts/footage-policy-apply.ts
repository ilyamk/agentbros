/**
 * Answers one footage:next question from the user's autonomous policy (pipeline/policy.json of the recording's source
 * project): the caption style, or which ranked shorts to approve. It re-derives the basis, refuses when the judged file
 * changed since footage:next (--expect), writes the answer and appends the decision to pipeline/decisions.jsonl;
 * film:revert revokes it. footage:next prints this command; nothing else should. CLI only, never MCP.
 */
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { applyFootagePolicy, PolicyApplyRefusal } from "../src/lib/footage/policy-apply";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "The recording's source project (a recut id resolves to it)" },
    { name: "apply", required: true, choices: ["captionStyle", "shorts"] as const, description: "Which pre-answer" },
    { name: "expect", required: true, description: "The sha256 footage:next printed (goals or proposals.json)" },
  ] as const);
  try {
    const { decision, outputs } = applyFootagePolicy(
      args.project!,
      args.apply as "captionStyle" | "shorts",
      args.expect!,
    );
    return {
      outputs,
      metadata: {
        decision,
        revert: `pnpm film:revert --project ${args.project} --decision ${decision.id} --answer "<the user's words>"`,
        next: `pnpm footage:next --project ${args.project}`,
      },
    };
  } catch (error) {
    if (error instanceof PolicyApplyRefusal) throw new CliErrorObject({ code: "VALIDATION", message: error.message });
    if (error instanceof Error && error.name === "ZodError")
      throw new CliErrorObject({ code: "VALIDATION", message: error.message });
    throw error;
  }
});
