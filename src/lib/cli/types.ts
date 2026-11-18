/**
 * Shared TypeScript types for the CLI helper module.
 *
 * Every production script emits exactly one JSON line on stdout using the
 * CliResult shape, and free-form progress lines on stderr.
 */

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  "PARTIAL_FAILURE",
  "RATE_LIMIT", // upstream throttled — retry with backoff
  "INSUFFICIENT_BALANCE", // provider balance exhausted
  "MISSING_API_KEY", // env var missing
  "VALIDATION", // zod schema or invariant failed
  "NETWORK", // fetch failed
  "FFMPEG_MISSING", // ffmpeg/ffprobe not installed
  "FFMPEG_FAILED", // ffmpeg exit code non-zero
  "INVALID_INPUT", // user passed a bad argument
  "FILE_NOT_FOUND", // expected input file missing
  "FILE_EXISTS", // would overwrite without --force
  "PROJECT_NOT_FOUND", // unknown project id
  "STAGE_INCOMPLETE", // upstream pipeline stage missing its artefact
  "TIMEOUT", // long-running operation exceeded budget
  "RENDER_STALLED", // renderer stopped advancing twice; details name the stuck frame
  "ASSET_MISSING", // shared media not on disk; run the named pnpm assets:sync command
  "LEAK", // a leak scan found private text; details name the hits
  "BUDGET_EXCEEDED", // paid admission refused by a ceiling, per-job limit or allocation; details carry the amounts
  "PAUSED", // the user paused or stopped the project in the console (RFC 0004 D12); halt, tell the user, never retry
  "INTERNAL", // catch-all
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type CliSuccess<M = Record<string, unknown>> = {
  ok: true;
  /** Files created, relative to the repository root. */
  outputs: string[];
  /** Arbitrary metadata: model, cost, dimensions, duration, etc. */
  metadata: M;
  elapsedMs: number;
};

export type CliError = {
  ok: false;
  error: ErrorCode;
  message: string;
  /** Optional hint for the orchestrator: how long to wait before retrying. */
  retryAfterMs?: number;
  details?: Record<string, unknown>;
  /** Set by sensors, whose failing result carries the same report as a passing one. */
  metadata?: Record<string, unknown>;
  /** Files a failing sensor still wrote (its report), as on success. */
  outputs?: string[];
  elapsedMs: number;
};

export type CliResult<M = Record<string, unknown>> = CliSuccess<M> | CliError;

// ---------------------------------------------------------------------------
// Argument specification
// ---------------------------------------------------------------------------

export type ArgSpec = {
  /** Long flag name, e.g. "project". Becomes --project on the CLI. */
  name: string;
  /** Single-character short alias, e.g. "p" for -p. */
  short?: string;
  required?: boolean;
  default?: string | boolean | number;
  type?: "string" | "boolean" | "number";
  description: string;
  /** Restrict the value to a specific set of allowed strings. */
  choices?: readonly string[];
};

// ---------------------------------------------------------------------------
// Inference helper for parseArgs return type
// ---------------------------------------------------------------------------

type ArgValue<A extends ArgSpec> = A["type"] extends "boolean"
  ? boolean
  : A["type"] extends "number"
    ? number
    : string | undefined;

/**
 * Maps an ArgSpec tuple to a typed record. Keys are the spec `name` fields.
 *
 * Example:
 *   const SPECS = [{ name: "project", ... }, { name: "force", type: "boolean", ... }] as const;
 *   type Result = ArgsResult<typeof SPECS>;
 *   // { project: string | undefined; force: boolean }
 */
export type ArgsResult<S extends readonly ArgSpec[]> = {
  [K in S[number] as K["name"]]: ArgValue<K>;
};
