/**
 * Block until the user acts in the console for a project (RFC 0004 D11, §8): a decision applied or refused, a control
 * change (pause, resume, stop) or a card answer after `--since <eventId>` (default: after the newest next-step answer
 * in the project's journal, else after the start), then print it as one
 * JSON line. A timeout or a signal is not an error: `metadata.event` is `timeout` or `interrupted`. Reads only; a
 * control alias, so the step lease and a pause admit it. In Claude Code run it in the background at a gate.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import { DEFAULT_WAIT_MINUTES, lastNextAnswerId, MAX_WAIT_MS, waitForConsole } from "../src/lib/console/wait";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project to wait on" },
    {
      name: "timeout-min",
      type: "number",
      description: `Give up after this many minutes (default ${DEFAULT_WAIT_MINUTES}, at most 1440)`,
    },
    {
      name: "since",
      description:
        "A journal event id (console.lastEventId of a next-step answer): count only actions after it (default: after the newest next, film:next, footage:next or film:init answer, else after the start)",
    },
  ] as const);
  const project = args.project!;
  validateProjectId(project);
  if (!existsSync(path.join("public", "projects", project)))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project "${project}" not found.` });
  const minutes = args["timeout-min"] ?? DEFAULT_WAIT_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--timeout-min must be a positive number." });
  if (args.since !== undefined && !z.ulid().safeParse(args.since).success)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--since must be a journal event id (a ULID)." });

  // Without --since: after the agent's last next-step answer, so a decision applied since that answer is not missed.
  const since = args.since ?? lastNextAnswerId(process.cwd(), project);
  const sinceFrom = args.since ? "flag" : since ? "next" : "start";
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    // The envelope is printed on the next tick; never hang on a signal.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const waiting = waitForConsole({
    rootDir: process.cwd(),
    project,
    ...(since ? { since } : {}),
    timeoutMs: Math.min(minutes * 60_000, MAX_WAIT_MS),
    signal: controller.signal,
  });
  process.stderr.write(`console:wait: waiting for the user's console action on ${project} (${minutes} min)\n`);
  const outcome = await waiting;
  return { metadata: { projectId: project, ...outcome, since: since ?? null, sinceFrom } };
});
