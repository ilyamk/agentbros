/**
 * The console grant (RFC 0004 D12, D15): the user's own console decisions (approve, feedback, memory, policy, budget)
 * still apply while the project is paused or stopped. The console server, which holds the per-machine token of
 * `out/console/session.json`, signs each command it spawns: AGENTBROS_CONSOLE_GRANT = HMAC-SHA256(token, canonical
 * JSON of { argv, issuedAt, project }), with AGENTBROS_CONSOLE_GRANT_AT = issuedAt. runScript's pause check admits a
 * command only when the grant verifies for this exact argv (process.argv after the script) and project and is under
 * 60 s old. Environment words alone (AGENTBROS_ACTOR=user) are spoofable; the grant is not, short of the token.
 *
 * What the grant authorises, exactly: (1) runScript's pause check admits the command while the project is paused or
 * stopped; (2) `recut:plan --approve` records an edit-hash approval, but only together with the intent the server wrote
 * for that decision and argv just before the spawn (intent.ts) — the grant alone approves nothing; (3) attribution:
 * only a verified grant makes a command the user's on the console (`actor: "user"`, `channel: "console"`,
 * cli/channel.ts). It never lifts the step lease, budget admission or any other approval gate (film:approve re-checks its own `--expect` and lease).
 *
 * Trust boundary (as D15): any process of the same OS user that can read session.json can forge a grant. Defence in
 * depth: the harness hooks' guard denies agent tool calls that read or write session.json or name the grant variables
 * (scripts/hooks/lib/guard.mjs), and an approval also needs the server-written intent.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Kept equal to SESSION_FILE in src/types/console.ts (tests/console-attribution.test.ts). Read here without the zod
 * contract: every CLI verifies its attribution at start (cli/channel.ts), and loading the contract costs ~150 ms.
 */
export const GRANT_SESSION_FILE = "out/console/session.json";

/** The token of `out/console/session.json` (`{ v: 1, token: <64 hex> }` exactly, as ConsoleSessionSchema), or undefined. */
export function grantSessionToken(rootDir: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path.join(rootDir, GRANT_SESSION_FILE), "utf8")) as Record<string, unknown>;
    const exact = !!value && typeof value === "object" && Object.keys(value).sort().join() === "token,v";
    return exact && value.v === 1 && typeof value.token === "string" && /^[a-f0-9]{64}$/.test(value.token)
      ? value.token
      : undefined;
  } catch {
    return undefined;
  }
}

export const GRANT_ENV = "AGENTBROS_CONSOLE_GRANT";
export const GRANT_AT_ENV = "AGENTBROS_CONSOLE_GRANT_AT";
export const GRANT_MAX_AGE_MS = 60_000;
/** Clock skew tolerated for a grant issued "in the future" (same machine; a small allowance only). */
const GRANT_SKEW_MS = 5_000;

/** Canonical: fixed key order, argv exactly as passed. */
const canonical = (project: string, argv: readonly string[], issuedAt: string) =>
  JSON.stringify({ argv: [...argv], issuedAt, project });

const sign = (token: string, project: string, argv: readonly string[], issuedAt: string) =>
  createHmac("sha256", token)
    .update(canonical(project, argv, issuedAt))
    .digest("hex");

/**
 * The environment a console spawn adds so its command runs while `project` is paused: `argv` is exactly the arguments
 * passed after the script. Empty when the console has no session token (the command is then judged like any other).
 */
export function consoleGrantEnv(
  rootDir: string,
  project: string,
  argv: readonly string[],
  now: Date = new Date(),
): Record<string, string> {
  const token = grantSessionToken(rootDir);
  if (!token) return {};
  const issuedAt = now.toISOString();
  return { [GRANT_ENV]: sign(token, project, argv, issuedAt), [GRANT_AT_ENV]: issuedAt };
}

/** Whether `env` carries a valid, fresh console grant for this project and argv. */
export function verifyConsoleGrant(options: {
  rootDir: string;
  project: string;
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): boolean {
  const env = options.env ?? process.env;
  const grant = env[GRANT_ENV];
  const issuedAt = env[GRANT_AT_ENV];
  if (!grant || !issuedAt || !/^[0-9a-f]{64}$/.test(grant)) return false;
  const at = Date.parse(issuedAt);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== issuedAt) return false;
  const age = (options.now ?? new Date()).getTime() - at;
  if (age > GRANT_MAX_AGE_MS || age < -GRANT_SKEW_MS) return false;
  const token = grantSessionToken(options.rootDir);
  if (!token) return false;
  const expected = Buffer.from(sign(token, options.project, options.argv, issuedAt), "hex");
  return timingSafeEqual(expected, Buffer.from(grant, "hex"));
}
