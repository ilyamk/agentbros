/**
 * Pointer geometry of the edit section (RU-T16–T18, RU-K03–K05; review:ui client.ts `pointerCommand` and the
 * pointermove preview). Pure: lanes come in as rectangles, so clamping, cross-lane transfer and the "Drop inside a
 * visual track lane" refusal are testable without layout. The command itself is `pointerProposal` (pointer.ts),
 * imported as a module; the store's dry-run and journal CAS stay the authority.
 */
import { pointerProposal, type Rational, type ReviewClip, type ReviewTrack } from "../api";
import { EditInputError, number } from "./edit-commands";

export interface LaneRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface LaneBox {
  trackId: string;
  kind: string;
  rect: LaneRect;
}

/** A live drag: captured at pointerdown (revision, clocks, grab offset) and read on every move and on release. */
export interface Drag {
  pointerId: number;
  mode: "move" | "start" | "end";
  track: ReviewTrack;
  clip: ReviewClip;
  /** Client coordinates at pointerdown. */
  x: number;
  y: number;
  /** Output frames between the clip's left edge and the grab point. */
  grabFrames: number;
  revision: number;
  duration: number;
  timebase: Rational;
  moved: boolean;
}

/** The 3 px threshold before a press counts as a drag. */
export const DRAG_THRESHOLD = 3;

export const passedThreshold = (drag: Pick<Drag, "x" | "y">, x: number, y: number) =>
  Math.abs(x - drag.x) > DRAG_THRESHOLD || Math.abs(y - drag.y) > DRAG_THRESHOLD;

type Command = Record<string, unknown> & { type: string };

const inside = (rect: LaneRect, x: number, y: number) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

/** The proposal for the pointer at (x, y). Throws the pointer module's messages, or "Drop inside a visual track lane". */
export function pointerCommand(drag: Drag, x: number, y: number, lanes: readonly LaneBox[]): Command {
  const own = lanes.find((lane) => lane.trackId === drag.track.id);
  if (!own) throw new EditInputError("dropLane");
  let lane = own;
  let targetTrackId: string | undefined;
  let deltaPx = x - drag.x;
  if (drag.mode === "move") {
    const hit = lanes.find((candidate) => inside(candidate.rect, x, y));
    if (!hit || hit.kind !== "visual") throw new EditInputError("dropLane");
    lane = hit;
    targetTrackId = hit.trackId;
    if (targetTrackId !== drag.track.id) {
      const desired = ((x - hit.rect.left) / hit.rect.width) * drag.duration - drag.grabFrames;
      deltaPx = ((desired - number(drag.clip.start)) / drag.duration) * hit.rect.width;
    }
  }
  const others = drag.track.clips.filter((clip) => clip.id !== drag.clip.id);
  const previous = others.filter((clip) => number(clip.end) <= number(drag.clip.start)).at(-1);
  const next = others.find((clip) => number(clip.start) >= number(drag.clip.end));
  return pointerProposal({
    mode: drag.mode,
    deltaPx,
    targetTrackId,
    laneWidth: lane.rect.width,
    durationInFrames: drag.duration,
    timebase: drag.timebase,
    trackId: drag.track.id,
    clip: drag.clip,
    previousEnd: previous?.end,
    nextStart: next?.start,
  }) as Command;
}

export interface PreviewStyle {
  left: string;
  width: string;
  transform: string;
}

/** Where the dragged clip is drawn for `command` (the old pointermove preview: transform, left and width). */
export function previewStyle(drag: Drag, command: Command, lanes: readonly LaneBox[]): PreviewStyle {
  const commands = (command.type === "batch" ? (command.commands as Command[]) : [command]) ?? [];
  const move = commands.find((c) => c.type === "move" || c.type === "transfer");
  const trim = commands.find((c) => c.type === "trim");
  const clip = drag.clip;
  const start = move ? number(move.start as Rational) : number(clip.start);
  const span = trim
    ? (((number(trim.end as Rational) - number(trim.start as Rational)) / number(clip.rate)) * number(drag.timebase)) /
      number(clip.source.timebase)
    : number(clip.end) - number(clip.start);
  const source = lanes.find((lane) => lane.trackId === drag.track.id)!.rect;
  const target =
    (move?.type === "transfer" ? lanes.find((lane) => lane.trackId === move.targetTrackId)?.rect : undefined) ?? source;
  const offsetX = target.left - source.left + (start / drag.duration) * (target.width - source.width);
  return {
    left: `${(100 * start) / drag.duration}%`,
    width: `${(span / drag.duration) * target.width}px`,
    transform: `translate(${offsetX}px,${target.top - source.top}px)`,
  };
}

/** Pointer-module messages with a translation (others are shown as written). */
export const POINTER_MESSAGES: Readonly<Record<string, "noChange" | "tooShort" | "noInterval">> = {
  "Pointer proposal makes no change": "noChange",
  "Clip is too short for inward frame trim": "tooShort",
  "No legal pointer interval": "noInterval",
};
