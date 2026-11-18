/**
 * runScript's pause check (RFC 0004 D12): a paused or stopped project refuses every command that is not a control
 * command, with error code `PAUSED`, whatever AGENTBROS_STEP_GUARD says. It judges the running script by its registry
 * aliases, as the step guard does (a script any of whose aliases is a control alias is admitted) and names the
 * script's first alias, so its message equals the guard hook's. Every project the command line names is judged
 * (`--project`, `-p`, every occurrence), so a decoy value cannot hide the one parseArgs keeps. Loaded only when a
 * named project has a paused or stopped control file. A command the console server spawned for the user carries a
 * console grant (grant.ts) and is admitted for that project; the grant lifts only the pause, never the step lease.
 */
import path from "node:path";
import { entriesForScript, scriptOf } from "../step-lease/guard";
import { CONTROL_ALIASES } from "../step-lease/lease";
import { verifyConsoleGrant } from "./grant";
import {
  COMPLETION_SCRIPTS,
  completesSubmittedJob,
  operationIdFromArgv,
  pauseCandidates,
  pauseMessage,
  projectsFromArgv,
  readControlLenient,
} from "./control";

export type PauseVerdict = { message: string; details: Record<string, unknown> };

/** The refusal for this process (argv as process.argv), or undefined when it may run. */
export function pauseVerdict(options: {
  rootDir: string;
  argv: readonly string[];
  /** Default: the registry aliases of argv[1]'s script. */
  aliases?: readonly string[];
  /** Default: argv[1]'s repository-relative script. */
  script?: string;
  /** Default: process.env (the console grant). */
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): PauseVerdict | undefined {
  const args = options.argv.slice(2);
  const named = [...new Set(projectsFromArgv(args))];
  const projects = pauseCandidates(named);
  const script = options.script ?? scriptOf(options.argv[1]);
  let aliases = options.aliases;
  for (const project of projects) {
    const projectDir = path.join(options.rootDir, "public", "projects", project);
    const control = readControlLenient(projectDir);
    if (!control || control.state === "running") continue;
    aliases ??= script ? entriesForScript(script).map((entry) => entry.alias!) : [];
    if (aliases.some((alias) => (CONTROL_ALIASES as readonly string[]).includes(alias))) return undefined;
    // The user's own decision from the console: a grant signed for exactly this argv and project (grant.ts).
    if (verifyConsoleGrant({ rootDir: options.rootDir, project, argv: args, env: options.env, now: options.now }))
      continue;
    // Soft pause: a script that runs exactly the one job it names, and that job is already submitted, only finishes
    // what is paid for. A repeated --operation-id or a script that derives ids from it is not exempt.
    const completes =
      script !== undefined &&
      (COMPLETION_SCRIPTS as readonly string[]).includes(script) &&
      named.length === 1 &&
      completesSubmittedJob(projectDir, operationIdFromArgv(args));
    if (completes) return undefined;
    const alias = aliases[0] ?? script ?? path.basename(options.argv[1] ?? "command");
    return {
      message: pauseMessage(project, control, alias),
      details: {
        project,
        state: control.state,
        by: "user",
        at: control.at,
        ...(control.answer ? { answer: control.answer } : {}),
        ...(control.reason ? { reason: control.reason } : {}),
        alias,
        retry: false,
      },
    };
  }
  return undefined;
}
