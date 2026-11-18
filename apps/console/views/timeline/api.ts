/**
 * Typed client of the console's review routes (`/api/review/<project>/…`, RFC 0004 WP13) and the universal review
 * behaviours of the review:ui parity checklist:
 *
 * - G1 status and errors: {@link runReviewTask} shows working, then ready or the server's message.
 * - G2 409: a conflict refreshes state and clears the draft through `onConflict`; nothing is ever re-sent.
 * - G3 proposal epoch: {@link ProposalGuard} discards a late prepare reply after a cancel, a new revision, another
 *   clip, another operation or another form signature.
 * - G5 apply: {@link planApply} / {@link applyProposal} refuse during a pointer drag and on an empty command, re-run the
 *   generic dry-run when the command was edited, then apply with the draft's revision as CAS.
 * - G6 display: {@link proposalSummary}.
 *
 * The review:ui browser modules are imported as modules (not serialized with `.toString()`): `pointerProposal`,
 * `createReviewChannelClient`.
 */
import { ApiFailure } from "@/api/errors";
import type { TextTransport } from "@/api/types";

export { pointerProposal } from "@review/pointer";
export { createReviewChannelClient } from "@review/realtime-channel-client";

// ---------------------------------------------------------------------------------------------------------------------
// Shapes returned by the unchanged services (ReviewService.state and friends). Only what the views read is typed
// strictly; the rest stays `unknown` and is shown as JSON where the old page did.

export interface Rational {
  num: number;
  den: number;
}

export interface ReviewCaption {
  start: Rational;
  end: Rational;
  text: string;
  [key: string]: unknown;
}

export interface ReviewClip {
  id: string;
  assetId: string;
  start: Rational;
  end: Rational;
  source: { start: Rational; end: Rational; timebase: Rational };
  rate: Rational;
  transition?: { kind: "cut" } | { kind: "fade"; duration: Rational } | Record<string, unknown>;
  captions?: ReviewCaption[];
  payload?: Record<string, unknown>;
}

export interface ReviewTrack {
  id: string;
  /** `visual`, `presenter`, `music`, `sfx`, … */
  kind: string;
  clips: ReviewClip[];
}

export interface ReviewAsset {
  id: string;
  kind: string;
  hash?: string;
  media?: unknown;
  rights?: { licence?: string; [key: string]: unknown };
  origin?: string;
  model?: unknown;
  billing?: string;
  /** `projects/<id>/…`; the file route takes it without the `projects/<id>/` prefix. */
  original: string;
}

export interface ReviewSnapshot {
  hash: string;
  label: string;
  revision: number;
  createdAt: string;
  durationInFrames: number;
}

export interface ReviewChoice {
  version: number;
  snapshotHash: string;
  snapshotRevision: number;
  currentRevision: number;
  currentHash: string;
  actor: string;
  declaredAt: string;
}

export interface ReviewBudgetJob {
  id: string;
  state: string;
  endpoint?: string;
  reservedUsd: number;
  quote?: unknown;
  actualUsd: number | null;
  paidAttempts?: number;
}

export interface ReviewState {
  projectId: string;
  /** `null` while the journal (`pipeline/timeline-edit.json`) is not initialized (RU-SE07). */
  revision: number | null;
  timelineHash: string | null;
  durationInFrames: number;
  timebase?: Rational;
  tracks: ReviewTrack[];
  /** Undo-stack commands, oldest first. */
  journal: unknown[];
  redoCount: number;
  assets: ReviewAsset[];
  entities: { id: string; kind: string; latestRevision: number; canonicalRevision?: number | null; name?: string }[];
  budget: { status?: string; jobs: ReviewBudgetJob[]; [key: string]: unknown };
  snapshots: ReviewSnapshot[];
  selected: ReviewChoice | null;
  /** Project-relative report paths (evidence runs, QA files, asset board, animatic). */
  reports: string[];
  /** `@out/…` renders and screenshots. */
  outputs: string[];
  visualisations?: unknown;
}

export interface DryRunResult {
  revision: number;
  timelineHash: string;
  snapshot: { durationInFrames: number; [key: string]: unknown };
}

/** A specialized prepare reply: a dry-run plus the command it built (and route-specific facts). */
export interface ProposalResult extends DryRunResult {
  command: unknown;
  [key: string]: unknown;
}

export interface CompareSide {
  hash: string;
  revision: number;
  timeline: { tracks: ReviewTrack[]; durationInFrames: number; [key: string]: unknown };
}

export interface CompareResult {
  left: CompareSide;
  right: CompareSide;
  equal: boolean;
}

/** `POST …/mutate` bodies (ReviewMutationSchema). */
export type ReviewMutation =
  | { action: "edit"; expectedRevision: number; command: unknown }
  | { action: "undo" | "redo"; expectedRevision: number }
  | { action: "snapshot"; expectedRevision: number; label: string }
  | { action: "choose"; expectedRevision: number; snapshotHash: string; actor: string };

/** The specialized prepare routes (RU-P, RU-AU01/02). */
export const PROPOSAL_ROUTES = [
  "authored-copy-proposal",
  "visual-reframe-proposal",
  "visual-remove-proposal",
  "visual-slip-proposal",
  "visual-split-proposal",
  "audio-position-proposal",
  "group-move-proposal",
] as const;
export type ProposalRoute = (typeof PROPOSAL_ROUTES)[number];

/** The channel ticket as `RealtimeReviewChannels.issue` returns it (checked again by the channel client). */
export interface ChannelTicket {
  version: 1;
  ticket: string;
  expiresAt: number;
  path: string;
  protocol: string;
  editorId: string;
  localSessionId: string;
  sequence: number;
  stateSha256: string;
  unresolvedCount: number;
  providerAck: false;
  providerPersistent: false;
  liveVerified: false;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------------------------------------
// Errors

/** A failed review request: the server's message verbatim; `conflict` for HTTP 409 (G2). */
export class ReviewRequestError extends Error {
  readonly status: number | undefined;
  readonly code: string;
  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = "ReviewRequestError";
    this.status = status;
    this.code = code;
  }
  get conflict(): boolean {
    return this.status === 409;
  }
}

/** A late prepare reply discarded by {@link ProposalGuard} (G3). */
export class ProposalStaleError extends Error {
  constructor(message = "Proposal cancelled or revision changed. Prepare again.") {
    super(message);
    this.name = "ProposalStaleError";
  }
}

function toReviewError(error: unknown): ReviewRequestError {
  if (error instanceof ReviewRequestError) return error;
  if (error instanceof ApiFailure) return new ReviewRequestError(error.message, error.code, error.status);
  return new ReviewRequestError(error instanceof Error ? error.message : String(error), "NETWORK");
}

// ---------------------------------------------------------------------------------------------------------------------
// The client

const enc = encodeURIComponent;

export class ReviewApi {
  readonly base: string;

  constructor(
    readonly project: string,
    private readonly transport: TextTransport,
  ) {
    this.base = `/api/review/${enc(project)}`;
  }

  private async call<T>(method: "GET" | "POST", route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let reply: { status: number; text: string };
    try {
      reply = await this.transport(method, `${this.base}/${route}`, body, signal);
    } catch (error) {
      throw toReviewError(error);
    }
    let json: unknown;
    try {
      json = reply.text ? JSON.parse(reply.text) : undefined;
    } catch {
      throw new ReviewRequestError(`Reply is not JSON (HTTP ${reply.status})`, "INVALID_RESPONSE", reply.status);
    }
    if (reply.status >= 400) {
      const body = (json ?? {}) as { error?: unknown; message?: unknown };
      throw new ReviewRequestError(
        typeof body.message === "string" ? body.message : `HTTP ${reply.status}`,
        typeof body.error === "string" ? body.error : "HTTP_ERROR",
        reply.status,
      );
    }
    return json as T;
  }

  state(signal?: AbortSignal) {
    return this.call<ReviewState>("GET", "state", undefined, signal);
  }
  dryRun(expectedRevision: number, command: unknown) {
    return this.call<DryRunResult>("POST", "dry-run", { expectedRevision, command });
  }
  /** Returns the new state (the service re-reads it after the write). */
  mutate(mutation: ReviewMutation) {
    return this.call<ReviewState>("POST", "mutate", mutation);
  }
  /** A specialized prepare (never writes). The body is the route's strict schema. */
  propose<T extends ProposalResult = ProposalResult>(route: ProposalRoute, body: Record<string, unknown>) {
    return this.call<T>("POST", route, body);
  }
  /** `left`/`right`: `current` or a snapshot hash. */
  compare(left: string, right: string) {
    return this.call<CompareResult>("GET", `compare?left=${enc(left)}&right=${enc(right)}`);
  }
  reviewPack(manifest: string) {
    return this.call<Record<string, unknown>>("GET", `review-pack?path=${enc(manifest)}`);
  }
  chapterInspection(body: {
    expectedRevision: number;
    timelineHash: string;
    manifestSha256: string | null;
    format: string;
    chapterId?: string;
  }) {
    return this.call<Record<string, unknown>>("POST", "chapter-inspection", body);
  }

  readonly realtime = {
    list: () => this.call<{ editors: Record<string, unknown>[]; errors?: unknown[] }>("GET", "realtime"),
    view: (editor: string) => this.call<Record<string, unknown>>("GET", `realtime?editor=${enc(editor)}`),
    channelState: (editor: string) =>
      this.call<Record<string, unknown>>("GET", `realtime/channel-state?editor=${enc(editor)}`),
    stillSources: () => this.call<Record<string, unknown>>("GET", "realtime/still-sources"),
    deriveSource: (editor: string, revision: string) =>
      this.call<Record<string, unknown>>(
        "GET",
        `realtime/derive-source?editor=${enc(editor)}&revision=${enc(revision)}`,
      ),
    request: (editor: string, revision: string) =>
      this.call<Record<string, unknown>>("GET", `realtime/request?editor=${enc(editor)}&revision=${enc(revision)}`),
    mutate: (body: Record<string, unknown>) => this.call<Record<string, unknown>>("POST", "realtime", body),
    channelTicket: (input: { editorId: string; localSessionId: string }) =>
      this.call<ChannelTicket>("POST", "realtime/channel-ticket", input),
  };

  /**
   * URL for `<img>`, `<video>`, `<audio>` (the session cookie authenticates it). `file` is a report, an `@out/…`
   * output, an `@realtime/…` frame or an asset original without `projects/<id>/`.
   */
  fileUrl(file: string): string {
    return `${this.base}/file?path=${enc(file)}`;
  }

  /** An asset's `original` (`projects/<id>/…`) as the file route's path. */
  originalPath(asset: Pick<ReviewAsset, "original">): string {
    return asset.original.replace(`projects/${this.project}/`, "");
  }

  /** A text report with the token header (RU-Q02); render it through text nodes only, never as HTML. */
  async reportText(file: string): Promise<string> {
    let reply: { status: number; text: string };
    try {
      reply = await this.transport("GET", `${this.base}/file?path=${enc(file)}`);
    } catch (error) {
      throw toReviewError(error);
    }
    if (reply.status >= 400) throw new ReviewRequestError("Cannot open report", "HTTP_ERROR", reply.status);
    return reply.text;
  }

  /** The realtime channel's WebSocket URL on this origin; the ticket goes in the subprotocol, never in the URL. */
  channelSocketUrl(origin: string = globalThis.location?.origin ?? ""): string {
    return `${origin.replace(/^http/, "ws")}${this.base}/realtime/channel`;
  }

  /** `ticket` and `socket` dependencies of `createReviewChannelClient`. */
  channelTransport(WebSocketImpl: typeof WebSocket = globalThis.WebSocket) {
    return {
      ticket: (input: { editorId: string; localSessionId: string }) => this.realtime.channelTicket(input),
      socket: (ticket: { protocol: string; ticket: string }) =>
        new WebSocketImpl(this.channelSocketUrl(), [ticket.protocol, `t.${ticket.ticket}`]),
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// G1 / G2: status and conflicts

export type ReviewStatus =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "ready" }
  | { kind: "error"; message: string }
  /** HTTP 409: state was refreshed and the draft cleared; validate again, nothing was replayed. */
  | { kind: "conflict"; message: string };

export interface RunHooks {
  setStatus(status: ReviewStatus): void;
  /** G2: re-read state and clear the draft. Never re-send the request. */
  onConflict(): Promise<void>;
}

/** G1: working → ready, or the error's message; a 409 first refreshes through `onConflict`. Never throws. */
export async function runReviewTask(task: () => Promise<unknown>, hooks: RunHooks): Promise<boolean> {
  hooks.setStatus({ kind: "working" });
  try {
    await task();
    hooks.setStatus({ kind: "ready" });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ReviewRequestError && error.conflict) {
      try {
        await hooks.onConflict();
      } catch {
        // The refresh failure is secondary; the conflict message stays.
      }
      hooks.setStatus({ kind: "conflict", message });
    } else hooks.setStatus({ kind: "error", message });
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// G3: proposal epoch

/** What a prepared proposal is bound to; any change discards a late reply. */
export interface ProposalBinding {
  revision: number | null;
  trackId?: string;
  clipId?: string;
  /** The operation picker's value. */
  operation?: string;
  /** Extra form signature (reframe controls, group members, chapter format, …). */
  signature?: string;
}

export interface ProposalTicket {
  epoch: number;
  binding: ProposalBinding;
}

export interface CancelEvent {
  /** False when only the draft is dropped and the command text is kept (typing in the command, RU-K07). */
  clearCommand: boolean;
}

const sameBinding = (a: ProposalBinding, b: ProposalBinding) =>
  a.revision === b.revision &&
  a.trackId === b.trackId &&
  a.clipId === b.clipId &&
  a.operation === b.operation &&
  a.signature === b.signature;

export class ProposalGuard {
  private epoch = 0;
  private readonly listeners = new Set<(event: CancelEvent) => void>();

  get current(): number {
    return this.epoch;
  }

  /** Bumps the epoch (every outstanding ticket goes stale) and tells the listeners (G4 invalidators call this). */
  cancel(event: CancelEvent = { clearCommand: true }): void {
    this.epoch++;
    for (const listener of [...this.listeners]) listener(event);
  }

  onCancel(listener: (event: CancelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The generic validate (Dry run, and Apply of an edited command): bumps the epoch so any specialized prepare still
   * in flight is discarded, keeps the command text, and returns this validation's ticket.
   */
  restart(binding: ProposalBinding): ProposalTicket {
    this.cancel({ clearCommand: false });
    return this.begin(binding);
  }

  /** Captures the epoch and binding before the request. */
  begin(binding: ProposalBinding): ProposalTicket {
    return { epoch: this.epoch, binding: { ...binding } };
  }

  isCurrent(ticket: ProposalTicket, now: ProposalBinding): boolean {
    return ticket.epoch === this.epoch && sameBinding(ticket.binding, now);
  }

  /** After the reply: throws {@link ProposalStaleError} when anything changed meanwhile. */
  assertCurrent(ticket: ProposalTicket, now: ProposalBinding, message?: string): void {
    if (!this.isCurrent(ticket, now)) throw new ProposalStaleError(message);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// G5 / G6: apply and display

/** The pinned proposal: the command exactly as validated, and the revision it was validated against. */
export interface ProposalDraft {
  command: unknown;
  revision: number;
}

export type ApplyPlan =
  | { kind: "refuse"; reason: "pointer-active" | "empty-command" | "invalid-json"; message: string }
  /** No draft, or the command text differs from it: the generic dry-run runs first (specialized checks are lost). */
  | { kind: "validate-then-apply"; command: unknown }
  | { kind: "apply"; draft: ProposalDraft };

export const APPLY_REFUSALS = {
  "pointer-active": "Finish or cancel pointer interaction before applying",
  "empty-command": "Prepare a new proposal first",
} as const;

export function planApply(input: { draft?: ProposalDraft; commandText: string; pointerActive: boolean }): ApplyPlan {
  if (input.pointerActive)
    return { kind: "refuse", reason: "pointer-active", message: APPLY_REFUSALS["pointer-active"] };
  if (!input.commandText.trim())
    return { kind: "refuse", reason: "empty-command", message: APPLY_REFUSALS["empty-command"] };
  let command: unknown;
  try {
    command = JSON.parse(input.commandText);
  } catch (error) {
    return { kind: "refuse", reason: "invalid-json", message: error instanceof Error ? error.message : "Invalid JSON" };
  }
  if (input.draft && JSON.stringify(input.draft.command) === JSON.stringify(command))
    return { kind: "apply", draft: input.draft };
  return { kind: "validate-then-apply", command };
}

/**
 * G5: applies the command in the textarea. A refusal or a stale validation throws (G1 shows it). The authority is the
 * journal CAS (`expectedRevision` = the draft's revision) plus the store validators; Apply never re-runs a
 * specialized prepare. Returns the state the service read back and the draft that was applied.
 */
export async function applyProposal(
  api: ReviewApi,
  guard: ProposalGuard,
  input: { draft?: ProposalDraft; commandText: string; pointerActive: boolean; revision: number | null },
): Promise<{ state: ReviewState; applied: ProposalDraft; validated: DryRunResult | undefined }> {
  const plan = planApply(input);
  if (plan.kind === "refuse") throw new Error(plan.message);
  let draft: ProposalDraft;
  let validated: DryRunResult | undefined;
  if (plan.kind === "validate-then-apply") {
    const result = await validateCommand(api, guard, input.revision, plan.command);
    validated = result.validated;
    draft = result.draft;
  } else draft = plan.draft;
  const state = await api.mutate({ action: "edit", expectedRevision: draft.revision, command: draft.command });
  return { state, applied: draft, validated };
}

/**
 * The generic dry-run (the Dry run button; Apply of an edited command): restarts the proposal epoch first, then pins
 * `{command, revision}` only if nothing changed while the request was out (G3). Never writes.
 */
export async function validateCommand(
  api: ReviewApi,
  guard: ProposalGuard,
  revision: number | null,
  command: unknown,
): Promise<{ draft: ProposalDraft; validated: DryRunResult }> {
  if (revision === null) throw new Error("Initialize the timeline before editing");
  const ticket = guard.restart({ revision });
  const validated = await api.dryRun(revision, command);
  guard.assertCurrent(ticket, { revision }, "Proposal cancelled or revision changed. Validate again.");
  return { draft: { command, revision }, validated };
}

/** G6: what the dry-run panel shows for a prepared or validated proposal. */
export function proposalSummary(result: DryRunResult, flags: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: result.revision,
    proposedHash: result.timelineHash,
    durationInFrames: result.snapshot.durationInFrames,
    ...flags,
  };
}

/** `projectId · revision N · F frames` parts (RU-SE05); `revision` is null for an uninitialized journal. */
export function identityOf(state: ReviewState): { project: string; revision: number | null; frames: number } {
  return { project: state.projectId, revision: state.revision, frames: state.durationInFrames };
}
