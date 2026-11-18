/**
 * Pause, resume or stop a project with the user's words (RFC 0004 D12): writes `pipeline/session/control.json`
 * atomically and journals `control.changed`. While a project is paused or stopped, runScript refuses every
 * non-control command with `PAUSED`; paid jobs already submitted still complete (soft pause). A stop also returns the
 * in-flight paid jobs with their reservations, which the user may cancel one by one with `job:cancel`.
 */
import { lstatSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import { processAttribution } from "../src/lib/cli/channel";
import { requireUserWords } from "../src/lib/cli/user-words";
import { writeControl } from "../src/lib/console/control";
import { projectTarget, recordEvent } from "../src/lib/console/journal";
import { inFlightJobs } from "../src/lib/jobs/cancel";
import { CONTROL_FILE, CONTROL_STATES, type ControlState } from "../src/types/console";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project to control" },
    { name: "state", required: true, choices: CONTROL_STATES, description: "running, paused or stopped" },
    { name: "answer", required: true, description: "The user's own words, verbatim (never the agent's)" },
    { name: "reason", description: "A short reason shown in the console and in the PAUSED message" },
  ] as const);
  const project = args.project!;
  validateProjectId(project);
  const projectDir = path.join("public", "projects", project);
  const stat = lstatSync(projectDir, { throwIfNoEntry: false });
  if (!stat?.isDirectory())
    throw new CliErrorObject({
      code: "PROJECT_NOT_FOUND",
      message: `Project "${project}" not found. Expected the folder ${projectDir}`,
    });
  const answer = args.answer!;
  requireUserWords(answer, "--answer");
  if (answer.length > 4000)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--answer is limited to 4000 characters." });
  if (args.reason !== undefined && (args.reason.length > 2000 || !args.reason.trim()))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--reason must be 1 to 2000 characters." });
  const state = args.state as ControlState;
  // The console and the user only with a grant signed for this argv (cli/channel.ts); env words alone are recorded as
  // `claimed`. Journaled while the control file's lock is held, so journal lines follow the file's order. Any resume
  // not verified as the console's is flagged, and the history's `channel: "cli"` shows "resumed via CLI" (D12).
  const who = processAttribution();
  const channel = who.verified ? "console" : "cli";
  const actor = who.verified ? "user" : "agent";
  const { control, previous } = writeControl(
    projectDir,
    { state, answer, channel, ...(args.reason ? { reason: args.reason } : {}) },
    ({ previous }) =>
      recordEvent(projectTarget(process.cwd(), project), {
        kind: "control.changed",
        project,
        data: {
          state,
          previous,
          answer,
          channel,
          actor,
          ...(who.claimed ? { claimed: who.claimed } : {}),
          ...(args.reason ? { reason: args.reason } : {}),
          ...(state === "running" && previous !== "running" && channel === "cli" ? { resumedViaCli: true } : {}),
        },
      }),
  );
  const resumedViaCli = state === "running" && previous !== "running" && channel === "cli";
  // The project is stopped already: a store that cannot be read is reported, never turned into a failed stop.
  let inFlight: ReturnType<typeof inFlightJobs> | undefined;
  let runningJobsError: string | undefined;
  if (state === "stopped")
    try {
      inFlight = inFlightJobs(projectDir);
    } catch (error) {
      runningJobsError = `The paid jobs could not be listed: ${error instanceof Error ? error.message : String(error)}`;
    }
  const runningJobs = inFlight?.jobs;
  const omitted = inFlight?.omitted ?? [];
  return {
    outputs: [path.join(projectDir, CONTROL_FILE)],
    metadata: {
      project,
      state,
      previous,
      changed: previous !== state,
      channel,
      actor,
      ...(resumedViaCli
        ? { notice: `Resumed from the CLI (${actor}), not in the console; the console shows this resume to the user.` }
        : {}),
      control,
      ...(runningJobs ? { runningJobs } : {}),
      ...(omitted.length ? { runningJobsOmitted: omitted } : {}),
      ...(runningJobsError ? { runningJobsError } : {}),
      next:
        state === "running"
          ? `Resumed: run pnpm next --project ${project}.`
          : `Every non-control command of ${project} now fails with PAUSED until the user resumes it.${
              runningJobs?.length
                ? ` ${runningJobs.length} paid job(s) are in flight; the user may cancel each one with pnpm job:cancel --project ${project} --operation-id <id> --answer "<the user's words>".`
                : ""
            }${omitted.length ? ` ${omitted.length} more in-flight job(s) have ids too long to list here: see metadata.runningJobsOmitted.` : ""}${
              runningJobsError ? ` ${runningJobsError}` : ""
            }`,
    },
  };
});
