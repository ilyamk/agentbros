// Pure: every cut, transition and hero moment is decided, a sound or a silence with its reason. Shared by plan:check
// (cut-sound-decided), sfx:cues (which places the decisions) and film:measure (cut-sound-coverage).
import type { MotionPlan } from "../../types/creative";
import type { CueSheet, CueSheetCue } from "../../types/film";
import type { Cue, SfxKind } from "../../motion/library/types";

export const SOUND_KINDS: readonly Exclude<SfxKind, "none">[] = [
  "click",
  "pop",
  "whoosh",
  "impact",
  "chime",
  "riser",
  "sub-drop",
  "tick",
  "glass",
];
/** Plan boundary to cue-sheet cue: the drift plan:check's cue-sheet dimension allows. */
export const DECISION_MATCH_FRAMES = 1;
/** A block cue this close to a decided event belongs to it: the decision replaces its sound. */
export const BLOCK_MATCH_FRAMES = 2;

export type SoundKind = Exclude<SfxKind, "none">;
export type CueDecision =
  | { state: "sound"; sfx: SoundKind; layers?: SoundKind[] }
  | { state: "silent"; reason: string }
  | { state: "undecided" | "conflict" | "unknown-sfx"; problem: string }
  | { state: "not-required" };

const isSoundKind = (value: unknown): value is SoundKind =>
  typeof value === "string" && (SOUND_KINDS as readonly string[]).includes(value);

/**
 * The weight a cue-sheet cue's sound plays at: its own `weight`, else hero when it layers sounds or is a moment (reveal,
 * hit) rather than a cut. One rule for sfx:cues (gain) and sfx:audition (which cues compare candidates).
 */
export function soundCueWeight(cue: Pick<CueSheetCue, "kind" | "weight" | "layers">): "hero" | "support" {
  return cue.weight ?? (cue.layers?.length || (cue.kind !== "cut" && cue.kind !== "transition") ? "hero" : "support");
}

/** Cuts and transitions always decide; a reveal or hit decides unless marked `weight: "support"`. */
export function needsDecision(cue: Pick<CueSheetCue, "kind" | "weight">): boolean {
  if (cue.kind === "cut" || cue.kind === "transition") return true;
  return (cue.kind === "reveal" || cue.kind === "hit") && cue.weight !== "support";
}

/** What a cue-sheet cue decided. `sfx: "none"` without a silent reason is not a decision. */
export function cueDecision(cue: Pick<CueSheetCue, "kind" | "weight" | "sfx" | "silent" | "layers">): CueDecision {
  const sounding = cue.sfx !== undefined && cue.sfx !== "none" && cue.sfx.trim() !== "";
  if (sounding && cue.silent)
    return { state: "conflict", problem: `both sfx "${cue.sfx}" and silent ("${cue.silent.reason}")` };
  if (cue.silent) return { state: "silent", reason: cue.silent.reason };
  if (sounding) {
    if (!isSoundKind(cue.sfx))
      return { state: "unknown-sfx", problem: `sfx "${cue.sfx}" is not a sound kind (${SOUND_KINDS.join(", ")})` };
    return { state: "sound", sfx: cue.sfx, ...(cue.layers?.length ? { layers: [...cue.layers] } : {}) };
  }
  if (!needsDecision(cue)) return { state: "not-required" };
  return {
    state: "undecided",
    problem: cue.sfx === "none" ? 'sfx "none" without silent.reason' : "neither sfx nor silent",
  };
}

export type UndecidedCue = { id: string; kind: string; frame: number; shotId?: string; problem: string };

/** The decision check: every cue that must decide and has not, or decided two ways. Empty when the sheet is complete. */
export function undecidedCues(sheet: Pick<CueSheet, "cues">): UndecidedCue[] {
  return sheet.cues.flatMap((cue) => {
    const decision = cueDecision(cue);
    if (decision.state === "sound" || decision.state === "silent" || decision.state === "not-required") return [];
    return [
      {
        id: cue.id,
        kind: cue.kind,
        frame: cue.frame,
        ...(cue.shotId ? { shotId: cue.shotId } : {}),
        problem: decision.problem,
      },
    ];
  });
}

export const DECISION_FIX =
  'Decide each in the cue sheet: `sfx` (a sound kind: what is heard, chosen for this moment) or `silent: {"reason": "..."}` (why nothing is heard). A whoosh on every cut is a template; a hero cue may add `layers`. Add the fields to the cue drafts and rerun edit:snap, or edit cue-sheet.json.';

export type FilmEventKind = "cut" | "reveal" | "hit";
/** One event of the film that must be decided, with where it came from and what decided it. */
export type FilmDecision = {
  frame: number;
  kind: FilmEventKind;
  sources: ("plan" | "cue-sheet" | "block")[];
  cueId?: string;
  shotId?: string;
  transition?: string;
  by?: "cue-sheet" | "block";
  blockId?: string;
} & (
  | { state: "sound"; sfx: SoundKind; layers?: SoundKind[] }
  | { state: "silent"; reason: string }
  | { state: "undecided" | "conflict" | "unknown-sfx"; problem: string }
);

type BlockCues = { blockId: string; startFrame: number; cues: Cue[] };

const familyOf = (kind: string): FilmEventKind | undefined =>
  kind === "cut" || kind === "transition"
    ? "cut"
    : kind === "reveal" || kind === "hit" || kind === "land"
      ? kind === "land"
        ? "hit"
        : kind
      : undefined;
const sameFamily = (a: FilmEventKind, b: FilmEventKind) => a === b || (a !== "cut" && b !== "cut");

/**
 * Every cut of the film (the plan's shot boundaries, the cue sheet's cuts and transitions, the blocks' cut cues) and
 * every hero moment of the cue sheet, each matched to its decision. The cue sheet decides; a block cue with a sound
 * decides a boundary the sheet does not name. Frames are at `fps` (the sheet and plan are rescaled).
 */
export function decideFilmEvents(input: {
  fps: number;
  plan?: Pick<MotionPlan, "fps" | "shots">;
  cueSheet?: Pick<CueSheet, "fps" | "cues">;
  blocks?: BlockCues[];
}): FilmDecision[] {
  const { fps } = input;
  const events: FilmDecision[] = [];
  if (input.cueSheet) {
    const scale = fps / input.cueSheet.fps;
    for (const cue of input.cueSheet.cues) {
      const kind = familyOf(cue.kind);
      if (!kind || !needsDecision(cue)) continue;
      const decision = cueDecision(cue);
      if (decision.state === "not-required") continue;
      const decided = decision.state === "sound" || decision.state === "silent";
      events.push({
        frame: Math.round(cue.frame * scale),
        kind,
        sources: ["cue-sheet"],
        cueId: cue.id,
        ...(cue.shotId ? { shotId: cue.shotId } : {}),
        ...(decided ? { by: "cue-sheet" as const } : {}),
        ...decision,
      });
    }
  }
  if (input.plan) {
    const scale = fps / input.plan.fps;
    const shots = input.plan.shots;
    for (let index = 1; index < shots.length; index++) {
      const frame = Math.round(shots[index]!.startFrame * scale);
      const transition = shots[index - 1]!.transitionToNext;
      const match = events
        .filter(
          (event) =>
            event.kind === "cut" && Math.abs(event.frame - frame) <= DECISION_MATCH_FRAMES * Math.max(1, scale),
        )
        .sort((a, b) => Math.abs(a.frame - frame) - Math.abs(b.frame - frame))[0];
      if (match) {
        if (!match.sources.includes("plan")) match.sources.push("plan");
        match.shotId ??= shots[index]!.id;
        if (transition) match.transition ??= transition;
        continue;
      }
      events.push({
        frame,
        kind: "cut",
        sources: ["plan"],
        shotId: shots[index]!.id,
        ...(transition ? { transition } : {}),
        state: "undecided",
        problem: "a shot boundary with no cue in the cue sheet",
      });
    }
  }
  for (const block of input.blocks ?? []) {
    for (const cue of block.cues) {
      const kind = familyOf(cue.kind);
      if (!kind) continue;
      const frame = block.startFrame + cue.frame;
      const match = events
        .filter((event) => sameFamily(event.kind, kind) && Math.abs(event.frame - frame) <= BLOCK_MATCH_FRAMES)
        .sort((a, b) => Math.abs(a.frame - frame) - Math.abs(b.frame - frame))[0];
      const sound = cue.sfx && cue.sfx !== "none" ? cue.sfx : undefined;
      if (match) {
        if (!match.sources.includes("block")) match.sources.push("block");
        // A block's sound decides only a boundary the cue sheet does not name: an undecided sheet cue stays undecided,
        // as plan:check reads it, and a conflict or an unknown kind stays for the author to fix.
        if (match.state === "undecided" && !match.sources.includes("cue-sheet") && sound)
          Object.assign(match, { state: "sound", sfx: sound, by: "block", blockId: block.blockId, problem: undefined });
        continue;
      }
      // Block hero moments the sheet does not name are the block's own business; its cuts are the film's.
      if (kind !== "cut") continue;
      events.push(
        sound
          ? { frame, kind, sources: ["block"], by: "block", blockId: block.blockId, state: "sound", sfx: sound }
          : {
              frame,
              kind,
              sources: ["block"],
              blockId: block.blockId,
              state: "undecided",
              problem: `${block.blockId}'s cut cue names no sound`,
            },
      );
    }
  }
  for (const event of events)
    if ("problem" in event && event.problem === undefined) delete (event as { problem?: string }).problem;
  return events.sort((a, b) => a.frame - b.frame || a.kind.localeCompare(b.kind));
}

export const isDecided = (event: FilmDecision) => event.state === "sound" || event.state === "silent";

/**
 * A transition block's cut cues on its seam in the film: `seamFrame` (block-relative, the frame the perceived cut
 * lands on) moves every `cut` cue there. Without it the cues stay where the item put them, which for the library's
 * transitions is the preview composition's centred seam: `placed: false`, so the caller warns.
 */
export function seamCues<C extends Pick<Cue, "frame" | "kind">>(
  cues: C[],
  props: Record<string, unknown> | undefined,
): { cues: C[]; placed: boolean } {
  const seam = props?.["seamFrame"];
  if (typeof seam !== "number" || !Number.isFinite(seam)) return { cues, placed: false };
  return { cues: cues.map((cue) => (cue.kind === "cut" ? { ...cue, frame: Math.round(seam) } : cue)), placed: true };
}

/** One line per undecided event, for an error message. */
export const describeUndecided = (events: FilmDecision[]) =>
  events
    .filter((event) => !isDecided(event))
    .map(
      (event) =>
        `${event.kind} @${event.frame}${event.shotId ? ` (${event.shotId})` : ""}${event.cueId ? ` cue ${event.cueId}` : ""}: ${(event as { problem?: string }).problem ?? event.state}`,
    );
