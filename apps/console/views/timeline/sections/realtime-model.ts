/**
 * Pure rules of the timeline's offline realtime editor (RU-R, RU-RC, RU-RS in the review:ui parity checklist),
 * ported from review:ui's `realtime-client.ts` / `realtime-still-client.ts`: the button-enable matrix (RU-R17), the
 * summary, the derive patch with its exact user-bound quote (RU-R10), the still draft payload (RU-RS02), the still
 * metadata check (RU-RS01) and the still identity (RU-RS03). No I/O; `realtime-controller.ts` drives them.
 */

/** A revision of `RealtimeReviewService.view().revisions` (only what the panel shows). */
export interface RealtimeRevision {
  revisionId: string;
  sessionId: string;
  status: "draft" | "queued" | "superseded" | "in-flight" | "uncertain" | "cancelled" | "complete" | string;
  highUsd: number;
  inputHash: string;
  request: { sha256: string; [key: string]: unknown };
  result?: { sha256: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** `GET …/realtime?editor=` (and every realtime mutation's reply). */
export interface RealtimeEditorView {
  editorId: string;
  sequence: number;
  ceilingUsd: number;
  committedUsd: number;
  queued?: string;
  inFlight?: string;
  selected?: string;
  revisions: RealtimeRevision[];
  /** The selected immutable preview's frames: `@realtime/<sha(editor)>/<resultSha>/<n>` (RU-R16). */
  frames: { file: string; sha256: string }[];
  /** Present on an `add-asset` reply (RU-RS02). */
  sourceInput?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RealtimeEditorListing {
  editorId: string;
  sequence: number;
  [key: string]: unknown;
}

/** `GET …/realtime/channel-state?editor=` (`RealtimeReviewChannels.inspect`). */
export interface ChannelState {
  sequence: number;
  stateSha256: string;
  unresolvedCount?: number;
  [key: string]: unknown;
}

/** One unknown local outcome listed by a channel reply (RU-RC06). */
export interface UnresolvedItem {
  localSessionId: string;
  messageId: string;
  intentSha256: string;
}

/** A registered still (`listRealtimeStills`, metadata only: nothing is decoded or previewed). */
export interface StillSource {
  assetId: string;
  assetSha256: string;
  mime: string;
  width: number;
  height: number;
  bytes?: number;
  [key: string]: unknown;
}

export const MAX_INLINE_REQUEST_BYTES = 65536;
export const MAX_STILL_PAYLOAD_BYTES = 16384;
export const MAX_STILL_SOURCES = 128;
/** RU-R03: background re-read interval while the panel is open, visible and no channel is active or busy. */
export const POLL_MS = 2500;
/** Same pattern as the server's editor, revision, session and channel IDs. */
export const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,100}$/;
const HASH = /^[a-f0-9]{64}$/;

/** Actions that only exist over HTTP; refused while the local channel is active (RU-RC03). */
export const HTTP_ONLY_ACTIONS = ["create", "add", "add-file", "add-asset"] as const;

export const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** The `#rt-summary` object (RU-R02): provider flags are always false. */
export function editorSummary(value: RealtimeEditorView) {
  return {
    editor: value.editorId,
    sequence: value.sequence,
    ceilingUsd: value.ceilingUsd,
    committedPlanningUsd: value.committedUsd,
    queued: value.queued || null,
    inFlight: value.inFlight || null,
    selected: value.selected || null,
    providerAck: false,
    liveVerified: false,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// RU-R17: the button-enable matrix (true = disabled), exactly as review:ui's `enabled()`.

export interface EnableInput {
  busy: boolean;
  current?: Pick<RealtimeEditorView, "editorId" | "queued" | "inFlight" | "revisions">;
  historyBlocked: boolean;
  channel: { active: boolean; busy: boolean; blocked: boolean };
  composer?: { editorId: string };
}

export interface Disabled {
  editor: boolean;
  refresh: boolean;
  create: boolean;
  add: boolean;
  addFile: boolean;
  complete: boolean;
  handoff: boolean;
  cancel: boolean;
  recover: boolean;
  derive: boolean;
  channelOpen: boolean;
  channelClose: boolean;
  channelStatus: boolean;
  reconcile: boolean;
  revision: (revision: Pick<RealtimeRevision, "status">, action: "queue" | "inspect" | "derive" | "select") => boolean;
}

export function disabledMatrix(input: EnableInput): Disabled {
  const { busy, current, composer } = input;
  const channelBusy = input.channel.busy;
  const channelActive = input.channel.active;
  const blocked = input.historyBlocked || input.channel.blocked;
  const base = busy || channelBusy;
  return {
    editor: base,
    refresh: base,
    create: base || channelActive,
    add: base || channelActive || blocked,
    addFile: base || channelActive || blocked,
    complete: base || blocked,
    handoff:
      base ||
      blocked ||
      !current?.queued ||
      !!current?.inFlight ||
      !!current?.revisions.some((revision) => revision.status === "uncertain"),
    cancel: base || blocked || !current || (!current.queued && !current.inFlight),
    recover: base || blocked || !current?.inFlight,
    derive: base || blocked || !composer || !current || composer.editorId !== current.editorId,
    channelOpen: base || channelActive || !current,
    channelClose: !channelBusy && !channelActive,
    channelStatus: base || !channelActive,
    reconcile: base || !channelActive,
    revision: (revision, action) =>
      base ||
      (blocked && (action === "queue" || action === "select")) ||
      (action === "queue" && revision.status !== "draft") ||
      (action === "select" && revision.status !== "complete"),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// RU-R10: edit a pinned request as a new local draft

/** The 7 whitelisted inputs as the form holds them (strings for number fields, as typed). */
export interface DeriveForm {
  revisionId: string;
  sessionId: string;
  prompt: string;
  seed: string;
  steps: string;
  scheduleMu: string;
  feedback: string;
  imageSize: "square" | "square_hd";
  interpolation: boolean;
  bound: string;
}

/** Prefill from `derive-source`: new IDs and the bound are cleared; defaults as review:ui. */
export function derivePrefill(input: Record<string, unknown>): DeriveForm {
  const text = (value: unknown, fallback: number | string) => String(value ?? fallback);
  return {
    revisionId: "",
    sessionId: "",
    bound: "",
    prompt: typeof input.prompt === "string" ? input.prompt : "",
    seed: input.seed === undefined ? "" : String(input.seed),
    steps: text(input.num_inference_steps, 3),
    scheduleMu: text(input.schedule_mu, 2.3),
    feedback: text(input.output_feedback_strength, 1),
    imageSize: input.image_size === "square_hd" ? "square_hd" : "square",
    interpolation: input.enable_interpolation === true,
  };
}

/** Source of the composed quote (verbatim from review:ui). */
export const DERIVE_QUOTE_SOURCE =
  "Explicit user-entered derive upper planning bound; expected equals conservative bound";

/** The patch exactly as review:ui composes it; `asOf` is the caller's clock. */
export function derivePatch(sourceRevision: string, form: DeriveForm, asOf: string) {
  const high = Number(form.bound);
  return {
    sourceRevision,
    revisionId: form.revisionId,
    sessionId: form.sessionId,
    input: {
      prompt: form.prompt,
      seed: Number(form.seed),
      num_inference_steps: Number(form.steps),
      schedule_mu: Number(form.scheduleMu),
      output_feedback_strength: Number(form.feedback),
      image_size: form.imageSize,
      enable_interpolation: form.interpolation,
    },
    quote: {
      currency: "USD",
      lowUsd: 0,
      expectedUsd: high,
      highUsd: high,
      bounded: true,
      confidence: "user-bound",
      providerEnforced: false,
      source: DERIVE_QUOTE_SOURCE,
      asOf,
    },
  };
}

export const positiveBound = (value: string) => {
  const high = Number(value);
  return value.trim() !== "" && Number.isFinite(high) && high > 0;
};

// ---------------------------------------------------------------------------------------------------------------------
// RU-RS: draft from a registered still

export interface StillForm {
  revisionId: string;
  sessionId: string;
  prompt: string;
  seed: string;
  bound: string;
  frames: string;
  inputBytes: string;
  responseBytes: string;
  controls: string;
  timeoutMs: string;
}

export const STILL_DEFAULTS: StillForm = {
  revisionId: "",
  sessionId: "",
  prompt: "",
  seed: "",
  bound: "",
  frames: "1",
  inputBytes: "4194304",
  responseBytes: "16777216",
  controls: "4",
  timeoutMs: "2000",
};

/** The pinned listing context: editor + sequence + registry checksum. */
export interface StillContext {
  editorId: string;
  sequence: number;
  registrySha256: string;
}

/** RU-RS01: a listing reply must be metadata only, ≤128 sources, with a 64-hex registry checksum. */
export function checkStillListing(value: unknown): { registrySha256: string; sources: StillSource[] } {
  const reply = (value ?? {}) as { metadataOnly?: unknown; sources?: unknown; registrySha256?: unknown };
  if (
    !reply.metadataOnly ||
    !Array.isArray(reply.sources) ||
    reply.sources.length > MAX_STILL_SOURCES ||
    typeof reply.registrySha256 !== "string" ||
    !HASH.test(reply.registrySha256)
  )
    throw new Error("Invalid still source metadata");
  return { registrySha256: reply.registrySha256, sources: reply.sources as StillSource[] };
}

/** Option label `mime · W×H · assetId`. */
export const stillLabel = (source: StillSource) =>
  `${source.mime} · ${source.width}×${source.height} · ${source.assetId}`;

/** RU-RS02: the `add-asset` body. */
export function stillPayload(context: StillContext, source: StillSource, form: StillForm) {
  return {
    action: "add-asset" as const,
    editorId: context.editorId,
    expected: context.sequence,
    draft: {
      assetId: source.assetId,
      assetSha256: source.assetSha256,
      registrySha256: context.registrySha256,
      revisionId: form.revisionId,
      sessionId: form.sessionId,
      input: { prompt: form.prompt, seed: Number(form.seed) },
      highUsd: Number(form.bound),
      limits: {
        maxFrames: Number(form.frames),
        maxInputBytes: Number(form.inputBytes),
        maxResponseBytes: Number(form.responseBytes),
        maxControls: Number(form.controls),
        timeoutMs: Number(form.timeoutMs),
      },
    },
  };
}

/** RU-RS03: any change of these discards the loaded sources. */
export function stillIdentity(input: {
  editorId?: string;
  sequence?: number;
  active: boolean;
  blocked: boolean;
  channelActive: boolean;
  channelBusy: boolean;
}): string {
  return JSON.stringify([
    input.editorId ?? null,
    input.sequence ?? null,
    input.active,
    input.blocked,
    input.channelActive,
    input.channelBusy,
  ]);
}

/** A status or summary value: text as written, anything else as pretty JSON (review:ui's `show`). */
export type DisplayValue = string | Record<string, unknown> | unknown[] | null | undefined;
export const displayText = (value: DisplayValue): string =>
  value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
