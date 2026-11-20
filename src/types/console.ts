import { z } from "zod";

/**
 * The studio console's contract (RFC 0004 §6, §9; docs/rfcs/0004-studio-console.md): the event journal, the project
 * read model, decisions, agent cards, the control file, the server's lock and session files, the hook cursor, ratings,
 * the `console` block of next-step answers and the HTTP and SSE bodies of the local server.
 *
 * Frozen at the end of WP0: change it only through an amendment line in the RFC's §17.
 *
 * This file is imported by the browser bundle (apps/console) as well as by Node code, so it must stay free of `node:*`
 * imports and of anything that pulls them in (src/lib/cli/index.ts does). Paths are plain POSIX strings.
 */

// ---------------------------------------------------------------------------
// Files, directories and switches
// ---------------------------------------------------------------------------

export const CONSOLE_SCHEMA_VERSION = 1 as const;

/** Repository-relative root of every project; a project's own paths below are relative to `public/projects/<id>/`. */
export const PROJECTS_DIR = "public/projects";
/** Repository-relative root of a project's renders: `out/<id>/`. */
export const OUT_DIR = "out";

/** Project-relative: the project's event journal (D7). Rotated at {@link EVENTS_ROTATE_BYTES} to `events.<n>.jsonl.gz`. */
export const EVENTS_FILE = "pipeline/events.jsonl";
/** Project-relative: one decided decision per file, `pipeline/inbox/<decisionId>.json` (D9). Pending ones are computed. */
export const INBOX_DIR = "pipeline/inbox";
/** Project-relative: pause, stop and resume (D12, §6.5). */
export const CONTROL_FILE = "pipeline/session/control.json";
/** Project-relative: agent cards, `pipeline/cards/<cardId>.json` (D14). */
export const CARDS_DIR = "pipeline/cards";
/** Project-relative: the user's ratings of references, styleframes and renders (`ref:rate`, WP9). */
export const RATINGS_FILE = "pipeline/ratings.json";

/** Repository-relative: everything the console writes outside projects (git-ignored; deleting it loses nothing). */
export const CONSOLE_OUT_DIR = "out/console";
/** Repository-relative: events of commands without a valid project (`playbook`, `film:init` before the project exists). */
export const GLOBAL_EVENTS_FILE = "out/console/events.jsonl";
/** Repository-relative: the built UI bundle (one `app.js`, one `style.css`, `index.html`). */
export const CONSOLE_DIST_DIR = "out/console/dist";
/** Repository-relative: lock of the running server, reused by every caller (D16). */
export const SERVER_LOCK_FILE = "out/console/server.json";
/** Repository-relative: the per-machine token, mode 0600, stable across restarts (D15). */
export const SESSION_FILE = "out/console/session.json";
/** Repository-relative: the detached server's log. */
export const SERVER_LOG_FILE = "out/console/server.log";
/** Repository-relative: hook cursor state, `out/console/hooks/<session>.json` (§7.1 H6). */
export const HOOKS_CURSOR_DIR = "out/console/hooks";
/** Repository-relative: thumbnails and frame strips keyed by content hash (FR7). */
export const CONSOLE_CACHE_DIR = "out/console/cache";
/** Repository-relative: interaction metrics (§12). */
export const METRICS_FILE = "out/console/metrics.json";

export const DEFAULT_CONSOLE_PORT = 4317;
/** Header that every state-changing request carries (CSRF, D15). */
export const CONSOLE_TOKEN_HEADER = "x-console-token";
/** Idle shutdown of the server (§9.2). */
export const CONSOLE_IDLE_SHUTDOWN_MS = 12 * 60 * 60 * 1000;

/** Environment switches and the variables the journal propagates. `off` disables; see each RFC decision. */
export const CONSOLE_ENV = {
  /** `off`: no auto-start (D16). Tests and benchmarks set it. */
  console: "AGENTBROS_CONSOLE",
  /** `off`: no journal lines (D7). */
  events: "AGENTBROS_EVENTS",
  /** `off`: every hook role disabled; `observe`: only observe (§7.1 H8). */
  hooks: "AGENTBROS_HOOKS",
  /** Pairs `cli.start`/`cli.end`; a child reads it as its `parentRunId`. */
  runId: "AGENTBROS_RUN_ID",
  /** `user` when the console spawns a CLI for a decision (D9). */
  actor: "AGENTBROS_ACTOR",
  /** `console` when the console spawns a CLI (D9). */
  channel: "AGENTBROS_CHANNEL",
} as const;

/** Journal limits (D7, §6.1). */
export const EVENT_DATA_MAX_BYTES = 8 * 1024;
export const EVENTS_ROTATE_BYTES = 10 * 1024 * 1024;
/** Redaction (§6.1): flags whose name matches are replaced by {@link REDACTED}; longer strings are truncated. */
export const REDACT_FLAG_PATTERN = /key|token|secret|password|auth/i;
export const REDACTED = "<redacted>";
export const REDACT_MAX_STRING = 512;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Same rule as `validateProjectId` in src/lib/cli. */
export const ProjectIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "a lowercase alphanumeric slug with hyphens");

/** File-name-safe identifier for decisions, cards, ratings and runs: no separators, never `.` or `..`. */
export const ConsoleIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "a file-name-safe id");

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "a lowercase hex SHA-256");
export const IsoTimeSchema = z.iso.datetime({ offset: true });
export const UsdSchema = z.number().finite().nonnegative();
const Count = z.number().int().nonnegative();
const Text = (max: number) => z.string().min(1).max(max);

/**
 * A safe relative POSIX path: non-empty, at most 1024 characters, no leading `/`, no backslash, no drive letter or
 * scheme, no NUL or control character, no empty, `.` or `..` segment. Pure string check, usable in the browser; the
 * server still resolves and confines every path on disk (symlinks included, D15).
 */
export function isSafeRelativePath(value: string): boolean {
  if (!value || value.length > 1024) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false; // C:, file:, http:
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Joins safe relative segments with `/`; throws on an unsafe result. */
export function joinRelative(...segments: string[]): string {
  const joined = segments.filter(Boolean).join("/");
  if (!isSafeRelativePath(joined)) throw new Error(`Unsafe relative path: ${joined}`);
  return joined;
}

/** Repository-relative path of a project file: `public/projects/<id>/<relative>`. */
export const projectFile = (project: string, relative: string) => joinRelative(PROJECTS_DIR, project, relative);
/** Repository-relative path of a render: `out/<id>/<relative>`. */
export const outFile = (project: string, relative: string) => joinRelative(OUT_DIR, project, relative);
/** Project-relative inbox file of a decision. */
export const inboxFile = (decisionId: string) => joinRelative(INBOX_DIR, `${decisionId}.json`);
/** Project-relative file of a card. */
export const cardFile = (cardId: string) => joinRelative(CARDS_DIR, `${cardId}.json`);
/** Repository-relative hook cursor of a harness session. */
export const hookCursorFile = (session: string) => joinRelative(HOOKS_CURSOR_DIR, `${session}.json`);

/** A path relative to a project root ({@link isSafeRelativePath}). */
export const RelativePathSchema = z.string().refine(isSafeRelativePath, "a relative path inside the project");

/** Agent content is Markdown without HTML: a tag-like `<` is refused rather than sanitised away. */
export const MarkdownSchema = z
  .string()
  .max(20_000)
  .refine((text) => !/<[/!?A-Za-z]/.test(text), "Markdown without HTML");

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const ROUTES = ["film", "footage", "recipe", "campaign", "replica", "timeline"] as const;
export const RouteSchema = z.enum(ROUTES);
export type Route = z.infer<typeof RouteSchema>;

export const FORMATS = ["vertical", "square", "landscape"] as const;
export const FormatSchema = z.enum(FORMATS);

export const CONTROL_STATES = ["running", "paused", "stopped"] as const;
export const ControlStateSchema = z.enum(CONTROL_STATES);
export type ControlState = z.infer<typeof ControlStateSchema>;

export const ACTORS = ["agent", "user", "system"] as const;
export const ActorSchema = z.enum(ACTORS);
export const CHANNELS = ["cli", "console", "mcp", "hook"] as const;
export const ChannelSchema = z.enum(CHANNELS);

/** Harnesses the hooks know; any other harness name is kept as given. */
export const HarnessSchema = z.union([z.enum(["claude-code", "codex"]), Text(64)]);

/**
 * Step status: the film chain's own statuses (`deriveChain`, src/lib/film/state.ts) plus `pending` (not reached yet)
 * and `running` (footage and timeline routes, which have no chain derivation).
 */
export const STEP_STATUSES = [
  "done",
  "skipped",
  "ready",
  "blocked",
  "invalid",
  "failing",
  "unsealed",
  "stale",
  "awaiting-gate",
  "pending",
  "running",
] as const;
export const StepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof StepStatusSchema>;

/** Paid job status as in src/lib/jobs/types.ts (`JobStatusSchema`). */
export const JOB_STATES = [
  "planned",
  "reserved",
  "submitting",
  "queued",
  "running",
  "result-ready",
  "downloading",
  "validated",
  "published",
  "failed",
  "cancelled",
  "unknown",
] as const;
export const JobStateSchema = z.enum(JOB_STATES);

// ---------------------------------------------------------------------------
// CLI envelope (the one JSON line every production CLI prints)
// ---------------------------------------------------------------------------

/**
 * Loose on purpose: CLIs add their own metadata, details and fields, and the error code list grows (`PAUSED`, WP8), so
 * `error` is any non-empty code string here.
 */
export const CliEnvelopeSchema = z
  .looseObject({
    ok: z.boolean(),
    outputs: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    elapsedMs: z.number().nonnegative().optional(),
    error: Text(64).optional(),
    message: z.string().optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((envelope) => envelope.ok || envelope.error !== undefined, "a failed envelope names its error code");
export type CliEnvelope = z.infer<typeof CliEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export const MEDIA_KINDS = ["video", "image", "audio", "strip", "document"] as const;
export const MediaKindSchema = z.enum(MEDIA_KINDS);

/**
 * A file the console shows. `root` names the tree `path` is relative to: `project` (default) is
 * `public/projects/<id>/`, `out` is `out/<id>/` (renders). Never absolute, never `..` (D14, D15).
 * `renderedAt`, `sourceHash` and `stale` tell the user when a render lags the code (§16).
 */
export const MediaRefSchema = z.strictObject({
  root: z.enum(["project", "out"]).optional(),
  path: RelativePathSchema,
  kind: MediaKindSchema,
  /** Short caption shown under the media. */
  label: Text(160).optional(),
  /** Content hash of the file, for caches and `bindTo`. */
  sha256: Sha256Schema.optional(),
  renderedAt: IsoTimeSchema.optional(),
  /** Hash of the source (composition code, plan) the render was made from. */
  sourceHash: Sha256Schema.optional(),
  /** The source changed since this render. */
  stale: z.boolean().optional(),
  durationSec: z.number().finite().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().finite().positive().optional(),
  /** Remotion composition id the render was made from, when cheaply known (WP10b amendment; "Open in Studio"). */
  composition: Text(128).optional(),
});
export type MediaRef = z.infer<typeof MediaRefSchema>;

// ---------------------------------------------------------------------------
// 6.1 Journal event
// ---------------------------------------------------------------------------

export const EVENT_KINDS = [
  "cli.start",
  "cli.end",
  "cli.progress",
  "agent.dispatch",
  "agent.start",
  "agent.end",
  "agent.notification",
  "decision.applied",
  "decision.refused",
  "control.changed",
  "card.posted",
  "card.answered",
  "job.state",
] as const;
export const EventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKindSchema>;

export const EventAgentSchema = z.strictObject({
  name: Text(128).optional(),
  role: Text(64).optional(),
  harness: HarnessSchema.optional(),
  sessionId: Text(128).optional(),
});

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Kind-specific `data`. Loose: writers may add fields; these are the ones readers rely on. */
export const EVENT_DATA_SCHEMAS = {
  "cli.start": z.looseObject({ cwd: z.string().optional() }),
  "cli.end": z.looseObject({}),
  "cli.progress": z.looseObject({ text: Text(512) }),
  /** `film:brief`: which agent was sent where. */
  "agent.dispatch": z.looseObject({
    brief: RelativePathSchema,
    team: z.string().optional(),
    variant: z.string().optional(),
    lane: z.string().optional(),
  }),
  /** Hooks: a session or subagent started. */
  "agent.start": z.looseObject({
    agentId: Text(128),
    agentType: z.string().optional(),
    parentAgentId: z.string().optional(),
    scope: z.enum(["session", "subagent"]).optional(),
  }),
  "agent.end": z.looseObject({
    agentId: Text(128),
    agentType: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    outcome: z.enum(["done", "failed", "interrupted"]).optional(),
  }),
  "agent.notification": z.looseObject({ type: Text(64), text: z.string().max(512).optional() }),
  "decision.applied": z.looseObject({ decisionId: ConsoleIdSchema, decisionKind: z.string(), answer: z.string() }),
  "decision.refused": z.looseObject({ decisionId: ConsoleIdSchema, decisionKind: z.string(), answer: z.string() }),
  "control.changed": z.looseObject({ state: ControlStateSchema, previous: ControlStateSchema.optional() }),
  "card.posted": z.looseObject({ cardId: ConsoleIdSchema, cardKind: z.string() }),
  "card.answered": z.looseObject({
    cardId: ConsoleIdSchema,
    choice: z.string().optional(),
    text: z.string().optional(),
  }),
  "job.state": z.looseObject({
    jobId: Text(128),
    state: JobStateSchema,
    provider: z.string().optional(),
    endpoint: z.string().optional(),
    reservedUsd: UsdSchema.optional(),
    costUsd: UsdSchema.optional(),
  }),
} as const satisfies Record<EventKind, z.ZodType>;

/** One line of `pipeline/events.jsonl` or `out/console/events.jsonl`. */
export const ConsoleEventSchema = z
  .strictObject({
    v: z.literal(1),
    /** ULID: sortable by time, unique across processes. */
    id: z.ulid(),
    at: IsoTimeSchema,
    project: ProjectIdSchema.optional(),
    kind: EventKindSchema,
    /** Pairs `cli.start`/`cli.end`; `AGENTBROS_RUN_ID` propagates to children as `parentRunId`. */
    runId: ConsoleIdSchema.optional(),
    parentRunId: ConsoleIdSchema.optional(),
    /** pnpm alias, e.g. `film:approve`. */
    alias: Text(64).optional(),
    /** Redacted (§6.1). */
    argv: z.array(z.string().max(1024)).max(256).optional(),
    ok: z.boolean().optional(),
    error: Text(64).optional(),
    message: z.string().max(2048).optional(),
    elapsedMs: z.number().nonnegative().optional(),
    /** Project-relative (or repository-relative for global events). */
    outputs: z.array(z.string().max(1024)).max(256).optional(),
    costUsd: UsdSchema.optional(),
    /** From the step lease when present. */
    step: Text(64).optional(),
    agent: EventAgentSchema.optional(),
    actor: ActorSchema.optional(),
    channel: ChannelSchema.optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((event, ctx) => {
    if (event.data !== undefined && byteLength(event.data) > EVENT_DATA_MAX_BYTES)
      ctx.addIssue({ code: "custom", path: ["data"], message: `data exceeds ${EVENT_DATA_MAX_BYTES} bytes` });
    if (event.kind.startsWith("cli.") && (!event.runId || !event.alias))
      ctx.addIssue({ code: "custom", path: ["runId"], message: "cli events carry runId and alias" });
    if (event.kind === "cli.end" && (event.ok === undefined || event.elapsedMs === undefined))
      ctx.addIssue({ code: "custom", path: ["ok"], message: "cli.end carries ok and elapsedMs" });
    if (event.kind === "cli.end" && event.ok === false && !event.error)
      ctx.addIssue({ code: "custom", path: ["error"], message: "a failed cli.end names its error code" });
    const data = EVENT_DATA_SCHEMAS[event.kind];
    const needsData = !["cli.start", "cli.end"].includes(event.kind);
    if (event.data === undefined) {
      if (needsData) ctx.addIssue({ code: "custom", path: ["data"], message: `${event.kind} carries data` });
      return;
    }
    const parsed = data.safeParse(event.data);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: "custom", path: ["data", ...issue.path.map(String)], message: issue.message });
  });
export type ConsoleEvent = z.infer<typeof ConsoleEventSchema>;

/** Redaction helpers' signatures (implemented by the journal, WP1; §6.1). */
export type RedactArgv = (argv: readonly string[]) => string[];
/** Truncates a long string to {@link REDACT_MAX_STRING} characters with its length and hash. */
export type RedactString = (value: string) => string;
/** Bounds `data` to {@link EVENT_DATA_MAX_BYTES}, redacting secret-like keys. */
export type RedactData = (data: Record<string, unknown>) => Record<string, unknown>;
export interface Redactor {
  argv: RedactArgv;
  string: RedactString;
  data: RedactData;
}

// ---------------------------------------------------------------------------
// 6.3 Decision
// ---------------------------------------------------------------------------

export const DECISION_KINDS = [
  "gate",
  "choice",
  "quote",
  "rating",
  "frame-feedback",
  "frame-note",
  "verdict",
  "card-answer",
  "control",
  "policy",
] as const;
export const DecisionKindSchema = z.enum(DECISION_KINDS);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

/**
 * `partial`: the decisive command ran, a follow-up failed (a verdict's memory or feedback; a retry runs only the failed
 * ones). `unknown`: the command's outcome could not be read (timeout, crash); the server reconciles with the chain.
 * Both amended 2026-11-17 (RFC 0004 WP5).
 */
export const DECISION_STATUSES = ["pending", "applied", "refused", "superseded", "partial", "unknown"] as const;
export const DecisionStatusSchema = z.enum(DECISION_STATUSES);

/** What the user saw: a project-relative file and its hash; the CLI refuses a stale one (FR3, `--expect`). */
export const BindingSchema = z.strictObject({ path: RelativePathSchema, sha256: Sha256Schema });

/** An action the user can take; `argv` is the literal pnpm command the server would spawn. */
export const DecisionOptionSchema = z.strictObject({
  id: ConsoleIdSchema,
  label: Text(160),
  argv: z.array(z.string().max(4096)).min(1).max(64),
  /** Spends or destroys: the UI shows the exact command before submission. */
  consequential: z.boolean().optional(),
});

/** A paid quote (FR4). `amountUsd: null` is an unknown price, never free. */
export const QuoteSchema = z.strictObject({
  amountUsd: UsdSchema.nullable(),
  provider: Text(64),
  endpoint: Text(256).optional(),
  maxAdmissibleUsd: UsdSchema.nullable().optional(),
  budgetAfterUsd: UsdSchema.nullable().optional(),
  ceilingUsd: UsdSchema.nullable().optional(),
  /** Hash of the quote the approval binds to. */
  quoteHash: Sha256Schema.optional(),
  summary: Text(240).optional(),
});
export type Quote = z.infer<typeof QuoteSchema>;

/**
 * A change of autonomy or the budget ceiling the user starts in the console (`policy` decisions, D13, US14, A10):
 * applied through `film:policy` or `budget --ceiling-usd`, which re-check every grant. Amended 2026-11-17 (RFC 0004
 * gap A10).
 */
export const PolicyChangeSchema = z
  .strictObject({
    autonomy: z.enum(["interactive", "autonomous"]).optional(),
    ceilingUsd: UsdSchema.optional(),
  })
  .refine(
    (change) => change.autonomy !== undefined || change.ceilingUsd !== undefined,
    "a policy change changes something",
  );
export type PolicyChange = z.infer<typeof PolicyChangeSchema>;

/** The final verdict (D24). */
export const VerdictSchema = z.strictObject({
  score: z.number().int().min(1).max(10),
  /** Scores on the project's frozen rubric axes, 1–10. */
  axes: z.record(Text(64), z.number().int().min(1).max(10)).optional(),
  worked: z.string().max(4000).optional(),
  didNot: z.string().max(4000).optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** A rectangle in normalised frame coordinates (0–1). */
export const RegionSchema = z
  .strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().gt(0).max(1),
    h: z.number().gt(0).max(1),
  })
  .refine((r) => r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9, "region inside the frame");

/**
 * A mark the user put on the frame (2026-11-20): with `w` and `h` a box, without them a point the arrow points at;
 * `text` is what the user wrote at it. Normalised frame coordinates (0–1), origin top left.
 */
export const FrameMarkSchema = z
  .strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().gt(0).max(1).optional(),
    h: z.number().gt(0).max(1).optional(),
    text: Text(300),
  })
  .refine((mark) => (mark.w === undefined) === (mark.h === undefined), "a box has both w and h")
  .refine(
    (mark) => mark.w === undefined || (mark.x + mark.w <= 1 + 1e-9 && mark.y + (mark.h ?? 0) <= 1 + 1e-9),
    "a box inside the frame",
  );
export type FrameMark = z.infer<typeof FrameMarkSchema>;
/** Marks one frame comment may carry (each a numbered label on the annotated still). */
export const MAX_FRAME_MARKS = 9;

/** A comment pinned to a frame of a render (US11); `marks` amended 2026-11-20. */
export const FrameCommentSchema = z.strictObject({
  media: MediaRefSchema,
  frame: Count,
  region: RegionSchema.optional(),
  marks: z.array(FrameMarkSchema).max(MAX_FRAME_MARKS).optional(),
  text: Text(4000),
});
export type FrameComment = z.infer<typeof FrameCommentSchema>;

/** Where `frame:note` keeps the notes and their annotated stills, relative to the project. */
export const FRAME_NOTES_DIR = "pipeline/frame-notes";

/**
 * `pipeline/frame-notes/<id>.json` (2026-11-20): the user's note on one frame of any video of the project, written by
 * `frame:note` (the console's `frame-note` decision). `still` is the frame as a PNG with the marks drawn on it.
 */
export const FrameNoteSchema = z.strictObject({
  v: z.literal(1),
  id: ConsoleIdSchema,
  project: ProjectIdSchema,
  media: z.strictObject({
    path: RelativePathSchema,
    root: z.enum(["project", "out"]),
    sha256: Sha256Schema.optional(),
  }),
  frame: Count,
  fps: z.number().positive().max(1000),
  /** Start of the frame, seconds. */
  timeSec: z.number().min(0),
  /** `mm:ss.mmm` (or `h:mm:ss.mmm`) of the frame's start. */
  time: Text(32),
  /** The user's words, verbatim. */
  words: Text(8000),
  region: RegionSchema.optional(),
  marks: z.array(FrameMarkSchema).max(MAX_FRAME_MARKS).optional(),
  /** The annotated still, relative to the project. */
  still: RelativePathSchema.optional(),
  /** How the marks were drawn: the user's overlay as they saw it, or boxes only (no overlay given). */
  drawn: z.enum(["overlay", "boxes", "none"]),
  channel: z.enum(["console", "cli"]),
  createdAt: IsoTimeSchema,
});
export type FrameNote = z.infer<typeof FrameNoteSchema>;

export const DecisionSchema = z
  .strictObject({
    v: z.literal(1),
    id: ConsoleIdSchema,
    project: ProjectIdSchema,
    kind: DecisionKindSchema,
    step: Text(64).optional(),
    title: Text(200),
    /** Short context: what happens next, what it costs. */
    summary: z.string().max(2000).optional(),
    /** The agent's recommendation, always labelled as the agent's view. */
    recommendation: z.strictObject({ by: Text(128), text: Text(2000) }).optional(),
    bindTo: z.array(BindingSchema).max(64),
    /**
     * What the user reviews, as one hash: over every binding and the quote's hash (src/lib/console/expect.ts). A
     * request sends it back as `expect` (FR3). Amended 2026-11-17 (RFC 0004 WP5).
     */
    expect: Sha256Schema.optional(),
    media: z.array(MediaRefSchema).max(48).optional(),
    options: z.array(DecisionOptionSchema).max(24).optional(),
    quote: QuoteSchema.optional(),
    /** The card this decision answers (`card-answer`). */
    cardId: ConsoleIdSchema.optional(),
    /** The user's words, verbatim (D10). */
    answer: z.string().max(8000).optional(),
    /** The chosen option id. */
    choice: ConsoleIdSchema.optional(),
    verdict: VerdictSchema.optional(),
    frameComments: z.array(FrameCommentSchema).max(64).optional(),
    /** Rating decisions: score per media path, 1–5. */
    ratings: z.record(RelativePathSchema, z.number().int().min(1).max(5)).optional(),
    /** `policy` decisions: the autonomy mode and/or ceiling asked for (amended 2026-11-17, A10). */
    policy: PolicyChangeSchema.optional(),
    /** The argv the server spawned (decided decisions). */
    argv: z.array(z.string().max(8192)).max(64).optional(),
    actor: z.literal("user").optional(),
    channel: z.enum(["console", "cli"]).optional(),
    status: DecisionStatusSchema,
    createdAt: IsoTimeSchema,
    decidedAt: IsoTimeSchema.optional(),
    /** Id of the decision that replaced this one. */
    supersededBy: ConsoleIdSchema.optional(),
    /** The spawned CLI's one JSON line. */
    result: CliEnvelopeSchema.optional(),
  })
  .superRefine((decision, ctx) => {
    const ids = decision.options?.map((option) => option.id) ?? [];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["options"], message: "option ids are unique" });
    if (decision.choice !== undefined && decision.options && !ids.includes(decision.choice))
      ctx.addIssue({ code: "custom", path: ["choice"], message: "choice is one of the options" });
    if (decision.status !== "pending" && !decision.decidedAt)
      ctx.addIssue({ code: "custom", path: ["decidedAt"], message: "a decided decision has decidedAt" });
    if (decision.kind === "verdict" && decision.status !== "pending" && !decision.verdict)
      ctx.addIssue({ code: "custom", path: ["verdict"], message: "a decided verdict carries its scores" });
  });
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * `pipeline/inbox/<decisionId>.json`: only decided decisions are written (D9). It records the request (answer,
 * choice), the argv, the envelope and the status.
 */
export const InboxDecisionFileSchema = DecisionSchema.superRefine((decision, ctx) => {
  if (decision.status === "pending")
    ctx.addIssue({ code: "custom", path: ["status"], message: "the inbox holds decided decisions only" });
  if (!decision.answer?.trim())
    ctx.addIssue({ code: "custom", path: ["answer"], message: "a decided decision carries the user's words" });
  if (decision.status !== "superseded" && (!decision.argv?.length || !decision.result))
    ctx.addIssue({ code: "custom", path: ["argv"], message: "an applied or refused decision records argv and result" });
});
export type InboxDecisionFile = z.infer<typeof InboxDecisionFileSchema>;

// ---------------------------------------------------------------------------
// 6.4 Card
// ---------------------------------------------------------------------------

export const CARD_KINDS = ["compare", "grid", "rating", "choice", "question", "markdown", "media"] as const;
export const CardKindSchema = z.enum(CARD_KINDS);
export type CardKind = z.infer<typeof CardKindSchema>;

export const CardOptionSchema = z.strictObject({ id: ConsoleIdSchema, label: Text(160) });
export const CardFromSchema = z.strictObject({ agent: Text(128), role: Text(64).optional() });

/** Card media: a {@link MediaRefSchema} (project-relative by default; `root: "out"` for renders). */
const media = (min: number, max: number) => z.array(MediaRefSchema).min(min).max(max);
const options = (min: number, max: number) => z.array(CardOptionSchema).min(min).max(max);

/** Per-kind content constraints, shared by the posted input and the stored card. */
const CARD_CONTENT = {
  /** A/B (or up to four) media side by side; with `expectsAnswer` the user picks one of `options`. */
  compare: {
    kind: z.literal("compare"),
    media: media(2, 4),
    options: options(2, 4).optional(),
    expectsAnswer: z.boolean(),
  },
  /** Candidates in a grid; optional pick. */
  grid: {
    kind: z.literal("grid"),
    media: media(2, 24),
    options: options(2, 24).optional(),
    expectsAnswer: z.boolean(),
  },
  /** 1–5 per media item; always answered. */
  rating: { kind: z.literal("rating"), media: media(1, 24), expectsAnswer: z.literal(true) },
  /** Pick one option; media optional. */
  choice: {
    kind: z.literal("choice"),
    media: media(0, 12).optional(),
    options: options(2, 12),
    expectsAnswer: z.literal(true),
  },
  /** A free-text question, optionally with suggested options. */
  question: {
    kind: z.literal("question"),
    media: media(0, 12).optional(),
    options: options(2, 12).optional(),
    expectsAnswer: z.literal(true),
  },
  /** Information only: Markdown body, no answer. */
  markdown: {
    kind: z.literal("markdown"),
    body: MarkdownSchema.pipe(z.string().min(1)),
    expectsAnswer: z.literal(false),
  },
  /** Media to look at; may ask for a comment. */
  media: { kind: z.literal("media"), media: media(1, 12), expectsAnswer: z.boolean() },
} as const;

const CARD_INPUT_BASE = {
  title: Text(160),
  body: MarkdownSchema.optional(),
  step: Text(64).optional(),
  from: CardFromSchema,
  expiresAt: IsoTimeSchema.optional(),
};

export const CardAnswerSchema = z
  .strictObject({
    choice: ConsoleIdSchema.optional(),
    text: z.string().max(8000).optional(),
    /** Rating cards: score per media path, 1–5. */
    ratings: z.record(RelativePathSchema, z.number().int().min(1).max(5)).optional(),
    at: IsoTimeSchema,
  })
  .refine(
    (answer) => answer.choice !== undefined || !!answer.text?.trim() || answer.ratings,
    "an answer says something",
  );
export type CardAnswer = z.infer<typeof CardAnswerSchema>;

const CARD_STORED_BASE = {
  v: z.literal(1),
  id: ConsoleIdSchema,
  project: ProjectIdSchema,
  createdAt: IsoTimeSchema,
  answer: CardAnswerSchema.optional(),
};

type CardShape = { kind: z.ZodLiteral<CardKind>; options?: z.ZodType; media?: z.ZodType };

function checkCard(
  card: {
    kind: CardKind;
    options?: { id: string }[];
    media?: { path: string }[];
    expectsAnswer: boolean;
    answer?: CardAnswer;
  },
  ctx: z.RefinementCtx,
) {
  const ids = card.options?.map((option) => option.id) ?? [];
  if (new Set(ids).size !== ids.length)
    ctx.addIssue({ code: "custom", path: ["options"], message: "option ids are unique" });
  if (card.kind === "compare" && card.expectsAnswer && !card.options)
    ctx.addIssue({ code: "custom", path: ["options"], message: "an answered compare card names its options" });
  const answer = card.answer;
  if (!answer) return;
  if (!card.expectsAnswer) ctx.addIssue({ code: "custom", path: ["answer"], message: "this card expects no answer" });
  if (answer.choice !== undefined && !ids.includes(answer.choice))
    ctx.addIssue({ code: "custom", path: ["answer", "choice"], message: "choice is one of the options" });
  const paths = new Set(card.media?.map((item) => item.path) ?? []);
  for (const key of Object.keys(answer.ratings ?? {}))
    if (!paths.has(key))
      ctx.addIssue({ code: "custom", path: ["answer", "ratings", key], message: "rating of a media item on the card" });
  if (card.kind === "rating" && !answer.ratings)
    ctx.addIssue({ code: "custom", path: ["answer", "ratings"], message: "a rating card is answered with ratings" });
}

const inputBranch = <S extends CardShape>(shape: S) => z.strictObject({ ...CARD_INPUT_BASE, ...shape });
const storedBranch = <S extends CardShape>(shape: S) =>
  z.strictObject({ ...CARD_STORED_BASE, ...CARD_INPUT_BASE, ...shape });

/** What `console:card --data <file.json>` takes (D14): no id, project, time or answer. */
export const CardInputSchema = z
  .discriminatedUnion("kind", [
    inputBranch(CARD_CONTENT.compare),
    inputBranch(CARD_CONTENT.grid),
    inputBranch(CARD_CONTENT.rating),
    inputBranch(CARD_CONTENT.choice),
    inputBranch(CARD_CONTENT.question),
    inputBranch(CARD_CONTENT.markdown),
    inputBranch(CARD_CONTENT.media),
  ])
  .superRefine((card, ctx) => checkCard(card, ctx));
export type CardInput = z.infer<typeof CardInputSchema>;

/** `pipeline/cards/<cardId>.json` and the view's `cards` (§6.4). */
export const CardSchema = z
  .discriminatedUnion("kind", [
    storedBranch(CARD_CONTENT.compare),
    storedBranch(CARD_CONTENT.grid),
    storedBranch(CARD_CONTENT.rating),
    storedBranch(CARD_CONTENT.choice),
    storedBranch(CARD_CONTENT.question),
    storedBranch(CARD_CONTENT.markdown),
    storedBranch(CARD_CONTENT.media),
  ])
  .superRefine((card, ctx) => checkCard(card, ctx));
export type Card = z.infer<typeof CardSchema>;

// ---------------------------------------------------------------------------
// 6.5 Control
// ---------------------------------------------------------------------------

export const ControlChangeSchema = z.strictObject({
  state: ControlStateSchema,
  by: z.literal("user"),
  channel: z.enum(["console", "cli"]),
  at: IsoTimeSchema,
  /** The user's words. */
  answer: z.string().max(4000).optional(),
  reason: z.string().max(2000).optional(),
});

/** `pipeline/session/control.json` (D12). The top level is the current state; `history` holds every change, oldest first. */
export const ControlFileSchema = z.strictObject({
  v: z.literal(1),
  ...ControlChangeSchema.shape,
  history: z.array(ControlChangeSchema).max(10_000),
});
export type ControlFile = z.infer<typeof ControlFileSchema>;

// ---------------------------------------------------------------------------
// Server lock, session token, hook cursor, ratings
// ---------------------------------------------------------------------------

/** `out/console/server.json` (D16). */
export const ServerLockSchema = z.strictObject({
  v: z.literal(1),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65_535),
  /** Bundle and server version; a mismatch restarts the server. */
  version: Text(128),
  startedAt: IsoTimeSchema,
  /** `http://127.0.0.1:<port>/`, without the token. */
  url: z.url().optional(),
});
export type ServerLock = z.infer<typeof ServerLockSchema>;

/** `out/console/session.json`, mode 0600 (D15): 32 random bytes as lowercase hex. */
export const ConsoleSessionSchema = z.strictObject({
  v: z.literal(1),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  credentialsToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ConsoleSession = z.infer<typeof ConsoleSessionSchema>;

/** `out/console/hooks/<session>.json`: what a harness session has already been told (§7.1 H6, H7). */
export const HookCursorSchema = z.strictObject({
  v: z.literal(1),
  session: ConsoleIdSchema,
  harness: HarnessSchema,
  project: ProjectIdSchema.optional(),
  /** Last journal event relayed to this session. */
  lastEventId: z.ulid().optional(),
  /** Hash of the last injected `orient` facts (dedupe). */
  lastInjectedHash: Sha256Schema.optional(),
  lastInjectedAt: IsoTimeSchema.optional(),
  /** Project and origin of the last dashboard instruction, distinct from a confirmed browser opening. */
  lastConsoleTarget: Sha256Schema.optional(),
  updatedAt: IsoTimeSchema,
});
export type HookCursor = z.infer<typeof HookCursorSchema>;

export const RATING_TARGETS = ["reference", "styleframe", "render", "asset", "other"] as const;

export const RatingSchema = z.strictObject({
  id: ConsoleIdSchema,
  target: z.strictObject({ path: RelativePathSchema, sha256: Sha256Schema.optional() }),
  kind: z.enum(RATING_TARGETS),
  score: z.number().int().min(1).max(5),
  /** The user's words; a note also becomes a memory preference (§8). */
  note: z.string().max(4000).optional(),
  step: Text(64).optional(),
  by: z.literal("user"),
  channel: z.enum(["console", "cli"]),
  at: IsoTimeSchema,
});
export type Rating = z.infer<typeof RatingSchema>;

/** `pipeline/ratings.json`, written by `ref:rate` (WP9); the latest rating of a path wins. */
export const RatingsFileSchema = z.strictObject({ v: z.literal(1), ratings: z.array(RatingSchema) });
export type RatingsFile = z.infer<typeof RatingsFileSchema>;

// ---------------------------------------------------------------------------
// Next-step answer blocks
// ---------------------------------------------------------------------------

/** `console` block added to project creation and next-step answers (D11, D16, §9.2). */
export const ConsoleNextBlockSchema = z.strictObject({
  /** URL without the token; absent when the server is off or failed to start. */
  url: z.url().optional(),
  /** A start or version problem. An authenticated older server can still have a URL. */
  error: z.string().max(2000).optional(),
  pending: Count,
  appliedSince: z.array(DecisionSchema),
  /** Fresh decisions left out of `appliedSince` (it keeps the newest ten); they stay in the console's history. */
  truncated: Count.optional(),
  /** The project's newest journal event when the answer was made: `console:wait --since` it misses nothing after. */
  lastEventId: z.ulid().optional(),
});
export type ConsoleNextBlock = z.infer<typeof ConsoleNextBlockSchema>;

export const HOOK_INSTALL_STATES = ["installed", "missing", "stale"] as const;
/** `hooks` block of `pnpm next` and the console Settings (§7.1 H3). */
export const HooksStatusSchema = z.strictObject({
  claude: z.enum(HOOK_INSTALL_STATES),
  codex: z.enum(HOOK_INSTALL_STATES),
});
export type HooksStatus = z.infer<typeof HooksStatusSchema>;

/** The command that installs or updates the console's hooks (§7.1 H3). */
export const HOOKS_INSTALL_COMMAND = "pnpm harness:setup --hooks --apply";

/** `GET /api/hooks` (H3; amended 2026-11-17): the hooks status of this checkout and the install command. */
export const HooksResponseSchema = z.strictObject({
  v: z.literal(1),
  status: HooksStatusSchema,
  command: Text(256),
  /** Per harness: what `--apply` would do (`none`, `write`, `conflict`) and the file, from the plan. */
  plan: z
    .array(
      z.strictObject({
        harness: Text(32),
        file: Text(512),
        action: z.enum(["none", "write", "conflict"]),
        conflict: Text(1000).optional(),
      }),
    )
    .max(8),
});
export type HooksResponse = z.infer<typeof HooksResponseSchema>;

/** `POST /api/hooks/install` (H3): the user's yes, the status after and the CLI's envelope. */
export const HooksInstallResponseSchema = z.strictObject({
  ok: z.boolean(),
  status: HooksStatusSchema.optional(),
  /** The one trust step per harness the user takes next (harness:setup's `trust`). */
  trust: z.array(Text(1000)).max(8).optional(),
  message: z.string().max(4000).optional(),
  result: CliEnvelopeSchema.optional(),
});
export type HooksInstallResponse = z.infer<typeof HooksInstallResponseSchema>;

// ---------------------------------------------------------------------------
// 6.2 Project view (read model)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Film material (WP10b amendment): what a film panel shows beside each decision (G2, §5.2, §5.4)
// ---------------------------------------------------------------------------

/** Longest excerpt of a document the view carries (the file itself stays a `document` media ref). */
export const FILM_EXCERPT_MAX = 4096;
/** Most items a list of film material carries. */
export const FILM_LIST_MAX = 60;

const Line = (max = 1000) => Text(max);
const lines = (max: number, length = 500) => z.array(Line(length)).max(max);
const Seconds = z.number().finite().nonnegative();

export const FilmBriefSchema = z.strictObject({
  /** brief.md (or the brief's own summary), cut at {@link FILM_EXCERPT_MAX}. */
  excerpt: z.string().max(FILM_EXCERPT_MAX).optional(),
  doc: MediaRefSchema.optional(),
  strategy: z
    .strictObject({
      proposition: Line(2000),
      audience: z.strictObject({ who: Line(), moment: Line() }).optional(),
      platform: Line(500).optional(),
      hook: z.strictObject({ mechanic: Line(), firstTwoSeconds: Line() }).optional(),
      tone: lines(16, 120),
      mandatories: lines(24),
      forbidden: lines(24),
      successCriteria: lines(24),
      filmType: Text(64).optional(),
      language: Text(32).optional(),
    })
    .optional(),
  /** strategy.md, cut at {@link FILM_EXCERPT_MAX}. */
  strategyExcerpt: z.string().max(FILM_EXCERPT_MAX).optional(),
  strategyDoc: MediaRefSchema.optional(),
});
export type FilmBrief = z.infer<typeof FilmBriefSchema>;

export const CLAIM_STATUSES = ["working", "in-development", "horizon", "unverified"] as const;

export const FilmDiscoverySchema = z.strictObject({
  category: Text(200).optional(),
  cliches: z
    .array(
      z.strictObject({
        cliche: Line(300),
        description: z.string().max(1000).optional(),
        seenIn: z.string().max(300).optional(),
      }),
    )
    .max(40),
  whiteSpace: lines(24),
  learn: lines(24),
  /** The product's claims; the panel groups them by status. */
  claims: z
    .array(z.strictObject({ text: Line(1000), status: z.enum(CLAIM_STATUSES), source: z.string().max(300).optional() }))
    .max(100),
  publicRule: z.string().max(1000).optional(),
  docs: z.array(MediaRefSchema).max(4).optional(),
});
export type FilmDiscovery = z.infer<typeof FilmDiscoverySchema>;

const PoolIdSchema = z.string().regex(/^[IS]\d{1,4}$/, "an anonymous pool id");

/**
 * A creative pool shown blind: anonymous ids only, never an author, team, variant letter or writing order. `top` and
 * `against` are the creative director's ranking and arguments (the agent's view); `chosen` is set only once the user's
 * step closed.
 */
export const FilmPoolSchema = z.strictObject({
  kind: z.enum(["ideas", "scripts"]),
  round: z.number().int().positive(),
  rubricVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  axes: z.array(Text(64)).max(16),
  items: z
    .array(
      z.strictObject({
        id: PoolIdSchema,
        title: Text(200).optional(),
        /** The idea or script as text, cut at 2 KB. */
        text: z.string().max(2048),
        /** Per-axis rubric scores, 1–5, of the latest review. */
        scores: z.record(Text(64), z.number().int().min(1).max(5)).optional(),
        mean: z.number().finite().nonnegative().optional(),
        passes: z.boolean().optional(),
        /** Scripts: measured reading overruns (each caps the reading axis). */
        overruns: Count.optional(),
      }),
    )
    .max(FILM_LIST_MAX),
  /** Pairwise judgements by unordered pair: `agreed` when both orders name the same winner. */
  pairs: z
    .array(z.strictObject({ a: PoolIdSchema, b: PoolIdSchema, winner: PoolIdSchema.optional(), agreed: z.boolean() }))
    .max(120),
  top: z.array(PoolIdSchema).max(3),
  verdict: z.enum(["pass", "below-threshold"]).optional(),
  against: z.array(z.strictObject({ id: PoolIdSchema, argument: Line(1000) })).max(6),
  chosen: PoolIdSchema.optional(),
  /** The pool file and, for ideas, the concept boards' contact sheet. */
  docs: z.array(MediaRefSchema).max(4).optional(),
});
export type FilmPool = z.infer<typeof FilmPoolSchema>;

export const FilmLookSchema = z.strictObject({
  styleframes: z
    .array(z.strictObject({ media: MediaRefSchema, rating: z.number().int().min(1).max(5).optional() }))
    .max(24),
  design: MediaRefSchema.optional(),
});
export type FilmLook = z.infer<typeof FilmLookSchema>;

export const FilmBeatsSchema = z.strictObject({
  fps: z.number().positive(),
  shots: z
    .array(
      z.strictObject({
        id: Text(64),
        beatId: Text(64).optional(),
        startFrame: Count,
        durationFrames: z.number().int().positive(),
        intent: z.string().max(500),
        subject: z.string().max(200).optional(),
        transitionToNext: z.string().max(160).optional(),
      }),
    )
    .max(120),
  /** Cue sheet: `sec` on the film's clock, `trackSec` on the music's (the waveform markers). */
  cues: z
    .array(
      z.strictObject({
        id: Text(64),
        kind: Text(32),
        frame: Count,
        sec: Seconds,
        trackSec: Seconds,
        shotId: Text(64).optional(),
        snap: Text(32).optional(),
      }),
    )
    .max(400),
  track: MediaRefSchema.optional(),
  sections: z
    .array(z.strictObject({ startSec: Seconds, endSec: Seconds, level: z.enum(["low", "mid", "high"]) }))
    .max(64)
    .optional(),
});
export type FilmBeats = z.infer<typeof FilmBeatsSchema>;

export const FilmNarrationSchema = z.strictObject({
  route: z.enum(["elevenlabs", "local", "existing"]).optional(),
  voiceWhy: z.string().max(1000).optional(),
  modelId: Text(64).optional(),
  pacingNote: z.string().max(1000).optional(),
  take: z.number().int().min(1).max(99).optional(),
  direction: z
    .array(z.strictObject({ beatId: Text(64), text: z.string().max(1000), emphasis: lines(16, 64) }))
    .max(FILM_LIST_MAX),
  takes: z
    .array(
      z.strictObject({
        beatId: Text(64),
        media: MediaRefSchema,
        startSec: Seconds.optional(),
        wordCount: Count.optional(),
        emphasisCount: Count.optional(),
      }),
    )
    .max(FILM_LIST_MAX),
  /** Caption words of the takes (edited words when present), at most 600 in all. */
  words: z
    .array(
      z.strictObject({
        beatId: Text(64),
        text: Text(64),
        start: Seconds,
        end: Seconds,
        emphasis: z.boolean().optional(),
      }),
    )
    .max(600),
  totalSec: Seconds.optional(),
});
export type FilmNarration = z.infer<typeof FilmNarrationSchema>;

/** One critic round (look, film or another critic step): scores, the ranked fixes and the frames it looked at. */
export const FilmCriticRoundSchema = z.strictObject({
  step: Text(64),
  round: z.number().int().positive(),
  verdict: z.enum(["approve-for-human", "revise", "rethink-idea"]),
  total: z.number().finite().optional(),
  scores: z.record(Text(64), z.number().int().min(1).max(5)),
  /** Ranked fixes (the critique's actions), at most seven; claims about sound are dropped (§2.2). */
  fixes: lines(7, 1000),
  frames: z
    .array(z.strictObject({ media: MediaRefSchema, timeSec: Seconds.optional(), note: z.string().max(500).optional() }))
    .max(12),
  /** The critic pack's phone sheet of the round, when written. */
  sheet: MediaRefSchema.optional(),
});
export type FilmCriticRound = z.infer<typeof FilmCriticRoundSchema>;

export const FilmHumanSchema = z.strictObject({
  /** The project's frozen creative rubric (film:init records its version; src/lib/film/creative-rubric.ts). */
  rubric: z.strictObject({ version: z.union([z.literal(1), z.literal(2)]), axes: z.array(Text(64)).min(1).max(16) }),
});
export type FilmHuman = z.infer<typeof FilmHumanSchema>;

/** The film route's material, section by section; a section is absent when its files are absent or unreadable. */
export const FilmMaterialSchema = z.strictObject({
  brief: FilmBriefSchema.optional(),
  discovery: FilmDiscoverySchema.optional(),
  ideas: FilmPoolSchema.optional(),
  scripts: FilmPoolSchema.optional(),
  look: FilmLookSchema.optional(),
  beats: FilmBeatsSchema.optional(),
  narration: FilmNarrationSchema.optional(),
  critic: z.strictObject({ rounds: z.array(FilmCriticRoundSchema).max(24) }).optional(),
  human: FilmHumanSchema.optional(),
});
export type FilmMaterial = z.infer<typeof FilmMaterialSchema>;

// --- Route material beyond the film (WP15 amendment): replica, recipe and campaign canvases ---

/** Replica route (a bespoke film of type `replica`): the rights answer, the shot-for-shot spec and its two checks. */
export const ReplicaMaterialSchema = z.strictObject({
  /** `pipeline/replica-rights.json`: the user's own words, shown as written. */
  rights: z
    .strictObject({
      status: z.enum(["owned", "licensed", "study-only"]),
      userStatement: z.string().max(2000),
      askedAt: Text(64),
    })
    .optional(),
  /** `pipeline/replica-spec.json`, bounded. */
  spec: z
    .strictObject({
      reference: Text(128),
      fps: z.number().positive(),
      format: FormatSchema,
      shots: z
        .array(
          z.strictObject({
            id: Text(64),
            referenceShot: Text(64),
            startFrame: Count,
            durationFrames: z.number().int().positive(),
            content: z.string().max(500),
            confidence: z.enum(["measured", "observed", "rough"]),
            camera: Text(64).optional(),
            transitionIn: Text(64).optional(),
            blocks: lines(16, 128),
            unreachable: z.string().max(500).optional(),
          }),
        )
        .max(200),
      swaps: z
        .array(
          z.strictObject({
            what: z.string().max(500),
            from: z.string().max(500),
            to: z.string().max(500),
            why: z.string().max(1000),
            shots: lines(200, 64).optional(),
          }),
        )
        .max(64),
      rounds: z
        .array(z.strictObject({ round: z.number().int().positive(), fixed: lines(32), remains: lines(32) }))
        .max(32),
      /** `pipeline/replica-spec.md`, when written. */
      doc: MediaRefSchema.optional(),
    })
    .optional(),
  /** `ref:replica-check`'s envelope (`pipeline/replica-check.json`). */
  check: z
    .strictObject({
      ok: z.boolean(),
      passed: z.boolean().optional(),
      issues: lines(20, 1000),
      message: Line(2000).optional(),
    })
    .optional(),
  /** `ref:compare --tolerance replica`'s envelope (`pipeline/replica-compare.json`): shots per measure. */
  compare: z
    .strictObject({
      ok: z.boolean(),
      message: Line(2000).optional(),
      measures: z
        .array(z.strictObject({ measure: Text(64), held: Count, failed: Count, notMeasured: Count, exempt: Count }))
        .max(32),
    })
    .optional(),
});
export type ReplicaMaterial = z.infer<typeof ReplicaMaterialSchema>;

/** Recipe route (`video:recipe` draft, `pipeline/recipe.json` + `project.json` scenes). */
export const RecipeMaterialSchema = z.strictObject({
  recipeId: Text(64),
  topic: z.string().max(500),
  formats: z.array(FormatSchema).max(3),
  durationInFrames: Count.optional(),
  productionReady: z.boolean(),
  findings: lines(32, 1000),
  nextAction: Line(1000).optional(),
  beats: z
    .array(
      z.strictObject({
        id: Text(64),
        purpose: z.string().max(500).optional(),
        headline: z.string().max(500).optional(),
        text: z.string().max(2000).optional(),
        durationInFrames: Count.optional(),
        transitionToNext: Text(64).optional(),
        /** The scene's visual, when it is a project file. */
        visual: MediaRefSchema.optional(),
        /** The visual is the recipe's placeholder ("approved visual needed"). */
        placeholder: z.boolean().optional(),
      }),
    )
    .max(64),
  /** `animatic.html`, the draft's storyboard page. */
  animatic: MediaRefSchema.optional(),
});
export type RecipeMaterial = z.infer<typeof RecipeMaterialSchema>;

/** Campaign container: members and their production state (the review itself is the campaign view, WP13e). */
export const CampaignMaterialSchema = z.strictObject({
  campaignId: Text(128),
  planHash: Text(128),
  /** Review draft revision. */
  reviewRevision: Count,
  members: z
    .array(
      z.strictObject({
        id: Text(128),
        language: Text(32),
        productId: Text(128).optional(),
        heldForPilot: z.boolean(),
        excluded: z.boolean(),
        choice: Text(32).optional(),
        tasks: z.array(z.strictObject({ state: Text(32), count: Count })).max(16),
        outputs: Count,
      }),
    )
    .max(500),
});
export type CampaignMaterial = z.infer<typeof CampaignMaterialSchema>;

/** `GET /api/library`: the motion library catalogue, read-only and trimmed (WP15, US21). */
export const LibraryItemSchema = z.strictObject({
  id: Text(128),
  category: Text(64),
  title: Text(200),
  description: z.string().max(4000),
  tags: lines(64, 128),
  formats: z.array(FormatSchema).max(3),
  durationInFrames: Count.optional(),
  importPath: Text(512),
  /** Credits: what the block was learned from (the catalogue's `inspiredBy`). */
  inspiredBy: lines(32, 1000),
  usage: z.string().max(4000).optional(),
  /** A preview still exists: `GET /library/preview/<id>`. */
  preview: z.boolean(),
});
export type LibraryItem = z.infer<typeof LibraryItemSchema>;
export const LibraryResponseSchema = z.strictObject({
  v: z.literal(1),
  version: z.number().int().nonnegative(),
  items: z.array(LibraryItemSchema).max(2000),
  categories: z.array(z.strictObject({ id: Text(64), count: Count })).max(64),
});
export type LibraryResponse = z.infer<typeof LibraryResponseSchema>;
// ---------------------------------------------------------------------------
// Footage material (WP12 amendment): what the footage panels show beside each decision (US19, §5.2, A15)
// ---------------------------------------------------------------------------

/** Cut kinds as recut:plan writes them (src/lib/workflows/recut-plan.ts): `pause` is a silence, `retake` a false start. */
export const FOOTAGE_CUT_KINDS = ["pause", "filler", "retake", "head", "tail"] as const;
/** Most transcript words the view carries (the excerpt; the transcript itself stays in the project). */
export const FOOTAGE_WORDS_MAX = 600;
/** Most cuts and kept spans the view carries. */
export const FOOTAGE_CUTS_MAX = 240;

const Unit = z.number().finite().min(0).max(1);

export const FootageSourceSchema = z.strictObject({
  /** The recording (project-relative), when it lies inside the project. */
  media: MediaRefSchema.optional(),
  file: Text(1024),
  durationSec: Seconds.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: Text(32).optional(),
  problems: lines(16),
});

export const FootageTranscriptSchema = z.strictObject({
  provider: Text(32),
  model: Text(64),
  language: Text(32),
  verbatim: z.boolean(),
  diarized: z.boolean(),
  speakers: z.array(z.strictObject({ id: Text(64), label: Text(120).optional(), words: Count })).max(16),
  wordCount: Count,
  durationSec: Seconds.optional(),
  /** The first {@link FOOTAGE_WORDS_MAX} words with their times; `truncated` when the transcript has more. */
  words: z
    .array(
      z.strictObject({
        text: Text(64),
        start: Seconds,
        end: Seconds,
        speaker: Text(64).optional(),
        kind: z.enum(["word", "filler", "event"]).optional(),
      }),
    )
    .max(FOOTAGE_WORDS_MAX),
  truncated: z.boolean(),
  /** Words a local recogniser seems to have glued together (footage:next's pointer, not a correction). */
  glued: z.array(z.strictObject({ text: Text(64), atSec: Seconds, why: Text(160) })).max(24),
});

export const FootagePlanSchema = z.strictObject({
  /** recut-plan.md, served as text. */
  doc: MediaRefSchema.optional(),
  /** The project the approved recut becomes. */
  recutProject: ProjectIdSchema,
  editHash: Sha256Schema.optional(),
  /** The hash the request's review approves, when any (stale when it differs from `editHash`). */
  approvedEditHash: Sha256Schema.optional(),
  formats: z.array(FormatSchema).max(3),
  sourceSec: Seconds.optional(),
  outputSec: Seconds.optional(),
  removedSec: Seconds.optional(),
  cuts: z
    .array(
      z.strictObject({
        id: Text(16),
        kind: z.enum(FOOTAGE_CUT_KINDS),
        startSec: Seconds,
        endSec: Seconds,
        /** The words around the cut as the plan shows them. */
        text: z.string().max(500).optional(),
        reason: z.string().max(500).optional(),
      }),
    )
    .max(FOOTAGE_CUTS_MAX),
  /** Kept spans in source seconds (the request's keepSpans), for the before/after timeline. */
  keep: z.array(z.strictObject({ startSec: Seconds, endSec: Seconds })).max(FOOTAGE_CUTS_MAX),
  protectedCount: Count.optional(),
});

export const FootageCaptionsSchema = z.strictObject({
  /** The style on the recut's timeline. */
  style: Text(64).optional(),
  /** The style the goals ask for. */
  wanted: Text(64).optional(),
  placed: z.boolean(),
  uiZone: Text(64).optional(),
  /** The styles footage:next offers when it asks. */
  choices: z.array(Text(64)).max(24),
});

export const FootageShortsSchema = z.strictObject({
  /** The proposals were ranked from the current candidates. */
  fresh: z.boolean(),
  threshold: z.number().finite().min(0).max(100).optional(),
  items: z
    .array(
      z.strictObject({
        id: Text(64),
        title: Text(200),
        score: z.number().finite().min(0).max(100),
        rank: z.number().int().positive().optional(),
        proposed: z.boolean(),
        startSec: Seconds,
        endSec: Seconds,
        text: z.string().max(1000),
        /** Axis scores 0–10 (hook, standalone, emotion, payoff, value, relevance). */
        axes: z.record(Text(32), z.number().finite().min(0).max(10)),
        warnings: lines(8),
        reason: Text(64).optional(),
      }),
    )
    .max(FILM_LIST_MAX),
  series: z
    .strictObject({
      episodes: Count,
      created: z
        .array(z.strictObject({ project: ProjectIdSchema, rendered: z.boolean(), media: MediaRefSchema.optional() }))
        .max(FILM_LIST_MAX),
    })
    .optional(),
});

export const FootageCamerasSchema = z.strictObject({
  synced: z.boolean(),
  method: Text(32).optional(),
  angles: z.array(Text(64)).max(16),
  segments: z
    .array(
      z.strictObject({
        startSec: Seconds,
        endSec: Seconds,
        angle: Text(64),
        speaker: Text(64).optional(),
        reason: Text(32),
      }),
    )
    .max(400),
});

export const FootageReframeSchema = z.strictObject({
  formats: z
    .array(
      z.strictObject({
        format: FormatSchema,
        reframed: z.boolean(),
        /** Clips with a fixed position, and clips with a tracked path. */
        fixed: Count,
        tracked: Count,
        /** The first tracked path, sampled: cover alignment x/y (0–1) by source frame. */
        points: z.array(z.strictObject({ frame: Count, x: Unit, y: Unit })).max(120),
      }),
    )
    .max(3),
});

export const FootageRenderSchema = z.strictObject({
  /** `vertical`, or `vertical-clean` for a render with captions off. */
  name: Text(32),
  format: FormatSchema,
  state: z.enum(["fresh", "stale", "missing"]),
  /** The recut project that owns the render (media URLs use it, not the source project). */
  project: ProjectIdSchema,
  media: MediaRefSchema.optional(),
});

/** The footage route's material, section by section; a section is absent when its files are absent or unreadable. */
export const FootageMaterialSchema = z.strictObject({
  source: FootageSourceSchema.optional(),
  transcript: FootageTranscriptSchema.optional(),
  plan: FootagePlanSchema.optional(),
  recut: z
    .strictObject({
      project: ProjectIdSchema,
      revision: Count,
      editHash: Sha256Schema.optional(),
      chapters: z.boolean(),
    })
    .optional(),
  captions: FootageCaptionsSchema.optional(),
  shorts: FootageShortsSchema.optional(),
  cameras: FootageCamerasSchema.optional(),
  reframe: FootageReframeSchema.optional(),
  renders: z.array(FootageRenderSchema).max(6).optional(),
});
export type FootageMaterial = z.infer<typeof FootageMaterialSchema>;

export const AgentRunSchema = z.strictObject({
  /** Hook `agent_id`, or the dispatch's run id. */
  id: ConsoleIdSchema,
  name: Text(128),
  role: Text(64).optional(),
  harness: HarnessSchema.optional(),
  step: Text(64).optional(),
  lane: Text(64).optional(),
  parentId: ConsoleIdSchema.optional(),
  startedAt: IsoTimeSchema,
  endedAt: IsoTimeSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
  status: z.enum(["running", "done", "failed", "interrupted"]),
  /** Where the run is known from: hooks, `film:brief` dispatch, or CLI events only. */
  source: z.enum(["hook", "dispatch", "cli"]),
  commands: Count.optional(),
  lastAlias: Text(64).optional(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const JobSummarySchema = z.strictObject({
  id: Text(128),
  provider: Text(64),
  endpoint: Text(256).optional(),
  step: Text(64).optional(),
  state: JobStateSchema,
  reservedUsd: UsdSchema.optional(),
  costUsd: UsdSchema.optional(),
  /** False: the price is unknown (never free). */
  priceKnown: z.boolean(),
  submittedAt: IsoTimeSchema.optional(),
  finishedAt: IsoTimeSchema.optional(),
  /** The provider supports cancellation of this job (D12); undefined when unknown. */
  cancellable: z.boolean().optional(),
  /** Why the job cannot be cancelled now (src/lib/jobs/cancel.ts); amended 2026-11-17 (A9). */
  cancelReason: Text(240).optional(),
  outputs: z.array(RelativePathSchema).max(64).optional(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

export const ProviderSpendSchema = z.strictObject({
  provider: Text(64),
  spentUsd: UsdSchema,
  reservedUsd: UsdSchema,
  jobs: Count,
  unknownPriced: Count,
});
export type ProviderSpend = z.infer<typeof ProviderSpendSchema>;

export const ASSET_KINDS = ["image", "video", "audio", "model3d", "text", "json", "font", "other"] as const;

export const AssetSummarySchema = z.strictObject({
  id: Text(128),
  kind: z.enum(ASSET_KINDS),
  path: RelativePathSchema,
  /** generated, stock, import, derivative, user, library … (the asset registry's origin). */
  origin: Text(64).optional(),
  provider: Text(64).optional(),
  licence: z
    .strictObject({
      id: Text(64).optional(),
      name: Text(160).optional(),
      url: z.url().optional(),
      attribution: z.string().max(1000).optional(),
    })
    .optional(),
  costUsd: UsdSchema.optional(),
  /** Scenes, shots or files that use it. */
  usedIn: z.array(Text(256)).max(256),
  approved: z.boolean().optional(),
  sha256: Sha256Schema.optional(),
  thumbnail: MediaRefSchema.optional(),
});
export type AssetSummary = z.infer<typeof AssetSummarySchema>;

export const FINDING_SEVERITIES = ["info", "warning", "error"] as const;

export const FindingSchema = z.strictObject({
  id: Text(128),
  severity: z.enum(FINDING_SEVERITIES),
  /** The sensor or check: `motion:check`, `qa:editorial`, `delivery` … */
  source: Text(64),
  message: Text(2000),
  step: Text(64).optional(),
  format: FormatSchema.optional(),
  frame: Count.optional(),
  timeSec: z.number().nonnegative().optional(),
  evidence: z.array(MediaRefSchema).max(12).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const StepRowSchema = z.strictObject({
  id: Text(64),
  title: Text(160),
  status: StepStatusSchema,
  reasons: z.array(z.string().max(2000)).max(64),
  owner: Text(128).optional(),
  /** The user may skip it (`film:done --skip`, §8). */
  skippable: z.boolean().optional(),
  /** The step needs the user's approval. */
  gate: z.boolean().optional(),
  startedAt: IsoTimeSchema.optional(),
  closedAt: IsoTimeSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
  critic: z
    .strictObject({
      round: Count,
      score: z.number().finite().optional(),
      action: z.enum(["review", "fix", "ask", "closed"]).optional(),
    })
    .optional(),
});
export type StepRow = z.infer<typeof StepRowSchema>;

export const CompositionInfoSchema = z.strictObject({
  id: Text(128),
  /** Repository-relative entry file. */
  entry: RelativePathSchema,
  durationInFrames: z.number().int().positive(),
  fps: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/**
 * One paid model generation (a job of `generate:model` and the other provider commands, 2026-11-20): the job store's
 * record with the provider's error, the money it holds and the result file once published. `output` is set only when
 * the job is validated or published and the file exists; a failed or running job never points at its planned path.
 * The prompt is the request's own `prompt` field; uploaded or signed provider URLs never enter the view.
 */
export const GenerationSchema = z.strictObject({
  id: Text(128),
  provider: Text(64),
  endpoint: Text(256).optional(),
  model: Text(256).optional(),
  step: Text(64).optional(),
  state: JobStateSchema,
  /** The provider's or the store's error text, as written ("rejected by content moderation (nsfw)"). */
  error: Text(2000).optional(),
  /** Money still held for the job: a published job without a receipt is reserved, not settled (never free). */
  reservedUsd: UsdSchema,
  /** Settled cost (receipt less refunds), only when a receipt exists. */
  costUsd: UsdSchema.optional(),
  /** The provider confirmed it charged nothing (a refunded or released failure). */
  noCharge: z.boolean().optional(),
  priceKnown: z.boolean(),
  /** The quote's expected price, for a job not yet billed. */
  quotedUsd: UsdSchema.optional(),
  createdAt: IsoTimeSchema.optional(),
  submittedAt: IsoTimeSchema.optional(),
  finishedAt: IsoTimeSchema.optional(),
  prompt: z.string().max(8000).optional(),
  resolution: Text(32).optional(),
  /** The model preparation the request was built from (`pipeline/model-preparations/<id>/`). */
  preparation: Text(80).optional(),
  /** Project-relative file the job publishes to (planned while it runs). */
  outputPath: RelativePathSchema.optional(),
  output: MediaRefSchema.optional(),
  references: z.array(MediaRefSchema).max(16).optional(),
  /** The clip the job transformed (its first video reference), for "compare with source". */
  source: MediaRefSchema.optional(),
});
export type Generation = z.infer<typeof GenerationSchema>;

/** The latest model preparation (`model:prepare`, 2026-11-20): what the request will say and what it was approved on. */
export const ModelPreparationViewSchema = z.strictObject({
  id: Text(80),
  createdAt: IsoTimeSchema.optional(),
  endpoint: Text(256).optional(),
  mode: Text(64).optional(),
  prompt: z.string().max(8000).optional(),
  resolution: Text(32).optional(),
  /** References and board samples (images under the preparation folder or the project's assets). */
  references: z.array(MediaRefSchema).max(16),
  board: z.array(MediaRefSchema).max(16),
  source: MediaRefSchema.optional(),
  approval: z.strictObject({ at: IsoTimeSchema.optional(), userStatement: z.string().max(2000).optional() }).optional(),
  rights: z.strictObject({ status: Text(64), userStatement: z.string().max(2000).optional() }).optional(),
  /** Every preparation in the project (only the latest is shown). */
  count: Count,
});
export type ModelPreparationView = z.infer<typeof ModelPreparationViewSchema>;

export const GenerationsSchema = z.strictObject({
  /** Newest first. */
  jobs: z.array(GenerationSchema).max(200),
  preparation: ModelPreparationViewSchema.optional(),
  /**
   * The project's route has no material of its own (a `project:new` template with no code, render, music or voice)
   * while it has generations: the template's render is not the current step and Studio is not offered.
   */
  templateOnly: z.boolean().optional(),
});
export type Generations = z.infer<typeof GenerationsSchema>;

/**
 * Media albums of the project's Media tab (2026-11-20), grouped by how a file was made, not by folder: `sources` (the
 * user's originals and reference photos), `preparation` (cuts, parts, prepared clips fed to a generation),
 * `generations` (provider results with no job in the store; jobs themselves are `generations.jobs`), `builds` (joins,
 * renders under `out/<id>/`, finals) and `unregistered` (files under `assets/` that no registry entry or job lists).
 */
export const MEDIA_ALBUMS = ["sources", "preparation", "generations", "builds", "unregistered"] as const;
export const MediaAlbumSchema = z.enum(MEDIA_ALBUMS);
export type MediaAlbum = z.infer<typeof MediaAlbumSchema>;

export const MediaItemSchema = z.strictObject({
  /** `sha256:<hash>` for a registered file, else `file:<path>` or `out:<path>`. */
  id: Text(1100),
  album: MediaAlbumSchema,
  media: MediaRefSchema,
  /** False: a file no asset registry entry or job lists (shown, never registered by the console). */
  registered: z.boolean(),
  origin: Text(64).optional(),
  tool: Text(64).optional(),
  createdAt: IsoTimeSchema.optional(),
  /** Other project files with the same bytes. */
  aliases: z.array(RelativePathSchema).max(8).optional(),
  /** The file it was made from, when the lineage says so. */
  parent: MediaRefSchema.optional(),
  /** The paid job that produced it. */
  generation: Text(128).optional(),
  /** The model preparation it belongs to. */
  preparation: Text(80).optional(),
});
export type MediaItem = z.infer<typeof MediaItemSchema>;

export const GallerySchema = z.strictObject({
  /** Newest first within each album. */
  items: z.array(MediaItemSchema).max(2000),
  truncated: z.boolean().optional(),
});
export type Gallery = z.infer<typeof GallerySchema>;

export const ProjectViewSchema = z
  .strictObject({
    v: z.literal(1),
    /** Increments on every change the projector sees; SSE `view.changed` carries it (D6). */
    revision: Count,
    generatedAt: IsoTimeSchema,
    project: z.strictObject({
      id: ProjectIdSchema,
      route: RouteSchema,
      title: Text(200).optional(),
      filmType: Text(64).optional(),
      playbook: Text(64).optional(),
      formats: z.array(FormatSchema).max(3).optional(),
      createdAt: IsoTimeSchema,
    }),
    control: z.strictObject({
      state: ControlStateSchema,
      by: z.literal("user").optional(),
      at: IsoTimeSchema.optional(),
      reason: z.string().max(2000).optional(),
    }),
    autonomy: z.strictObject({
      mode: z.enum(["interactive", "autonomous"]),
      ceilingUsd: UsdSchema.optional(),
      finalReviewOnly: z.boolean().optional(),
      source: z.enum(["film:policy", "budget", "none"]),
    }),
    steps: z.array(StepRowSchema).max(128),
    current: z
      .strictObject({
        step: Text(64),
        owner: Text(128).optional(),
        next: z.strictObject({ argv: z.array(z.string().max(4096)).max(64), why: z.string().max(2000) }),
      })
      .optional(),
    /** Derived from chain or footage state, never only from the journal (FR2). */
    waiting: z.array(DecisionSchema).max(64),
    agents: z.strictObject({ active: AgentRunSchema.optional(), today: z.array(AgentRunSchema).max(500) }),
    money: z.strictObject({
      ceilingUsd: UsdSchema.optional(),
      reservedUsd: UsdSchema,
      spentUsd: UsdSchema,
      unknownPriced: Count,
      byProvider: z.array(ProviderSpendSchema).max(64),
      jobs: z.array(JobSummarySchema).max(1000),
    }),
    media: z.strictObject({
      latestRender: MediaRefSchema.optional(),
      animatic: MediaRefSchema.optional(),
      /** Scene renders and other renders, newest first. */
      renders: z.array(MediaRefSchema).max(200).optional(),
      composition: CompositionInfoSchema.optional(),
    }),
    assets: z.array(AssetSummarySchema).max(5000),
    qa: z.strictObject({
      findings: z.array(FindingSchema).max(1000),
      delivery: z
        .strictObject({
          ok: z.boolean(),
          checkedAt: IsoTimeSchema,
          formats: z
            .array(z.strictObject({ format: FormatSchema, ok: z.boolean() }))
            .max(3)
            .optional(),
        })
        .optional(),
    }),
    cards: z.array(CardSchema).max(200),
    advisories: z.array(z.string().max(2000)).max(64),
    /** Film route only: the chain's material for the film panels (WP10b amendment). */
    film: FilmMaterialSchema.optional(),
    /** Replica, recipe and campaign routes: their step material for the route panels (WP15 amendment). */
    replica: ReplicaMaterialSchema.optional(),
    recipe: RecipeMaterialSchema.optional(),
    campaign: CampaignMaterialSchema.optional(),
    /** Footage route only: the recording's material for the footage panels (WP12 amendment). */
    footage: FootageMaterialSchema.optional(),
    /** Paid model generations and the latest model preparation, on every route (2026-11-20). */
    generations: GenerationsSchema.optional(),
    /** The Media tab's albums: every media file of the project by lineage (2026-11-20). */
    gallery: GallerySchema.optional(),
    stepGuard: z
      .strictObject({
        violations: Count,
        last: z.strictObject({ at: IsoTimeSchema, alias: Text(64), step: Text(64), code: Text(32) }).optional(),
      })
      .optional(),
  })
  .superRefine((view, ctx) => {
    view.waiting.forEach((decision, index) => {
      if (decision.status !== "pending")
        ctx.addIssue({ code: "custom", path: ["waiting", index, "status"], message: "waiting decisions are pending" });
      if (decision.project !== view.project.id)
        ctx.addIssue({ code: "custom", path: ["waiting", index, "project"], message: "decision of another project" });
    });
    view.cards.forEach((card, index) => {
      if (card.project !== view.project.id)
        ctx.addIssue({ code: "custom", path: ["cards", index, "project"], message: "card of another project" });
    });
  });
export type ProjectView = z.infer<typeof ProjectViewSchema>;

/** Home page row (US1, `GET /api/projects`). */
export const ProjectSummarySchema = z.strictObject({
  id: ProjectIdSchema,
  route: RouteSchema,
  title: Text(200).optional(),
  filmType: Text(64).optional(),
  playbook: Text(64).optional(),
  step: Text(64).optional(),
  stepTitle: Text(160).optional(),
  stepStatus: StepStatusSchema.optional(),
  activeAgent: z.strictObject({ name: Text(128), role: Text(64).optional(), since: IsoTimeSchema }).optional(),
  waiting: Count,
  control: ControlStateSchema,
  spentUsd: UsdSchema,
  /** Money held by unsettled jobs (2026-11-20); shown beside spent, never folded into it. */
  reservedUsd: UsdSchema.optional(),
  ceilingUsd: UsdSchema.optional(),
  latestRender: MediaRefSchema.optional(),
  updatedAt: IsoTimeSchema,
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

// ---------------------------------------------------------------------------
// HTTP bodies (§9.1)
// ---------------------------------------------------------------------------

/** Error body of every endpoint; `error` uses the CLI error codes. */
export const ApiErrorSchema = z.strictObject({ ok: z.literal(false), error: Text(64), message: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** `GET /api/projects`. */
export const ProjectsResponseSchema = z.strictObject({
  v: z.literal(1),
  projects: z.array(ProjectSummarySchema),
  /** Waiting decisions across projects, newest first (home "Waiting for you"). */
  waiting: z.array(DecisionSchema).max(200),
  monthSpentUsd: UsdSchema.optional(),
  recentDeliveries: z
    .array(z.strictObject({ project: ProjectIdSchema, media: MediaRefSchema, checkedAt: IsoTimeSchema }))
    .max(50)
    .optional(),
});
export type ProjectsResponse = z.infer<typeof ProjectsResponseSchema>;

/** `GET /api/projects/:id/view` returns a {@link ProjectViewSchema}. */
export const ProjectViewResponseSchema = ProjectViewSchema;

/** `GET /api/projects/:id/events?since=<id>&limit=` query. */
export const EventsQuerySchema = z.strictObject({
  since: z.ulid().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
export type EventsQuery = z.infer<typeof EventsQuerySchema>;

/** `GET /api/projects/:id/events`: oldest first; `next` is the id to pass as `since` for the following page. */
export const EventsPageSchema = z.strictObject({
  v: z.literal(1),
  events: z.array(ConsoleEventSchema),
  next: z.ulid().nullable(),
});
export type EventsPage = z.infer<typeof EventsPageSchema>;

/** `GET /api/stream?project=:id` query. */
export const StreamQuerySchema = z.strictObject({ project: ProjectIdSchema.optional() });

/** SSE event names (the `event:` field); each `data:` line is one JSON {@link ConsoleStreamMessageSchema}. */
export const SSE_EVENTS = ["view.changed", "event"] as const;
export const ViewChangedMessageSchema = z.strictObject({
  type: z.literal("view.changed"),
  project: ProjectIdSchema.optional(),
  revision: Count,
});
export const EventMessageSchema = z.strictObject({ type: z.literal("event"), event: ConsoleEventSchema });
export const ConsoleStreamMessageSchema = z.discriminatedUnion("type", [ViewChangedMessageSchema, EventMessageSchema]);
export type ConsoleStreamMessage = z.infer<typeof ConsoleStreamMessageSchema>;

/** `GET /thumb/:id/*path?t=&w=` query: time in seconds and width in pixels. */
export const ThumbQuerySchema = z.strictObject({
  t: z.coerce.number().nonnegative().optional(),
  w: z.coerce.number().int().min(16).max(1920).optional(),
});

/**
 * `POST /api/projects/:id/decisions` (D9). Names a computed pending decision by `decisionId`, or a new decision by
 * `kind` (frame feedback, a rating, a verdict). `answer` is the user's words, verbatim (D10). `expect` is the hash the
 * user saw (FR3).
 */
/** Largest overlay a decision request carries (base64 characters, about 1.1 MB of PNG). */
export const FRAME_OVERLAY_MAX_BASE64 = 1_500_000;

export const DecisionRequestSchema = z
  .strictObject({
    decisionId: ConsoleIdSchema.optional(),
    kind: DecisionKindSchema.optional(),
    step: Text(64).optional(),
    choice: ConsoleIdSchema.optional(),
    answer: z
      .string()
      .max(8000)
      .refine((text) => text.trim().length > 0, "the user's words"),
    expect: Sha256Schema.optional(),
    verdict: VerdictSchema.optional(),
    frameComments: z.array(FrameCommentSchema).max(64).optional(),
    ratings: z.record(RelativePathSchema, z.number().int().min(1).max(5)).optional(),
    /**
     * The client's nonce for one submission (a rating or a frame comment, WP9): a retry with the same id returns the
     * first outcome instead of applying twice. Amended 2026-11-17 (RFC 0004 WP9 review).
     */
    requestId: ConsoleIdSchema.optional(),
    /** A `policy` request's change (amended 2026-11-17, A10). */
    policy: PolicyChangeSchema.optional(),
    /**
     * The marks of a frame comment drawn as the user saw them: a transparent PNG at the render's size, base64 (amended
     * 2026-11-20). The server hands it to `frame:note`, which lays it over the frame; the inbox never stores it.
     */
    overlay: z
      .string()
      .max(FRAME_OVERLAY_MAX_BASE64)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, "base64")
      .optional(),
  })
  .superRefine((request, ctx) => {
    if (request.overlay && request.kind !== "frame-note" && request.kind !== "frame-feedback")
      ctx.addIssue({ code: "custom", path: ["overlay"], message: "only a frame comment carries an overlay" });
    if (request.kind === "policy" && !request.policy)
      ctx.addIssue({ code: "custom", path: ["policy"], message: "a policy request carries its change" });
    if (request.policy && request.kind !== "policy")
      ctx.addIssue({ code: "custom", path: ["policy"], message: "only a policy request carries a policy change" });
    if (!request.decisionId && !request.kind)
      ctx.addIssue({ code: "custom", path: ["decisionId"], message: "decisionId or kind" });
    if (request.kind === "verdict" && !request.verdict)
      ctx.addIssue({ code: "custom", path: ["verdict"], message: "a verdict carries its scores" });
    if (request.kind === "control")
      ctx.addIssue({ code: "custom", path: ["kind"], message: "control goes to /control" });
  });
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

/** Reply of `POST …/decisions`: the decision as written to the inbox (applied or refused, with the CLI envelope). */
export const DecisionResponseSchema = z.strictObject({ ok: z.boolean(), decision: DecisionSchema });
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

/** `POST /api/projects/:id/control` (D12). */
export const ControlRequestSchema = z.strictObject({
  state: ControlStateSchema,
  answer: z
    .string()
    .max(4000)
    .refine((text) => text.trim().length > 0, "the user's words"),
  reason: z.string().max(2000).optional(),
});
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

/** Reply of `POST …/control`; a stop lists the running paid jobs the user may cancel one by one (D12). */
export const ControlResponseSchema = z.strictObject({
  ok: z.boolean(),
  control: ControlFileSchema,
  runningJobs: z.array(JobSummarySchema).optional(),
  result: CliEnvelopeSchema.optional(),
});
export type ControlResponse = z.infer<typeof ControlResponseSchema>;

/** A paid job's operation ID, as the job store writes it (src/lib/jobs/types.ts `OperationInputSchema`). */
export const OperationIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/, "an operation id");

/** What a cancel did (D12): never faked; `unavailable` when the provider or the job's state allows no cancel. */
export const JOB_CANCEL_OUTCOMES = ["cancelled", "requested", "unavailable", "refused", "busy"] as const;
export const JobCancelOutcomeSchema = z.enum(JOB_CANCEL_OUTCOMES);

/** `POST /api/projects/:id/jobs/:jobId/cancel` (D12, WP8 amendment): the user cancels one paid job, in their words. */
export const JobCancelRequestSchema = z.strictObject({
  answer: z
    .string()
    .max(4000)
    .refine((text) => text.trim().length > 0, "the user's words"),
});
export type JobCancelRequest = z.infer<typeof JobCancelRequestSchema>;

/** Reply of `POST …/jobs/:jobId/cancel`: the outcome, the job after it and the `job:cancel` envelope. */
export const JobCancelResponseSchema = z.strictObject({
  ok: z.boolean(),
  outcome: JobCancelOutcomeSchema.optional(),
  job: JobSummarySchema.optional(),
  message: z.string().max(4000).optional(),
  result: CliEnvelopeSchema.optional(),
});
export type JobCancelResponse = z.infer<typeof JobCancelResponseSchema>;

/** `POST /api/projects/:id/cards/:cardId/answer` (the server stamps `at`). */
export const CardAnswerRequestSchema = z
  .strictObject({
    choice: ConsoleIdSchema.optional(),
    text: z.string().max(8000).optional(),
    ratings: z.record(RelativePathSchema, z.number().int().min(1).max(5)).optional(),
  })
  .refine(
    (answer) => answer.choice !== undefined || !!answer.text?.trim() || answer.ratings,
    "an answer says something",
  );
export type CardAnswerRequest = z.infer<typeof CardAnswerRequestSchema>;

export const CardAnswerResponseSchema = z.strictObject({ ok: z.literal(true), card: CardSchema });
export type CardAnswerResponse = z.infer<typeof CardAnswerResponseSchema>;

// ---------------------------------------------------------------------------
// Remotion Studio on request (§17 amendment of D21, 2026-11-18)
// ---------------------------------------------------------------------------

/** What Studio opens for a project: a bespoke film's build entry and composition, or a project.json composition. */
export const StudioTargetSchema = z.strictObject({
  /** `film`: pipeline/build.json; `project`: project.json through GenericProject with the render's props. */
  kind: z.enum(["film", "project"]),
  entry: RelativePathSchema,
  composition: Text(128),
  format: FormatSchema.optional(),
});
export type StudioTarget = z.infer<typeof StudioTargetSchema>;

/** Reply of `GET /api/projects/<id>/studio`: whether Studio can open this project, and the running one. */
export const StudioStatusResponseSchema = z.strictObject({
  ok: z.literal(true),
  available: z.boolean(),
  /** Why not, in English, when `available` is false (a campaign container, no build.json and no project.json). */
  reason: z.string().max(500).optional(),
  target: StudioTargetSchema.optional(),
  /** Formats a `project` target can open; a film has its own. */
  formats: z.array(FormatSchema).max(3).optional(),
  running: z
    .strictObject({ url: z.string().max(512), startedAt: IsoTimeSchema, format: FormatSchema.optional() })
    .optional(),
});
export type StudioStatusResponse = z.infer<typeof StudioStatusResponseSchema>;

/** Body of `POST /api/projects/<id>/studio`: start Studio for the project, or reuse the running one. */
export const StudioOpenRequestSchema = z.strictObject({ format: FormatSchema.optional() });
export type StudioOpenRequest = z.infer<typeof StudioOpenRequestSchema>;

/** Reply of `POST /api/projects/<id>/studio`: the loopback URL of the composition in Studio. */
export const StudioOpenResponseSchema = z.strictObject({
  ok: z.literal(true),
  url: z.string().max(512),
  reused: z.boolean(),
});
export type StudioOpenResponse = z.infer<typeof StudioOpenResponseSchema>;
