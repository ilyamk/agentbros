/** A time-limited, reasoned exception to a project's step lease: appended to pipeline/session/unlocks.jsonl. Spend still needs the user's approval. CLI only (docs/step-lease.md). */
import { existsSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import { projectDirOf, readLease, UNLOCK_MAX_MINUTES, unlocksFile, writeUnlock } from "../src/lib/step-lease/lease";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    {
      name: "reason",
      required: true,
      description: "Why commands outside the current step must run now; recorded and reported by film:status",
    },
    {
      name: "minutes",
      type: "number",
      default: 30,
      description: `How long the unlock lasts (1-${UNLOCK_MAX_MINUTES})`,
    },
  ] as const);
  const projectId = args.project!;
  validateProjectId(projectId);
  const projectDir = projectDirOf(process.cwd(), projectId);
  if (!existsSync(projectDir))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project "${projectId}" not found.` });
  let unlock;
  try {
    unlock = writeUnlock(projectDir, { reason: args.reason!, minutes: args.minutes! });
  } catch (error) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const loaded = readLease(projectDir);
  return {
    outputs: [path.relative(process.cwd(), unlocksFile(projectDir))],
    metadata: {
      projectId,
      unlock,
      lease: loaded && "lease" in loaded ? { step: loaded.lease.step, owner: loaded.lease.owner } : null,
      note: "Commands outside the step run until the unlock ends; each is recorded in pipeline/session/violations.jsonl as unlocked. Spend still needs the user's approval.",
    },
  };
});
