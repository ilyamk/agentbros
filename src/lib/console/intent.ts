/**
 * The console's decision intent (RFC 0004 D15, WP12 review): before it spawns a command that records an approval
 * itself (`recut:plan --approve`), the console server writes `pipeline/inbox/intent/<decision>.json` with the decision
 * id and the sha256 of the exact alias and arguments it is about to run, and removes it after the child exits. The
 * command admits the approval only when that record exists for this project, decision and argv and is fresh, besides
 * the console grant: a forged grant alone (session token read) does not approve, and neither does a copied argv.
 *
 * The inbox itself holds decided decisions only (InboxDecisionFileSchema), so the intent is a separate file beside it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { INBOX_DIR } from "../../types/console";
import { GRANT_MAX_AGE_MS } from "./grant";

/** Aliases the console runs only with an intent on disk (the approval is recorded by the command, not by apply). */
export const INTENT_ALIASES = ["recut:plan"] as const;
/** A decision id safe as a file name. */
export const DECISION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** The intent outlives the spawn's grant by the command's own run time at most. */
export const INTENT_MAX_AGE_MS = GRANT_MAX_AGE_MS;

export const ConsoleIntentSchema = z.strictObject({
  v: z.literal(1),
  project: z.string().min(1).max(128),
  decisionId: z.string().regex(DECISION_ID_PATTERN),
  alias: z.string().min(1).max(64),
  argvSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The approved edit hash, for a reader (`--approve`); the argv hash binds it already. */
  editHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ConsoleIntent = z.infer<typeof ConsoleIntentSchema>;

export const needsIntent = (alias: string) => (INTENT_ALIASES as readonly string[]).includes(alias);

/** sha256 of the canonical JSON of [alias, ...args]: the arguments exactly as spawned (process.argv after the script). */
export const intentArgvHash = (alias: string, args: readonly string[]) =>
  createHash("sha256")
    .update(JSON.stringify([alias, ...args]))
    .digest("hex");

export function intentPath(rootDir: string, project: string, decisionId: string): string {
  if (!DECISION_ID_PATTERN.test(decisionId)) throw new Error(`Not a decision id: ${decisionId}`);
  return path.join(rootDir, "public", "projects", project, INBOX_DIR, "intent", `${decisionId}.json`);
}

const flagValue = (args: readonly string[], flag: string): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === flag) return args[i + 1];
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
};

/** Written by the console server under its per-project lock, just before the spawn (atomic, mode 0600). */
export function writeIntent(
  rootDir: string,
  input: { project: string; decisionId: string; alias: string; args: readonly string[]; now?: Date },
): string {
  const editHash = flagValue(input.args, "--approve");
  const intent = ConsoleIntentSchema.parse({
    v: 1,
    project: input.project,
    decisionId: input.decisionId,
    alias: input.alias,
    argvSha256: intentArgvHash(input.alias, input.args),
    ...(editHash && /^[0-9a-f]{64}$/.test(editHash) ? { editHash } : {}),
    createdAt: (input.now ?? new Date()).toISOString(),
  });
  const file = intentPath(rootDir, input.project, input.decisionId);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return file;
}

export function removeIntent(rootDir: string, project: string, decisionId: string): void {
  try {
    rmSync(intentPath(rootDir, project, decisionId), { force: true });
  } catch {
    // best effort: a stale intent expires by age
  }
}

/** Whether the server wrote this intent for exactly this project, decision, alias and argv, and recently. */
export function matchesIntent(input: {
  rootDir: string;
  project: string;
  decisionId: string;
  alias: string;
  args: readonly string[];
  now?: Date;
}): boolean {
  if (!DECISION_ID_PATTERN.test(input.decisionId)) return false;
  let intent: ConsoleIntent;
  try {
    const parsed = ConsoleIntentSchema.safeParse(
      JSON.parse(readFileSync(intentPath(input.rootDir, input.project, input.decisionId), "utf8")),
    );
    if (!parsed.success) return false;
    intent = parsed.data;
  } catch {
    return false;
  }
  const age = (input.now ?? new Date()).getTime() - Date.parse(intent.createdAt);
  return (
    intent.project === input.project &&
    intent.decisionId === input.decisionId &&
    intent.alias === input.alias &&
    intent.argvSha256 === intentArgvHash(input.alias, input.args) &&
    age <= INTENT_MAX_AGE_MS &&
    age >= -5_000
  );
}
