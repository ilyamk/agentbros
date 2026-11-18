/**
 * Pure builders of the edit section (RU-T04–T11, RU-P01–P06, RU-AU01–04; the review:ui parity checklist),
 * with the same inputs, defaults and refusals as review:ui's `fields()`, `structuredCommand()` and `prepare*()`
 * (the former HTML-string client, removed in WP13f). Field values are the raw control values keyed by the old element ids, so a form is
 * a plain record and every rule here is testable without a DOM. Client refusals throw {@link EditInputError} with a
 * dictionary key; the server's own refusals arrive verbatim from the routes.
 */
import type { ProposalRoute, Rational, ReviewClip, ReviewState, ReviewTrack } from "../api";
import type { editEn } from "./edit.strings";

export const OPERATIONS = [
  "move",
  "authored-copy",
  "visual-reframe",
  "visual-remove",
  "visual-slip",
  "visual-split",
  "transfer",
  "trim",
  "rate",
  "transition",
  "captions",
  "audio-position",
  "audio-trim",
  "audio-gain",
  "audio-loop",
] as const;
export type Operation = (typeof OPERATIONS)[number];

/** Operations built in the browser and checked by the generic dry-run. */
export type GenericOperation =
  "move" | "transfer" | "trim" | "rate" | "transition" | "captions" | "audio-gain" | "audio-loop";
/** Operations prepared by a specialized route (prepare never writes). */
export type SpecializedOperation = Exclude<Operation, GenericOperation>;

export const SPECIALIZED: Readonly<Record<SpecializedOperation, ProposalRoute>> = {
  "authored-copy": "authored-copy-proposal",
  "visual-reframe": "visual-reframe-proposal",
  "visual-remove": "visual-remove-proposal",
  "visual-slip": "visual-slip-proposal",
  "visual-split": "visual-split-proposal",
  "audio-position": "audio-position-proposal",
  "audio-trim": "audio-position-proposal",
};

export const isSpecialized = (operation: Operation): operation is SpecializedOperation => operation in SPECIALIZED;

export const isOperation = (value: string): value is Operation => (OPERATIONS as readonly string[]).includes(value);

export const GROUP_MAX = 24;
export const REFRAME_FORMATS = ["vertical", "square", "landscape"] as const;
export const COPY_LIMITS = { headline: 80, subtext: 160 } as const;

export type ErrorKey = keyof typeof editEn.error;

/**
 * A refusal made in the browser: `key` names `d.timeline.edit.error.<key>`, or `d.timeline.edit.unsupported.<key>`
 * for an operation the selected track does not support.
 */
export class EditInputError extends Error {
  constructor(
    readonly key: ErrorKey | Unsupported,
    readonly group: "error" | "unsupported" = "error",
  ) {
    super(key);
    this.name = "EditInputError";
  }
}

export interface ClipRef {
  trackId: string;
  clipId: string;
}

export type FieldValues = Record<string, string | boolean>;

export const number = (value: Rational) => value.num / value.den;
const frame = (num: number): Rational => ({ num, den: 1 });

export function findTrack(state: ReviewState, trackId: string): ReviewTrack | undefined {
  return state.tracks.find((track) => track.id === trackId);
}

/** The selected clip, or a refusal (review:ui `currentClip()`). */
export function currentClip(
  state: ReviewState,
  selected: ClipRef | undefined,
): { track: ReviewTrack; clip: ReviewClip } {
  if (!selected) throw new EditInputError("selectClip");
  const track = findTrack(state, selected.trackId);
  const clip = track?.clips.find((candidate) => candidate.id === selected.clipId);
  if (!track || !clip) throw new EditInputError("clipGone");
  return { track, clip };
}

const isAudio = (track: ReviewTrack) => track.kind === "music" || track.kind === "sfx";

/** Why an operation has no form for this clip (the old page showed a notice instead of fields). */
export type Unsupported = keyof typeof editEn.unsupported;

export function unsupportedReason(operation: Operation, track: ReviewTrack, clip: ReviewClip): Unsupported | undefined {
  switch (operation) {
    case "visual-remove":
      return track.kind === "visual" ? undefined : "visualRemove";
    case "visual-slip":
      return track.kind === "visual" ? undefined : "visualSlip";
    case "visual-split":
      return track.kind === "visual" ? undefined : "visualSplit";
    case "transfer":
      return track.kind === "visual" ? undefined : "transfer";
    case "audio-position":
    case "audio-trim":
      return isAudio(track) ? undefined : "audioPosition";
    case "audio-gain":
    case "audio-loop":
      return isAudio(track) ? undefined : "audioMix";
    case "captions":
      return clip.captions?.length ? undefined : "noCaptions";
    default:
      return undefined;
  }
}

/** The authored copy a clip carries: `payload.scene`, or its template props for `scene.hook`. */
export function authoredCopy(clip: ReviewClip): { target: "scene.hook" | "legacy"; headline: string; subtext: string } {
  const scene = clip.payload?.scene as { template?: { id?: unknown; props?: Record<string, unknown> } } | undefined;
  const hook = scene?.template?.id === "scene.hook";
  const copy = (hook ? scene?.template?.props : (scene as Record<string, unknown> | undefined)) ?? {};
  const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
  return { target: hook ? "scene.hook" : "legacy", headline: text(copy.headline), subtext: text(copy.subtext) };
}

/**
 * A split point the server can accept: the integer output frame nearest the clip's middle, strictly inside the clip.
 * (review:ui defaulted to `clip.start`, which `buildVisualSplitProposal` always refuses; parity plan defect 2.)
 */
export function defaultSplitPoint(clip: ReviewClip): Rational {
  const start = number(clip.start);
  const end = number(clip.end);
  const middle = Math.round((start + end) / 2);
  if (middle > start && middle < end) return frame(middle);
  const above = Math.floor(start) + 1;
  return above < end ? frame(above) : clip.start;
}

const otherVisualTracks = (state: ReviewState, track: ReviewTrack) =>
  state.tracks.filter((candidate) => candidate.kind === "visual" && candidate.id !== track.id);

/** The form's initial values (review:ui `fields(c)`), keyed by the old element ids. */
export function defaultFields(
  operation: Operation,
  state: ReviewState,
  track: ReviewTrack,
  clip: ReviewClip,
): FieldValues {
  if (unsupportedReason(operation, track, clip)) return {};
  switch (operation) {
    case "move":
      return { "edit-start": String(number(clip.start)) };
    case "trim":
      return { "edit-start": String(number(clip.source.start)), "edit-end": String(number(clip.source.end)) };
    case "rate":
      return { "rate-num": String(clip.rate.num), "rate-den": String(clip.rate.den) };
    case "transition": {
      const transition = clip.transition as { kind?: string; duration?: Rational } | undefined;
      return {
        "fade-frames": String(transition?.kind === "fade" && transition.duration ? number(transition.duration) : 0),
      };
    }
    case "captions":
      return Object.fromEntries((clip.captions ?? []).map((caption, i) => [`caption-${i}`, caption.text]));
    case "transfer":
      return {
        "target-track": otherVisualTracks(state, track)[0]?.id ?? "",
        "transfer-num": String(clip.start.num),
        "transfer-den": String(clip.start.den),
      };
    case "authored-copy": {
      const copy = authoredCopy(clip);
      return {
        "copy-headline-mode": "keep",
        "copy-headline": copy.headline,
        "copy-subtext-mode": "keep",
        "copy-subtext": copy.subtext,
      };
    }
    case "visual-reframe":
      return { "reframe-format": "vertical", "reframe-x": "0.5", "reframe-y": "0.5", "reframe-reset": false };
    case "visual-remove":
      return {};
    case "visual-slip":
      return { "slip-num": "1", "slip-den": "1" };
    case "visual-split": {
      const at = defaultSplitPoint(clip);
      return { "split-at-num": String(at.num), "split-at-den": String(at.den), "split-right-id": `${clip.id}-right` };
    }
    case "audio-position":
      return { "audio-position-num": String(clip.start.num), "audio-position-den": String(clip.start.den) };
    case "audio-trim":
      return {
        "audio-source-start-num": String(clip.source.start.num),
        "audio-source-start-den": String(clip.source.start.den),
        "audio-source-end-num": String(clip.source.end.num),
        "audio-source-end-den": String(clip.source.end.den),
      };
    case "audio-gain": {
      const gain = clip.payload?.audioGain;
      return { "audio-gain": typeof gain === "number" ? String(gain) : "" };
    }
    case "audio-loop": {
      const loop = clip.payload?.loop;
      return { "audio-loop": typeof loop === "boolean" ? String(loop) : "" };
    }
  }
}

const text = (values: FieldValues, id: string) => {
  const value = values[id];
  return typeof value === "string" ? value : "";
};

/** review:ui `integer()`: `Number(value)` must be a safe integer (so a blank field reads as 0, as before). */
export function integerField(values: FieldValues, id: string): number {
  const value = Number(text(values, id));
  if (!Number.isSafeInteger(value)) throw new EditInputError("integers");
  return value;
}

/** review:ui `exact()`: digits only (optional minus), a safe integer. */
export function exactField(values: FieldValues, id: string, key: ErrorKey): number {
  const value = text(values, id).trim();
  if (!/^-?[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new EditInputError(key);
  return Number(value);
}

/**
 * The generic operations' command (review:ui `structuredCommand()`), validated by the generic dry-run. Exhaustive:
 * a specialized operation is never built here (the old catch-all built a captions command for any unknown type).
 */
export function structuredCommand(
  operation: GenericOperation,
  state: ReviewState,
  selected: ClipRef | undefined,
  values: FieldValues,
): Record<string, unknown> {
  const { track, clip } = currentClip(state, selected);
  const base = { type: operation, trackId: track.id, clipId: clip.id };
  switch (operation) {
    case "audio-gain":
    case "audio-loop": {
      if (!isAudio(track)) throw new EditInputError("audioMix", "unsupported");
      if (operation === "audio-loop") {
        const loop = text(values, "audio-loop");
        return { ...base, loop: loop === "" ? null : loop === "true" };
      }
      const raw = text(values, "audio-gain").trim();
      const gain = raw === "" ? null : Number(raw);
      if (gain !== null && (!Number.isFinite(gain) || gain < 0 || gain > 1)) throw new EditInputError("gainRange");
      return { ...base, gain };
    }
    case "transfer": {
      if (track.kind !== "visual") throw new EditInputError("transfer", "unsupported");
      const targetTrackId = text(values, "target-track");
      if (!targetTrackId) throw new EditInputError("targetTrack");
      return {
        ...base,
        targetTrackId,
        start: { num: integerField(values, "transfer-num"), den: integerField(values, "transfer-den") },
      };
    }
    case "move":
      return { ...base, start: frame(integerField(values, "edit-start")) };
    case "trim":
      return {
        ...base,
        start: frame(integerField(values, "edit-start")),
        end: frame(integerField(values, "edit-end")),
      };
    case "rate":
      return { ...base, rate: { num: integerField(values, "rate-num"), den: integerField(values, "rate-den") } };
    case "transition": {
      const frames = integerField(values, "fade-frames");
      return { ...base, transition: frames === 0 ? { kind: "cut" } : { kind: "fade", duration: frame(frames) } };
    }
    case "captions": {
      if (!clip.captions?.length) throw new EditInputError("noCaptions");
      return {
        ...base,
        captions: clip.captions.map((caption, i) => ({ ...caption, text: text(values, `caption-${i}`) })),
      };
    }
  }
}

/** One `Prepare mute` / `Prepare gain reset` command (RU-AU03). */
export function gainCommand(selected: ClipRef, gain: 0 | null) {
  return { type: "audio-gain", ...selected, gain };
}

/** A specialized prepare: the route, its strict body, the late-reply signature and the G6 display of the reply. */
export interface PrepareRequest {
  route: ProposalRoute;
  body: Record<string, unknown>;
  /** Extra form signature the reply is bound to (reframe controls). */
  signature?: string;
  display(result: {
    revision: number;
    timelineHash: string;
    snapshot: { durationInFrames: number };
    [key: string]: unknown;
  }): Record<string, unknown>;
}

const summary = (
  result: { revision: number; timelineHash: string; snapshot: { durationInFrames: number } },
  flags: Record<string, unknown>,
) => ({
  revision: result.revision,
  proposedHash: result.timelineHash,
  durationInFrames: result.snapshot.durationInFrames,
  ...flags,
});

/** The body and display of a specialized prepare (review:ui `prepareAuthoredCopy` … `prepareAudioPosition`). */
export function prepareRequest(
  operation: SpecializedOperation,
  state: ReviewState,
  selected: ClipRef | undefined,
  values: FieldValues,
): PrepareRequest {
  const { track, clip } = currentClip(state, selected);
  const binding = { trackId: track.id, clipId: clip.id };
  const expectedRevision = state.revision;
  const route = SPECIALIZED[operation];
  const reason = unsupportedReason(operation, track, clip);
  if (reason) throw new EditInputError(reason, "unsupported");
  switch (operation) {
    case "authored-copy": {
      const patch: Record<string, string | null> = {};
      for (const key of ["headline", "subtext"] as const) {
        const mode = text(values, `copy-${key}-mode`);
        if (mode === "set") patch[key] = text(values, `copy-${key}`);
        else if (key === "subtext" && mode === "remove") patch[key] = null;
      }
      return {
        route,
        body: { expectedRevision, ...binding, target: authoredCopy(clip).target, ...patch },
        display: (result) => summary(result, { authoredCopy: true, freshRenderRequired: true }),
      };
    }
    case "visual-reframe": {
      const format = text(values, "reframe-format");
      const coordinate = (id: string) => {
        const raw = text(values, id).trim();
        if (raw === "") throw new EditInputError("reframeRequired");
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new EditInputError("reframeRange");
        return value;
      };
      const position =
        values["reframe-reset"] === true ? null : { x: coordinate("reframe-x"), y: coordinate("reframe-y") };
      return {
        route,
        body: { expectedRevision, ...binding, format, position },
        signature: reframeSignature(values),
        display: (result) => ({
          revision: result.revision,
          proposedHash: result.timelineHash,
          format,
          position,
          originalSha256: result.originalSha256,
        }),
      };
    }
    case "visual-remove":
      return {
        route,
        body: { expectedRevision, ...binding },
        display: (result) => summary(result, { visualRemove: true, gapRetained: true }),
      };
    case "visual-slip": {
      const delta = { num: integerField(values, "slip-num"), den: integerField(values, "slip-den") };
      return {
        route,
        body: { expectedRevision, ...binding, delta },
        display: (result) =>
          summary(result, {
            sourceSlip: true,
            oldSource: clip.source,
            newSource: (result.command as { source?: unknown } | undefined)?.source,
            physical: result.physical,
          }),
      };
    }
    case "visual-split": {
      const at = {
        num: exactField(values, "split-at-num", "splitIntegers"),
        den: exactField(values, "split-at-den", "splitIntegers"),
      };
      return {
        route,
        body: { expectedRevision, ...binding, at, newClipId: text(values, "split-right-id") },
        display: (result) => summary(result, { visualSplit: true }),
      };
    }
    case "audio-position":
    case "audio-trim": {
      const rational = (prefix: string) => ({
        num: exactField(values, `${prefix}-num`, "audioIntegers"),
        den: exactField(values, `${prefix}-den`, "audioIntegers"),
      });
      const change =
        operation === "audio-position"
          ? { mode: "move", start: rational("audio-position") }
          : { mode: "trim", sourceStart: rational("audio-source-start"), sourceEnd: rational("audio-source-end") };
      return {
        route,
        body: { expectedRevision, ...binding, ...change },
        display: (result) => summary(result, { audioPosition: true }),
      };
    }
  }
}

/** The reframe form's four controls; a reply is kept only if they are unchanged (RU-P02 extra late guard). */
export function reframeSignature(values: FieldValues): string {
  return JSON.stringify([
    values["reframe-format"],
    values["reframe-x"],
    values["reframe-y"],
    values["reframe-reset"] === true,
  ]);
}

/** The visual clips a group can hold, in lane order. */
export function groupCandidates(state: ReviewState): ClipRef[] {
  return state.tracks
    .filter((track) => track.kind === "visual")
    .flatMap((track) => track.clips.map((clip) => ({ trackId: track.id, clipId: clip.id })));
}

/** Toggles a member; adding a 25th is refused (RU-P06). */
export function toggleGroupMember(members: readonly ClipRef[], member: ClipRef, checked: boolean): ClipRef[] {
  const rest = members.filter((m) => m.trackId !== member.trackId || m.clipId !== member.clipId);
  if (!checked) return rest;
  if (rest.length >= GROUP_MAX) throw new EditInputError("groupMax");
  return [...rest, member];
}

/** The group-move prepare body (review:ui `prepareGroupMove`). */
export function groupMoveRequest(
  members: readonly ClipRef[],
  num: string,
  den: string,
  revision: number,
): { body: Record<string, unknown>; signature: string } {
  if (members.length < 2 || members.length > GROUP_MAX) throw new EditInputError("groupRange");
  const exact = (value: string) => {
    const trimmed = value.trim();
    if (!/^-?[0-9]+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) throw new EditInputError("groupDelta");
    return Number(trimmed);
  };
  const delta = { num: exact(num), den: exact(den) };
  const copy = members.map((m) => ({ trackId: m.trackId, clipId: m.clipId }));
  return { body: { expectedRevision: revision, members: copy, delta }, signature: JSON.stringify(copy) };
}
