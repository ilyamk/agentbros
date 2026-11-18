/**
 * Who ran this command and through which channel (RFC 0004 D9, D10, D12, D15). The studio console spawns the owning
 * CLI with `AGENTBROS_ACTOR=user`, `AGENTBROS_CHANNEL=console` and a console grant signed for exactly that argv and
 * project (console/grant.ts). Environment words alone are spoofable, so the user and the console are believed only
 * when the grant verifies for this process's argv: then records that carry the user's words (approvals, policy
 * grants, ceiling grants, feedback, memory, ratings, control changes) note `channel: "console"`, and the journal
 * writes `actor: "user"`. Otherwise an env claim of either is ignored for attribution (reported as `claimed`), and
 * the CLI is the default.
 *
 * The verdict is taken once per process, at runScript's start (before guardPause clears the grant from the
 * environment and before the 60 s grant could expire during a long run), and memoised.
 */
import { verifyConsoleGrant } from "../console/grant";

export type WordsChannel = { channel?: "console" };

export type Actor = "agent" | "user" | "system";
export type Channel = "cli" | "console" | "mcp" | "hook";

export interface Attribution {
  actor: Actor;
  channel: Channel;
  /** A console grant signed for this exact argv verified: the user's own console decision. */
  verified: boolean;
  /** The env asked for `actor: "user"` or `channel: "console"` without a valid grant; recorded, never believed. */
  claimed?: { actor?: string; channel?: string };
}

const ACTORS: readonly string[] = ["agent", "user", "system"];
const CHANNELS: readonly string[] = ["cli", "console", "mcp", "hook"];

/** Every `--project`/`-p` value of the arguments (both `--flag value` and `--flag=value`). */
function projectsOf(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const equal = token.indexOf("=");
    const flag = equal < 0 ? token : token.slice(0, equal);
    if (flag !== "--project" && flag !== "-p") continue;
    const value = equal < 0 ? args[i + 1] : token.slice(equal + 1);
    if (value !== undefined) values.push(value);
    if (equal < 0) i++;
  }
  return [...new Set(values)];
}

export interface AttributionOptions {
  env?: NodeJS.ProcessEnv;
  /** process.argv shape: the grant covers `argv.slice(2)`. */
  argv?: readonly string[];
  /** Checkout root holding out/console/session.json (default: the cwd, as the pause check). */
  rootDir?: string;
  now?: Date;
}

/**
 * The attribution of a command: the console and the user only with a grant verified for its argv and one of the
 * projects it names (`""` when it names none: the console signs project-less spawns that way); `mcp`, `hook` and
 * `system` are taken from the env as they grant nothing; anything else is `agent` on the `cli`.
 */
export function resolveAttribution(options: AttributionOptions = {}): Attribution {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const args = argv.slice(2);
  const envActor = env.AGENTBROS_ACTOR ?? "";
  const envChannel = env.AGENTBROS_CHANNEL ?? "";
  const claimsUser = envActor === "user" || envChannel === "console";
  if (claimsUser) {
    const rootDir = options.rootDir ?? process.cwd();
    const projects = projectsOf(args);
    const verified = (projects.length ? projects : [""]).some((project) => {
      try {
        return verifyConsoleGrant({ rootDir, project, argv: args, env, now: options.now });
      } catch {
        return false;
      }
    });
    if (verified) return { actor: "user", channel: "console", verified: true };
  }
  const actor: Actor = envActor !== "user" && ACTORS.includes(envActor) ? (envActor as Actor) : "agent";
  const channel: Channel = envChannel !== "console" && CHANNELS.includes(envChannel) ? (envChannel as Channel) : "cli";
  return {
    actor,
    channel,
    verified: false,
    ...(claimsUser
      ? {
          claimed: {
            ...(envActor ? { actor: envActor.slice(0, 32) } : {}),
            ...(envChannel ? { channel: envChannel.slice(0, 32) } : {}),
          },
        }
      : {}),
  };
}

let memo: Attribution | undefined;

/**
 * This process's attribution, decided on first call and kept (runScript calls it before anything clears the grant).
 * Tests that change the environment call {@link resetProcessAttribution}.
 */
export function processAttribution(): Attribution {
  return (memo ??= resolveAttribution());
}

/** Test helper: forget the memoised verdict. */
export function resetProcessAttribution(): void {
  memo = undefined;
}

/**
 * `{ channel: "console" }` when the console spawned this command for the user (grant verified), else `{}`. With an
 * explicit `env`, that env is judged against this process's argv (tests); without, the memoised process verdict.
 */
export function wordsChannel(env?: NodeJS.ProcessEnv): WordsChannel {
  const attribution = env ? resolveAttribution({ env }) : processAttribution();
  return attribution.verified ? { channel: "console" } : {};
}
