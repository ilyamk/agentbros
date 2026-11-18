/**
 * The `console` and `hooks` blocks of next-step answers (RFC 0004 D11, D16, §9.2, WP7a): `pnpm next`, `film:next`,
 * `footage:next` and `film:init` start or reuse the console server, count the decisions waiting for the user and list
 * the console decisions decided since this project's last next-step answer. Never throws and never fails the caller:
 * a failed or refused start is `console.error`. With `AGENTBROS_CONSOLE=off` nothing is started or written.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CONSOLE_ENV,
  CONSOLE_OUT_DIR,
  ConsoleNextBlockSchema,
  INBOX_DIR,
  InboxDecisionFileSchema,
  ProjectIdSchema,
  type ConsoleNextBlock,
  type Decision,
  type HooksStatus,
} from "../../types/console";
import { hooksStatus } from "../harness/hooks";
import { issuePairingCode, pairingUrl } from "./pairing";
import { ensureConsoleServer, type ConsoleStartResult } from "./start";
import { lastEventId } from "./wait";
import { deriveWaiting } from "./view/waiting";

/**
 * Repository-relative: `out/console/next-cursor/<project>.json` (or `<project>.<agent>.json` when `AGENTBROS_AGENT`
 * names the caller, so a leaf agent's loop does not consume the orchestrator's), what the last answer reported.
 */
export const NEXT_CURSOR_DIR = `${CONSOLE_OUT_DIR}/next-cursor`;
/** How long a next-step command waits for a new server (D16: low latency; a live one is reused at once). */
export const NEXT_START_TIMEOUT_MS = 4000;
/** At most this many decisions per answer (newest kept); the first answer for a project shows only the last few. */
export const APPLIED_SINCE_MAX = 10;
export const APPLIED_SINCE_FIRST = 3;
/** Optional caller key for the cursor (no harness sets it today; a leaf agent's environment may). */
export const AGENT_ENV = "AGENTBROS_AGENT";

const CursorSchema = z.strictObject({
  v: z.literal(1),
  project: ProjectIdSchema,
  /** decidedAt (ms) of the newest decision reported. */
  decidedAtMs: z.number().nonnegative(),
  /** Ids reported at exactly that time (ties). */
  ids: z.array(z.string()).max(256),
  updatedAt: z.string(),
});
export type NextCursor = z.infer<typeof CursorSchema>;
type Cursor = NextCursor;

export interface NextFieldsOptions {
  /** Checkout root (the next-step commands pass process.cwd()). */
  rootDir: string;
  project: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Tests: port 0, a fixed version, `--no-build`. */
  port?: number;
  version?: string;
  daemonArgs?: string[];
  /** Tests: replace the start (default ensureConsoleServer). */
  start?: (options: Parameters<typeof ensureConsoleServer>[0]) => Promise<ConsoleStartResult>;
}

export interface NextFields {
  console: ConsoleNextBlock;
  hooks: HooksStatus;
}

export const consoleOff = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env[CONSOLE_ENV.console] ?? "").trim().toLowerCase() === "off";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const AGENT_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** The cursor file of a project for a caller (`agent` when it is a safe key, else the shared one). */
export function cursorFile(rootDir: string, project: string, agent?: string): string {
  const key = agent && AGENT_KEY.test(agent) ? `${project}.${agent}` : project;
  return path.join(rootDir, NEXT_CURSOR_DIR, `${key}.json`);
}
const decidedMs = (decision: Decision) => Date.parse(decision.decidedAt ?? "") || 0;

/** Decided console decisions of a project (`pipeline/inbox/*.json`, applied or refused), oldest first. */
export function readDecided(rootDir: string, project: string): Decision[] {
  const dir = path.join(rootDir, "public", "projects", project, INBOX_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const decisions: Decision[] = [];
  for (const name of names) {
    try {
      const parsed = InboxDecisionFileSchema.safeParse(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
      if (parsed.success && parsed.data.project === project && parsed.data.status !== "superseded")
        decisions.push(parsed.data);
    } catch {
      // a torn or foreign file is skipped
    }
  }
  return decisions.sort((a, b) => decidedMs(a) - decidedMs(b) || a.id.localeCompare(b.id));
}

function readCursor(file: string, project: string): Cursor | undefined {
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success && parsed.data.project === project ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The later of two cursors (ties merge their ids): a cursor never moves backwards. */
function laterCursor(a: Cursor, b: Cursor | undefined): Cursor {
  if (!b || a.decidedAtMs > b.decidedAtMs) return a;
  if (b.decidedAtMs > a.decidedAtMs) return b;
  return { ...a, ids: [...new Set([...b.ids, ...a.ids])].slice(-256) };
}

/** Whether cursor `a` already includes everything cursor `b` reported. */
const covers = (a: Cursor, b: Cursor) =>
  a.decidedAtMs > b.decidedAtMs || (a.decidedAtMs === b.decidedAtMs && b.ids.every((id) => a.ids.includes(id)));

/**
 * Writes the cursor monotonically: the file is re-read just before the atomic rename and the later cursor kept, and
 * after the rename a concurrent writer's later cursor that landed first is restored, so concurrent answers never move
 * it backwards.
 */
export function writeCursor(file: string, cursor: Cursor): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = laterCursor(cursor, readCursor(file, cursor.project));
    writeFileSync(temporary, `${JSON.stringify(next)}\n`);
    renameSync(temporary, file);
    const now = readCursor(file, cursor.project);
    if (!now || covers(now, next)) return;
    cursor = laterCursor(now, next);
  }
}

/**
 * The decisions decided in the console since this project's last next-step answer, and advances the cursor. The first
 * call (no cursor) returns at most the last {@link APPLIED_SINCE_FIRST}; any call at most {@link APPLIED_SINCE_MAX}.
 */
export function takeAppliedSince(
  rootDir: string,
  project: string,
  options: { now?: number; agent?: string } = {},
): { decisions: Decision[]; truncated: number } {
  const file = cursorFile(rootDir, project, options.agent);
  const decided = readDecided(rootDir, project);
  const cursor = readCursor(file, project);
  const fresh = cursor
    ? decided.filter((decision) => {
        const ms = decidedMs(decision);
        return ms > cursor.decidedAtMs || (ms === cursor.decidedAtMs && !cursor.ids.includes(decision.id));
      })
    : decided.slice(-APPLIED_SINCE_FIRST);
  if (cursor && !fresh.length) return { decisions: [], truncated: 0 };
  const newest = decided.at(-1);
  const newestMs = newest ? decidedMs(newest) : (cursor?.decidedAtMs ?? 0);
  const ids = decided.filter((decision) => decidedMs(decision) === newestMs).map((decision) => decision.id);
  writeCursor(file, {
    v: 1,
    project,
    decidedAtMs: newestMs,
    ids: newest ? ids.slice(-256) : (cursor?.ids ?? []),
    updatedAt: new Date(options.now ?? Date.now()).toISOString(),
  });
  return {
    decisions: fresh.slice(-APPLIED_SINCE_MAX),
    truncated: Math.max(0, fresh.length - APPLIED_SINCE_MAX),
  };
}

function safeHooks(rootDir: string): HooksStatus {
  try {
    return hooksStatus(rootDir);
  } catch {
    return { claude: "missing", codex: "missing" };
  }
}

/**
 * The `console` and `hooks` fields for a next-step answer. Starts (or reuses) the server in parallel with counting the
 * waiting decisions; with `AGENTBROS_CONSOLE=off` starts nothing, writes no cursor and reports no decisions.
 */
export async function consoleNextFields(options: NextFieldsOptions): Promise<NextFields> {
  const env = options.env ?? process.env;
  const rootDir = path.resolve(options.rootDir);
  const hooks = safeHooks(rootDir);
  const off = consoleOff(env);
  try {
    const start = (options.start ?? ensureConsoleServer)({
      rootDir,
      project: options.project,
      env,
      timeoutMs: options.timeoutMs ?? NEXT_START_TIMEOUT_MS,
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.version !== undefined ? { version: options.version } : {}),
      ...(options.daemonArgs ? { daemonArgs: options.daemonArgs } : {}),
    }).catch((error: unknown): ConsoleStartResult => ({ error: message(error) }));
    const pending = (await deriveWaiting(rootDir, options.project).catch(() => [])).length;
    let appliedSince: Decision[] = [];
    let truncated = 0;
    let cursorError: string | undefined;
    if (!off)
      try {
        const agent = env[AGENT_ENV]?.trim();
        ({ decisions: appliedSince, truncated } = takeAppliedSince(rootDir, options.project, agent ? { agent } : {}));
      } catch (error) {
        cursorError = `appliedSince: ${message(error)}`;
      }
    let lastId: string | undefined;
    try {
      lastId = lastEventId(rootDir, options.project);
    } catch {
      // no journal id: console:wait falls back to the last next-step answer
    }
    const started = await start;
    const error = "error" in started ? started.error : cursorError;
    // A one-use pairing link (pairing.ts), never the token: a fresh browser opening it gets a session once.
    const baseUrl = "error" in started ? started.existingBaseUrl : started.baseUrl;
    let url: string | undefined;
    if (!off && baseUrl)
      try {
        url = pairingUrl(baseUrl, issuePairingCode(rootDir), options.project);
      } catch {
        url = new URL(`/#/projects/${encodeURIComponent(options.project)}`, baseUrl).href;
      }
    const block = ConsoleNextBlockSchema.parse({
      ...(url ? { url } : {}),
      ...(error ? { error: error.slice(0, 2000) } : {}),
      pending,
      appliedSince,
      ...(truncated ? { truncated } : {}),
      ...(lastId ? { lastEventId: lastId } : {}),
    });
    return { console: block, hooks };
  } catch (error) {
    return { console: { error: message(error).slice(0, 2000), pending: 0, appliedSince: [] }, hooks };
  }
}
