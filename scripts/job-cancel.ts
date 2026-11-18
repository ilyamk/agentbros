/**
 * Cancel one paid job on the user's words (RFC 0004 D12), usually after a stop: a job not yet submitted is cancelled
 * locally; a submitted Higgsfield job through the provider's cancel call (settled only when the provider reports it
 * cancelled); any other provider or state is recorded as unavailable, never faked. One job per call.
 */
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, requireEnv, runScript, validateProjectId } from "../src/lib/cli";
import { requireUserWords } from "../src/lib/cli/user-words";
import { cancelJob, jobSummary, UnknownJobError } from "../src/lib/jobs/cancel";
import { OperationStore } from "../src/lib/jobs/store";
import { createHiggsfieldClient } from "../src/lib/providers/higgsfield/client";
import { OperationIdSchema } from "../src/types/console";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project whose job to cancel" },
    {
      name: "operation-id",
      required: true,
      description: "The job's operation ID (console:control --state stopped lists them)",
    },
    { name: "answer", required: true, description: "The user's own words asking for this cancel, verbatim" },
  ] as const);
  const project = args.project!;
  validateProjectId(project);
  const projectDir = path.join("public", "projects", project);
  if (!lstatSync(projectDir, { throwIfNoEntry: false })?.isDirectory())
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project "${project}" not found.` });
  const operationId = args["operation-id"]!;
  if (!OperationIdSchema.safeParse(operationId).success)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid --operation-id." });
  const answer = args.answer!;
  requireUserWords(answer, "--answer");
  if (answer.length > 4000)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--answer is limited to 4000 characters." });
  const directory = path.join(projectDir, "pipeline");
  if (!existsSync(path.join(directory, "operations.json")))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Project ${project} has no paid jobs.` });
  const store = new OperationStore(project, { directory });
  try {
    const result = await cancelJob({
      store,
      operationId,
      answer,
      higgsfield: () => createHiggsfieldClient({ credentials: requireEnv("HIGGSFIELD_API_KEY") }),
    });
    return {
      outputs: [path.join(directory, "operations.json")],
      metadata: {
        project,
        operationId,
        outcome: result.outcome,
        cancelled: result.outcome === "cancelled",
        message: result.message,
        job: jobSummary(result.job),
      },
    };
  } catch (error) {
    if (error instanceof UnknownJobError)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: error.message, details: { unknownJob: true } });
    throw error;
  }
});
